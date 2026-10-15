import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PostingService, quotaDay } from '@main/pipeline/posting';
import { SchedulerService } from '@main/pipeline/scheduler';
import type {
  OAuthTokens,
  PublisherProvider,
  PublishArgs,
  PublishMediaService,
} from '@main/pipeline/contracts5';
import { PublishError } from '@main/services/publish/errors';
import { OAuthLoopback } from '@main/services/publish/oauth';
import { TokenStore } from '@main/services/publish/token-store';
import { FileKeyCipher } from '@main/services/secrets';
import { MemoryStorageProvider } from '@main/services/storage/memory';
import { shortsFieldsSchema, type MediaReport, type Platform, type PostDraft } from '@shared/publish';
import { makeServices } from './helpers';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 5, 10, 12, 0, 0);

const INFO = {
  durationSec: 20,
  width: 1080,
  height: 1920,
  fps: 30,
  sizeBytes: 12,
  videoCodec: 'h264',
  audioCodec: 'aac',
};

class FakeProvider implements PublisherProvider {
  readonly platform: Platform = 'shorts';
  readonly scopes = ['x'];
  calls: PublishArgs[] = [];
  bodies: string[] = [];
  failures: PublishError[] = [];
  refreshed = 0;
  async publish(a: PublishArgs) {
    this.calls.push(a);
    this.bodies.push(fs.readFileSync(a.media.file, 'utf8'));
    const f = this.failures.shift();
    if (f) throw f;
    a.onProgress(1, 'done');
    return {
      platformPostId: `vid${this.calls.length}`,
      url: `https://example.test/shorts/vid${this.calls.length}`,
      outcome: 'published' as const,
      note: null,
      quotaUnits: 1,
    };
  }
  authUrl(a: { redirectUri: string; state: string; codeChallenge: string }) {
    return `https://auth.example.test/?redirect_uri=${encodeURIComponent(a.redirectUri)}&state=${a.state}`;
  }
  async exchangeCode() {
    return {
      tokens: { accessToken: 'AT', refreshToken: 'RT', expiresAt: T0 + 3_600_000, scope: null, extra: {} },
      account: {
        externalId: 'UC123',
        displayName: 'My Channel',
        handle: 'mychannel',
        avatarUrl: null,
        scopes: ['x'],
        info: {},
      },
    };
  }
  async refresh(t: OAuthTokens) {
    this.refreshed += 1;
    return { ...t, accessToken: `AT${this.refreshed}`, expiresAt: T0 + 100 * DAY };
  }
  async revoke() {}
  async testConnection() {
    return { ok: true, message: 'ok', detail: null, account: null };
  }
  validateFields() {
    return [];
  }
  quotaCost() {
    return 1;
  }
  async quota(a: { usedPosts: number; now: number }) {
    return { used: a.usedPosts, limit: 100, unit: 'posts' as const, resetsAt: a.now + DAY, postsLeft: 100 - a.usedPosts, note: null };
  }
}

interface Env {
  svc: Awaited<ReturnType<typeof makeServices>>['svc'];
  dir: string;
  cleanup: () => Promise<void>;
  posting: PostingService;
  scheduler: SchedulerService;
  provider: FakeProvider;
  storage: MemoryStorageProvider;
  clock: { now: number };
  notes: string[];
  mediaIssues: { current: MediaReport['issues'] };
  fixCalls: number[];
  clipId: string;
  accountId: string;
  tokens: TokenStore;
  oauth: OAuthLoopback;
  secrets: Set<string>;
}

async function setup(): Promise<Env> {
  const { svc, dir, cleanup } = await makeServices();
  const db = svc.dbHandle.prisma;
  const provider = new FakeProvider();
  const storage = new MemoryStorageProvider();
  const clock = { now: T0 };
  const notes: string[] = [];
  const mediaIssues: { current: MediaReport['issues'] } = { current: [] };
  const fixCalls: number[] = [];
  const tokens = new TokenStore(path.join(dir, 'tokens.bin'), new FileKeyCipher(path.join(dir, 'k2')));
  let port = 55000 + Math.floor(Math.random() * 800);
  const oauth = new OAuthLoopback({
    port: () => port,
    openExternal: async (u) => {
      const url = new URL(u);
      const ru = url.searchParams.get('redirect_uri') as string;
      setTimeout(() => {
        http.get(`${ru}?code=c&state=${url.searchParams.get('state')}`).on('error', () => {});
      }, 10);
    },
  });
  port += 0;
  const media: PublishMediaService = {
    probe: async (file) => ({ ...INFO, sizeBytes: fs.statSync(file).size }),
    validate: ({ info, platform }) => ({
      platform,
      ok: !mediaIssues.current.some((i) => i.severity === 'error'),
      issues: mediaIssues.current,
      media: info,
    }),
    fix: async ({ file, outFile }) => {
      fixCalls.push(1);
      fs.copyFileSync(file, outFile);
      mediaIssues.current = [];
      return { ...INFO, sizeBytes: fs.statSync(outFile).size };
    },
  };
  const secrets = new Set<string>(['google.clientId', 'google.clientSecret']);
  const posts: unknown[] = [];
  const posting = new PostingService({
    db,
    queue: svc.queue,
    brand: { getKit: async () => { throw new Error('no kits'); }, defaultKitId: async () => null },
    providers: { shorts: provider, reels: provider, tiktok: provider },
    tokens,
    oauth,
    media,
    getSettings: () => svc.settings.get(),
    hasSecret: (k) => secrets.has(k),
    getStorage: () => storage,
    cacheDir: path.join(dir, 'cache'),
    ffmpegPath: () => 'ffmpeg',
    notify: async (n) => {
      notes.push(`${n.level}:${n.title}`);
    },
    emit: { post: (p) => posts.push(p), accountsChanged: () => {} },
    now: () => clock.now,
    timeZone: () => 'UTC',
    log: () => {},
  });
  posting.registerJobs();
  const scheduler = new SchedulerService({
    db,
    posting,
    getSettings: () => svc.settings.get(),
    notify: async (n) => {
      notes.push(`${n.level}:${n.title}`);
    },
    trayAvailable: () => false,
    emitStatus: () => {},
    now: () => clock.now,
    timeZone: () => 'UTC',
    tickMs: 3_600_000,
    log: () => {},
  });

  const video = await db.video.create({ data: { sourceUrl: 'https://youtu.be/x', title: 'V' } });
  const clip = await db.clip.create({
    data: { videoId: video.id, title: 'A great clip', startSec: 0, endSec: 20, status: 'rendered' },
  });
  await storage.put(`clips/${clip.id}/clip.mp4`, Buffer.from('fake-mp4-body'), { contentType: 'video/mp4' });
  const acc = await db.socialAccount.create({
    data: { platform: 'shorts', externalId: 'UC1', displayName: 'My Channel' },
  });
  tokens.set(acc.id, { accessToken: 'AT0', refreshToken: 'RT0', expiresAt: T0 + 50 * DAY, scope: null, extra: {} });
  await svc.queue.start();
  return {
    svc, dir, cleanup, posting, scheduler, provider, storage, clock, notes, mediaIssues, fixCalls,
    clipId: clip.id, accountId: acc.id, tokens, oauth, secrets,
  };
}

const draft = (e: Env, over: Partial<PostDraft> = {}): PostDraft => ({
  source: { clipId: e.clipId },
  accountId: e.accountId,
  fields: shortsFieldsSchema.parse({ platform: 'shorts', title: 'Hello', madeForKids: false }),
  scheduledAt: null,
  autoFix: true,
  groupId: null,
  ...over,
});

async function until<T>(fn: () => Promise<T | false | null | undefined> | T | false | null | undefined, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

let env: Env;
beforeEach(async () => {
  env = await setup();
});
afterEach(async () => {
  await env.scheduler.stop();
  await env.cleanup();
});

describe('publish now', () => {
  it('downloads the clip, hands it to the provider, records the result and quota, and notifies', async () => {
    const { posts, refused } = await env.posting.create([draft(env)]);
    expect(refused).toEqual([]);
    const id = posts[0]!.id;
    const done = await until(async () => {
      const p = await env.posting.get(id);
      return p.status === 'published' ? p : false;
    });
    expect(done.result).toMatchObject({ platformPostId: 'vid1', outcome: 'published' });
    expect(env.provider.bodies[0]).toBe('fake-mp4-body');
    expect(env.provider.calls[0]!.media.contentType).toBe('video/mp4');
    expect(await env.provider.calls[0]!.media.presignedUrl()).toContain('clips/');
    const usage = await env.svc.dbHandle.prisma.quotaUsage.findFirstOrThrow({ where: { accountId: env.accountId } });
    expect(usage).toMatchObject({ units: 1, posts: 1, day: quotaDay('shorts', T0) });
    expect(env.notes).toContain('success:Published to YouTube Shorts');
  });

  it('refuses invalid items individually and keeps the valid ones', async () => {
    const { posts, refused } = await env.posting.create([
      draft(env, { accountId: 'nope' }),
      draft(env),
      draft(env, { source: { clipId: 'missing' } }),
    ]);
    expect(posts).toHaveLength(1);
    expect(refused.map((r) => r.index)).toEqual([0, 2]);
  });

  it('refreshes tokens that are about to expire before publishing and stores the new ones', async () => {
    env.tokens.set(env.accountId, { accessToken: 'OLD', refreshToken: 'RT', expiresAt: T0 + 60_000, scope: null, extra: {} });
    const { posts } = await env.posting.create([draft(env)]);
    await until(async () => (await env.posting.get(posts[0]!.id)).status === 'published');
    expect(env.provider.refreshed).toBe(1);
    expect(env.provider.calls[0]!.tokens.accessToken).toBe('AT1');
    expect(env.tokens.get(env.accountId)?.accessToken).toBe('AT1');
  });
});

describe('scheduling', () => {
  it('keeps a future post scheduled and publishes it when its time comes', async () => {
    const { posts } = await env.posting.create([draft(env, { scheduledAt: T0 + 3_600_000 })]);
    const id = posts[0]!.id;
    await env.scheduler.start();
    await env.scheduler.tick();
    expect((await env.posting.get(id)).status).toBe('scheduled');
    expect(env.provider.calls).toHaveLength(0);

    env.clock.now = T0 + 3_600_000 + 1000;
    await env.scheduler.tick();
    await until(async () => (await env.posting.get(id)).status === 'published');
    expect(env.provider.calls).toHaveLength(1);
  });

  it('catch-up: late within the grace window is published, later than the window is marked missed', async () => {
    const late = (await env.posting.create([draft(env, { scheduledAt: T0 + 3_600_000 })])).posts[0]!.id;
    const tooLate = (await env.posting.create([draft(env, { scheduledAt: T0 + 60_000 })])).posts[0]!.id;
    // The app was closed; it opens 3 h after the first, 150 min (> 120 min grace) after… compute explicitly:
    env.clock.now = T0 + 3_600_000 + 30 * 60_000; // late post is 30 min late, the other is 90+ min older → also within 120? make it older
    await env.svc.dbHandle.prisma.post.update({ where: { id: tooLate }, data: { scheduledAt: new Date(T0 - 3 * 3_600_000) } });
    await env.scheduler.start(); // catch-up runs at start
    await until(async () => (await env.posting.get(late)).status === 'published');
    const missed = await env.posting.get(tooLate);
    expect(missed.status).toBe('missed');
    expect(missed.error?.message).toMatch(/not running/);
    expect(env.notes.some((n) => n.includes('caught up'))).toBe(true);
    // a missed post can be retried explicitly
    await env.posting.retry(tooLate);
    await until(async () => (await env.posting.get(tooLate)).status === 'published');
  });

  it('does nothing while paused and resumes afterwards', async () => {
    const id = (await env.posting.create([draft(env, { scheduledAt: T0 + 1000 })])).posts[0]!.id;
    await env.scheduler.start();
    await env.scheduler.setPaused(true);
    env.clock.now = T0 + 5000;
    await env.scheduler.tick();
    expect((await env.posting.get(id)).status).toBe('scheduled');
    expect((await env.scheduler.status()).paused).toBe(true);
    await env.scheduler.setPaused(false);
    await until(async () => (await env.posting.get(id)).status === 'published');
  });

  it('status reports upcoming posts, the next time and quota', async () => {
    await env.posting.create([draft(env, { scheduledAt: T0 + 7200_000 }), draft(env, { scheduledAt: T0 + 3600_000 })]);
    await env.scheduler.start();
    const st = await env.scheduler.status();
    expect(st).toMatchObject({ active: true, upcoming: 2, nextAt: T0 + 3600_000 });
    expect(st.quota[0]).toMatchObject({ platform: 'shorts', limit: 100 });
  });
});

describe('failures', () => {
  it('retries a network failure with backoff and succeeds the second time', async () => {
    env.provider.failures.push(new PublishError('network', 'connection reset'));
    const id = (await env.posting.create([draft(env)])).posts[0]!.id;
    const waiting = await until(async () => {
      const p = await env.posting.get(id);
      return p.status === 'scheduled' ? p : false;
    });
    expect(waiting.error).toMatchObject({ code: 'network', retryable: true });
    expect(waiting.nextAttemptAt).toBeGreaterThan(T0);
    expect(waiting.attempts).toBe(1);
    await env.scheduler.start();
    env.clock.now = waiting.nextAttemptAt! + 1000;
    await env.scheduler.tick();
    const done = await until(async () => {
      const p = await env.posting.get(id);
      return p.status === 'published' ? p : false;
    });
    expect(done.attempts).toBe(2);
    expect(done.error).toBeNull();
  });

  it('an auth error fails the post and flags the account for re-connecting', async () => {
    env.provider.failures.push(new PublishError('auth', 'token revoked', { retryable: false, hint: 'Reconnect.' }));
    const id = (await env.posting.create([draft(env)])).posts[0]!.id;
    const p = await until(async () => {
      const v = await env.posting.get(id);
      return v.status === 'failed' ? v : false;
    });
    expect(p.error).toMatchObject({ code: 'auth', hint: 'Reconnect.' });
    const acc = await env.svc.dbHandle.prisma.socialAccount.findUniqueOrThrow({ where: { id: env.accountId } });
    expect(acc.status).toBe('needs-reauth');
    expect(env.notes.some((n) => n.startsWith('error:'))).toBe(true);
  });

  it('a quota error waits for the reset instead of hammering the platform', async () => {
    env.provider.failures.push(new PublishError('quota', 'daily limit', { retryAfterSec: 6 * 3600 }));
    const id = (await env.posting.create([draft(env)])).posts[0]!.id;
    const p = await until(async () => {
      const v = await env.posting.get(id);
      return v.status === 'scheduled' ? v : false;
    });
    expect(p.nextAttemptAt!).toBeGreaterThanOrEqual(T0 + 6 * 3600_000);
  });

  it('gives up after the maximum number of attempts', async () => {
    for (let i = 0; i < 6; i++) env.provider.failures.push(new PublishError('platform', 'boom'));
    const id = (await env.posting.create([draft(env)])).posts[0]!.id;
    await env.scheduler.start();
    for (let i = 0; i < 8; i++) {
      const p = await until(async () => {
        const v = await env.posting.get(id);
        return v.status === 'scheduled' || v.status === 'failed' ? v : false;
      });
      if (p.status === 'failed') break;
      env.clock.now = p.nextAttemptAt! + 1000;
      await env.scheduler.tick();
    }
    const final = await env.posting.get(id);
    expect(final.status).toBe('failed');
    expect(final.attempts).toBeLessThanOrEqual(4);
  });
});

describe('media checks and auto-fix', () => {
  const issue = (fixable: boolean): MediaReport['issues'] => [
    { severity: 'error', code: 'fps', message: 'Frame rate too high.', fixable },
  ];

  it('refuses an out-of-spec file when auto-fix is off, or when the issue cannot be fixed', async () => {
    env.mediaIssues.current = issue(true);
    const a = await env.posting.create([draft(env, { autoFix: false })]);
    expect(a.posts).toHaveLength(0);
    expect(a.refused[0]!.report?.issues[0]?.code).toBe('fps');
    env.mediaIssues.current = issue(false);
    const b = await env.posting.create([draft(env, { autoFix: true })]);
    expect(b.refused).toHaveLength(1);
  });

  it('re-encodes a fixable file once and uploads the fixed copy', async () => {
    env.mediaIssues.current = issue(true);
    const { posts } = await env.posting.create([draft(env)]);
    const done = await until(async () => {
      const p = await env.posting.get(posts[0]!.id);
      return p.status === 'published' ? p : false;
    });
    expect(env.fixCalls).toHaveLength(1);
    expect(done.autoFixed).toBe(true);
    expect(await env.storage.head(`posts/${done.id}/media.mp4`)).not.toBeNull();
  });
});

describe('editing rules', () => {
  it('only drafts, scheduled, failed and missed posts can be edited; cancel keeps history', async () => {
    const id = (await env.posting.create([draft(env, { scheduledAt: T0 + DAY })])).posts[0]!.id;
    const edited = await env.posting.update({
      id,
      fields: shortsFieldsSchema.parse({ platform: 'shorts', title: 'New title', madeForKids: true }),
      scheduledAt: T0 + 2 * DAY,
    });
    expect(edited.title).toBe('New title');
    expect(edited.scheduledAt).toBe(T0 + 2 * DAY);
    const asDraft = await env.posting.update({ id, scheduledAt: null });
    expect(asDraft.status).toBe('draft');
    const canceled = await env.posting.cancel(id);
    expect(canceled.status).toBe('canceled');
    await expect(env.posting.update({ id, scheduledAt: T0 + DAY })).rejects.toThrow(/can no longer be edited/);
    await expect(env.posting.retry(id)).rejects.toThrow(/failed or missed/);
  });

  it('disconnecting an account turns its pending posts into drafts and forgets its tokens', async () => {
    const id = (await env.posting.create([draft(env, { scheduledAt: T0 + DAY })])).posts[0]!.id;
    await env.posting.disconnect(env.accountId);
    const p = await env.posting.get(id);
    expect(p.status).toBe('draft');
    expect(p.scheduledAt).toBeNull();
    expect(env.tokens.has(env.accountId)).toBe(false);
    expect((await env.posting.listAccounts()).accounts).toHaveLength(0);
  });

  it('lists by window and status', async () => {
    await env.posting.create([draft(env, { scheduledAt: T0 + DAY }), draft(env, { scheduledAt: T0 + 5 * DAY })]);
    const r = await env.posting.list({ from: T0, to: T0 + 2 * DAY, limit: 50 });
    expect(r.items).toHaveLength(1);
    const s = await env.posting.list({ statuses: ['draft'], limit: 50 });
    expect(s.items).toHaveLength(0);
  });
});

describe('connecting accounts', () => {
  it('needs saved developer-app credentials', async () => {
    env.secrets.clear();
    await expect(env.posting.connect('shorts')).rejects.toThrow(/credentials/);
    expect(env.posting.setup().find((s) => s.platform === 'shorts')?.configured).toBe(false);
  });

  it('runs the loopback flow, stores the account and keeps tokens out of the renderer-facing row', async () => {
    const acc = await env.posting.connect('shorts');
    expect(acc).toMatchObject({ displayName: 'My Channel', handle: 'mychannel', status: 'connected' });
    expect(JSON.stringify(acc)).not.toContain('AT');
    expect(env.tokens.get(acc.id)?.refreshToken).toBe('RT');
  });
});

describe('digest', () => {
  it('summarises today and what needs attention', async () => {
    await env.posting.create([draft(env, { scheduledAt: T0 + 3600_000 })]);
    await env.scheduler.start();
    const r = await env.scheduler.digestNow();
    expect(r.sent).toBe(true);
    expect(env.notes).toContain('info:Your posting day');
  });
});
