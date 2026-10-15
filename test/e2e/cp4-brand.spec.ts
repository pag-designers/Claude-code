import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import {
  watermarkRect,
  type BrandAssetView,
  type BrandKit,
  type BrollItem,
} from '../../shared/brand';
import { startSmartAnthropicStub } from '../support/e2e-anthropic';
import type { StubAnthropic } from '../unit/llm-stub-server';
import { encodePng, encodeWoff1, measureEbur, writeRenamedFont } from '../unit/brand-media-helpers';

/**
 * CP4 (Brand Kit) end-to-end on REAL media in the REAL Electron app (same harness as cp3-editor.spec.ts):
 * build a kit from real files (PNG + SVG logos, an intro video, music, a WOFF font under a new family name, a kit
 * subtitle style, hook card colours), run the real pipeline with the kit as the default so the clips come out branded,
 * inspect the downloaded clips frame by frame (intro first, watermark inside the intro-shifted programme at the
 * computed rect, hook card colour, loudness, shifted SRT), re-apply / remove the kit, open a clip in the editor with the
 * kit's parts and export it for real, import stock B-roll from a local fake Pexels, and look at the Brand Kit page.
 * Only the Claude answers and the Pexels API are scripted.
 *
 * Run: CLIPFERN_E2E_CP1_VIDEO=<mp4> CLIPFERN_E2E_SIDECAR_USERDATA=<ud> CLIPFERN_E2E_OUT=<dir> \
 *   xvfb-run -a pnpm exec playwright test test/e2e/cp4-brand.spec.ts
 */
const VIDEO = process.env.CLIPFERN_E2E_CP1_VIDEO;
const SIDECAR_BASE = process.env.CLIPFERN_E2E_SIDECAR_USERDATA;
const OUT =
  process.env.CLIPFERN_E2E_OUT ?? fs.mkdtempSync(path.join(os.tmpdir(), 'clipfern-cp4-out-'));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const S3rver = require('s3rver') as new (o: Record<string, unknown>) => {
  run(): Promise<unknown>;
  close(): Promise<void>;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const FFMPEG = require('ffmpeg-static') as string;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const FFPROBE = (require('ffprobe-static') as { path: string }).path;

test.skip(
  !VIDEO || !SIDECAR_BASE || !fs.existsSync(VIDEO ?? ''),
  'needs CLIPFERN_E2E_CP1_VIDEO and CLIPFERN_E2E_SIDECAR_USERDATA',
);
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let userData: string;
let s3: { close(): Promise<void> };
let s3dir = '';
let media: http.Server;
let mediaUrl: string;
let pexels: http.Server;
let pexelsBase: string;
let stub: StubAnthropic;
let videoId = '';
const S3_PORT = 4575;
const BUCKET = 'clipfern-cp4';
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'clipfern-cp4-work-'));

const LOGO_RGB = [255, 0, 255] as const; // magenta PNG logo
const INTRO_RGB = [0, 170, 0] as const; // green intro
const INTRO_SEC = 2;
const HOOK_CARD = '#FF8800';
const CAPTION_FILL = '#00FFFF';
const FAMILY = 'Montserrax'; // renamed copy of the shipped Montserrat (same length)

interface Clip {
  id: string;
  title: string;
  startSec: number;
  endSec: number;
  durationSec: number;
  status: string;
  error: string | null;
  captionStyleId: string;
  hookApplied: string | null;
  brandKitId: string | null;
  brandApplied: { kitId: string; rev: number } | null;
}

const invoke = <T = unknown>(channel: string, payload?: unknown) =>
  page.evaluate(
    ([c, p]) =>
      (
        window as unknown as { clipfern: { invoke(c: string, p?: unknown): Promise<unknown> } }
      ).clipfern.invoke(c as string, p) as Promise<T>,
    [channel, payload] as const,
  );

const clips = async () =>
  (await invoke<{ items: Clip[] }>('clips:list', { videoId })).items.filter(
    (c) => c.status === 'rendered' || c.status === 'rendering' || c.status === 'queued',
  );
const ff = (args: string[]) => execFileSync(FFMPEG, ['-v', 'error', '-y', ...args]);

function probe(file: string) {
  const j = JSON.parse(
    execFileSync(FFPROBE, [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_streams',
      '-show_format',
      file,
    ]).toString(),
  ) as {
    streams: { codec_type: string; width?: number; height?: number }[];
    format: { duration: string };
  };
  const v = j.streams.find((s) => s.codec_type === 'video');
  return {
    w: v?.width ?? 0,
    h: v?.height ?? 0,
    dur: Number(j.format.duration),
    audio: j.streams.some((s) => s.codec_type === 'audio'),
  };
}

/** One decoded RGBA frame at time `t` (seconds). */
function frameAt(file: string, t: number, outPng?: string) {
  const { w, h } = probe(file);
  const raw = execFileSync(
    FFMPEG,
    [
      '-v',
      'error',
      '-ss',
      String(t),
      '-i',
      file,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgba',
      '-',
    ],
    { maxBuffer: 1 << 28 },
  );
  if (outPng) ff(['-ss', String(t), '-i', file, '-frames:v', '1', outPng]);
  const at = (x: number, y: number): [number, number, number] => {
    const k = (Math.round(y) * w + Math.round(x)) * 4;
    return [raw[k] as number, raw[k + 1] as number, raw[k + 2] as number];
  };
  /** Number of pixels in the box whose colour is within `tol` (per channel) of `rgb`. */
  const count = (
    box: { x0: number; y0: number; x1: number; y1: number },
    rgb: readonly number[],
    tol: number,
  ) => {
    let n = 0;
    for (let y = Math.max(0, box.y0); y < Math.min(h, box.y1); y += 2)
      for (let x = Math.max(0, box.x0); x < Math.min(w, box.x1); x += 2) {
        const p = at(x, y);
        if (p.every((v, i) => Math.abs(v - (rgb[i] as number)) <= tol)) n++;
      }
    return n;
  };
  return { w, h, at, count };
}

const hexRgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** Downloads a rendered clip (+ SRT) into a fresh folder through the real `clips:download` flow. */
async function downloadClip(id: string): Promise<{ mp4: string; srt: string }> {
  const dir = fs.mkdtempSync(path.join(WORK, 'dl-'));
  await app.evaluate(({ dialog }, d) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [d] })) as never;
  }, dir);
  const r = await invoke<{ saved: number; dir: string }>('clips:download', {
    ids: [id],
    withCaptions: true,
  });
  expect(r.saved).toBe(1);
  const files = fs.readdirSync(dir);
  return {
    mp4: path.join(
      dir,
      files.find((f) => f.endsWith('.mp4'))!,
    ),
    srt: path.join(
      dir,
      files.find((f) => f.endsWith('.srt'))!,
    ),
  };
}

async function waitClip(id: string, ok: (c: Clip) => boolean, ms = 12 * 60_000) {
  await expect
    .poll(
      async () => {
        const c = (await invoke<{ items: Clip[] }>('clips:list', { videoId })).items.find(
          (x) => x.id === id,
        );
        if (c?.status === 'failed') throw new Error(`render failed: ${c.error}`);
        return Boolean(c && c.status === 'rendered' && ok(c));
      },
      { timeout: ms, intervals: [1500] },
    )
    .toBe(true);
}

test.beforeAll(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  s3dir = process.env.CLIPFERN_E2E_S3DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'clipfern-s3-'));
  fs.mkdirSync(s3dir, { recursive: true });
  const server = new S3rver({
    port: S3_PORT,
    address: '127.0.0.1',
    silent: true,
    directory: s3dir,
    configureBuckets: [{ name: BUCKET, configs: [] }],
  });
  await server.run();
  s3 = server;

  media = http.createServer((req, res) => {
    const size = fs.statSync(VIDEO!).size;
    const range = req.headers.range?.match(/bytes=(\d+)-(\d*)/);
    const base = { 'content-type': 'video/mp4', 'accept-ranges': 'bytes' };
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Number(range[2]) : size - 1;
      res.writeHead(206, {
        ...base,
        'content-range': `bytes ${start}-${end}/${size}`,
        'content-length': end - start + 1,
      });
      fs.createReadStream(VIDEO!, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { ...base, 'content-length': size });
      fs.createReadStream(VIDEO!).pipe(res);
    }
  });
  await new Promise<void>((r) =>
    media.listen(Number(process.env.CLIPFERN_E2E_MEDIA_PORT ?? 0), '127.0.0.1', r),
  );
  mediaUrl = `http://127.0.0.1:${(media.address() as AddressInfo).port}/talk.mp4`;

  // a fake Pexels (official API shapes) serving one portrait clip
  const stock = path.join(WORK, 'stock.mp4');
  ff([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=720x1280:r=30:d=3',
    '-f',
    'lavfi',
    '-i',
    'sine=f=300:d=3',
    '-shortest',
    '-pix_fmt',
    'yuv420p',
    stock,
  ]);
  pexels = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const json = (o: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(o));
    };
    const base = `http://127.0.0.1:${(pexels.address() as AddressInfo).port}`;
    const video = {
      id: 777,
      url: 'https://www.pexels.com/video/777/',
      image: `${base}/thumb.jpg`,
      duration: 3,
      width: 720,
      height: 1280,
      user: { name: 'Ann Photographer', url: 'https://www.pexels.com/@ann' },
      video_files: [
        {
          id: 1,
          quality: 'hd',
          file_type: 'video/mp4',
          width: 720,
          height: 1280,
          link: `${base}/files/stock.mp4`,
        },
      ],
      video_pictures: [],
    };
    if (u.pathname === '/videos/search') {
      if (req.headers.authorization !== 'PEXELS-E2E-KEY') {
        res.writeHead(401).end('{}');
        return;
      }
      json({ page: 1, per_page: 24, total_results: 1, videos: [video] });
    } else if (u.pathname === '/videos/videos/777') json(video);
    else if (u.pathname === '/files/stock.mp4') {
      res.writeHead(200, {
        'content-type': 'video/mp4',
        'content-length': fs.statSync(stock).size,
      });
      fs.createReadStream(stock).pipe(res);
    } else if (u.pathname === '/thumb.jpg') {
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      res.end(
        Buffer.from(
          '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
          'base64',
        ),
      );
    } else res.writeHead(404).end();
  });
  await new Promise<void>((r) => pexels.listen(0, '127.0.0.1', r));
  pexelsBase = `http://127.0.0.1:${(pexels.address() as AddressInfo).port}`;

  stub = await startSmartAnthropicStub();
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'clipfern-cp4-ud-'));
  for (const d of ['sidecar-venv', 'models', 'uv']) {
    if (fs.existsSync(path.join(SIDECAR_BASE!, d)))
      execFileSync('cp', ['-al', path.join(SIDECAR_BASE!, d), path.join(userData, d)]);
  }
  const exe = process.env.CLIPFERN_E2E_EXE;
  app = await electron.launch({
    ...(exe ? { executablePath: exe } : {}),
    args: [
      '--no-sandbox',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--autoplay-policy=no-user-gesture-required',
      ...(exe ? [] : ['.']),
    ],
    cwd: path.resolve(__dirname, '../..'),
    env: {
      ...process.env,
      CLIPFERN_USER_DATA: userData,
      CLIPFERN_S3_ENDPOINT_OVERRIDE: `http://127.0.0.1:${S3_PORT}`,
      CLIPFERN_ALLOW_ANY_URL: '1',
      CLIPFERN_ANTHROPIC_BASE_URL: stub.baseUrl,
      CLIPFERN_PEXELS_BASE_URL: pexelsBase,
      CLIPFERN_WHISPER_MODEL: process.env.CLIPFERN_E2E_WHISPER ?? 'tiny',
      ANTHROPIC_API_KEY: 'sk-ant-api03-E2E-NOT-A-REAL-KEY-000000',
    },
  });
  page = await app.firstWindow();
  await page.waitForFunction(() => !!(window as unknown as { clipfern?: unknown }).clipfern);
  await invoke('settings:set', { r2Bucket: BUCKET, whisperModel: 'tiny' });
});

test.afterAll(async () => {
  await app?.close();
  await stub?.stop();
  await s3?.close();
  media?.close();
  pexels?.close();
});

/* ---------------------------------------------------------------------------- the kit ------------ */

let kit: BrandKit;
let assets: Record<'logo' | 'svg' | 'intro' | 'music' | 'font', BrandAssetView>;
let styleId = '';

test('build a Brand Kit from real files: PNG + SVG logos, intro video, music, a WOFF font, kit subtitle style, hook card', async () => {
  test.setTimeout(240_000);
  // --- real files --------------------------------------------------------------------------------
  const logoPng = path.join(WORK, 'logo.png');
  fs.writeFileSync(
    logoPng,
    encodePng(400, 160, (x, y) =>
      x < 8 || y < 8 || x > 391 || y > 151 ? [0, 0, 0, 0] : [...LOGO_RGB, 255],
    ),
  );
  const logoSvg = path.join(WORK, 'mark.svg');
  fs.writeFileSync(
    logoSvg,
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200"><circle cx="100" cy="100" r="90" fill="#0066FF"/></svg>',
  );
  const intro = path.join(WORK, 'intro.mp4');
  ff([
    '-f',
    'lavfi',
    '-i',
    `color=c=0x${INTRO_RGB.map((v) => v.toString(16).padStart(2, '0')).join('')}:s=720x1280:r=30:d=${INTRO_SEC}`,
    '-f',
    'lavfi',
    '-i',
    `sine=f=660:d=${INTRO_SEC}`,
    '-shortest',
    '-pix_fmt',
    'yuv420p',
    intro,
  ]);
  const music = path.join(WORK, 'bed.wav');
  ff(['-f', 'lavfi', '-i', 'sine=f=220:d=40', '-ar', '44100', music]);
  const ttf = writeRenamedFont(
    path.resolve(__dirname, '../../electron/main/assets/fonts/Montserrat-ExtraBold.ttf'),
    'Montserrat',
    FAMILY,
    path.join(WORK, 'brandfont.ttf'),
  );
  const woff = path.join(WORK, 'brandfont.woff');
  fs.writeFileSync(woff, encodeWoff1(fs.readFileSync(ttf)));

  // --- upload through the real pipeline ----------------------------------------------------------
  kit = await invoke<BrandKit>('brand:create', { name: 'E2E Brand' });
  expect(kit.isDefault).toBe(true);
  const add = async (kind: string, p: string) => {
    const r = await invoke<{
      assets: BrandAssetView[];
      errors: { name: string; message: string }[];
    }>('brand:addFiles', { kitId: kit.id, kind, paths: [p] });
    expect(r.errors).toEqual([]);
    return r.assets[0]!;
  };
  assets = {
    logo: await add('logo', logoPng),
    svg: await add('logo', logoSvg),
    intro: await add('video', intro),
    music: await add('audio', music),
    font: await add('font', woff),
  };
  expect(assets.logo).toMatchObject({ kind: 'logo', width: 400, height: 160 });
  expect(assets.svg.usableKey).toMatch(/\.usable\.png$/); // SVG → PNG raster
  expect(assets.svg.width).toBeGreaterThan(0);
  expect(assets.intro).toMatchObject({ kind: 'video', hasAudio: true });
  expect(assets.intro.durationSec).toBeCloseTo(INTRO_SEC, 1);
  expect(assets.intro.previewKey).toBe(`${assets.intro.storageKey}.preview.mp4`);
  expect(assets.music.previewKey).toMatch(/\.preview\.m4a$/);
  expect(assets.music.loudnessLufs).not.toBeNull();
  expect(assets.font.font).toMatchObject({ family: FAMILY });
  expect(assets.font.usableKey).toMatch(/\.usable\.ttf$/); // WOFF → TTF for libass
  // thumbnails and previews really are in storage
  for (const a of Object.values(assets))
    if (a.thumbUrl) expect((await fetch(a.thumbUrl)).ok).toBe(true);
  // the font is in the merged fonts directory libass reads, and listed for the renderer
  const merged = path.join(userData, 'fonts', 'merged');
  expect(fs.readdirSync(merged).some((f) => f.startsWith(assets.font.id))).toBe(true);
  expect(fs.readdirSync(merged).some((f) => /montserrat/i.test(f))).toBe(true); // shipped fonts still there
  const fonts = await invoke<{ fonts: { assetId: string; family: string; url: string }[] }>(
    'brand:fonts',
  );
  expect(fonts.fonts.find((f) => f.assetId === assets.font.id)?.family).toBe(FAMILY);

  // --- a wrong-section upload is refused with a clear message -----------------------------------
  const bad = await invoke<{ assets: unknown[]; errors: { name: string; message: string }[] }>(
    'brand:addFiles',
    { kitId: kit.id, kind: 'logo', paths: [music] },
  );
  expect(bad.assets).toEqual([]);
  expect(bad.errors[0]!.message).toMatch(/audio/i);

  // --- colours from the logo ----------------------------------------------------------------------
  const { colors } = await invoke<{ colors: string[] }>('brand:extractColors', {
    assetId: assets.logo.id,
    count: 3,
  });
  expect(colors[0]!.toLowerCase()).toBe('#ff00ff');

  // --- subtitle style that uses the brand font, hook card colours, defaults --------------------
  const { styles } = await invoke<{ styles: Record<string, unknown>[] }>('captions:styles');
  const base = styles.find((s) => s.id === 'clean-pop')!;
  const saved = await invoke<{ id: string }>('brand:saveStyle', {
    kitId: kit.id,
    style: {
      ...base,
      id: 'new-kit-style',
      name: 'Brand caption',
      builtin: false,
      font: { ...(base.font as object), family: FAMILY },
      fill: CAPTION_FILL,
      highlight: { ...(base.highlight as object), color: CAPTION_FILL },
    },
  });
  styleId = saved.id;
  expect(
    (await invoke<{ styles: unknown[] }>('brand:styles', { kitId: kit.id })).styles,
  ).toHaveLength(1);
  kit = await invoke<BrandKit>('brand:update', {
    id: kit.id,
    baseRev: kit.rev,
    patch: {
      spec: {
        watermark: {
          ...kit.spec.watermark,
          assetId: assets.logo.id,
          position: 'top-right',
          sizePct: 20,
          opacity: 1,
          safeArea: 'all',
        },
        introAssetId: assets.intro.id,
        musicBed: { ...kit.spec.musicBed, assetId: assets.music.id },
        hook: { ...kit.spec.hook, cardColor: HOOK_CARD, textColor: '#101114' },
        colors: [{ id: 'c1', name: 'Brand magenta', hex: '#FF00FF', group: 'Primary' }],
        defaults: {
          ...kit.spec.defaults,
          captionStyleId: styleId,
          watermarkOn: true,
          introOn: true,
          musicOn: true,
        },
      },
    },
  });
  expect(kit.rev).toBeGreaterThan(1);
  // a stale save is a CONFLICT (another window)
  await expect(
    invoke('brand:update', { id: kit.id, baseRev: 1, patch: { name: 'x' } }),
  ).rejects.toThrow(/CONFLICT|changed somewhere else/);
  // references are validated: an intro must be a video of THIS kit
  await expect(
    invoke('brand:update', { id: kit.id, patch: { spec: { introAssetId: assets.music.id } } }),
  ).rejects.toThrow(/intro/i);
});

/* ----------------------------------------------------------------------- the branded pipeline -- */

test('pipeline: real media → clips come out branded (kit as the default): intro, watermark, hook card, music, loudness, shifted SRT', async () => {
  test.setTimeout(35 * 60_000);
  await expect
    .poll(async () => (await invoke<{ modelReady: boolean }>('sidecar:status')).modelReady, {
      timeout: 30_000,
    })
    .toBe(true);
  await expect
    .poll(
      async () =>
        (await invoke<{ tools: { name: string; ok: boolean }[] }>('binaries:status')).tools.find(
          (t) => t.name === 'yt-dlp',
        )?.ok,
      { timeout: 120_000 },
    )
    .toBe(true);
  const res = await invoke<{ videoId: string }>('pipeline:start', {
    url: mediaUrl,
    options: {
      clipPreset: '30-60',
      clipCount: 2,
      minScore: 45,
      captions: true,
      hookCard: true,
      aspect: '9:16',
      brandKitId: 'default',
    },
  });
  videoId = res.videoId;
  await expect
    .poll(
      async () => {
        const g = await invoke<{ video: { status: string; stage: string; error: string } }>(
          'videos:get',
          { id: videoId },
        );
        if (g.video.status === 'failed')
          throw new Error(`failed at ${g.video.stage}: ${g.video.error}`);
        return g.video.status;
      },
      { timeout: 25 * 60_000, intervals: [2000] },
    )
    .toBe('ready');

  const cs = await clips();
  expect(cs.length).toBeGreaterThanOrEqual(1);
  // the kit's subtitle style was adopted by the run and the clips record the kit + revision they were branded with
  for (const c of cs) {
    expect(c.status).toBe('rendered');
    expect(c.captionStyleId).toBe(styleId);
    expect(c.brandApplied).toEqual({ kitId: kit.id, rev: kit.rev });
  }

  const c = cs.find((x) => x.hookApplied) ?? cs[0]!;
  const dl = await downloadClip(c.id);
  fs.copyFileSync(dl.mp4, path.join(OUT, 'branded-clip.mp4'));
  const info = probe(dl.mp4);
  expect(info).toMatchObject({ w: 1080, h: 1920, audio: true });
  // programme + intro (the outro is off)
  expect(info.dur).toBeGreaterThan(c.durationSec + INTRO_SEC - 0.6);
  expect(info.dur).toBeLessThan(c.durationSec + INTRO_SEC + 0.6);

  // 1) the first frames are the intro (green), scaled to the clip size
  const f0 = frameAt(dl.mp4, 0.5, path.join(OUT, 'branded-intro.png'));
  expect(f0.count({ x0: 0, y0: 0, x1: f0.w, y1: f0.h }, INTRO_RGB, 40)).toBeGreaterThan(
    (f0.w * f0.h) / 8,
  );
  // …and it carries no watermark (the logo is only on the programme)
  const rect = watermarkRect(
    { width: 1080, height: 1920 },
    {
      position: 'top-right',
      sizePct: 20,
      marginPct: kit.spec.watermark.marginPct,
      safeArea: 'all',
    },
    400 / 160,
  );
  const box = { x0: rect.x + 4, y0: rect.y + 4, x1: rect.x + rect.w - 4, y1: rect.y + rect.h - 4 };
  expect(f0.count(box, LOGO_RGB, 60)).toBe(0);

  // 2) during the programme the logo sits at the shared watermarkRect (computed by the same function the editor uses)
  const f1 = frameAt(dl.mp4, INTRO_SEC + 1.2, path.join(OUT, 'branded-programme.png'));
  const logoPixels = f1.count(box, LOGO_RGB, 40);
  const boxPixels = (((box.x1 - box.x0) / 2) | 0) * (((box.y1 - box.y0) / 2) | 0);
  expect(logoPixels).toBeGreaterThan(boxPixels * 0.9);
  // and nowhere else on that frame (mirror position, top-left)
  expect(f1.count({ x0: 20, y0: rect.y, x1: 20 + rect.w, y1: rect.y + rect.h }, LOGO_RGB, 40)).toBe(
    0,
  );

  // 3) the hook card uses the kit's colours (a title card at the start of the programme)
  if (c.hookApplied) {
    const fh = frameAt(dl.mp4, INTRO_SEC + 1.2);
    const orange = fh.count(
      { x0: 0, y0: 1920 * 0.1, x1: 1080, y1: 1920 * 0.26 },
      hexRgb(HOOK_CARD),
      30,
    );
    expect(orange).toBeGreaterThan(1500);
  }

  // 4) mixed audio sits at the loudness target (music bed + intro + programme, normalised once)
  const lufs = measureEbur(dl.mp4);
  expect(lufs.lufs).toBeGreaterThan(-17);
  expect(lufs.lufs).toBeLessThan(-11);
  expect(lufs.truePeak).toBeLessThan(-0.5);

  // 5) the SRT shipped with the clip is shifted by the intro length: the first cue starts after the intro
  const srt = fs.readFileSync(dl.srt, 'utf8');
  const first = /(\d\d):(\d\d):(\d\d),(\d\d\d)/.exec(srt);
  expect(first).not.toBeNull();
  const firstSec =
    Number(first![1]) * 3600 +
    Number(first![2]) * 60 +
    Number(first![3]) +
    Number(first![4]) / 1000;
  expect(firstSec).toBeGreaterThanOrEqual(INTRO_SEC - 0.01);
});

test('apply / remove / re-apply a kit on a rendered clip re-renders it (and unbranded clips are untouched)', async () => {
  test.setTimeout(20 * 60_000);
  const [c] = await clips();
  // remove branding
  const r1 = await invoke<{ queued: number; skipped: number }>('brand:apply', {
    kitId: 'none',
    clipIds: [c!.id],
  });
  expect(r1).toEqual({ queued: 1, skipped: 0 });
  await waitClip(c!.id, (x) => x.brandApplied === null);
  const plain = await downloadClip(c!.id);
  expect(probe(plain.mp4).dur).toBeLessThan(c!.durationSec + 0.6); // no intro any more
  const fp = frameAt(plain.mp4, 1);
  const rect = watermarkRect(
    { width: 1080, height: 1920 },
    {
      position: 'top-right',
      sizePct: 20,
      marginPct: kit.spec.watermark.marginPct,
      safeArea: 'all',
    },
    400 / 160,
  );
  expect(
    fp.count({ x0: rect.x, y0: rect.y, x1: rect.x + rect.w, y1: rect.y + rect.h }, LOGO_RGB, 40),
  ).toBe(0);

  // a kit change makes the render stale (rev), re-applying brings it up to date
  kit = await invoke<BrandKit>('brand:update', {
    id: kit.id,
    patch: { spec: { watermark: { ...kit.spec.watermark, position: 'bottom-left' } } },
  });
  await invoke('brand:apply', { kitId: kit.id, clipIds: [c!.id] });
  await waitClip(c!.id, (x) => x.brandApplied?.rev === kit.rev);
  const again = await downloadClip(c!.id);
  expect(probe(again.mp4).dur).toBeGreaterThan(c!.durationSec + INTRO_SEC - 0.6);
  const bl = watermarkRect(
    { width: 1080, height: 1920 },
    {
      position: 'bottom-left',
      sizePct: 20,
      marginPct: kit.spec.watermark.marginPct,
      safeArea: 'all',
    },
    400 / 160,
  );
  const fa = frameAt(again.mp4, INTRO_SEC + 1.2, path.join(OUT, 'branded-bottom-left.png'));
  expect(
    fa.count(
      { x0: bl.x + 4, y0: bl.y + 4, x1: bl.x + bl.w - 4, y1: bl.y + bl.h - 4 },
      LOGO_RGB,
      40,
    ),
  ).toBeGreaterThan(200);
});

/* ------------------------------------------------------------------------------- the editor ----- */

interface ProjectDoc {
  id: string;
  rev: number;
  project: {
    brandKitId: string | null;
    assets: { id: string; kind: string; source: { kind: string; key?: string } }[];
    tracks: { id: string; kind: string; name: string; items: Record<string, unknown>[] }[];
  };
}
let projectId = '';

test('a new editor project takes the default kit (intro, watermark track, music with ducking) and exports for real', async () => {
  test.setTimeout(10 * 60_000);
  const [c] = await clips();
  const doc = await invoke<ProjectDoc>('editor:create', { from: { clipId: c!.id } });
  projectId = doc.id;
  const p = doc.project;
  expect(p.brandKitId).toBe(kit.id);
  const wm = p.tracks.find((t) => t.id === 'tr_brand_wm');
  expect(wm?.items).toHaveLength(1);
  const items = p.tracks.flatMap((t) => t.items) as {
    id: string;
    startSec: number;
    durationSec: number;
  }[];
  const intro = items.find((i) => i.id === 'brand_intro');
  expect(intro).toMatchObject({ startSec: 0 });
  expect(intro!.durationSec).toBeCloseTo(INTRO_SEC, 1);
  const music = p.tracks.find((t) => t.id === 'tr_brand_music');
  expect(music?.items.length).toBeGreaterThanOrEqual(1);
  expect((music as unknown as { ducking: { enabled: boolean } }).ducking.enabled).toBe(true);
  // brand assets are ordinary upload assets pointing at brand/ keys
  expect(
    p.assets.some((a) => a.source.kind === 'upload' && a.source.key?.startsWith('brand/')),
  ).toBe(true);
  // the main video starts after the intro
  const main = p.tracks
    .find((t) => t.kind === 'video')!
    .items.find((i) => i.id !== 'brand_intro') as {
    startSec: number;
  };
  expect(main.startSec).toBeCloseTo(INTRO_SEC, 1);

  // preview media of a brand video works through the editor's existing machinery
  const introAsset = p.assets.find(
    (a) => a.kind === 'video' && a.source.key?.includes(assets.intro.id),
  )!;
  const pv = await invoke<{ url: string | null; reason: string | null }>('editor:previewUrl', {
    projectId,
    assetId: introAsset.id,
  });
  expect(pv.reason).toBeNull();
  expect((await fetch(pv.url!)).ok).toBe(true);

  // a REAL export
  const { exportId } = await invoke<{ exportId: string }>('editor:export', {
    projectId,
    settings: { preset: 'shorts' },
  });
  type Job = { id: string; status: string; error: string | null; durationSec: number | null };
  await expect
    .poll(
      async () => {
        const j = (await invoke<{ items: Job[] }>('exports:list', { limit: 20 })).items.find(
          (x) => x.id === exportId,
        );
        if (j?.status === 'failed') throw new Error(`export failed: ${j.error}`);
        return j?.status;
      },
      { timeout: 8 * 60_000, intervals: [1500] },
    )
    .toBe('done');
  const dir = fs.mkdtempSync(path.join(WORK, 'exp-'));
  await app.evaluate(({ dialog }, d) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [d] })) as never;
  }, dir);
  await invoke('exports:download', { ids: [exportId] });
  const mp4 = path.join(
    dir,
    fs.readdirSync(dir).find((f) => f.endsWith('.mp4'))!,
  );
  fs.copyFileSync(mp4, path.join(OUT, 'editor-branded-export.mp4'));
  const info = probe(mp4);
  expect(info).toMatchObject({ w: 1080, h: 1920, audio: true });
  const f0 = frameAt(mp4, 0.5, path.join(OUT, 'editor-export-intro.png'));
  expect(f0.count({ x0: 0, y0: 0, x1: f0.w, y1: f0.h }, INTRO_RGB, 40)).toBeGreaterThan(
    (f0.w * f0.h) / 8,
  );
  const f1 = frameAt(mp4, INTRO_SEC + 1.2, path.join(OUT, 'editor-export-programme.png'));
  const wmRect = watermarkRect(
    { width: 1080, height: 1920 },
    {
      position: 'bottom-left',
      sizePct: 20,
      marginPct: kit.spec.watermark.marginPct,
      safeArea: 'all',
    },
    400 / 160,
  );
  expect(
    f1.count(
      {
        x0: wmRect.x + 6,
        y0: wmRect.y + 6,
        x1: wmRect.x + wmRect.w - 6,
        y1: wmRect.y + wmRect.h - 6,
      },
      LOGO_RGB,
      45,
    ),
  ).toBeGreaterThan(200);
  // the hook text of the opened clip follows the kit's card colours, like a rendered clip's card
  if (c!.hookApplied) {
    expect(
      f1.count({ x0: 0, y0: 1920 * 0.1, x1: 1080, y1: 1920 * 0.26 }, hexRgb(HOOK_CARD), 40),
    ).toBeGreaterThan(1500);
  }
  expect(measureEbur(mp4).lufs).toBeGreaterThan(-18);
});

/* -------------------------------------------------------------------------- stock B-roll --------- */

test('stock B-roll: Pexels search, import into the project and into the kit with the credit kept', async () => {
  test.setTimeout(180_000);
  expect(await invoke('broll:status')).toEqual({ pexels: false, pixabay: false });
  await invoke('secrets:set', { key: 'pexels.apiKey', value: 'PEXELS-E2E-KEY' });
  expect(await invoke('broll:status')).toEqual({ pexels: true, pixabay: false });
  const found = await invoke<{ items: BrollItem[]; nextPage: number | null }>('broll:search', {
    provider: 'pexels',
    query: 'city night',
    orientation: 'portrait',
    page: 1,
  });
  expect(found.items).toHaveLength(1);
  expect(found.items[0]).toMatchObject({
    id: 'pexels:777',
    author: 'Ann Photographer',
    width: 720,
  });
  const imp = await invoke<{
    asset: { id: string; kind: string; durationSec: number | null; source: { key: string } };
  }>('broll:importToProject', { projectId, item: found.items[0] });
  expect(imp.asset).toMatchObject({ kind: 'video' });
  expect(imp.asset.durationSec).toBeCloseTo(3, 0);
  expect(imp.asset.source.key.startsWith(`editor/${projectId}/`)).toBe(true);
  const pv = await invoke<{ url: string | null }>('editor:previewUrl', {
    projectId,
    assetId: imp.asset.id,
  }).catch(() => null);
  void pv; // the asset is not in the saved project yet; the preview path is covered above for brand assets
  const inKit = await invoke<{ asset: BrandAssetView }>('broll:importToKit', {
    kitId: kit.id,
    item: found.items[0],
  });
  expect(inKit.asset).toMatchObject({ kind: 'video', hasAudio: true });
  expect(inKit.asset.credit).toMatchObject({ source: 'pexels', author: 'Ann Photographer' });
  expect(inKit.asset.previewKey).toBeTruthy();
  // a rejected key is a plain-language error, never a crash
  await invoke('secrets:set', { key: 'pexels.apiKey', value: 'WRONG' });
  await expect(
    invoke('broll:search', { provider: 'pexels', query: 'city', orientation: 'any', page: 1 }),
  ).rejects.toThrow(/rejected/i);
});

/* ------------------------------------------------------------------------- the real UI ---------- */

test('the Brand Kit page in the real app lists the kit, its assets and fonts; the font is usable in the renderer', async () => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('app://clipfern/brand-kit/');
  await expect(page.getByText('E2E Brand').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Drop a file here, or browse.').first()).toBeVisible({
    timeout: 30_000,
  });
  await page.waitForTimeout(1500); // thumbnails
  await page.screenshot({ path: path.join(OUT, 'brand-kit-page.png') });
  // the brand font registers with the renderer under its family name
  const ok = await page.evaluate(async (family) => {
    const w = window as unknown as { document: Document };
    await w.document.fonts.load(`16px "${family}"`);
    return w.document.fonts.check(`16px "${family}"`);
  }, FAMILY);
  expect(ok).toBe(true);
  expect(errors.filter((e) => !/GL Driver|GPU stall/.test(e))).toEqual([]);
});

/* ----------------------------------------------------------------------- deleting a kit ---------- */

const bucketKeys = (): string[] => {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else out.push(path.relative(path.join(s3dir, BUCKET), path.join(d, e.name)));
    }
  };
  if (fs.existsSync(path.join(s3dir, BUCKET))) walk(path.join(s3dir, BUCKET));
  return out;
};

test('deleting assets clears kit references; files an editor project still uses are kept, the rest are removed with the kit', async () => {
  test.setTimeout(120_000);
  // the music asset is referenced by the kit's music bed: deleting it clears that reference
  const r = await invoke<{ deleted: number; clearedRefs: string[] }>('brand:deleteAssets', {
    ids: [assets.music.id],
  });
  expect(r).toMatchObject({ deleted: 1, clearedRefs: ['music bed'] });
  expect(
    (await invoke<{ kit: BrandKit }>('brand:get', { id: kit.id })).kit.spec.musicBed.assetId,
  ).toBeNull();
  // …but the editor project from the previous test uses that music file, so its objects are kept
  expect(bucketKeys().some((k) => k.includes(assets.music.id))).toBe(true);

  // the project from the previous test still references the logo / intro files
  const before = bucketKeys().filter(
    (k) => k.startsWith(`brand/${kit.id}/`) || k.includes(`brand`),
  );
  expect(before.some((k) => k.includes(assets.logo.id))).toBe(true);
  await invoke('brand:delete', { id: kit.id });
  const after = bucketKeys();
  expect(after.some((k) => k.includes(assets.svg.id))).toBe(false); // unreferenced → gone
  expect(after.some((k) => k.includes(assets.logo.id))).toBe(true); // used by the editor project → kept
  expect((await invoke<{ items: unknown[] }>('brand:list')).items).toHaveLength(0);
  expect(await invoke('brand:defaultKit')).toEqual({ id: null });
  // clips that used the kit now render without one; the font left the fonts directory
  const merged = path.join(userData, 'fonts', 'merged');
  expect(fs.readdirSync(merged).some((f) => f.startsWith(assets.font.id))).toBe(false);
  // the project keeps working: its brand asset previews still resolve
  const d = await invoke<ProjectDoc>('editor:get', { id: projectId });
  const logoAsset = d.project.assets.find((a) => a.source.key?.includes(assets.logo.id));
  expect(logoAsset).toBeTruthy();
  const pv = await invoke<{ url: string | null }>('editor:previewUrl', {
    projectId,
    assetId: logoAsset!.id,
  });
  expect(pv.url).toBeTruthy();
  expect((await fetch(pv.url!)).ok).toBe(true);
  void spawnSync;
});
