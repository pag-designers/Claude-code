import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
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
import { createClient } from '@libsql/client';
import type { PostView, SchedulerStatus, SocialAccount } from '../../shared/publish';
import { startSmartAnthropicStub } from '../support/e2e-anthropic';
import { startFakeInstagram, type FakeInstagram } from '../support/fake-instagram';
import { startFakeTiktok, type FakeTiktok } from '../support/fake-tiktok';
import { startFakeYoutube, type FakeYoutube } from '../support/fake-youtube';
import type { StubAnthropic } from '../unit/llm-stub-server';

/**
 * CP5 (posting + scheduler) end-to-end in the REAL Electron app on REAL media. The platforms are local fake servers
 * (test/support/fake-{youtube,instagram,tiktok}.ts, written from the official docs); the system browser is replaced by a
 * stub that follows the consent URL, so the loopback OAuth redirect (PKCE + state) is the real one. Claude is scripted.
 * Covers: connect three accounts (tokens never leave main, never reach the log), post now, scheduled post published by
 * the real scheduler loop, Instagram pulling the video from a presigned URL (hash compared), TikTok's unaudited limits,
 * quota / auth failures and recovery, pause, restart catch-up (late within the grace window → published, too late →
 * missed), the daily digest.
 *
 * Run: CLIPFERN_E2E_CP1_VIDEO=<mp4> CLIPFERN_E2E_SIDECAR_USERDATA=<ud> CLIPFERN_E2E_OUT=<dir> \
 *   xvfb-run -a pnpm exec playwright test test/e2e/cp5-posting.spec.ts
 */
const VIDEO = process.env.CLIPFERN_E2E_CP1_VIDEO;
const SIDECAR_BASE = process.env.CLIPFERN_E2E_SIDECAR_USERDATA;
const OUT =
  process.env.CLIPFERN_E2E_OUT ?? fs.mkdtempSync(path.join(os.tmpdir(), 'clipfern-cp5-out-'));
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

const S3_PORT = 4585;
const BUCKET = 'clipfern-cp5';
const LOOPBACK_PORT = 53691;
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'clipfern-cp5-work-'));

let app: ElectronApplication;
let page: Page;
let userData: string;
let s3: { close(): Promise<void> };
let media: http.Server;
let mediaUrl: string;
let stub: StubAnthropic;
let yt: FakeYoutube;
let ig: FakeInstagram;
let tt: FakeTiktok;
let videoId = '';
let clipId = '';
let clipSha = '';
const accounts: Partial<Record<'shorts' | 'reels' | 'tiktok', SocialAccount>> = {};

const invoke = <T = unknown>(channel: string, payload?: unknown) =>
  page.evaluate(
    ([c, p]) =>
      (
        window as unknown as { clipfern: { invoke(c: string, p?: unknown): Promise<unknown> } }
      ).clipfern.invoke(c as string, p) as Promise<T>,
    [channel, payload] as const,
  );

const sha256 = (file: string) =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function waitPost(id: string, status: PostView['status'], ms = 60_000): Promise<PostView> {
  let last: PostView | null = null;
  await expect
    .poll(
      async () => {
        last = await invoke<PostView>('posts:get', { id });
        return last.status;
      },
      { timeout: ms, intervals: [400], message: `waiting for post ${id} to be ${status}` },
    )
    .toBe(status);
  return last!;
}

async function launch(): Promise<void> {
  const exe = process.env.CLIPFERN_E2E_EXE;
  app = await electron.launch({
    ...(exe ? { executablePath: exe } : {}),
    args: [
      '--no-sandbox',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
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
      CLIPFERN_GOOGLE_OAUTH_BASE: yt.urls.oauthBase,
      CLIPFERN_YOUTUBE_API_BASE: yt.urls.apiBase,
      CLIPFERN_YOUTUBE_UPLOAD_BASE: yt.urls.uploadBase,
      CLIPFERN_META_OAUTH_BASE: ig.urls.oauthBase,
      CLIPFERN_GRAPH_BASE: ig.urls.graphBase,
      CLIPFERN_TIKTOK_AUTH_BASE: tt.urls.authBase,
      CLIPFERN_TIKTOK_API_BASE: tt.urls.apiBase,
      CLIPFERN_SCHEDULER_TICK_MS: '1000',
      CLIPFERN_SKIP_QUIT_CONFIRM: '1',
      ANTHROPIC_API_KEY: 'sk-ant-api03-E2E-NOT-A-REAL-KEY-000000',
    },
  });
  page = await app.firstWindow();
  await page.waitForFunction(() => !!(window as unknown as { clipfern?: unknown }).clipfern);
  // The "system browser": follow the consent URL; the fake redirects to the app's loopback server.
  await app.evaluate(({ shell }) => {
    shell.openExternal = (async (u: string) => {
      void fetch(u).catch(() => {});
    }) as never;
  });
}

test.beforeAll(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const s3dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipfern-s3-'));
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
  const redirect = (p: string) => [`http://127.0.0.1:${LOOPBACK_PORT}/oauth/${p}`];
  yt = await startFakeYoutube();
  ig = await startFakeInstagram({ redirectUris: redirect('reels') });
  tt = await startFakeTiktok({ audited: false, redirectUris: redirect('tiktok') });

  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'clipfern-cp5-ud-'));
  for (const d of ['sidecar-venv', 'models', 'uv']) {
    if (fs.existsSync(path.join(SIDECAR_BASE!, d)))
      execFileSync('cp', ['-al', path.join(SIDECAR_BASE!, d), path.join(userData, d)]);
  }
  await launch();
  await invoke('settings:set', {
    r2Bucket: BUCKET,
    whisperModel: 'tiny',
    oauthLoopbackPort: LOOPBACK_PORT,
  });
});

test.afterAll(async () => {
  await app?.close().catch(() => {});
  await Promise.allSettled([stub?.stop(), s3?.close(), yt?.stop(), ig?.stop(), tt?.stop()]);
  media?.close();
});

/* -------------------------------------------------------------------------------- setup ------------ */

test('a real run produces a rendered clip to post', async () => {
  test.setTimeout(30 * 60_000);
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
    options: { clipPreset: '30-60', clipCount: 1, minScore: 45, captions: true, aspect: '9:16' },
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
  const { items } = await invoke<{ items: { id: string; status: string }[] }>('clips:list', {
    videoId,
  });
  const clip = items.find((c) => c.status === 'rendered')!;
  expect(clip).toBeTruthy();
  clipId = clip.id;

  // the file the platforms must receive byte for byte
  const dir = fs.mkdtempSync(path.join(WORK, 'dl-'));
  await app.evaluate(({ dialog }, d) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [d] })) as never;
  }, dir);
  await invoke('clips:download', { ids: [clipId], withCaptions: false });
  const mp4 = fs.readdirSync(dir).find((f) => f.endsWith('.mp4'))!;
  clipSha = sha256(path.join(dir, mp4));
  fs.copyFileSync(path.join(dir, mp4), path.join(OUT, 'clip-to-post.mp4'));
});

test('connect YouTube, Instagram and TikTok through the real loopback OAuth flow', async () => {
  // before any credentials: connecting says what is missing
  const before = await invoke<{
    setup: { platform: string; configured: boolean; redirectUri: string }[];
  }>('accounts:list');
  expect(before.setup.every((s) => !s.configured)).toBe(true);
  expect(before.setup.find((s) => s.platform === 'shorts')!.redirectUri).toBe(
    `http://127.0.0.1:${LOOPBACK_PORT}/oauth/shorts`,
  );
  await expect(invoke('accounts:connect', { platform: 'shorts' })).rejects.toThrow(/credentials/i);

  const set = (key: string, value: string) => invoke('secrets:set', { key, value });
  await set('google.clientId', yt.clientId);
  await set('google.clientSecret', yt.clientSecret);
  await set('meta.appId', ig.state.appId);
  await set('meta.appSecret', ig.state.appSecret);
  await set('tiktok.clientKey', tt.state.clientKey);
  await set('tiktok.clientSecret', tt.state.clientSecret);

  for (const platform of ['shorts', 'reels', 'tiktok'] as const) {
    const { account } = await invoke<{ account: SocialAccount }>('accounts:connect', { platform });
    expect(account.status).toBe('connected');
    accounts[platform] = account;
  }
  expect(accounts.shorts).toMatchObject({ displayName: 'Fake Clips Channel', handle: 'fakeclips' });
  expect(accounts.reels).toMatchObject({ handle: 'clipfern_test' });
  expect(accounts.tiktok).toMatchObject({ displayName: expect.any(String) });
  // PKCE + state were really exchanged with Google's fake
  expect(yt.state.authRequests[0]).toMatchObject({ codeChallengeMethod: 'S256' });
  expect(yt.state.authRequests[0]!.state).toBeTruthy();

  const list = await invoke<{ accounts: SocialAccount[]; setup: { configured: boolean }[] }>(
    'accounts:list',
  );
  expect(list.accounts).toHaveLength(3);
  expect(list.setup.every((s) => s.configured)).toBe(true);
});

test('tokens stay in main: encrypted on disk, absent from IPC output and from the log', async () => {
  const everyToken = [
    ...yt.state.tokens.accessIssued,
    ...yt.state.tokens.refreshIssued,
    ...ig.state.tokens.map((t) => t.value),
    ...tt.state.tokensIssued.access,
    ...tt.state.tokensIssued.refresh,
  ].filter((t) => t.length > 8);
  expect(everyToken.length).toBeGreaterThan(3);
  const ipc = JSON.stringify(await invoke('accounts:list'));
  const blob = fs.readFileSync(path.join(userData, 'tokens.bin')).toString('latin1');
  const log = fs.readFileSync(path.join(userData, 'logs', 'main.log'), 'utf8');
  for (const t of everyToken) {
    expect(ipc).not.toContain(t);
    expect(blob).not.toContain(t);
    expect(log).not.toContain(t);
  }
  expect(log).not.toContain(yt.clientSecret);
  expect(log).not.toContain(ig.state.appSecret);
});

/* ------------------------------------------------------------------------------ publishing ---------- */

test('prefill gives the clip’s own title and hashtags; YouTube "post now" uploads the exact file', async () => {
  test.setTimeout(180_000);
  const pre = await invoke<{ title: string; fields: Record<string, unknown> }>('publish:prefill', {
    source: { clipId },
    platform: 'shorts',
  });
  expect(pre.title.length).toBeGreaterThan(0);
  expect(pre.fields.platform).toBe('shorts');

  const validate = await invoke<{
    report: { ok: boolean; media: { width: number; height: number } };
  }>('publish:validate', { source: { clipId }, platform: 'shorts' });
  expect(validate.report.ok).toBe(true);
  expect(validate.report.media.height).toBeGreaterThan(validate.report.media.width);

  const r = await invoke<{ posts: PostView[]; refused: unknown[] }>('posts:create', {
    items: [
      {
        source: { clipId },
        accountId: accounts.shorts!.id,
        fields: { ...pre.fields, title: 'E2E Short', madeForKids: false },
        scheduledAt: null,
      },
    ],
  });
  expect(r.refused).toEqual([]);
  const done = await waitPost(r.posts[0]!.id, 'published');
  expect(done.result).toMatchObject({ outcome: 'published' });
  expect(done.result!.url).toMatch(/shorts\//);

  const v = yt.state.videos.at(-1)!;
  expect(v.sha256).toBe(clipSha); // byte for byte what the Library holds
  expect(v.metadata.snippet?.title).toBe('E2E Short');
  expect(v.metadata.status?.selfDeclaredMadeForKids).toBe(false);
  expect(v.metadata.snippet?.description).toMatch(/#Shorts/);
  expect(yt.state.counters.badChunks).toBe(0);
  // the clip knows it was posted
  const forClip = await invoke<{ items: PostView[] }>('posts:list', { clipId, limit: 50 });
  expect(forClip.items.map((p) => p.platform)).toContain('shorts');
});

test('a scheduled Instagram Reel goes out by itself at its time; Instagram pulls the video from a presigned URL', async () => {
  test.setTimeout(120_000);
  const at = Date.now() + 4_000;
  const r = await invoke<{ posts: PostView[]; refused: unknown[] }>('posts:create', {
    items: [
      {
        source: { clipId },
        accountId: accounts.reels!.id,
        fields: { platform: 'reels', caption: 'E2E reel #clipfern', firstComment: 'first!' },
        scheduledAt: at,
      },
    ],
  });
  expect(r.refused).toEqual([]);
  const id = r.posts[0]!.id;
  expect(r.posts[0]!.status).toBe('scheduled');
  // not before its time
  await new Promise((res) => setTimeout(res, 1500));
  expect((await invoke<PostView>('posts:get', { id })).status).toBe('scheduled');
  expect(ig.state.containers).toHaveLength(0);

  const done = await waitPost(id, 'published', 90_000);
  expect(done.publishedAt!).toBeGreaterThanOrEqual(at - 500);
  const fetched = ig.state.fetchedVideos.at(-1)!;
  expect(fetched).toMatchObject({ ok: true, httpStatus: 200 });
  expect(fetched.sha256).toBe(clipSha);
  expect(fetched.url).toContain('X-Amz-Signature');
  const media = ig.state.media.at(-1)!;
  expect(media.caption).toBe('E2E reel #clipfern');
  expect(media.comments.map((c) => c.message)).toContain('first!');
  // the signed URL never reached the log
  const log = fs.readFileSync(path.join(userData, 'logs', 'main.log'), 'utf8');
  expect(log).not.toContain('X-Amz-Signature');
});

test('TikTok (unaudited app): never public; the platform’s limit is explained, not hidden', async () => {
  test.setTimeout(120_000);
  const test1 = await invoke<{ ok: boolean }>('accounts:test', { id: accounts.tiktok!.id });
  expect(test1.ok).toBe(true);
  const base = {
    source: { clipId },
    accountId: accounts.tiktok!.id,
    scheduledAt: null,
  };
  const wantPublic = await invoke<{ posts: PostView[]; refused: { reason: string }[] }>(
    'posts:create',
    {
      items: [
        {
          ...base,
          fields: { platform: 'tiktok', title: 'E2E tt', privacyLevel: 'PUBLIC_TO_EVERYONE' },
        },
      ],
    },
  );
  if (wantPublic.refused.length) {
    expect(wantPublic.refused[0]!.reason).toMatch(/only me|private|audit|SELF_ONLY|privacy/i);
  } else {
    const done = await waitPost(wantPublic.posts[0]!.id, 'published');
    expect(done.result!.note).toMatch(/private|only me|SELF_ONLY|audit/i);
  }
  expect(tt.state.published.every((u) => u.postInfo?.privacy_level === 'SELF_ONLY')).toBe(true);

  const priv = await invoke<{ posts: PostView[]; refused: unknown[] }>('posts:create', {
    items: [
      {
        ...base,
        fields: { platform: 'tiktok', title: 'E2E tt private', privacyLevel: 'SELF_ONLY' },
      },
    ],
  });
  expect(priv.refused).toEqual([]);
  await waitPost(priv.posts[0]!.id, 'published');
  expect(tt.state.published.at(-1)!.sha256).toBe(clipSha);

  // draft mode: lands in the TikTok inbox, outcome says so
  const draft = await invoke<{ posts: PostView[] }>('posts:create', {
    items: [{ ...base, fields: { platform: 'tiktok', title: 'E2E draft', mode: 'draft' } }],
  });
  const d = await waitPost(draft.posts[0]!.id, 'published');
  expect(d.result).toMatchObject({ outcome: 'draft-uploaded' });
  expect(tt.state.inbox).toHaveLength(1);
});

/* ------------------------------------------------------------------------------- failures ----------- */

test('a quota error waits for the reset (shown with its reason), and Retry recovers', async () => {
  test.setTimeout(120_000);
  yt.control.failNext('quota', 1);
  const r = await invoke<{ posts: PostView[] }>('posts:create', {
    items: [
      {
        source: { clipId },
        accountId: accounts.shorts!.id,
        fields: { platform: 'shorts', title: 'E2E quota', madeForKids: false },
        scheduledAt: null,
      },
    ],
  });
  const id = r.posts[0]!.id;
  const waiting = await waitPost(id, 'scheduled');
  expect(waiting.error).toMatchObject({ code: 'quota', retryable: true });
  expect(waiting.nextAttemptAt!).toBeGreaterThan(Date.now() + 60_000); // waits for the Pacific midnight, not seconds
  expect(waiting.error!.hint ?? waiting.error!.message).toBeTruthy();
  const retried = await invoke<PostView>('posts:retry', { id }).catch(async () =>
    invoke<PostView>('posts:postNow', { id }),
  );
  expect(['queued', 'publishing', 'published']).toContain(retried.status);
  await waitPost(id, 'published');
});

test('a revoked grant fails the post, flags the account, and reconnecting fixes it', async () => {
  test.setTimeout(120_000);
  yt.control.expireAccessTokens();
  yt.control.expireRefreshTokens();
  // force a refresh attempt by making the stored token look expired: the fake rejects both
  const r = await invoke<{ posts: PostView[] }>('posts:create', {
    items: [
      {
        source: { clipId },
        accountId: accounts.shorts!.id,
        fields: { platform: 'shorts', title: 'E2E auth', madeForKids: false },
        scheduledAt: null,
      },
    ],
  });
  const failed = await waitPost(r.posts[0]!.id, 'failed');
  expect(failed.error).toMatchObject({ code: 'auth' });
  const list = await invoke<{ accounts: SocialAccount[] }>('accounts:list');
  expect(list.accounts.find((a) => a.id === accounts.shorts!.id)!.status).toBe('needs-reauth');

  // reconnect (the fake issues fresh tokens), then retry the same post
  const { account } = await invoke<{ account: SocialAccount }>('accounts:connect', {
    platform: 'shorts',
  });
  expect(account.id).toBe(accounts.shorts!.id); // same account row, so scheduled posts keep pointing at it
  expect(account.status).toBe('connected');
  await invoke('posts:retry', { id: failed.id });
  await waitPost(failed.id, 'published');
});

/* ---------------------------------------------------------------------------- scheduler controls ----- */

test('pause stops the scheduler, resume releases what was waiting; status shows next time and quota', async () => {
  test.setTimeout(120_000);
  const paused = await invoke<SchedulerStatus>('scheduler:setPaused', { paused: true });
  expect(paused.paused).toBe(true);
  const at = Date.now() + 2_000;
  const r = await invoke<{ posts: PostView[] }>('posts:create', {
    items: [
      {
        source: { clipId },
        accountId: accounts.shorts!.id,
        fields: { platform: 'shorts', title: 'E2E paused', madeForKids: false },
        scheduledAt: at,
      },
    ],
  });
  const id = r.posts[0]!.id;
  const st = await invoke<SchedulerStatus>('scheduler:status');
  expect(st).toMatchObject({ active: true, paused: true, upcoming: 1, nextAt: at });
  expect(st.quota.some((q) => q.platform === 'shorts' && q.used >= 1)).toBe(true);
  await new Promise((res) => setTimeout(res, 4_000));
  expect((await invoke<PostView>('posts:get', { id })).status).toBe('scheduled'); // overdue, but paused
  await invoke('scheduler:setPaused', { paused: false });
  await waitPost(id, 'published');
});

test('the daily digest is a real notification', async () => {
  const r = await invoke<{ sent: boolean }>('scheduler:digestNow');
  expect(r.sent).toBe(true);
  const n = await invoke<{ items: { title: string; kind: string }[] }>('notifications:list', {
    limit: 50,
  });
  expect(n.items.some((x) => x.kind === 'post' && /posting day/i.test(x.title))).toBe(true);
});

/* ------------------------------------------------------------------------------------ restart ------- */

test('restart: a post that came due while closed is published (within grace) or marked missed (too late)', async () => {
  test.setTimeout(240_000);
  const future = Date.now() + 3_600_000;
  const mk = async (title: string) =>
    (
      await invoke<{ posts: PostView[] }>('posts:create', {
        items: [
          {
            source: { clipId },
            accountId: accounts.shorts!.id,
            fields: { platform: 'shorts', title, madeForKids: false },
            scheduledAt: future,
          },
        ],
      })
    ).posts[0]!.id;
  const late = await mk('E2E late 10 min');
  const tooLate = await mk('E2E too late');
  const stillFuture = await mk('E2E still future');
  const before = yt.state.videos.length;

  const pid = app.process().pid!;
  await app.close();
  expect(() => process.kill(pid, 0)).toThrow(); // really gone: nothing else holds the database
  // The app is closed. Time passes: edit the stored schedule directly.
  const db = createClient({ url: `file:${path.join(userData, 'clipfern.db')}` });
  expect((await db.execute('PRAGMA integrity_check')).rows[0]![0]).toBe('ok'); // a clean shutdown leaves a sound file
  const sample = await db.execute({
    sql: 'SELECT scheduledAt FROM Post WHERE id = ?',
    args: [late],
  });
  const raw = sample.rows[0]!.scheduledAt;
  const enc = (ms: number) =>
    typeof raw === 'number' || typeof raw === 'bigint' ? ms : new Date(ms).toISOString();
  await db.execute({
    sql: 'UPDATE Post SET scheduledAt = ? WHERE id = ?',
    args: [enc(Date.now() - 10 * 60_000), late],
  });
  await db.execute({
    sql: 'UPDATE Post SET scheduledAt = ? WHERE id = ?',
    args: [enc(Date.now() - 5 * 3_600_000), tooLate],
  });
  expect((await db.execute('PRAGMA integrity_check')).rows[0]![0]).toBe('ok');
  // leave no -wal/-shm of this (different) SQLite build behind for the app to inherit
  await db.execute('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  const walFile = path.join(userData, 'clipfern.db-wal');
  expect(fs.existsSync(walFile) ? fs.statSync(walFile).size : 0).toBe(0);
  fs.rmSync(path.join(userData, 'clipfern.db-shm'), { force: true }); // nobody has the database open

  await launch();
  await waitPost(late, 'published', 90_000);
  const missed = await waitPost(tooLate, 'missed', 30_000);
  expect(missed.error?.message).toMatch(/not running/i);
  expect((await invoke<PostView>('posts:get', { id: stillFuture })).status).toBe('scheduled');
  expect(yt.state.videos.length).toBe(before + 1); // exactly one upload happened (no duplicates)
  const n = await invoke<{ items: { title: string }[] }>('notifications:list', { limit: 50 });
  expect(n.items.some((x) => /caught up/i.test(x.title))).toBe(true);

  // accounts and tokens survived the restart
  const st = await invoke<SchedulerStatus>('scheduler:status');
  expect(st.catchUp.lastRunAt).not.toBeNull();
  const list = await invoke<{ accounts: SocialAccount[] }>('accounts:list');
  expect(list.accounts.every((a) => a.status === 'connected')).toBe(true);

  // the user can reschedule a missed post
  await invoke('posts:retry', { id: tooLate });
  await waitPost(tooLate, 'published');
});

/* ------------------------------------------------------------------------------------ cleanup ------- */

test('disconnecting forgets the account and turns its pending posts into drafts', async () => {
  const future = Date.now() + 3_600_000;
  const r = await invoke<{ posts: PostView[] }>('posts:create', {
    items: [
      {
        source: { clipId },
        accountId: accounts.reels!.id,
        fields: { platform: 'reels', caption: 'will be a draft' },
        scheduledAt: future,
      },
    ],
  });
  await invoke('accounts:disconnect', { id: accounts.reels!.id });
  const p = await invoke<PostView>('posts:get', { id: r.posts[0]!.id });
  expect(p.status).toBe('draft');
  expect(p.scheduledAt).toBeNull();
  const list = await invoke<{ accounts: SocialAccount[] }>('accounts:list');
  expect(list.accounts.map((a) => a.platform).sort()).toEqual(['shorts', 'tiktok']);
  // and still no secret in the log after all of the above
  const log = fs.readFileSync(path.join(userData, 'logs', 'main.log'), 'utf8');
  for (const t of [...yt.state.tokens.accessIssued, ...yt.state.tokens.refreshIssued])
    expect(log).not.toContain(t);
});
