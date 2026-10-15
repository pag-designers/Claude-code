/* eslint-disable no-console -- the metrics lines are the point of the parity report */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { resolveExportSettings, type Project } from '../../shared/editor';
import { createCaptionService } from '../../electron/main/services/captions';
import { createExportCompiler } from '../../electron/main/services/editor-export';
import { createEditorMedia } from '../../electron/main/services/editor-media';
import type { EditorAssetFile } from '../../electron/main/pipeline/contracts3';
import type { ParApi } from './support/editor-parity-page';
import {
  CH,
  CW,
  asset,
  image,
  project,
  shape,
  subtitle,
  text,
  track,
  video,
  writePng,
  type Img,
} from './support/editor-compositor-utils';

/**
 * PREVIEW / EXPORT PARITY (BRIEF §5: "Verify that preview and export are visually identical; write golden-frame tests").
 * The SAME project JSON is (a) drawn by the real WebGL compositor in Chromium and (b) compiled to FFmpeg by the real export
 * compiler and rendered for exactly one frame; the two frames are compared pixel by pixel. Media are real files (PNG / H.264).
 *   pnpm exec playwright test test/e2e/editor-parity.spec.ts      (writes side-by-side sheets to CLIPFERN_PARITY_OUT)
 */
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

const ROOT = path.resolve(__dirname, '../..');
const FONT_DIR = path.join(ROOT, 'renderer/public/fonts/editor');
const OUT =
  process.env.CLIPFERN_PARITY_OUT ??
  '/tmp/claude-0/-home-user-Claude-code/389612c4-f895-58c2-a3c2-02cb884e9ba1/scratchpad/editor-parity';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const FFMPEG = require('ffmpeg-static') as string;
const FPS = 30;

function findChrome(): string | undefined {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH))
    return process.env.CHROME_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  if (!fs.existsSync(root)) return undefined;
  for (const d of fs
    .readdirSync(root)
    .filter((n) => /^chromium-\d+$/.test(n))
    .sort()
    .reverse()) {
    const p = path.join(root, d, 'chrome-linux', 'chrome');
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}
const CHROME = findChrome();
test.skip(!CHROME, 'needs a Chromium binary');

let browser: Browser;
let page: Page;
let work: string;
const problems: string[] = [];
const par = <K extends keyof ParApi>(name: K, ...args: Parameters<ParApi[K]>) =>
  page.evaluate(
    ([n, a]) =>
      (window as unknown as { PAR: Record<string, (...x: unknown[]) => unknown> }).PAR[
        n as string
      ]!(...(a as unknown[])),
    [name, args] as const,
  ) as Promise<Awaited<ReturnType<ParApi[K]>>>;

const ff = (args: string[]) => {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-y', ...args], { maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(' ')}\n${r.stderr.toString()}`);
  return r.stdout;
};

/* ------------------------------------------------------------------ media ------------------------- */

const files: Record<string, EditorAssetFile> = {};
function register(
  id: string,
  file: string,
  w: number,
  h: number,
  kind: 'image' | 'video',
  dur: number | null,
  hasAudio = false,
) {
  files[id] = {
    assetId: id,
    kind,
    path: file,
    width: w,
    height: h,
    fps: kind === 'video' ? FPS : null,
    durationSec: dur,
    hasAudio,
  };
}
function makeMedia(): void {
  const png = (id: string, lavfi: string, w: number, h: number) => {
    const f = path.join(work, `${id}.png`);
    ff(['-f', 'lavfi', '-i', lavfi, '-frames:v', '1', '-pix_fmt', 'rgb24', f]);
    register(id, f, w, h, 'image', null);
  };
  png('bars', 'testsrc2=size=640x360:rate=1', 640, 360);
  png('tall', 'testsrc2=size=360x640:rate=1', 360, 640);
  png('small', 'testsrc2=size=200x120:rate=1', 200, 120);
  png('base', `color=c=0xC86432:s=${CW}x${CH}`, CW, CH);
  png('top', `color=c=0x5AB4F0:s=${CW}x${CH}`, CW, CH);
  png('red', `color=c=0xFF0000:s=${CW}x${CH}`, CW, CH);
  png(
    'grad',
    `gradients=s=${CW}x${CH}:c0=0x2040C0:c1=0xF0C020:x0=0:y0=0:x1=${CW}:y1=${CH}:duration=1:speed=0.0001`,
    CW,
    CH,
  );
  const vid = path.join(work, 'vid.mp4');
  ff([
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=640x360:rate=${FPS}`,
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000',
    '-t',
    '6',
    '-c:v',
    'libx264',
    '-crf',
    '12',
    '-pix_fmt',
    'yuv420p',
    '-colorspace',
    'bt709',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
    '-color_range',
    'tv',
    '-g',
    '30',
    '-c:a',
    'aac',
    vid,
  ]);
  register('vid', vid, 640, 360, 'video', 6, true);
  // A second clip whose colour changes smoothly with time: a wrong source frame is a big, obvious error.
  const vid2 = path.join(work, 'vid2.mp4');
  ff([
    '-f',
    'lavfi',
    '-i',
    `nullsrc=s=640x360:r=${FPS},geq=r='128+127*sin(2*PI*T/3)':g='128+127*sin(2*PI*T/2)':b='128+127*sin(2*PI*T/5)',format=yuv420p`,
    '-t',
    '6',
    '-c:v',
    'libx264',
    '-crf',
    '12',
    '-colorspace',
    'bt709',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
    '-color_range',
    'tv',
    '-g',
    '30',
    vid2,
  ]);
  register('vid2', vid2, 640, 360, 'video', 6, false);
}

/** One decoded RGBA frame of the test video at source frame index k (what the preview's <video> would show). */
function videoFrame(assetId: string, k: number): string {
  const out = path.join(work, `${assetId}-${k}.png`);
  if (!fs.existsSync(out))
    ff([
      '-i',
      files[assetId]!.path,
      '-vf',
      `select=eq(n\\,${k}),scale=in_range=tv:in_color_matrix=bt709:out_range=pc,format=rgb24`,
      '-frames:v',
      '1',
      out,
    ]);
  return fs.readFileSync(out).toString('base64');
}

/* ------------------------------------------------------------------ the two renderers ------------- */

const captions = createCaptionService({ fontsDir: path.join(ROOT, 'electron/main/assets/fonts') });
const styles = new Map(captions.builtinStyles().map((s) => [s.id, s]));
const compiler = createExportCompiler({ ffmpegPath: FFMPEG });
const media = createEditorMedia({ ffmpegPath: () => FFMPEG });

async function exportFrame(p: Project, t: number, name: string): Promise<Img> {
  const settings = resolveExportSettings(
    {
      preset: 'custom',
      width: p.canvas.width,
      height: p.canvas.height,
      fps: FPS,
      quality: 100,
      loudnessLufs: null,
      burnCaptions: true,
    },
    p.canvas,
  );
  const dir = path.join(work, `x-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, 'out.mp4');
  const used: Record<string, EditorAssetFile> = {};
  for (const a of p.assets) used[a.id] = files[a.id] as EditorAssetFile;
  const compiled = await compiler.compile({
    project: p,
    settings,
    files: used,
    workDir: dir,
    outPath,
    fontsDir: path.join(ROOT, 'electron/main/assets/fonts'),
    encoder: 'libx264',
    range: { startSec: t, endSec: t + 1 / FPS },
    getStyle: (id) => styles.get(id) ?? (styles.get('clean-pop') as never),
    captions,
  });
  await media.runFfmpeg({
    ffmpegPath: FFMPEG,
    args: compiled.args,
    durationSec: compiled.durationSec,
  });
  const raw = ff([
    '-i',
    outPath,
    '-vf',
    'scale=in_range=tv:in_color_matrix=bt709:out_range=pc,format=rgba',
    '-frames:v',
    '1',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    '-',
  ]);
  return { w: p.canvas.width, h: p.canvas.height, data: Buffer.from(raw) };
}

async function previewFrame(p: Project, t: number): Promise<Img> {
  // The host's job: hand the compositor the frame each video item needs (here: decoded from the same file by FFmpeg).
  for (const req of await par('framesNeeded', p, t)) {
    if (files[req.assetId]?.kind === 'video')
      await par(
        'loadPng',
        req.assetId,
        videoFrame(req.assetId, Math.floor(req.srcSec * FPS + 0.009)),
      );
  }
  const r = await par('render', p, t);
  expect(r.missing).toEqual([]);
  return { w: r.w, h: r.h, data: Buffer.from(r.b64, 'base64') };
}

/* ------------------------------------------------------------------ comparison -------------------- */

interface Metrics {
  mae: number;
  p99: number;
  psnr: number;
  bad: number;
}
function compare(a: Img, b: Img): Metrics {
  const n = a.w * a.h;
  const hist = new Uint32Array(256);
  let sum = 0;
  let sq = 0;
  let bad = 0;
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs((a.data[i * 4 + c] as number) - (b.data[i * 4 + c] as number));
      sum += d;
      sq += d * d;
      if (d > m) m = d;
    }
    hist[m] = (hist[m] as number) + 1;
    if (m > 32) bad++;
  }
  let acc = 0;
  let p99 = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v] as number;
    if (acc >= n * 0.99) {
      p99 = v;
      break;
    }
  }
  const mse = sq / (n * 3);
  return {
    mae: sum / (n * 3),
    p99,
    psnr: mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse),
    bad: bad / n,
  };
}

function sheet(name: string, exp: Img, pre: Img): void {
  const gap = 4;
  const w = exp.w * 3 + gap * 4;
  const out = Buffer.alloc(w * (exp.h + gap * 2) * 4, 60);
  const put = (im: Img, x0: number, diff: boolean, other?: Img) => {
    for (let y = 0; y < im.h; y++)
      for (let x = 0; x < im.w; x++) {
        const s = (y * im.w + x) * 4;
        const d = ((y + gap) * w + x0 + x) * 4;
        for (let c = 0; c < 3; c++) {
          out[d + c] = diff
            ? Math.min(
                255,
                Math.abs((im.data[s + c] as number) - ((other as Img).data[s + c] as number)) * 6,
              )
            : (im.data[s + c] as number);
        }
        out[d + 3] = 255;
      }
  };
  put(exp, gap, false);
  put(pre, gap * 2 + exp.w, false);
  put(exp, gap * 3 + exp.w * 2, true, pre);
  writePng(path.join(OUT, `${name}.png`), { w, h: exp.h + gap * 2, data: out });
}

const results: { name: string; m: Metrics; tol: Tol }[] = [];
interface Tol {
  mae: number;
  psnr: number;
}
const TIGHT: Tol = { mae: 2.5, psnr: 24 };

async function parity(name: string, p: Project, t: number, tol: Tol = TIGHT): Promise<Metrics> {
  const [exp, pre] = await Promise.all([exportFrame(p, t, name), previewFrame(p, t)]);
  sheet(name, exp, pre);
  const m = compare(exp, pre);
  results.push({ name, m, tol });
  console.log(
    `[parity] ${name.padEnd(28)} MAE ${m.mae.toFixed(2)}  p99 ${m.p99}  PSNR ${m.psnr.toFixed(1)} dB  >32: ${(m.bad * 100).toFixed(2)}%`,
  );
  expect(m.mae, `${name}: mean abs error`).toBeLessThanOrEqual(tol.mae);
  expect(m.psnr, `${name}: PSNR`).toBeGreaterThanOrEqual(tol.psnr);
  return m;
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  fs.mkdirSync(OUT, { recursive: true });
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'clipfern-parity-'));
  makeMedia();
  const out = await build({
    entryPoints: [path.join(__dirname, 'support/editor-parity-page.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    alias: { '@shared': path.join(ROOT, 'shared') },
    logLevel: 'silent',
  });
  browser = await chromium.launch({
    executablePath: CHROME,
    args: [
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--use-gl=angle',
    ],
  });
  page = await (await browser.newContext({ viewport: { width: 800, height: 600 } })).newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.route('http://par.test/**', async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname.startsWith('/fonts/'))
      return route.fulfill({
        path: path.join(FONT_DIR, path.basename(u.pathname)),
        contentType: 'font/ttf',
      });
    return route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><body></body></html>',
    });
  });
  await page.goto('http://par.test/index.html');
  await page.addScriptTag({ content: (out.outputFiles[0] as { text: string }).text });
  await par('init', 'http://par.test/fonts/');
  for (const [id, f] of Object.entries(files))
    if (f.kind === 'image') await par('loadPng', id, fs.readFileSync(f.path).toString('base64'));
});

test.afterAll(async () => {
  await browser?.close();
  fs.writeFileSync(path.join(OUT, 'metrics.json'), JSON.stringify(results, null, 2));
  expect(problems).toEqual([]);
  fs.rmSync(work, { recursive: true, force: true });
});

const A = (id: string) =>
  asset(
    id,
    files[id]?.width ?? CW,
    files[id]?.height ?? CH,
    files[id]?.kind === 'video' ? 'video' : 'image',
    files[id]?.durationSec ?? 10,
  );

test.describe('pipeline calibration', () => {
  test('a flat colour survives preview and export (colour range / matrix agree)', async () => {
    await parity(
      'calibration-flat',
      project([track('v', 'video', [image('a', 'base', 0, 2)])], [A('base')]),
      0.5,
      { mae: 1.5, psnr: 38 },
    );
  });
  test('a detailed picture at native size (no scaling)', async () => {
    await parity(
      'calibration-detail',
      project([track('v', 'video', [image('a', 'tall', 0, 2)])], [A('tall')]),
      0.5,
      { mae: 2.5, psnr: 24 },
    );
  });
});

test.describe('geometry', () => {
  test('cover: wide picture on a tall canvas', async () => {
    await parity(
      'cover',
      project([track('v', 'video', [image('a', 'bars', 0, 2)])], [A('bars')]),
      1,
    );
  });
  test('contain with blurred background fill', async () => {
    await parity(
      'contain-bgblur',
      project(
        [track('v', 'video', [image('a', 'bars', 0, 2, { fit: 'contain', backgroundBlur: true })])],
        [A('bars')],
      ),
      1,
      { mae: 4, psnr: 24 },
    );
  });
  test('native size, centred on the canvas background', async () => {
    await parity(
      'native',
      project([track('v', 'video', [image('a', 'small', 0, 2, { fit: 'native' })])], [A('small')], {
        background: '#203040',
      }),
      1,
    );
  });
  test('translate + scale + rotate + opacity over a background colour', async () => {
    await parity(
      'transform',
      project(
        [
          track('v', 'video', [
            image('a', 'bars', 0, 2, {
              transform: {
                x: { v: 30 },
                y: { v: -60 },
                scale: { v: 0.6 },
                rotation: { v: 20 },
                opacity: { v: 0.85 },
              },
            }),
          ]),
        ],
        [A('bars')],
        { background: '#203040' },
      ),
      1,
      { mae: 4, psnr: 24 },
    );
  });
  test('crop region + mirror', async () => {
    await parity(
      'crop-mirror',
      project(
        [
          track('v', 'video', [
            image('a', 'bars', 0, 2, {
              mirror: true,
              crop: { x: { v: 0.1 }, y: { v: 0.1 }, w: { v: 0.6 }, h: { v: 0.6 } },
            }),
          ]),
        ],
        [A('bars')],
      ),
      1,
    );
  });
  test('keyframed crop (a reframe path) and keyframed transform at mid-animation', async () => {
    const kf = (t: number, v: number) => ({ t, v, ease: 'linear' as const });
    await parity(
      'crop-keyframes',
      project(
        [
          track('v', 'video', [
            image('a', 'bars', 0, 2, {
              crop: { x: { v: 0, kf: [kf(0, 0), kf(2, 0.36)] }, w: { v: 0.5625 }, h: { v: 1 } },
            }),
          ]),
        ],
        [A('bars')],
      ),
      1,
    );
    await parity(
      'transform-keyframes',
      project(
        [
          track('v', 'video', [
            image('a', 'tall', 0, 2, {
              fit: 'contain',
              transform: {
                x: { v: 0, kf: [kf(0, -100), kf(2, 100)] },
                scale: { v: 1, kf: [kf(0, 0.4), kf(2, 0.8)] },
                rotation: { v: 0, kf: [kf(0, -10), kf(2, 10)] },
              },
            }),
          ]),
        ],
        [A('tall')],
        { background: '#101820' },
      ),
      1,
      { mae: 4, psnr: 24 },
    );
  });
});

test.describe('colour, blur, fades, blend', () => {
  test('exposure / contrast / saturation / temperature', async () => {
    await parity(
      'colour',
      project(
        [
          track('v', 'video', [
            image('a', 'bars', 0, 2, {
              color: {
                exposure: { v: 0.3 },
                contrast: { v: 0.2 },
                saturation: { v: -0.3 },
                temperature: { v: 0.4 },
              },
            }),
          ]),
        ],
        [A('bars')],
      ),
      1,
      { mae: 3.5, psnr: 24 },
    );
  });
  test('filter preset (vivid) and mono', async () => {
    await parity(
      'filter-vivid',
      project(
        [track('v', 'video', [image('a', 'bars', 0, 2, { color: { filter: 'vivid' } })])],
        [A('bars')],
      ),
      1,
      { mae: 3.5, psnr: 24 },
    );
    await parity(
      'filter-mono',
      project(
        [track('v', 'video', [image('a', 'bars', 0, 2, { color: { filter: 'mono' } })])],
        [A('bars')],
      ),
      1,
      { mae: 3.5, psnr: 24 },
    );
  });
  test('gaussian blur (sigma in canvas px)', async () => {
    await parity(
      'blur',
      project([track('v', 'video', [image('a', 'tall', 0, 2, { blur: { v: 4 } })])], [A('tall')]),
      1,
      { mae: 3.5, psnr: 24 },
    );
  });
  test('fade-in alpha over the background', async () => {
    await parity(
      'fade',
      project([track('v', 'video', [image('a', 'tall', 0, 4, { fadeInSec: 2 })])], [A('tall')], {
        background: '#203040',
      }),
      0.5,
    );
  });
  for (const mode of ['multiply', 'screen', 'overlay', 'add', 'darken', 'lighten']) {
    test(`blend mode ${mode}`, async () => {
      await parity(
        `blend-${mode}`,
        project(
          [
            track('v', 'video', [image('a', 'tall', 0, 2)]),
            track('o', 'overlay', [
              image('b', 'grad', 0, 2, { blend: mode, transform: { opacity: { v: 0.8 } } }),
            ]),
          ],
          [A('tall'), A('grad')],
        ),
        1,
        { mae: 4, psnr: 24 },
      );
    });
  }
  test('layer order, hidden track not drawn', async () => {
    await parity(
      'layers',
      project(
        [
          track('v', 'video', [image('a', 'tall', 0, 2)]),
          track('o', 'overlay', [
            image('b', 'small', 0, 2, {
              fit: 'contain',
              transform: { scale: { v: 0.5 }, y: { v: 150 } },
            }),
          ]),
          track('h', 'overlay', [image('c', 'red', 0, 2)], { hidden: true }),
        ],
        [A('tall'), A('small'), A('red')],
      ),
      1,
    );
  });
});

test.describe('transitions (overlap model)', () => {
  const two = (type: string) =>
    project(
      [
        track('v', 'video', [
          image('a', 'bars', 0, 2),
          image('b', 'tall', 1, 2, { transitionIn: { type, durationSec: 1 } }),
        ]),
      ],
      [A('bars'), A('tall')],
    );
  for (const [type, t] of [
    ['crossfade', 1.5],
    ['dip-black', 1.25],
    ['dip-white', 1.75],
    ['slide-left', 1.4],
    ['slide-right', 1.6],
    ['slide-up', 1.3],
    ['slide-down', 1.5],
    ['zoom', 1.5],
  ] as const) {
    test(`${type} at p=${(t - 1).toFixed(2)}`, async () => {
      await parity(`transition-${type}`, two(type), t, { mae: 6, psnr: 24 });
    });
  }
});

test.describe('shapes, text and subtitles', () => {
  test('rect with radius + stroke, ellipse, progress bar, line, arrow', async () => {
    const p = project(
      [
        track('v', 'video', [image('a', 'tall', 0, 2)]),
        track('s1', 'overlay', [
          shape('r', 'rect', 0, 2, {
            width: 200,
            height: 80,
            fill: '#FFCC00',
            radius: 20,
            stroke: { color: '#000000', width: 6 },
            transform: { y: { v: -200 } },
          }),
        ]),
        track('s2', 'overlay', [
          shape('e', 'ellipse', 0, 2, {
            width: 120,
            height: 120,
            fill: '#00CCAA',
            transform: { x: { v: -90 }, y: { v: 20 } },
          }),
        ]),
        track('s3', 'overlay', [
          shape('p', 'progress-bar', 0, 2, {
            width: 300,
            height: 16,
            fill: '#FFFFFF',
            radius: 8,
            transform: { y: { v: 260 } },
          }),
        ]),
      ],
      [A('tall')],
    );
    await parity('shapes', p, 1, { mae: 3.5, psnr: 24 });
  });
  test('text with outline and a boxed title (libass vs canvas text: structural tolerance)', async () => {
    const p = project(
      [
        track('v', 'video', [image('a', 'tall', 0, 3)]),
        track('t1', 'text', [
          text('t1', 'Hello parity', 0, 3, {
            style: {
              fontFamily: 'Montserrat',
              weight: 800,
              size: 54,
              color: '#FFFFFF',
              stroke: { color: '#000000', width: 6 },
            },
            transform: { y: { v: -150 } },
          }),
        ]),
        track('t2', 'text', [
          text('t2', 'Boxed title', 0, 3, {
            style: {
              fontFamily: 'Poppins',
              weight: 700,
              size: 40,
              color: '#101114',
              box: { color: '#FFFFFF', opacity: 1, padding: 16, radius: 14 },
            },
            transform: { y: { v: 150 } },
          }),
        ]),
      ],
      [A('tall')],
    );
    await parity('text', p, 1.5, { mae: 5, psnr: 22 });
  });
  test('subtitle cue, Clean Pop, active word', async () => {
    const p = project(
      [
        track('v', 'video', [image('a', 'tall', 0, 3)]),
        track('s', 'subtitle', [
          subtitle(
            'c',
            [
              { w: 'THIS', s: 0, e: 0.5 },
              { w: 'IS', s: 0.5, e: 0.9 },
              { w: 'PARITY', s: 0.9, e: 1.6 },
            ],
            0.5,
            2,
          ),
        ]),
      ],
      [A('tall')],
    );
    await parity('subtitle', p, 1.6, { mae: 5, psnr: 22 });
  });
});

test.describe('video: source time (speed, reverse, freeze, ramp) and reframe path', () => {
  test('plain, 2× speed with in-point, reverse, freeze frame', async () => {
    const mk = (extra: Record<string, unknown>) =>
      project([track('v', 'video', [video('a', 'vid2', 0, 2, extra)])], [A('vid2')]);
    await parity('video-plain', mk({}), 1, { mae: 3, psnr: 24 });
    await parity('video-speed2x', mk({ speed: 2, inSec: 1 }), 0.8, { mae: 3, psnr: 24 });
    await parity('video-reverse', mk({ reverse: true, inSec: 1 }), 0.5, { mae: 3, psnr: 24 });
    await parity('video-freeze', mk({ freezeAtSec: 2.5 }), 1.2, { mae: 3, psnr: 24 });
  });
  test('speed ramp', async () => {
    const kf = (t: number, v: number) => ({ t, v, ease: 'linear' as const });
    await parity(
      'video-ramp',
      project(
        [track('v', 'video', [video('a', 'vid2', 0, 2, { speedCurve: [kf(0, 1), kf(2, 3)] })])],
        [A('vid2')],
      ),
      1.5,
      { mae: 3, psnr: 24 },
    );
  });
  test('a face-tracking style crop path over video, with colour', async () => {
    const kf = (t: number, v: number) => ({ t, v, ease: 'linear' as const });
    await parity(
      'video-reframe',
      project(
        [
          track('v', 'video', [
            video('a', 'vid', 0, 3, {
              crop: { x: { v: 0, kf: [kf(0, 0.05), kf(3, 0.4)] }, w: { v: 0.5625 }, h: { v: 1 } },
              color: { contrast: { v: 0.1 } },
            }),
          ]),
        ],
        [A('vid')],
      ),
      1.5,
      { mae: 3.5, psnr: 24 },
    );
  });
});

test('summary: every scenario within its tolerance, report written', async () => {
  const worst = [...results].sort((a, b) => b.m.mae - a.m.mae).slice(0, 5);
  console.log(
    '[parity] worst 5 by MAE:',
    worst.map((r) => `${r.name} ${r.m.mae.toFixed(2)}`).join(', '),
  );
  expect(results.length).toBeGreaterThanOrEqual(36);
  void execFileSync;
});
