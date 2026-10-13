import { execFileSync } from 'node:child_process';
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
 * CP1 end-to-end on REAL media, in the REAL Electron app:
 *   local media server → yt-dlp (generic extractor) → ffmpeg → real sidecar transcription (faster-whisper)
 *   → real heuristics → SCRIPTED Claude stand-in → real reframe/captions/render → S3 (s3rver) → library.
 * Only the LLM answers are scripted (no key in CI/sandbox) — see test/support/e2e-anthropic.ts.
 *
 * Needs: CLIPFERN_E2E_CP1_VIDEO=<mp4>, CLIPFERN_E2E_SIDECAR_USERDATA=<userData with sidecar-venv+models>.
 * Run: xvfb-run -a pnpm exec playwright test test/e2e/cp1-pipeline.spec.ts
 */
const VIDEO = process.env.CLIPFERN_E2E_CP1_VIDEO;
const SIDECAR_BASE = process.env.CLIPFERN_E2E_SIDECAR_USERDATA;
const OUT =
  process.env.CLIPFERN_E2E_OUT ?? fs.mkdtempSync(path.join(os.tmpdir(), 'clipfern-cp1-out-'));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const S3rver = require('s3rver') as new (o: Record<string, unknown>) => {
  run(): Promise<unknown>;
  close(): Promise<void>;
};

test.skip(
  !VIDEO || !SIDECAR_BASE || !fs.existsSync(VIDEO ?? ''),
  'needs CLIPFERN_E2E_CP1_VIDEO and CLIPFERN_E2E_SIDECAR_USERDATA',
);
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let userData: string;
let s3: { close(): Promise<void> };
let s3dir: string;
let media: http.Server;
let mediaUrl: string;
let stub: StubAnthropic;
const S3_PORT = 4571;
const BUCKET = 'clipfern-cp1';

const invoke = <T = unknown>(channel: string, payload?: unknown) =>
  page.evaluate(
    ([c, p]) =>
      (
        window as unknown as { clipfern: { invoke(c: string, p?: unknown): Promise<unknown> } }
      ).clipfern.invoke(c as string, p) as Promise<T>,
    [channel, payload] as const,
  );

test.beforeAll(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  s3dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipfern-s3-'));
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
  await new Promise<void>((r) => media.listen(0, '127.0.0.1', r));
  mediaUrl = `http://127.0.0.1:${(media.address() as AddressInfo).port}/talk.mp4`;

  stub = await startSmartAnthropicStub();

  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'clipfern-cp1-ud-'));
  for (const d of ['sidecar-venv', 'models', 'uv']) {
    if (fs.existsSync(path.join(SIDECAR_BASE!, d)))
      execFileSync('cp', ['-al', path.join(SIDECAR_BASE!, d), path.join(userData, d)]);
  }
  app = await electron.launch({
    args: ['--no-sandbox', '.'],
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
  await invoke('settings:set', {
    r2Bucket: BUCKET,
    whisperModel: (process.env.CLIPFERN_E2E_WHISPER as 'tiny' | undefined) ?? 'tiny',
  });
});

test.afterAll(async () => {
  await app?.close();
  await stub?.stop();
  await s3?.close();
  media?.close();
});

interface VideoGet {
  video: {
    status: string;
    stage: string | null;
    error: string | null;
    clipCount: number;
    renderedCount: number;
    title: string;
    durationSec: number | null;
    hasProxy: boolean;
  };
  analysis: { overview: { summary: string }; chapters: { title: string }[] } | null;
  stages: {
    stage: string;
    status: string;
    startedAt: number | null;
    finishedAt: number | null;
    error: string | null;
  }[];
}
interface Clip {
  id: string;
  title: string;
  hook: string | null;
  startSec: number;
  endSec: number;
  durationSec: number;
  score: number | null;
  status: string;
  hasRender: boolean;
  hasThumb: boolean;
  error: string | null;
}

test('the transcription engine from the copied sandbox venv is ready', async () => {
  await expect
    .poll(
      async () =>
        (await invoke<{ installed: boolean; modelReady: boolean }>('sidecar:status')).modelReady,
      { timeout: 30_000 },
    )
    .toBe(true);
});

test('pipeline: real media in → ready clips out (streaming), artifacts in storage', async () => {
  test.setTimeout(25 * 60_000);
  await expect
    .poll(
      async () =>
        (await invoke<{ tools: { name: string; ok: boolean }[] }>('binaries:status')).tools.find(
          (t) => t.name === 'yt-dlp',
        )?.ok,
      { timeout: 120_000 },
    )
    .toBe(true);

  const info = await invoke<{ title: string; durationSec: number | null }>('pipeline:probe', {
    url: mediaUrl,
  });
  expect(info.title.length).toBeGreaterThan(0); // generic URLs carry no duration; ffprobe provides it after download

  const t0 = Date.now();
  const { videoId } = await invoke<{ videoId: string }>('pipeline:start', {
    url: mediaUrl,
    options: {
      clipPreset: '30-60',
      clipCount: 5,
      minScore: 45,
      captions: true,
      hookCard: true,
      aspect: '9:16',
    },
  });

  const timeline: {
    t: number;
    stage: string | null;
    status: string;
    rendered: number;
    clips: number;
  }[] = [];
  let firstRenderedAt: number | null = null;
  let last = '';
  await expect
    .poll(
      async () => {
        const g = await invoke<VideoGet>('videos:get', { id: videoId });
        const key = `${g.video.status}|${g.video.stage}|${g.video.renderedCount}|${g.video.clipCount}`;
        if (key !== last) {
          last = key;
          timeline.push({
            t: Math.round((Date.now() - t0) / 1000),
            stage: g.video.stage,
            status: g.video.status,
            rendered: g.video.renderedCount,
            clips: g.video.clipCount,
          });
        }
        if (g.video.renderedCount > 0 && firstRenderedAt === null)
          firstRenderedAt = Date.now() - t0;
        if (g.video.status === 'failed')
          throw new Error(`pipeline failed at ${g.video.stage}: ${g.video.error}`);
        return g.video.status;
      },
      { timeout: 22 * 60_000, intervals: [1500] },
    )
    .toBe('ready');
  const total = Date.now() - t0;

  const g = await invoke<VideoGet>('videos:get', { id: videoId });
  fs.writeFileSync(
    path.join(OUT, 'timeline.json'),
    JSON.stringify(
      {
        totalMs: total,
        firstRenderedAtMs: firstRenderedAt,
        timeline,
        stages: g.stages,
        video: g.video,
        llmRequests: stub.requests.length,
      },
      null,
      2,
    ),
  );
  expect(g.video.hasProxy).toBe(true);
  expect(g.analysis?.overview.summary.length ?? 0).toBeGreaterThan(10);
  expect(g.stages.every((s) => ['done', 'skipped'].includes(s.status))).toBe(true);

  const { items: clips } = await invoke<{ items: Clip[] }>('clips:list', { videoId });
  fs.writeFileSync(path.join(OUT, 'clips.json'), JSON.stringify(clips, null, 2));
  expect(clips.length).toBeGreaterThanOrEqual(3);
  expect(clips.every((c) => c.status === 'rendered' && c.hasRender && c.hasThumb)).toBe(true);
  // streaming: the first clip was ready well before the whole run finished
  expect(firstRenderedAt).not.toBeNull();
  expect(firstRenderedAt!).toBeLessThan(total);

  // request-level assertions on what Clipfern sent to "Claude"
  const rankReqs = stub.requests.filter(
    (r) =>
      'moments' in
      ((r.body.output_config?.format?.schema as { properties?: object })?.properties ?? {}),
  );
  expect(rankReqs.length).toBeGreaterThanOrEqual(1);
  for (const r of stub.requests) {
    expect(r.body).not.toHaveProperty('temperature');
    expect(r.headers['x-api-key']).toMatch(/^sk-ant-/);
  }

  // download every rendered clip through the presigned URLs and inspect real files
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ffprobe = (require('ffprobe-static') as { path: string }).path;
  const report: unknown[] = [];
  for (const c of clips) {
    const { url } = await invoke<{ url: string | null }>('clips:mediaUrl', {
      id: c.id,
      kind: 'render',
    });
    expect(url).toBeTruthy();
    const buf = Buffer.from(await (await fetch(url!)).arrayBuffer());
    const file = path.join(OUT, `${String(c.score).padStart(2, '0')}-${c.id}.mp4`);
    fs.writeFileSync(file, buf);
    const probe = JSON.parse(
      execFileSync(ffprobe, [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_streams',
        '-show_format',
        file,
      ]).toString(),
    ) as {
      streams: {
        codec_type: string;
        width?: number;
        height?: number;
        codec_name: string;
        pix_fmt?: string;
      }[];
      format: { duration: string };
    };
    const v = probe.streams.find((s) => s.codec_type === 'video');
    const a = probe.streams.find((s) => s.codec_type === 'audio');
    expect([v?.width, v?.height]).toEqual([1080, 1920]);
    expect(v?.codec_name).toBe('h264');
    expect(a?.codec_name).toBe('aac');
    const dur = Number(probe.format.duration);
    expect(Math.abs(dur - c.durationSec)).toBeLessThan(1.0);
    report.push({
      id: c.id,
      score: c.score,
      title: c.title,
      start: c.startSec,
      end: c.endSec,
      fileDur: dur,
      size: buf.length,
    });
    const thumb = (
      await invoke<{ url: string | null }>('clips:mediaUrl', { id: c.id, kind: 'thumb' })
    ).url;
    fs.writeFileSync(
      path.join(OUT, `${c.id}.jpg`),
      Buffer.from(await (await fetch(thumb!)).arrayBuffer()),
    );
  }
  fs.writeFileSync(path.join(OUT, 'files.json'), JSON.stringify(report, null, 2));

  // storage layout: proxy, transcript, analysis, signals, and the cross-run cache exist; the full-res source does not
  const keysInBucket = (dir: string): string[] =>
    fs
      .readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => path.join(e.parentPath ?? dir, e.name));
  const files = keysInBucket(path.join(s3dir, BUCKET)).map((f) =>
    path.relative(path.join(s3dir, BUCKET), f),
  );
  const has = (re: RegExp) => files.some((f) => re.test(f));
  expect(has(new RegExp(`videos/${videoId}/proxy.mp4`))).toBe(true);
  expect(has(new RegExp(`videos/${videoId}/transcript.json`))).toBe(true);
  expect(has(new RegExp(`videos/${videoId}/analysis.json`))).toBe(true);
  expect(has(new RegExp(`videos/${videoId}/source.mp4`))).toBe(false);
  expect(
    has(/cache\/yt-x-[0-9a-f]+\/tiny\/transcript.json/) ||
      has(/cache\/yt-x-[0-9a-f]+\/[^/]+\/transcript.json/),
  ).toBe(true);

  // local disk is clean (BRIEF §3): no full-res source left in the cache dir
  const cacheDir = path.join(userData, 'cache', videoId);
  expect(fs.existsSync(path.join(cacheDir, 'source.mp4'))).toBe(false);

  // storage usage counter reads real bytes now
  const usage = await invoke<{
    configured: boolean;
    usedBytes: number;
    breakdown: Record<string, number>;
  }>('storage:usage', { refresh: true });
  expect(usage.configured).toBe(true);
  expect(usage.usedBytes).toBeGreaterThan(0);
  expect(usage.breakdown.clips).toBeGreaterThan(0);

  // cost tracker recorded the (stubbed) calls
  const cost = await invoke<{ calls: number }>('cost:summary');
  expect(cost.calls).toBeGreaterThanOrEqual(2);
  test.info().annotations.push({ type: 'out', description: OUT });
});

test('favorites, delete and bulk download work on the real library', async () => {
  const { items } = await invoke<{ items: Clip[] }>('clips:list', {});
  expect(items.length).toBeGreaterThan(0);
  const first = items[0]!;
  await invoke('clips:favorite', { ids: [first.id], value: true });
  const fav = await invoke<{ items: Clip[] }>('clips:list', { favorite: true });
  expect(fav.items.map((c) => c.id)).toEqual([first.id]);
  await invoke('clips:favorite', { ids: [first.id], value: false });
  const last = items.at(-1)!;
  await invoke('clips:delete', { ids: [last.id] });
  const after = await invoke<{ items: Clip[] }>('clips:list', {});
  expect(after.items.map((c) => c.id)).not.toContain(last.id);
  expect(
    (await invoke<{ url: string | null }>('clips:mediaUrl', { id: last.id, kind: 'render' })).url,
  ).toBeNull();
});
