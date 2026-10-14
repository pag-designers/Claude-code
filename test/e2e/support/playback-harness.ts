/**
 * Browser harness for the playback / preview specs. Bundles a tiny page (playback-app/main.tsx) with esbuild —
 * the real <PreviewPlayer/>, real editor store, real compositor — plus the renderer's Tailwind/token CSS, into a PRIVATE
 * directory (CLIPFERN_E2E_OUT or .tmp/playback-app; never renderer/out). Serves it together with the generated test media
 * (HTTP Range supported, hit counters), installs a contract-validated `window.clipfern` for the `editor:*` media channels
 * and records console errors / warnings, page errors and non-same-origin requests.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { invokeContract, type InvokeChannel } from '../../../shared/ipc';
import type { Asset, EditorProjectDoc, Project } from '../../../shared/editor';
import { projectSchema } from '../../../shared/editor';
import { ensurePlaybackMedia } from './playback-media';
import { findChrome } from './harness';

const ROOT = path.resolve(__dirname, '../../..');
export const BUILD_DIR = process.env.CLIPFERN_E2E_OUT
  ? path.join(path.resolve(process.env.CLIPFERN_E2E_OUT), 'playback-app')
  : path.join(ROOT, '.tmp/playback-app');
export const CHROME = findChrome();
export const canRun = (): boolean => !!CHROME;

export async function buildApp(): Promise<void> {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  await build({
    entryPoints: [path.join(__dirname, 'playback-app/main.tsx')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    outfile: path.join(BUILD_DIR, 'app.js'),
    jsx: 'automatic',
    tsconfig: path.join(ROOT, 'renderer/tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"development"' },
    logLevel: 'error',
    sourcemap: 'inline',
    loader: { '.woff2': 'file' },
  });
  const cssPath = path.join(ROOT, 'renderer/app/globals.css');
  const css = fs.readFileSync(cssPath, 'utf8');
  const out = await postcss([tailwind()]).process(css, { from: cssPath });
  fs.writeFileSync(path.join(BUILD_DIR, 'app.css'), out.css);
  fs.writeFileSync(
    path.join(BUILD_DIR, 'index.html'),
    `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><title>playback</title>` +
      `<link rel="stylesheet" href="/app.css"></head><body class="bg-background text-foreground"><div id="root"></div>` +
      `<script src="/app.js"></script></body></html>`,
  );
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.webm': 'video/webm',
  '.wav': 'audio/wav',
  '.png': 'image/png',
};

export interface Served {
  base: string;
  hits: string[];
  /** Per-request delay (ms) for media paths, to exercise loading states. */
  delay: { ms: number };
  close(): void;
}

export function serve(mediaDir: string): Promise<Served> {
  const hits: string[] = [];
  const delay = { ms: 0 };
  const server = http.createServer((req, res) => {
    const u = decodeURIComponent((req.url ?? '/').split('?')[0] as string);
    if (u === '/favicon.ico') return void res.writeHead(204).end();
    let file: string;
    const isMedia = u.startsWith('/media/');
    if (isMedia) file = path.join(mediaDir, u.slice('/media/'.length));
    else if (u.startsWith('/fonts/')) file = path.join(ROOT, 'renderer/public', u);
    else file = path.join(BUILD_DIR, u === '/' ? 'index.html' : u);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile())
      return void res.writeHead(404).end('not found');
    if (isMedia) hits.push(u.slice('/media/'.length));
    const size = fs.statSync(file).size;
    const type = MIME[path.extname(file)] ?? 'application/octet-stream';
    const send = () => {
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
      if (range) {
        const start = range[1] ? Number(range[1]) : 0;
        const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        res.writeHead(206, {
          'content-type': type,
          'content-range': `bytes ${start}-${end}/${size}`,
          'accept-ranges': 'bytes',
          'content-length': end - start + 1,
          'access-control-allow-origin': '*',
        });
        fs.createReadStream(file, { start, end }).pipe(res);
        return;
      }
      res.writeHead(200, {
        'content-type': type,
        'accept-ranges': 'bytes',
        'content-length': size,
        'access-control-allow-origin': '*',
      });
      fs.createReadStream(file).pipe(res);
    };
    if (isMedia && delay.ms > 0) setTimeout(send, delay.ms);
    else send();
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        hits,
        delay,
        close: () => server.close(),
      }),
    ),
  );
}

/** What the fake main process answers for `editor:previewUrl` etc. */
export interface BridgeConfig {
  /** assetId → file under /media/ (or null + reason = no proxy). */
  previewUrls: Record<string, { file: string } | { reason: string }>;
  /** Added latency for `editor:previewUrl`, ms. */
  previewDelayMs: number;
}

export interface Session {
  page: Page;
  context: BrowserContext;
  problems: string[];
  calls: { channel: string; payload: unknown }[];
  bridge: BridgeConfig;
  close(): Promise<void>;
}

export interface Harness {
  served: Served;
  browser: Browser;
  open(opts?: {
    width?: number;
    height?: number;
    w?: number;
    h?: number;
    bridge?: Partial<BridgeConfig>;
    theme?: 'dark' | 'light';
    dpr?: number;
  }): Promise<Session>;
  close(): Promise<void>;
}

/** 1×1 test PNG (red) as a data URL for thumbnail strips. */
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export async function createHarness(): Promise<Harness> {
  const mediaDir = ensurePlaybackMedia();
  await buildApp();
  const served = await serve(mediaDir);
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: [
      '--no-sandbox',
      '--autoplay-policy=no-user-gesture-required',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
    ],
  });

  const open: Harness['open'] = async (opts = {}) => {
    const { width = 900, height = 900, w = 420, h = 760, theme = 'dark', dpr = 1 } = opts;
    const context = await browser.newContext({
      viewport: { width, height },
      colorScheme: theme,
      deviceScaleFactor: dpr,
    });
    const page = await context.newPage();
    const problems: string[] = [];
    const calls: Session['calls'] = [];
    const bridge: BridgeConfig = { previewUrls: {}, previewDelayMs: 0, ...opts.bridge };
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning')
        problems.push(`console.${m.type()}: ${m.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('request', (r) => {
      const url = r.url();
      if (!url.startsWith(served.base) && !url.startsWith('data:') && !url.startsWith('blob:'))
        problems.push(`EXTERNAL REQUEST: ${url}`);
    });
    await page.exposeFunction('__bridgeInvoke', async (channel: string, payload: unknown) => {
      if (!(channel in invokeContract)) throw new Error(`Unknown channel: ${channel}`);
      const spec = invokeContract[channel as InvokeChannel];
      const input = spec.input.parse(payload);
      calls.push({ channel, payload: input });
      let out: unknown;
      switch (channel) {
        case 'editor:previewUrl': {
          if (bridge.previewDelayMs) await new Promise((r) => setTimeout(r, bridge.previewDelayMs));
          const a = (input as { assetId: string }).assetId;
          const m = bridge.previewUrls[a];
          out = !m
            ? { url: null, reason: `unknown asset ${a}` }
            : 'file' in m
              ? { url: `${served.base}/media/${m.file}`, reason: null }
              : { url: null, reason: m.reason };
          break;
        }
        case 'editor:waveform': {
          const peaks = Array.from({ length: 200 }, (_, i) => Math.abs(Math.sin(i / 7)));
          out = { rate: 25, durationSec: 8, peaks };
          break;
        }
        case 'editor:thumbStrip': {
          const c = (input as { count: number; startSec: number; endSec: number }).count;
          const s = (input as { startSec: number }).startSec;
          const e = (input as { endSec: number }).endSec;
          out = {
            dataUrl: PNG_DATA_URL,
            tileW: 1,
            tileH: 1,
            cols: c,
            times: Array.from({ length: c }, (_, i) => s + ((e - s) * i) / c),
          };
          break;
        }
        case 'editor:beats':
          out = { beats: [0.5, 1, 1.5, 2] };
          break;
        default:
          throw new Error(`playback harness does not implement ${channel}`);
      }
      return spec.output.parse(out);
    });
    await page.addInitScript(() => {
      const w = window as unknown as Record<string, unknown>;
      w.clipfern = {
        platform: 'linux',
        invoke: (c: string, p?: unknown) =>
          (w.__bridgeInvoke as (c: string, p: unknown) => Promise<unknown>)(c, p),
        on: () => () => {},
      };
      try {
        localStorage.setItem('clipfern.theme', 'dark');
      } catch {
        /* ignore */
      }
    });
    await page.goto(`${served.base}/?w=${w}&h=${h}`);
    await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);
    return { page, context, problems, calls, bridge, close: () => context.close() };
  };

  return {
    served,
    browser,
    open,
    close: async () => {
      await browser.close();
      served.close();
    },
  };
}

/* ------------------------------------------------------------------ project builders -------- */

export const ASSETS: Record<string, Asset> = {
  clip: {
    id: 'clip',
    kind: 'video',
    name: 'clip.webm',
    source: { kind: 'upload', key: 'k/clip.webm', fileName: 'clip.webm' },
    durationSec: 6,
    width: 320,
    height: 568,
    fps: 30,
    hasAudio: true,
    beats: null,
  },
  mute: {
    id: 'mute',
    kind: 'video',
    name: 'nosound.webm',
    source: { kind: 'upload', key: 'k/nosound.webm', fileName: 'nosound.webm' },
    durationSec: 3,
    width: 320,
    height: 568,
    fps: 30,
    hasAudio: false,
    beats: null,
  },
  tone: {
    id: 'tone',
    kind: 'audio',
    name: 'tone.wav',
    source: { kind: 'upload', key: 'k/tone.wav', fileName: 'tone.wav' },
    durationSec: 8,
    width: null,
    height: null,
    fps: null,
    hasAudio: true,
    beats: null,
  },
  pic: {
    id: 'pic',
    kind: 'image',
    name: 'pic.png',
    source: { kind: 'upload', key: 'k/pic.png', fileName: 'pic.png' },
    durationSec: null,
    width: 256,
    height: 256,
    fps: null,
    hasAudio: false,
    beats: null,
  },
};

export const MEDIA_FILES: Record<string, { file: string }> = {
  clip: { file: 'clip.webm' },
  mute: { file: 'nosound.webm' },
  tone: { file: 'tone.wav' },
  pic: { file: 'pic.png' },
};

/** Builds a project through the real zod schema so every default is filled in. */
export function makeProject(input: {
  tracks: Record<string, unknown>[];
  assets?: string[];
  canvas?: Record<string, unknown>;
}): Project {
  return projectSchema.parse({
    tracks: input.tracks,
    assets: (input.assets ?? ['clip', 'tone', 'pic', 'mute']).map((id) => ASSETS[id]),
    canvas: input.canvas ?? {},
  });
}

export const doc = (project: Project, id = 'proj1'): EditorProjectDoc => ({
  id,
  name: 'Playback test',
  rev: 1,
  project,
  updatedAt: Date.now(),
});

export function videoItem(o: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'video', id: 'v1', assetId: 'clip', startSec: 0, durationSec: 6, ...o };
}
export function audioItem(o: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'audio', id: 'm1', assetId: 'tone', startSec: 0, durationSec: 8, ...o };
}
export function textItem(o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'text',
    id: 't1',
    text: 'Hello',
    startSec: 0,
    durationSec: 6,
    style: { color: '#FF00FF', size: 120, weight: 800 },
    ...o,
  };
}
export function track(
  kind: string,
  items: Record<string, unknown>[],
  o: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: `tr_${kind}_${Math.random().toString(36).slice(2, 6)}`,
    kind,
    name: kind,
    items,
    ...o,
  };
}
