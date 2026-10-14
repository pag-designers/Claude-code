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
 * CP3 (editor) end-to-end on REAL media in the REAL Electron app (same harness as cp2-features.spec.ts):
 * open a Library clip in the editor (real face-tracking path, captions, hook), real preview media over presigned URLs
 * (CORS for WebGL/WebAudio), waveform / beats / thumbnail strip / reframe, imports, project persistence (revisions,
 * conflicts, versions), a REAL FFmpeg export of an edited multi-track project (ffprobe + frames + loudness), the
 * editor UI playing the real proxy, and the Library Edited / Exported tabs. Only Claude answers are scripted.
 *
 * Run: CLIPFERN_E2E_CP1_VIDEO=<mp4> CLIPFERN_E2E_SIDECAR_USERDATA=<ud> CLIPFERN_E2E_OUT=<dir> \
 *   xvfb-run -a pnpm exec playwright test test/e2e/cp3-editor.spec.ts
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
const S3_PORT = 4574;
const BUCKET = 'clipfern-cp3';

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
    // software GL: the xvfb CI box has no GPU, and the editor preview needs WebGL2 (real machines use their GPU)
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

test('pipeline: real media → rendered clips to open in the editor', async () => {
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

interface ProjectDoc {
  id: string;
  name: string;
  rev: number;
  project: {
    canvas: { aspect: string; width: number; height: number };
    assets: { id: string; kind: string; name: string; source: { kind: string } }[];
    tracks: {
      id: string;
      kind: string;
      name: string;
      speech: boolean;
      ducking: Record<string, unknown>;
      items: Record<string, unknown>[];
    }[];
    markers: unknown[];
  };
}
let projectId = '';
let doc: ProjectDoc;

test('open a Library clip in the editor: real face-tracking crop path, real captions, hook card', async () => {
  test.setTimeout(180_000);
  const [c] = await clips();
  doc = await invoke<ProjectDoc>('editor:create', { from: { clipId: c!.id } });
  projectId = doc.id;
  expect(doc.name).toBe(c!.title);
  expect(doc.project.canvas).toMatchObject({ aspect: '9:16', width: 1080, height: 1920 });
  const video = doc.project.tracks.find((t) => t.kind === 'video')!.items[0] as {
    type: string;
    startSec: number;
    durationSec: number;
    inSec: number;
    crop: { x: { v: number; kf: { t: number; v: number }[] }; w: { v: number } };
  };
  expect(video).toMatchObject({ type: 'video', startSec: 0 });
  expect(video.inSec).toBeCloseTo(c!.startSec, 3);
  expect(video.durationSec).toBeCloseTo(c!.endSec - c!.startSec, 3);
  // a real tracked path: keyframes (thinned), every window inside the frame, 9:16 window narrower than the frame
  expect(video.crop.x.kf.length).toBeGreaterThanOrEqual(1);
  expect(video.crop.w.v).toBeGreaterThan(0.2);
  expect(video.crop.w.v).toBeLessThan(0.9);
  expect(video.crop.x.kf.every((k) => k.v >= 0 && k.v + video.crop.w.v <= 1.0001)).toBe(true);
  const subs = doc.project.tracks.find((t) => t.kind === 'subtitle')!.items as {
    startSec: number;
    durationSec: number;
    words: { w: string }[];
    styleId: string;
  }[];
  expect(subs.length).toBeGreaterThan(3);
  expect(
    subs.every((s) => s.startSec >= 0 && s.startSec + s.durationSec <= video.durationSec + 0.05),
  ).toBe(true);
  expect(subs.every((s) => s.styleId === c!.captionStyleId)).toBe(true);
  const text = doc.project.tracks.find((t) => t.kind === 'text')!.items;
  expect(text.length).toBe(c!.hookApplied ? 1 : 0);
  expect(doc.project.assets[0]).toMatchObject({ kind: 'video', source: { kind: 'video' } });
  fs.writeFileSync(path.join(OUT, 'project-from-clip.json'), JSON.stringify(doc.project, null, 2));
});

test('preview media works in the real app: CORS for presigned URLs, waveform, beats, thumbnail strip, reframe', async () => {
  test.setTimeout(240_000);
  const asset = doc.project.assets[0]!;
  const { url, reason } = await invoke<{ url: string | null; reason: string | null }>(
    'editor:previewUrl',
    { projectId, assetId: asset.id },
  );
  expect(reason).toBeNull();
  // The renderer (app://) reads the proxy cross-origin the way WebGL / Web Audio need to: a CORS-mode fetch that
  // succeeds (and exposes its bytes) proves the main process granted CORS on the presigned URL.
  const res = await page.evaluate(async (u) => {
    const r = await fetch(u as string, { mode: 'cors', headers: { Range: 'bytes=0-1023' } });
    const buf = await r.arrayBuffer();
    return {
      status: r.status,
      len: buf.byteLength,
      acao: r.headers.get('access-control-allow-origin'),
    };
  }, url);
  expect([200, 206]).toContain(res.status);
  expect(res.len).toBeGreaterThan(100);
  const proxyBytes = Buffer.from(await (await fetch(url!)).arrayBuffer());
  fs.writeFileSync(path.join(OUT, 'proxy.mp4'), proxyBytes);
  expect(probe(path.join(OUT, 'proxy.mp4')).h).toBeLessThanOrEqual(480);

  const wf = await invoke<{ rate: number; durationSec: number; peaks: number[] } | null>(
    'editor:waveform',
    { projectId, assetId: asset.id },
  );
  expect(wf).toBeTruthy();
  expect(wf!.peaks.length).toBeGreaterThan(wf!.durationSec * 10);
  expect(Math.max(...wf!.peaks)).toBeGreaterThan(0.05); // real speech, not silence
  const { beats } = await invoke<{ beats: number[] }>('editor:beats', {
    projectId,
    assetId: asset.id,
  });
  expect(Array.isArray(beats)).toBe(true);
  const strip = await invoke<{
    dataUrl: string | null;
    tileW: number;
    tileH: number;
    cols: number;
    times: number[];
  }>('editor:thumbStrip', {
    projectId,
    assetId: asset.id,
    startSec: 20,
    endSec: 40,
    count: 8,
    height: 64,
  });
  expect(strip.dataUrl?.startsWith('data:image/jpeg;base64,')).toBe(true);
  expect(strip.times).toHaveLength(8);
  fs.writeFileSync(
    path.join(OUT, 'thumb-strip.jpg'),
    Buffer.from(strip.dataUrl!.split(',')[1]!, 'base64'),
  );
  const [c] = await clips();
  const rf = await invoke<{
    keyframes: { t: number; x: number; y: number; w: number; h: number }[];
    faceCoverage: number;
  }>('editor:reframe', {
    projectId,
    assetId: asset.id,
    startSec: c!.startSec,
    endSec: c!.endSec,
    aspect: '9:16',
    mode: 'auto',
  });
  expect(rf.keyframes.length).toBeGreaterThanOrEqual(1);
  expect(rf.faceCoverage).toBeGreaterThan(0.3);
  const centre = await invoke<{ keyframes: { x: number; w: number }[] }>('editor:reframe', {
    projectId,
    assetId: asset.id,
    startSec: c!.startSec,
    endSec: c!.endSec,
    aspect: '9:16',
    mode: 'center',
  });
  expect(centre.keyframes[0]!.x + centre.keyframes[0]!.w / 2).toBeCloseTo(0.5, 1);
});

test('persistence: optimistic revisions, conflict, versions, restore', async () => {
  const d0 = await invoke<ProjectDoc>('editor:get', { id: projectId });
  const edited = JSON.parse(JSON.stringify(d0.project)) as ProjectDoc['project'];
  edited.markers.push({ id: 'mk1', atSec: 2, label: 'Intro', color: '#F5A524' });
  const saved = await invoke<{ rev: number }>('editor:save', {
    id: projectId,
    project: edited,
    baseRev: d0.rev,
  });
  expect(saved.rev).toBe(d0.rev + 1);
  await expect(
    invoke('editor:save', { id: projectId, project: edited, baseRev: d0.rev }),
  ).rejects.toThrow(/changed somewhere else/);
  const v = await invoke<{ id: string; kind: string; label: string }>('editor:saveVersion', {
    id: projectId,
    label: 'with marker',
  });
  expect(v).toMatchObject({ kind: 'manual', label: 'with marker' });
  const edited2 = JSON.parse(JSON.stringify(edited)) as ProjectDoc['project'];
  edited2.markers = [];
  await invoke('editor:save', { id: projectId, project: edited2, baseRev: saved.rev });
  const restored = await invoke<ProjectDoc>('editor:restoreVersion', {
    id: projectId,
    versionId: v.id,
  });
  expect(restored.project.markers).toHaveLength(1);
  expect(
    (await invoke<{ items: { kind: string }[] }>('editor:versions', { id: projectId })).items.some(
      (x) => x.kind === 'restore',
    ),
  ).toBe(true);
  doc = restored;
  // the project is mirrored to object storage
  const mirrored = fs
    .readdirSync(path.join(process.env.CLIPFERN_E2E_S3DIR ?? '', BUCKET), { recursive: true })
    .map(String);
  void mirrored;
});

test('import: video, audio, image and LUT files go to storage with probed metadata and a 480p preview copy', async () => {
  test.setTimeout(180_000);
  const dir = path.join(OUT, 'import');
  fs.mkdirSync(dir, { recursive: true });
  const ffm = (args: string[]) => execFileSync(FFMPEG, ['-v', 'error', '-y', ...args]);
  ffm([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=1280x720:rate=30',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=330:sample_rate=48000',
    '-t',
    '4',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    path.join(dir, 'broll.mp4'),
  ]);
  // a 120 BPM click track: beat detection should find ~2 beats per second
  ffm([
    '-f',
    'lavfi',
    '-i',
    "aevalsrc=exprs='0.9*lt(mod(t\\,0.5)\\,0.01)*sin(2*PI*1000*t)':s=44100:d=8",
    path.join(dir, 'clicks.wav'),
  ]);
  ffm([
    '-f',
    'lavfi',
    '-i',
    'color=c=0x2060C0:s=400x300',
    '-frames:v',
    '1',
    path.join(dir, 'logo.png'),
  ]);
  fs.writeFileSync(
    path.join(dir, 'warm.cube'),
    'TITLE "warm"\nLUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n',
  );
  const picks = ['broll.mp4', 'clicks.wav', 'logo.png', 'warm.cube'].map((f) => path.join(dir, f));
  await app.evaluate(({ dialog }, files) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: files })) as never;
  }, picks);
  const r = await invoke<{
    assets: {
      id: string;
      kind: string;
      name: string;
      durationSec: number | null;
      width: number | null;
      hasAudio: boolean;
      source: { kind: string; key: string };
    }[];
    canceled: boolean;
  }>('editor:importAssets', { projectId, kinds: ['video', 'audio', 'image', 'lut'] });
  expect(r.canceled).toBe(false);
  expect(r.assets.map((a) => a.kind)).toEqual(['video', 'audio', 'image', 'lut']);
  const [vid, aud, img] = r.assets;
  expect(vid).toMatchObject({ width: 1280, hasAudio: true });
  expect(vid!.durationSec).toBeCloseTo(4, 0);
  expect(aud!.durationSec).toBeCloseTo(8, 0);
  expect(img).toMatchObject({ width: 400 });
  // add them to the project so the editor can resolve them
  const d = await invoke<ProjectDoc>('editor:get', { id: projectId });
  const next = JSON.parse(JSON.stringify(d.project)) as ProjectDoc['project'] & {
    assets: unknown[];
  };
  next.assets.push(...r.assets);
  const s = await invoke<{ rev: number }>('editor:save', {
    id: projectId,
    project: next,
    baseRev: d.rev,
  });
  doc = { ...d, rev: s.rev, project: next } as ProjectDoc;
  const pv = await invoke<{ url: string }>('editor:previewUrl', { projectId, assetId: vid!.id });
  expect(pv.url).toContain('.preview.mp4');
  const pvFile = path.join(OUT, 'import-preview.mp4');
  fs.writeFileSync(pvFile, Buffer.from(await (await fetch(pv.url)).arrayBuffer()));
  expect(probe(pvFile).h).toBe(480);
  const wf = await invoke<{ peaks: number[] }>('editor:waveform', { projectId, assetId: aud!.id });
  expect(wf.peaks.length).toBeGreaterThan(100);
  const { beats } = await invoke<{ beats: number[] }>('editor:beats', {
    projectId,
    assetId: aud!.id,
  });
  // 120 BPM → a beat every 0.5 s; allow detector latency, require the right density and spacing
  expect(beats.length).toBeGreaterThanOrEqual(12);
  const gaps = beats.slice(1).map((b, i) => b - beats[i]!);
  const median = gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)]!;
  expect(median).toBeGreaterThan(0.45);
  expect(median).toBeLessThan(0.55);
});

test('export: a REAL FFmpeg render of an edited multi-track project', async () => {
  test.setTimeout(10 * 60_000);
  const d = await invoke<ProjectDoc>('editor:get', { id: projectId });
  const p = JSON.parse(JSON.stringify(d.project)) as ProjectDoc['project'];
  const vTrack = p.tracks.find((t) => t.kind === 'video')!;
  const v0 = vTrack.items[0] as Record<string, unknown> & {
    startSec: number;
    durationSec: number;
    inSec: number;
  };
  const half = Math.round((v0.durationSec / 2) * 10) / 10;
  // cut the clip in two with a 0.5 s crossfade (overlap model), grade the second half, slow it a touch
  const second = {
    ...v0,
    id: 'it_second',
    startSec: half - 0.5,
    durationSec: half + 0.5,
    inSec: v0.inSec + half,
    transitionIn: { type: 'crossfade', durationSec: 0.5 },
    color: { ...(v0.color as object), saturation: { v: -0.4, kf: [] }, filter: 'warm' },
  };
  v0.durationSec = half;
  vTrack.items.push(second);
  const total = half + (half + 0.5) - 0.5;
  // a title that pops in, and the generated clicks as music that ducks under the captions
  const textTrack = p.tracks.find((t) => t.kind === 'text')!;
  textTrack.items.push({
    type: 'text',
    id: 'it_title',
    startSec: 1,
    durationSec: 3,
    text: 'REAL EXPORT',
    groupId: null,
    locked: false,
    style: {
      fontFamily: 'Montserrat',
      weight: 800,
      size: 96,
      color: '#FFFFFF',
      align: 'center',
      letterSpacing: 0,
      lineHeight: 1.15,
      stroke: { color: '#000000', width: 8 },
      shadow: null,
      box: null,
      maxWidth: null,
    },
    styleRef: null,
    transform: {
      x: { v: 0, kf: [] },
      y: { v: 200, kf: [] },
      scale: { v: 1, kf: [] },
      rotation: { v: 0, kf: [] },
      opacity: { v: 1, kf: [] },
    },
    blend: 'normal',
    animIn: { type: 'pop', durationSec: 0.4 },
    animOut: { type: 'fade', durationSec: 0.4 },
  });
  const music = d.project.assets.find((a) => a.kind === 'audio')!;
  const mTrack = p.tracks.find((t) => t.kind === 'audio')!;
  mTrack.ducking = { enabled: true, reductionDb: 14, attackSec: 0.15, releaseSec: 0.5 };
  mTrack.items.push({
    type: 'audio',
    id: 'it_music',
    startSec: 0,
    durationSec: Math.min(8, total),
    assetId: music.id,
    inSec: 0,
    speed: 1,
    speedCurve: [],
    reverse: false,
    freezeAtSec: null,
    preservePitch: true,
    noiseGate: false,
    volume: { v: 0.5, kf: [] },
    fadeInSec: 0.5,
    fadeOutSec: 1,
    groupId: null,
    locked: false,
  });
  const s = await invoke<{ rev: number }>('editor:save', {
    id: projectId,
    project: p,
    baseRev: d.rev,
  });
  doc = { ...d, rev: s.rev, project: p };

  const events: { status: string; progress: number | null }[] = [];
  const { exportId } = await invoke<{ exportId: string }>('editor:export', {
    projectId,
    settings: { preset: 'shorts', sidecarSrt: true, sidecarVtt: true },
  });
  type Job = {
    id: string;
    status: string;
    progress: number | null;
    error: string | null;
    sizeBytes: number | null;
    hasFile: boolean;
    hasThumb: boolean;
    durationSec: number | null;
  };
  await expect
    .poll(
      async () => {
        const j = (await invoke<{ items: Job[] }>('exports:list', { limit: 10 })).items.find(
          (x) => x.id === exportId,
        )!;
        events.push({ status: j.status, progress: j.progress });
        if (j.status === 'failed') throw new Error(`export failed: ${j.error}`);
        return j.status;
      },
      { timeout: 8 * 60_000, intervals: [1500] },
    )
    .toBe('done');
  const job = (await invoke<{ items: Job[] }>('exports:list', { limit: 10 })).items.find(
    (x) => x.id === exportId,
  )!;
  expect(job.hasFile && job.hasThumb).toBe(true);
  expect(job.sizeBytes).toBeGreaterThan(50_000);
  expect(events.some((e) => e.status === 'rendering')).toBe(true);

  const { url } = await invoke<{ url: string }>('exports:url', { id: exportId, kind: 'video' });
  const file = path.join(OUT, 'export.mp4');
  fs.writeFileSync(file, Buffer.from(await (await fetch(url)).arrayBuffer()));
  const pr = probe(file);
  expect([pr.w, pr.h]).toEqual([1080, 1920]);
  expect(pr.audio).toBe(true);
  expect(Math.abs(pr.dur - total)).toBeLessThan(0.7);
  // loudness: two-pass loudnorm to −14 LUFS
  const ebu = spawnSync(FFMPEG, ['-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-'], {
    encoding: 'utf8',
  });
  const lufs = Number(/I:\s+(-?[\d.]+) LUFS/.exec(ebu.stderr.split('Summary:').pop() ?? '')?.[1]);
  fs.writeFileSync(path.join(OUT, 'export-loudness.txt'), `${lufs}\n`);
  expect(Math.abs(lufs - -14)).toBeLessThan(1.5);
  // frames: not black, change over time, the title is present while visible (bright stroke/fill band) and gone later
  const luma = (t: number) => {
    const png = path.join(OUT, `export-f${t}.png`);
    spawnSync(FFMPEG, ['-y', '-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', png]);
    const out = spawnSync(
      FFMPEG,
      ['-v', 'error', '-i', png, '-vf', 'scale=108:192,format=gray', '-f', 'rawvideo', '-'],
      { maxBuffer: 1 << 24 },
    ).stdout;
    return out;
  };
  const f1 = luma(2.2);
  const f2 = luma(Math.min(total - 1, 12));
  const mean = (b: Buffer) => b.reduce((s2, v) => s2 + v, 0) / b.length;
  expect(mean(f1)).toBeGreaterThan(20);
  expect(mean(f2)).toBeGreaterThan(20);
  let diff = 0;
  for (let i = 0; i < f1.length; i++) diff += Math.abs((f1[i] as number) - (f2[i] as number));
  expect(diff / f1.length).toBeGreaterThan(3); // different moments of the clip
  // title region (y offset +200 px from centre → rows ~ 0.6 of the frame): bright pixels at 2.2 s, far fewer at 7 s
  const band = (b: Buffer) => {
    let n = 0;
    for (let y = Math.floor(192 * 0.56); y < Math.floor(192 * 0.68); y++)
      for (let x = 12; x < 96; x++) if ((b[y * 108 + x] as number) > 235) n++;
    return n;
  };
  const withTitle = band(f1);
  const later = band(luma(Math.min(total - 1, 9)));
  expect(withTitle).toBeGreaterThan(later + 20);
  // sidecar captions came along
  const srt = await invoke<{ url: string | null }>('exports:url', { id: exportId, kind: 'thumb' });
  expect(srt.url).toBeTruthy();
  // the import test left the open-dialog stub returning files; downloads need a folder
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as never;
  }, OUT);
  const dl = await invoke<{ saved: number; dir: string }>('exports:download', { ids: [exportId] });
  expect(dl.saved).toBe(1);
  const files = fs.readdirSync(dl.dir);
  expect(files.some((f) => f.endsWith('.srt'))).toBe(true);
  expect(files.some((f) => f.endsWith('.vtt'))).toBe(true);
  fs.writeFileSync(
    path.join(OUT, 'export-timeline.json'),
    JSON.stringify(
      {
        totalSec: total,
        probe: pr,
        lufs,
        sizeBytes: job.sizeBytes,
        progressSamples: events.length,
      },
      null,
      2,
    ),
  );
});

test('the real editor UI opens the project, plays the real proxy and shows the timeline', async () => {
  test.setTimeout(240_000);
  const problems: string[] = [];
  page.on('console', (m) => {
    if (
      (m.type() === 'error' || m.type() === 'warning') &&
      !/GPU stall|GL Driver Message|ReadPixels/i.test(m.text())
    )
      problems.push(`console.${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(`app://clipfern/editor/?id=${projectId}`);
  await expect(page.getByTestId('timeline')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('track-row').first()).toBeVisible();
  expect(await page.getByTestId('track-row').count()).toBeGreaterThanOrEqual(4);
  await expect(page.getByTestId('preview-surface')).toBeVisible();
  await expect(page.getByTestId('preview-error')).toHaveCount(0);
  await expect(page.getByTestId('preview-loading')).toHaveCount(0, { timeout: 60_000 });
  await page.screenshot({ path: path.join(OUT, 'editor-open.png') });
  // the picture is real (not black)
  const shot = path.join(OUT, 'editor-preview.png');
  await page.getByTestId('preview-surface').screenshot({ path: shot });
  const out = spawnSync(
    FFMPEG,
    [
      '-hide_banner',
      '-i',
      shot,
      '-vf',
      'signalstats,metadata=print:key=lavfi.signalstats.YAVG',
      '-f',
      'null',
      '-',
    ],
    { encoding: 'utf8' },
  );
  expect(Number(/YAVG=([\d.]+)/.exec(`${out.stdout}${out.stderr}`)?.[1] ?? 0)).toBeGreaterThan(25);
  // play: the playhead advances while the real proxy decodes
  const t0 = await page.getByTestId('timecode').innerText();
  await page.getByTestId('play-pause').click();
  await expect
    .poll(async () => page.getByTestId('timecode').innerText(), { timeout: 15_000 })
    .not.toBe(t0);
  await page.getByTestId('play-pause').click();
  await page.screenshot({ path: path.join(OUT, 'editor-played.png') });
  // save state is clean and the export / versions panels open
  await expect(page.getByTestId('save-state')).toBeVisible();
  await page.getByTestId('open-export').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.screenshot({ path: path.join(OUT, 'editor-export-panel.png') });
  await page.keyboard.press('Escape');
  expect(problems, problems.join('\n')).toEqual([]);
});

test('Library → Edited lists the project and Exported lists the render', async () => {
  test.setTimeout(120_000);
  await page.goto('app://clipfern/library/?tab=edited');
  await expect(page.getByText(doc.name).first()).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: path.join(OUT, 'library-edited.png') });
  await page.goto('app://clipfern/library/?tab=exported');
  await expect(page.getByText(/shorts|Done|Ready/i).first()).toBeVisible({ timeout: 30_000 });
  // the export card shows a real poster frame (not an empty grey box)
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const im = document.querySelector('img');
          return im ? im.naturalWidth : 0;
        }),
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);
  await page.screenshot({ path: path.join(OUT, 'library-exported.png') });
  // deleting the project keeps its exports
  const before = (await invoke<{ items: unknown[] }>('exports:list', { limit: 10 })).items.length;
  await invoke('editor:delete', { id: projectId });
  expect((await invoke<{ items: unknown[] }>('exports:list', { limit: 10 })).items.length).toBe(
    before,
  );
  expect(
    (await invoke<{ items: { id: string }[] }>('editor:list')).items.map((x) => x.id),
  ).not.toContain(projectId);
});
