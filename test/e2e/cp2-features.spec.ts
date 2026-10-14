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
import { startSmartAnthropicStub } from '../support/e2e-anthropic';
import type { StubAnthropic } from '../unit/llm-stub-server';

/**
 * CP2 end-to-end on REAL media in the REAL Electron app (same harness as cp1-pipeline.spec.ts):
 * caption presets + real libass preview, restyle re-render, subtitle edits → SRT, steered re-run,
 * One-Click Highlights, hook variants, metadata, thumbnails, reframe modes, analysis-only mode, AI chat
 * tools, markers. Only the Claude answers are scripted (test/support/e2e-anthropic.ts).
 *
 * Run: CLIPFERN_E2E_CP1_VIDEO=<mp4> CLIPFERN_E2E_SIDECAR_USERDATA=<ud> CLIPFERN_E2E_OUT=<dir> \
 *   xvfb-run -a pnpm exec playwright test test/e2e/cp2-features.spec.ts
 */
const VIDEO = process.env.CLIPFERN_E2E_CP1_VIDEO;
const SIDECAR_BASE = process.env.CLIPFERN_E2E_SIDECAR_USERDATA;
const OUT =
  process.env.CLIPFERN_E2E_OUT ?? fs.mkdtempSync(path.join(os.tmpdir(), 'clipfern-cp2-out-'));
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
let media: http.Server;
let mediaUrl: string;
let stub: StubAnthropic;
let videoId = '';
const S3_PORT = 4573;
const BUCKET = 'clipfern-cp2';

interface Clip {
  id: string;
  title: string;
  hook: string | null;
  startSec: number;
  endSec: number;
  durationSec: number;
  kind: 'clip' | 'highlight';
  status: string;
  error: string | null;
  captionStyleId: string;
  reframeMode: string;
  layout: string | null;
  hookApplied: string | null;
  hasHooks: boolean;
  hasMeta: boolean;
  hasThumbOptions: boolean;
  runId: string | null;
  runPrompt: string | null;
  subtitleRev: number;
}

const invoke = <T = unknown>(channel: string, payload?: unknown) =>
  page.evaluate(
    ([c, p]) =>
      (
        window as unknown as { clipfern: { invoke(c: string, p?: unknown): Promise<unknown> } }
      ).clipfern.invoke(c as string, p) as Promise<T>,
    [channel, payload] as const,
  );

const clips = async (extra: Record<string, unknown> = {}) =>
  (await invoke<{ items: Clip[] }>('clips:list', { videoId, ...extra })).items;
const clipById = async (id: string) => (await clips()).find((c) => c.id === id);
const waitRendered = (id: string, afterRev?: (c: Clip) => boolean) =>
  expect
    .poll(
      async () => {
        const c = await clipById(id);
        if (c?.status === 'failed') throw new Error(`render failed: ${c.error}`);
        return c?.status === 'rendered' && (afterRev ? afterRev(c) : true);
      },
      { timeout: 6 * 60_000, intervals: [1500] },
    )
    .toBe(true);

async function download(id: string, name: string, kind: 'render' | 'thumb' = 'render') {
  const { url } = await invoke<{ url: string | null }>('clips:mediaUrl', { id, kind });
  expect(url).toBeTruthy();
  const file = path.join(OUT, name);
  fs.writeFileSync(file, Buffer.from(await (await fetch(url!)).arrayBuffer()));
  return file;
}

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
    w: v?.width,
    h: v?.height,
    dur: Number(j.format.duration),
    audio: j.streams.some((s) => s.codec_type === 'audio'),
  };
}

/** Grabs one frame as raw gray bytes (small), for pixel comparisons. */
function frameGray(file: string, t: number, out: string): Buffer {
  spawnSync(FFMPEG, [
    '-y',
    '-v',
    'error',
    '-ss',
    String(t),
    '-i',
    file,
    '-frames:v',
    '1',
    '-vf',
    'scale=270:480',
    '-f',
    'image2',
    out,
  ]);
  const raw = spawnSync(
    FFMPEG,
    ['-v', 'error', '-i', out, '-vf', 'format=gray', '-f', 'rawvideo', '-'],
    { maxBuffer: 1 << 24 },
  );
  return raw.stdout;
}
/** Same for a still image (JPEG). */
function imageGray(file: string): Buffer {
  const raw = spawnSync(
    FFMPEG,
    ['-v', 'error', '-i', file, '-vf', 'scale=270:480,format=gray', '-f', 'rawvideo', '-'],
    { maxBuffer: 1 << 24 },
  );
  return raw.stdout;
}
const meanAbsDiff = (a: Buffer, b: Buffer) => {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += Math.abs(a[i]! - b[i]!);
  return s / n;
};

test.beforeAll(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const s3dir =
    process.env.CLIPFERN_E2E_S3DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'clipfern-s3-'));
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
  stub = await startSmartAnthropicStub();
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'clipfern-cp2-ud-'));
  for (const d of ['sidecar-venv', 'models', 'uv']) {
    if (fs.existsSync(path.join(SIDECAR_BASE!, d)))
      execFileSync('cp', ['-al', path.join(SIDECAR_BASE!, d), path.join(userData, d)]);
  }
  const exe = process.env.CLIPFERN_E2E_EXE;
  app = await electron.launch({
    ...(exe ? { executablePath: exe } : {}),
    args: exe ? ['--no-sandbox'] : ['--no-sandbox', '.'],
    cwd: path.resolve(__dirname, '../..'),
    env: {
      ...process.env,
      CLIPFERN_USER_DATA: userData,
      CLIPFERN_S3_ENDPOINT_OVERRIDE: `http://127.0.0.1:${S3_PORT}`,
      CLIPFERN_ALLOW_ANY_URL: '1',
      CLIPFERN_ANTHROPIC_BASE_URL: stub.baseUrl,
      CLIPFERN_WHISPER_MODEL: process.env.CLIPFERN_E2E_WHISPER ?? 'tiny',
      ANTHROPIC_API_KEY: 'sk-ant-api03-E2E-NOT-A-REAL-KEY-000000',
    },
  });
  page = await app.firstWindow();
  await page.waitForFunction(() => !!(window as unknown as { clipfern?: unknown }).clipfern);
  await invoke('settings:set', { r2Bucket: BUCKET, whisperModel: 'tiny' });
  // Native dialogs cannot be clicked in e2e: answer them with a temp folder / file.
  await app.evaluate(({ dialog }, dir) => {
    dialog.showSaveDialog = (async (_w: unknown, o?: { defaultPath?: string }) => ({
      canceled: false,
      filePath: `${dir}/${(o?.defaultPath ?? 'out').split('/').pop()}`,
    })) as never;
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as never;
  }, OUT);
});

test.afterAll(async () => {
  await app?.close();
  await stub?.stop();
  await s3?.close();
  media?.close();
});

test('pipeline: real media → clips (with CP2 fields), engine ready', async () => {
  test.setTimeout(30 * 60_000);
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
      clipCount: 3,
      minScore: 45,
      captions: true,
      hookCard: true,
      aspect: '9:16',
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
      { timeout: 20 * 60_000, intervals: [2000] },
    )
    .toBe('ready');
  const cs = await clips();
  expect(cs.length).toBeGreaterThanOrEqual(1);
  expect(
    cs.every(
      (c) => c.status === 'rendered' && c.kind === 'clip' && c.captionStyleId === 'clean-pop',
    ),
  ).toBe(true);
  expect(
    cs.every(
      (c) =>
        c.reframeMode === 'auto' && ['single', 'split', 'screen-face'].includes(c.layout ?? ''),
    ),
  ).toBe(true);
});

test('captions: 14 built-in presets, real libass previews that differ, custom preset round-trip', async () => {
  test.setTimeout(180_000);
  const { styles } = await invoke<{ styles: { id: string; builtin: boolean; name: string }[] }>(
    'captions:styles',
  );
  const ids = styles.filter((s) => s.builtin).map((s) => s.id);
  expect(ids).toEqual([
    'clean-pop',
    'hormozi-bold',
    'karaoke-highlight',
    'tiktok-classic',
    'minimal-lower-third',
    'neon-glow',
    'boxed-highlight',
    'typewriter',
    'bounce-word',
    'gradient-glow',
    'outline-only',
    'caption-bubble',
    'podcast-lower-third',
    'subtle-serif',
  ]);
  const [first] = await clips();
  const hashes = new Set<string>();
  fs.mkdirSync(path.join(OUT, 'previews'), { recursive: true });
  for (const s of styles.filter((x) => x.builtin)) {
    const full = (
      await invoke<{ styles: Record<string, unknown>[] }>('captions:styles')
    ).styles.find((x) => x.id === s.id)!;
    const p = await invoke<{ dataUrl: string; width: number; height: number }>('captions:preview', {
      style: full,
      clipId: first!.id,
      text: 'Watch the weather change today',
      activeWord: 2,
    });
    expect(p.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    const png = Buffer.from(p.dataUrl.split(',')[1]!, 'base64');
    expect(png.length).toBeGreaterThan(3000);
    fs.writeFileSync(path.join(OUT, 'previews', `${s.id}.png`), png);
    hashes.add(
      png.toString('base64').slice(0, 0) +
        String(png.length) +
        ':' +
        png.subarray(100, 200).toString('hex'),
    );
  }
  expect(hashes.size, 'every preset renders differently').toBe(14);

  const base = (await invoke<{ styles: Record<string, unknown>[] }>('captions:styles')).styles.find(
    (x) => x.id === 'hormozi-bold',
  )!;
  const saved = await invoke<{ id: string; builtin: boolean }>('captions:saveStyle', {
    style: { ...base, name: 'My style', fill: '#00FF88' },
  });
  expect(saved.builtin).toBe(false);
  expect(saved.id).not.toBe('hormozi-bold');
  expect(
    (await invoke<{ styles: { id: string }[] }>('captions:styles')).styles.map((s) => s.id),
  ).toContain(saved.id);
  await expect(invoke('captions:deleteStyle', { id: 'clean-pop' })).rejects.toThrow(/Built-in/);
  await invoke('captions:deleteStyle', { id: saved.id });
  const { fonts } = await invoke<{ fonts: { family: string }[] }>('captions:fonts');
  expect(fonts.map((f) => f.family)).toEqual(
    expect.arrayContaining(['Montserrat', 'Anton', 'Poppins']),
  );
});

test('restyle: another preset re-renders the clip and the burned captions really change', async () => {
  test.setTimeout(8 * 60_000);
  const [c] = await clips();
  const before = await download(c!.id, 'restyle-before.mp4');
  await invoke('clips:restyle', { ids: [c!.id], styleId: 'hormozi-bold' });
  await waitRendered(c!.id, (x) => x.captionStyleId === 'hormozi-bold');
  const after = await download(c!.id, 'restyle-after.mp4');
  const pb = probe(after);
  expect([pb.w, pb.h]).toEqual([1080, 1920]);
  expect(Math.abs(pb.dur - c!.durationSec)).toBeLessThan(1.2);
  // captions sit in the lower third: that band must differ strongly between the two styles, the top band must not
  let band = 0;
  let top = 0;
  for (const t of [5, 9, 14]) {
    const a = frameGray(before, t, path.join(OUT, `rs-a-${t}.png`));
    const b = frameGray(after, t, path.join(OUT, `rs-b-${t}.png`));
    const w = 270;
    const h = 480;
    const slice = (buf: Buffer, y0: number, y1: number) => buf.subarray(y0 * w, y1 * w);
    band = Math.max(
      band,
      meanAbsDiff(
        slice(a, Math.floor(h * 0.55), Math.floor(h * 0.8)),
        slice(b, Math.floor(h * 0.55), Math.floor(h * 0.8)),
      ),
    );
    top = Math.max(
      top,
      meanAbsDiff(
        slice(a, Math.floor(h * 0.25), Math.floor(h * 0.45)),
        slice(b, Math.floor(h * 0.25), Math.floor(h * 0.45)),
      ),
    );
  }
  fs.writeFileSync(path.join(OUT, 'restyle-metrics.json'), JSON.stringify({ band, top }));
  expect(band).toBeGreaterThan(2);
  expect(band).toBeGreaterThan(top * 2);
});

test('subtitles: edits persist, mark clips outdated, appear in the re-rendered SRT and export', async () => {
  test.setTimeout(8 * 60_000);
  const [c] = await clips();
  const got = await invoke<{
    cues: { id: number; s: number; e: number; text: string; wordStart: number }[];
    edits: { rev: number };
    outdatedClips: number;
  }>('subtitles:get', { videoId });
  expect(got.cues.length).toBeGreaterThan(5);
  expect(got.edits.rev).toBe(0);
  const inClip = got.cues.find((q) => q.s >= c!.startSec + 2 && q.e <= c!.endSec - 1)!;
  expect(inClip).toBeTruthy();
  const wordIdx = inClip.wordStart;
  const saved = await invoke<{
    edits: { rev: number };
    outdatedClips: number;
    cues: { text: string }[];
  }>('subtitles:save', {
    videoId,
    edits: { rev: 0, words: { [String(wordIdx)]: { text: 'ZEBRAXYZ' } }, breaks: [], merges: [] },
  });
  expect(saved.edits.rev).toBe(1);
  expect(saved.outdatedClips).toBeGreaterThanOrEqual(1);
  expect(saved.cues.some((q) => q.text.includes('ZEBRAXYZ'))).toBe(true);
  expect(
    (
      await invoke<{ edits: { words: Record<string, { text?: string }> } }>('subtitles:get', {
        videoId,
      })
    ).edits.words[String(wordIdx)]?.text,
  ).toBe('ZEBRAXYZ');
  // video + clips carry the revision
  expect(
    (await invoke<{ video: { subtitleRev: number } }>('videos:get', { id: videoId })).video
      .subtitleRev,
  ).toBe(1);

  // export through the (stubbed) save dialog
  const ex = await invoke<{ saved: boolean; path: string }>('subtitles:export', {
    videoId,
    clipId: c!.id,
    format: 'srt',
  });
  expect(ex.saved).toBe(true);
  const srt = fs.readFileSync(ex.path, 'utf8');
  expect(srt).toContain('ZEBRAXYZ');
  expect(srt.startsWith('1\n')).toBe(true);
  const vtt = await invoke<{ path: string }>('subtitles:export', { videoId, format: 'vtt' });
  expect(fs.readFileSync(vtt.path, 'utf8').startsWith('WEBVTT')).toBe(true);

  // re-render picks the edit up: the SRT shipped with the clip contains it and the clip is no longer outdated
  await invoke('clips:rerender', { id: c!.id });
  await waitRendered(c!.id, (x) => x.subtitleRev === 1);
  const dl = await invoke<{ saved: number; dir: string }>('clips:download', {
    ids: [c!.id],
    withCaptions: true,
  });
  expect(dl.saved).toBe(1);
  const srts = fs.readdirSync(dl.dir).filter((f) => f.endsWith('.srt'));
  expect(srts.some((f) => fs.readFileSync(path.join(dl.dir, f), 'utf8').includes('ZEBRAXYZ'))).toBe(
    true,
  );
  expect(
    (await invoke<{ outdatedClips: number }>('subtitles:get', { videoId })).outdatedClips,
  ).toBeLessThan(saved.outdatedClips);
});

test('hooks: 5 variants per platform, applying one re-renders with that title card, removing it works', async () => {
  test.setTimeout(8 * 60_000);
  const [c] = await clips();
  const h = await invoke<{
    tiktok: { text: string }[];
    reels: unknown[];
    shorts: unknown[];
    applied: unknown;
  }>('hooks:generate', { clipId: c!.id });
  expect(h.tiktok).toHaveLength(5);
  expect(h.reels).toHaveLength(5);
  expect(h.shorts).toHaveLength(5);
  expect(h.tiktok.every((v) => v.text.split(/\s+/).length <= 10)).toBe(true);
  expect(await invoke('hooks:get', { clipId: c!.id })).toMatchObject({ applied: null });
  const withCard = await download(c!.id, 'hook-before.mp4');
  await invoke('hooks:apply', { clipId: c!.id, choice: { platform: 'tiktok', index: 2 } });
  await waitRendered(c!.id, (x) => x.hookApplied === h.tiktok[2]!.text);
  // the hook card is on screen in the first seconds: the top band changes vs. the previous render
  const applied = await download(c!.id, 'hook-applied.mp4');
  const a = frameGray(withCard, 1.2, path.join(OUT, 'hook-a.png'));
  const b = frameGray(applied, 1.2, path.join(OUT, 'hook-b.png'));
  expect(meanAbsDiff(a, b)).toBeGreaterThan(0.5);
  await invoke('hooks:apply', { clipId: c!.id, choice: null });
  await waitRendered(c!.id, (x) => x.hookApplied === null);
  const none = await download(c!.id, 'hook-none.mp4');
  const n = frameGray(none, 1.2, path.join(OUT, 'hook-n.png'));
  expect(meanAbsDiff(b, n)).toBeGreaterThan(0.5);
});

test('metadata: per-platform title/description/hashtags/posting time, editable', async () => {
  const [c] = await clips();
  const m = await invoke<
    Record<
      string,
      { title: string; hashtags: string[]; postingTime: { hour: number; reason: string } }
    >
  >('meta:generate', { clipId: c!.id });
  for (const p of ['tiktok', 'reels', 'shorts']) {
    expect(m[p]!.title.length).toBeGreaterThan(3);
    expect(m[p]!.hashtags.length).toBeGreaterThan(0);
    expect(m[p]!.postingTime.reason).toMatch(/not based on your analytics/i);
  }
  expect(m.shorts!.hashtags.map((x) => x.toLowerCase().replace(/^#/, ''))).toContain('shorts');
  await invoke('meta:save', {
    clipId: c!.id,
    platform: 'reels',
    meta: { ...m.reels, title: 'Edited title' },
  });
  expect((await invoke<typeof m>('meta:get', { clipId: c!.id }))!.reels!.title).toBe(
    'Edited title',
  );
  expect((await clipById(c!.id))?.hasMeta).toBe(true);
});

test('thumbnails: real frames scored, candidates load from storage, choosing one with overlay text rebuilds the thumbnail', async () => {
  test.setTimeout(180_000);
  const [c] = await clips();
  const before = await download(c!.id, 'thumb-before.jpg', 'thumb');
  const t = await invoke<{
    candidates: {
      t: number;
      scores: { total: number; sharpness: number };
      llmRank: number | null;
    }[];
    overlayText: string | null;
  }>('thumbs:generate', { clipId: c!.id });
  expect(t.candidates.length).toBeGreaterThanOrEqual(4);
  expect(t.candidates.every((x) => x.scores.sharpness >= 0 && x.scores.total >= 0)).toBe(true);
  for (let i = 0; i < Math.min(3, t.candidates.length); i++) {
    const { url } = await invoke<{ url: string }>('thumbs:url', { clipId: c!.id, index: i });
    const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
    expect(buf.subarray(0, 3).toString('hex')).toBe('ffd8ff'); // JPEG
    fs.writeFileSync(path.join(OUT, `thumb-cand-${i}.jpg`), buf);
  }
  const pick = t.candidates[2]!;
  await invoke('thumbs:choose', { clipId: c!.id, t: pick.t, overlayText: 'WATCH THIS' });
  const after = await download(c!.id, 'thumb-after.jpg', 'thumb');
  expect(fs.statSync(after).size).toBeGreaterThan(5000);
  const a = imageGray(before);
  const b = imageGray(after);
  expect(a.length).toBeGreaterThan(1000);
  expect(b.length).toBe(a.length);
  expect(meanAbsDiff(a, b)).toBeGreaterThan(1);
  expect((await clipById(c!.id))?.hasThumbOptions).toBe(true);
});

test('reframe: centre crop and multi-face modes re-render with the chosen layout', async () => {
  test.setTimeout(10 * 60_000);
  const [c] = await clips();
  await invoke('clips:reframe', { ids: [c!.id], mode: 'center' });
  await waitRendered(c!.id, (x) => x.reframeMode === 'center');
  expect((await clipById(c!.id))?.layout).toBe('single');
  const f = await download(c!.id, 'reframe-center.mp4');
  expect(probe(f).w).toBe(1080);
  await invoke('clips:reframe', { ids: [c!.id], mode: 'multi-face' });
  await waitRendered(c!.id, (x) => x.reframeMode === 'multi-face');
  const lay = (await clipById(c!.id))?.layout;
  expect(['single', 'split']).toContain(lay);
  const f2 = await download(c!.id, 'reframe-multi.mp4');
  expect([probe(f2).w, probe(f2).h]).toEqual([1080, 1920]);
  await invoke('clips:reframe', { ids: [c!.id], mode: 'auto' });
  await waitRendered(c!.id, (x) => x.reframeMode === 'auto');
});

test('One-Click Highlights: a stitched reel with several segments renders as one video', async () => {
  test.setTimeout(12 * 60_000);
  const { clipId } = await invoke<{ clipId: string }>('highlights:create', {
    videoId,
    prompt: 'best moments',
  });
  await waitRendered(clipId);
  const reel = (await clips()).find((x) => x.id === clipId)!;
  expect(reel.kind).toBe('highlight');
  const f = await download(clipId, 'highlights.mp4');
  const p = probe(f);
  expect([p.w, p.h]).toEqual([1080, 1920]);
  expect(p.audio).toBe(true);
  expect(p.dur).toBeGreaterThan(20);
  expect(Math.abs(p.dur - reel.durationSec)).toBeLessThan(3);
});

test('steered re-run: reuses the transcript, is tagged with its prompt, completes', async () => {
  test.setTimeout(10 * 60_000);
  const before = stub.requests.length;
  const { runId } = await invoke<{ runId: string }>('moments:find', {
    videoId,
    prompt: 'anything about the weather',
    options: { clipCount: 2, minScore: 30 },
  });
  await expect
    .poll(
      async () =>
        (
          await invoke<{ items: { id: string; status: string; error: string | null }[] }>(
            'moments:runs',
            { videoId },
          )
        ).items.find((r) => r.id === runId)?.status,
      { timeout: 5 * 60_000, intervals: [1500] },
    )
    .not.toBe('running');
  const run = (
    await invoke<{ items: { id: string; status: string; found: number; error: string | null }[] }>(
      'moments:runs',
      { videoId },
    )
  ).items.find((r) => r.id === runId)!;
  expect(run.status, run.error ?? '').toBe('done');
  const newReqs = stub.requests.slice(before).map((r) => JSON.stringify(r.body));
  expect(newReqs.some((b) => b.includes('anything about the weather'))).toBe(true);
  const steered = (await clips()).filter((x) => x.runId === runId);
  expect(steered.length).toBe(run.found);
  for (const s of steered) {
    expect(s.runPrompt).toBe('anything about the weather');
    await waitRendered(s.id);
  }
});

test('analysis-only mode: summary + transcript without ranking or rendering (cached transcript reused)', async () => {
  test.setTimeout(10 * 60_000);
  const rankBefore = stub.requests.filter(
    (r) =>
      'moments' in
      ((r.body.output_config?.format?.schema as { properties?: object })?.properties ?? {}),
  ).length;
  const res = await invoke<{ videoId: string }>('pipeline:start', {
    url: mediaUrl,
    options: { mode: 'analysis' },
  });
  await expect
    .poll(
      async () =>
        (
          await invoke<{ video: { status: string; error: string } }>('videos:get', {
            id: res.videoId,
          })
        ).video.status,
      { timeout: 5 * 60_000, intervals: [1500] },
    )
    .toBe('ready');
  const g = await invoke<{
    video: { clipCount: number };
    analysis: { overview: { summary: string } } | null;
    stages: { stage: string; status: string }[];
  }>('videos:get', { id: res.videoId });
  expect(g.video.clipCount).toBe(0);
  expect(g.analysis?.overview.summary.length ?? 0).toBeGreaterThan(10);
  expect(g.stages.find((s) => s.stage === 'moments')?.status).toBe('skipped');
  expect(g.stages.find((s) => s.stage === 'render')?.status).toBe('skipped');
  const rankAfter = stub.requests.filter(
    (r) =>
      'moments' in
      ((r.body.output_config?.format?.schema as { properties?: object })?.properties ?? {}),
  ).length;
  expect(rankAfter).toBe(rankBefore);
  expect(
    (await invoke<{ words: unknown[] } | null>('videos:transcript', { id: res.videoId }))?.words
      .length ?? 0,
  ).toBeGreaterThan(100);
});

test('AI chat: grounded answer with a [mm:ss] citation and an executed create_clip action; markers', async () => {
  test.setTimeout(10 * 60_000);
  const before = (await clips()).length;
  const { threadId } = await invoke<{ threadId: string }>('chat:send', {
    videoId,
    text: 'Make a clip about the weather forecast',
  });
  await expect
    .poll(
      async () => {
        const { items } = await invoke<{
          items: { role: string; text: string; actions: { status: string; tool: string }[] }[];
        }>('chat:messages', { threadId });
        const a = items.find((m) => m.role === 'assistant');
        return a &&
          a.text.length > 0 &&
          a.actions.length > 0 &&
          a.actions.every((x) => x.status !== 'running')
          ? a
          : null;
      },
      { timeout: 60_000, intervals: [500] },
    )
    .not.toBeNull();
  const { items } = await invoke<{
    items: {
      role: string;
      text: string;
      citations: unknown[];
      actions: { tool: string; status: string; summary: string; href: string }[];
    }[];
  }>('chat:messages', { threadId });
  const a = items.find((m) => m.role === 'assistant')!;
  expect(a.actions[0]).toMatchObject({ tool: 'create_clip', status: 'done' });
  expect(a.actions[0]!.summary).toMatch(/Created clip/);
  expect(a.actions[0]!.href).toContain(videoId);
  const after = await clips();
  expect(after.length).toBe(before + 1);
  const created = after.find((c) => c.title.toLowerCase().includes('weather') || c.hook === null)!;
  expect(created).toBeTruthy();
  expect(
    (await invoke<{ items: { id: string }[] }>('chat:threads', { videoId })).items.map((t) => t.id),
  ).toContain(threadId);
  await invoke('chat:delete', { threadId });
  expect((await invoke<{ items: unknown[] }>('chat:messages', { threadId })).items).toHaveLength(0);

  const m = await invoke<{ id: string; atSec: number }>('markers:add', {
    videoId,
    atSec: 42.5,
    label: 'Interesting',
  });
  expect(
    (await invoke<{ items: { label: string }[] }>('markers:list', { videoId })).items.map(
      (x) => x.label,
    ),
  ).toContain('Interesting');
  await invoke('markers:delete', { id: m.id });
  expect((await invoke<{ items: unknown[] }>('markers:list', { videoId })).items).toHaveLength(0);
});

test('cost tracker recorded every CP2 call kind', async () => {
  const cost = await invoke<{ calls: number; byPurpose?: Record<string, number> }>('cost:summary');
  // every request the stub saw was recorded by the cost tracker (nothing is spent without being counted)
  expect(cost.calls).toBe(stub.requests.length);
  expect(cost.calls).toBeGreaterThan(8);
  for (const r of stub.requests) {
    expect(r.body).not.toHaveProperty('temperature');
    expect(JSON.stringify(r.body)).not.toContain('sk-ant-');
  }
});
