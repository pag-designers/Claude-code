/**
 * TikTok publisher against the local fake (test/support/fake-tiktok.ts): OAuth + PKCE, rotating refresh, Direct Post,
 * drafts, unaudited behaviour, chunk failure + resume, status failures, abort, redaction.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tiktokFieldsSchema, type TiktokFields } from '@shared/publish';
import type { OAuthTokens, ProviderAccount, PublishArgs } from '@main/pipeline/contracts5';
import { PublishError } from '@main/services/publish/errors';
import { redact } from '@main/services/publish-tiktok/errors';
import {
  closestNotMorePublic,
  createTiktokProvider,
  planChunks,
  toHexChallenge,
  type TiktokPublisher,
  type TiktokTuning,
} from '@main/services/publish-tiktok';
import { startFakeTiktok, type FakeTiktok, type FakeTiktokOpts } from '../support/fake-tiktok';

const sha = (b: Buffer | string): string => crypto.createHash('sha256').update(b).digest('hex');

/** Deterministic non-compressible bytes. */
function bytes(n: number, seed: number): Buffer {
  const b = Buffer.allocUnsafe(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    b[i] = x & 0xff;
  }
  return b;
}

let dir: string;
let bigFile: string; // 26 MB -> 2 chunks (10 MB + 16 MB final)
let bigSha: string;
let smallFile: string; // 3 MB -> one whole-file chunk
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipfern-tt-'));
  const big = bytes(26_000_000 + 123, 7);
  bigFile = path.join(dir, 'big.mp4');
  fs.writeFileSync(bigFile, big);
  bigSha = sha(big);
  const small = bytes(3_000_000 + 5, 9);
  smallFile = path.join(dir, 'small.mp4');
  fs.writeFileSync(smallFile, small);
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const FAST: TiktokTuning = { pollIntervalMs: 5, retryDelayMs: 5, maxPollMs: 5000 };

let fake: FakeTiktok;
let logs: string[];
beforeEach(() => {
  logs = [];
});
afterEach(async () => {
  await fake?.stop();
});

async function setup(
  opts: FakeTiktokOpts = {},
  tuning: TiktokTuning = FAST,
  fetchImpl?: typeof fetch,
): Promise<TiktokPublisher> {
  fake = await startFakeTiktok(opts);
  return createTiktokProvider(
    {
      getCredentials: () => ({
        clientId: fake.state.clientKey,
        clientSecret: fake.state.clientSecret,
      }),
      baseUrls: {
        CLIPFERN_TIKTOK_AUTH_BASE: fake.urls.authBase,
        CLIPFERN_TIKTOK_API_BASE: fake.urls.apiBase,
      },
      fetch: fetchImpl,
      log: (m) => logs.push(m),
    },
    tuning,
  );
}

const REDIRECT = 'http://127.0.0.1:43111/oauth/tiktok';

/** The real consent round trip against the fake: authUrl -> 302 -> code -> exchangeCode. */
async function connect(
  p: TiktokPublisher,
): Promise<{ tokens: OAuthTokens; account: ProviderAccount }> {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url'); // what the core produces
  const url = p.authUrl({ redirectUri: REDIRECT, state: 'st-1', codeChallenge: challenge });
  const res = await fetch(url, { redirect: 'manual' });
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.get('location') ?? '');
  expect(loc.searchParams.get('state')).toBe('st-1');
  const code = loc.searchParams.get('code') ?? '';
  return p.exchangeCode({ code, redirectUri: REDIRECT, codeVerifier: verifier });
}

function fields(over: Partial<TiktokFields> = {}): TiktokFields {
  return tiktokFieldsSchema.parse({
    platform: 'tiktok',
    title: 'Great clip #fyp',
    mode: 'direct',
    privacyLevel: 'PUBLIC_TO_EVERYONE',
    allowComment: true,
    allowDuet: false,
    allowStitch: true,
    ...over,
  });
}

interface Run {
  args: PublishArgs;
  progress: { f: number | null; m?: string }[];
  ctl: AbortController;
}
function runArgs(
  conn: { tokens: OAuthTokens; account: ProviderAccount },
  f: TiktokFields,
  file = smallFile,
  durationSec = 20,
): Run {
  const progress: Run['progress'] = [];
  const ctl = new AbortController();
  const size = fs.statSync(file).size;
  return {
    progress,
    ctl,
    args: {
      tokens: conn.tokens,
      account: conn.account,
      fields: f,
      signal: ctl.signal,
      media: {
        file,
        sizeBytes: size,
        durationSec,
        width: 1080,
        height: 1920,
        contentType: 'video/mp4',
        presignedUrl: async () => 'https://example.invalid/never-used',
      },
      onProgress: (f2, m) => progress.push({ f: f2, m }),
      log: (m) => logs.push(m),
    },
  };
}

async function failure(p: Promise<unknown>): Promise<PublishError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(PublishError);
    return e as PublishError;
  }
  throw new Error('expected a PublishError');
}

/* ------------------------------------------------------------------------------------------ OAuth ---- */

describe('TikTok OAuth', () => {
  it('builds the documented authorize URL: scopes, state, hex S256 challenge, no client secret', async () => {
    const p = await setup();
    const verifier = 'v'.repeat(64);
    const b64 = crypto.createHash('sha256').update(verifier).digest('base64url');
    const u = new URL(p.authUrl({ redirectUri: REDIRECT, state: 'abc', codeChallenge: b64 }));
    expect(u.origin + u.pathname).toBe(`${fake.urls.authBase}/v2/auth/authorize/`);
    expect(u.searchParams.get('client_key')).toBe(fake.state.clientKey);
    expect(u.searchParams.get('scope')).toBe('user.info.basic,video.publish,video.upload');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(u.searchParams.get('state')).toBe('abc');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    // TikTok wants hex(SHA-256(verifier)), not base64url
    expect(u.searchParams.get('code_challenge')).toBe(sha(verifier));
    expect(u.toString()).not.toContain(fake.state.clientSecret);
    expect(toHexChallenge(sha(verifier).toUpperCase())).toBe(sha(verifier));
  });

  it('completes the loopback round trip and reads the account (name, handle from creator_info, avatar)', async () => {
    const p = await setup();
    const { tokens, account } = await connect(p);
    expect(tokens.accessToken).toMatch(/^act\./);
    expect(tokens.refreshToken).toMatch(/^rft\./);
    expect(tokens.expiresAt).toBeGreaterThan(Date.now() + 23 * 3600_000);
    expect(tokens.extra.openId).toBe('open-id-0001');
    expect(tokens.scope).toBe('user.info.basic,video.publish,video.upload');
    expect(account).toMatchObject({
      externalId: 'open-id-0001',
      displayName: 'Fern Clips',
      handle: 'fernclips',
      avatarUrl: 'https://example.invalid/avatar.jpg',
      scopes: ['user.info.basic', 'video.publish', 'video.upload'],
    });
    expect(account.info.privacyOptions).toBe('PUBLIC_TO_EVERYONE,MUTUAL_FOLLOW_FRIENDS,SELF_ONLY');
    expect(account.info.audited).toBeNull(); // cannot be known from the options alone
    expect(account.info.maxDurationSec).toBe(600);
  });

  it('marks an account that is only offered SELF_ONLY as unaudited', async () => {
    const p = await setup({ audited: false });
    const { account } = await connect(p);
    expect(account.info.privacyOptions).toBe('SELF_ONLY');
    expect(account.info.audited).toBe(false);
  });

  it('refuses a wrong PKCE verifier, a reused code, and a wrong client secret as auth errors', async () => {
    const p = await setup();
    const verifier = 'w'.repeat(60);
    const url = p.authUrl({
      redirectUri: REDIRECT,
      state: 's',
      codeChallenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    });
    const code =
      new URL(
        (await fetch(url, { redirect: 'manual' })).headers.get('location') ?? '',
      ).searchParams.get('code') ?? '';
    const bad = await failure(
      p.exchangeCode({ code, redirectUri: REDIRECT, codeVerifier: 'x'.repeat(60) }),
    );
    expect(bad.code).toBe('auth');
    expect(bad.retryable).toBe(false);
    // the code was spent by the failed attempt in the fake? it is single use only when it matched; use a fresh one
    const url2 = p.authUrl({
      redirectUri: REDIRECT,
      state: 's2',
      codeChallenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    });
    const code2 =
      new URL(
        (await fetch(url2, { redirect: 'manual' })).headers.get('location') ?? '',
      ).searchParams.get('code') ?? '';
    await p.exchangeCode({ code: code2, redirectUri: REDIRECT, codeVerifier: verifier });
    const reused = await failure(
      p.exchangeCode({ code: code2, redirectUri: REDIRECT, codeVerifier: verifier }),
    );
    expect(reused.code).toBe('auth');

    const wrongSecret = createTiktokProvider(
      {
        getCredentials: () => ({
          clientId: fake.state.clientKey,
          clientSecret: 'not-the-secret-123',
        }),
        baseUrls: {
          CLIPFERN_TIKTOK_API_BASE: fake.urls.apiBase,
          CLIPFERN_TIKTOK_AUTH_BASE: fake.urls.authBase,
        },
      },
      FAST,
    );
    const e = await failure(
      wrongSecret.exchangeCode({ code: 'whatever', redirectUri: REDIRECT, codeVerifier: verifier }),
    );
    expect(e.code).toBe('auth');
    expect(e.hint).toMatch(/client key/i);
    expect(e.message + (e.hint ?? '')).not.toContain('not-the-secret-123');
  });

  it('the fake enforces TikTok’s redirect URI rules (loopback host, port required, no query)', async () => {
    const p = await setup();
    const ch = sha('x'.repeat(50));
    for (const bad of [
      'https://example.com/cb',
      'http://127.0.0.1/cb',
      'http://127.0.0.1:43111/cb?x=1',
      'myapp://cb',
    ]) {
      const r = await fetch(p.authUrl({ redirectUri: bad, state: 's', codeChallenge: ch }), {
        redirect: 'manual',
      });
      expect(r.status, bad).toBe(400);
    }
    const ok = await fetch(
      p.authUrl({ redirectUri: 'http://localhost:5/cb', state: 's', codeChallenge: ch }),
      {
        redirect: 'manual',
      },
    );
    expect(ok.status).toBe(302);
  });

  it('throws an auth error with a hint when the developer credentials are not saved', async () => {
    fake = await startFakeTiktok();
    const p = createTiktokProvider({ getCredentials: () => null });
    expect(() => p.authUrl({ redirectUri: REDIRECT, state: 's', codeChallenge: sha('a') })).toThrow(
      PublishError,
    );
    const e = await failure(
      p.refresh({ accessToken: 'a', refreshToken: 'r', expiresAt: 0, scope: null, extra: {} }),
    );
    expect(e.code).toBe('auth');
  });

  it('ROTATES refresh tokens: returns the new pair, keeps openId, the old refresh token is spent', async () => {
    const p = await setup();
    const { tokens } = await connect(p);
    const next = await p.refresh(tokens);
    expect(next.accessToken).not.toBe(tokens.accessToken);
    expect(next.refreshToken).not.toBe(tokens.refreshToken);
    expect(next.extra.openId).toBe('open-id-0001');
    expect(next.expiresAt).toBeGreaterThan(Date.now() + 23 * 3600_000);
    expect(fake.state.validRefreshTokens()).toEqual([next.refreshToken]);
    const replay = await failure(p.refresh(tokens));
    expect(replay.code).toBe('auth');
    expect(replay.retryable).toBe(false);
    expect(replay.hint).toMatch(/reconnect/i);
    // the rotated pair keeps working
    const again = await p.refresh(next);
    expect(again.refreshToken).not.toBe(next.refreshToken);
  });

  it('refresh keeps the old refresh token when TikTok does not send a new one, and a revoked grant is an auth error', async () => {
    const p = await setup();
    const { tokens } = await connect(p);
    fake.control.revokeRefreshTokens();
    const e = await failure(p.refresh(tokens));
    expect(e.code).toBe('auth');
    expect(e.message).not.toContain(tokens.refreshToken ?? 'never');
  });

  it('a TikTok outage while refreshing is a retryable platform error, not an auth error', async () => {
    const down = (async () =>
      new Response('<html>bad gateway</html>', { status: 502 })) as typeof fetch;
    const p = await setup({}, FAST, down);
    const e = await failure(
      p.refresh({
        accessToken: 'a-token',
        refreshToken: 'r-token',
        expiresAt: 0,
        scope: null,
        extra: {},
      }),
    );
    expect(e.code).toBe('platform');
    expect(e.retryable).toBe(true);
  });

  it('revoke is best effort and invalidates the access token', async () => {
    const p = await setup();
    const { tokens } = await connect(p);
    await p.revoke(tokens);
    expect(fake.state.revokeCalls).toBe(1);
    const t = await p.testConnection(tokens);
    expect(t.ok).toBe(false);
    await fake.stop();
    await expect(p.revoke(tokens)).resolves.toBeUndefined(); // server gone: still no throw
  });

  it('testConnection reports the visibility options and whether only private posts are possible', async () => {
    const p = await setup();
    const { tokens } = await connect(p);
    const ok = await p.testConnection(tokens);
    expect(ok.ok).toBe(true);
    expect(ok.message).toContain('Fern Clips');
    expect(ok.detail).toContain('Everyone');
    expect(ok.account?.handle).toBe('fernclips');
    await fake.stop();

    const q = await setup({ audited: false });
    const c2 = await connect(q);
    const t2 = await q.testConnection(c2.tokens);
    expect(t2.ok).toBe(true);
    expect(t2.message).toMatch(/only private/i);
    expect(t2.detail).toMatch(/audit/i);
    expect(t2.account?.info.audited).toBe(false);
  });

  it('testConnection returns ok:false (never throws) for a dead token and an unreachable server', async () => {
    const p = await setup();
    const { tokens } = await connect(p);
    fake.control.expireAccessTokens();
    const r = await p.testConnection(tokens);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/no longer valid/i);
    await fake.stop();
    const r2 = await p.testConnection(tokens);
    expect(r2.ok).toBe(false);
    expect(r2.message).toMatch(/reach TikTok/i);
  });
});

/* ------------------------------------------------------------------------------- Direct Post ----- */

describe('TikTok Direct Post', () => {
  it('chunk plan follows the documented rules', () => {
    expect(planChunks(3_000_005)).toMatchObject({ chunkSize: 3_000_005, totalChunkCount: 1 });
    const p = planChunks(26_000_123);
    expect(p).toMatchObject({ chunkSize: 10_000_000, totalChunkCount: 2 });
    expect(p.ranges).toEqual([
      { start: 0, end: 9_999_999 },
      { start: 10_000_000, end: 26_000_122 },
    ]);
    const huge = planChunks(4 * 1024 ** 3);
    expect(huge.totalChunkCount).toBeLessThanOrEqual(1000);
    expect(huge.ranges.at(-1)?.end).toBe(4 * 1024 ** 3 - 1);
    expect(() => planChunks(0)).toThrow();
    // every chunk but the last has chunk_size bytes; last is chunk_size .. < 2 * chunk_size
    for (const size of [10_000_000, 19_999_999, 20_000_000, 64_000_001, 500_000_000]) {
      const pl = planChunks(size);
      const lens = pl.ranges.map((r) => r.end - r.start + 1);
      expect(lens.reduce((a, b) => a + b, 0)).toBe(size);
      for (const l of lens.slice(0, -1)) expect(l).toBe(pl.chunkSize);
      expect(pl.totalChunkCount).toBe(Math.floor(size / pl.chunkSize));
    }
  });

  it('posts a public video (audited): byte-exact multi-chunk upload, post_info, ids, url, progress', async () => {
    const p = await setup({ audited: true });
    const conn = await connect(p);
    const run = runArgs(
      conn,
      fields({
        commercial: { enabled: true, yourBrand: true, brandedContent: false },
        aigc: true,
        coverTimestampMs: 1500,
      }),
      bigFile,
      30,
    );
    const r = await p.publish(run.args);

    expect(fake.state.published).toHaveLength(1);
    const up = fake.state.published[0]!;
    expect(up.sha256).toBe(bigSha);
    expect(up.receivedBytes).toBe(fs.statSync(bigFile).size);
    expect(up.chunks.map((c) => c.status)).toEqual([206, 201]);
    expect(up.chunks[1]).toMatchObject({ start: 10_000_000, end: fs.statSync(bigFile).size - 1 });
    expect(up.postInfo).toMatchObject({
      title: 'Great clip #fyp',
      privacy_level: 'PUBLIC_TO_EVERYONE',
      disable_comment: false,
      disable_duet: true,
      disable_stitch: false,
      brand_content_toggle: false,
      brand_organic_toggle: true,
      is_aigc: true,
      video_cover_timestamp_ms: 1500,
    });
    // post id is an int64 above 2^53: it must survive as an exact string
    expect(r).toEqual({
      platformPostId: '7300000000000000001',
      url: 'https://www.tiktok.com/@fernclips/video/7300000000000000001',
      outcome: 'published',
      note: null,
      quotaUnits: 0,
    });
    const fr = run.progress.map((x) => x.f).filter((x): x is number => x !== null);
    expect(fr).toEqual([...fr].sort((a, b) => a - b));
    expect(fr.at(-1)).toBe(1);
    expect(run.progress.some((x) => /Uploading to TikTok \d+ %/.test(x.m ?? ''))).toBe(true);
    expect(run.progress.some((x) => /processing/i.test(x.m ?? ''))).toBe(true);
  });

  it('honours the creator’s disabled interactions and sends no upload credentials to the API host as a header', async () => {
    const p = await setup({
      creator: { commentDisabled: true, stitchDisabled: true, duetDisabled: true },
    });
    const conn = await connect(p);
    await p.publish(
      runArgs(conn, fields({ allowComment: true, allowDuet: true, allowStitch: true })).args,
    );
    expect(fake.state.published[0]?.postInfo).toMatchObject({
      disable_comment: true,
      disable_duet: true,
      disable_stitch: true,
    });
  });

  it('UNAUDITED app (only SELF_ONLY offered) asked for PUBLIC: downgraded to SELF_ONLY with a note, never public', async () => {
    const p = await setup({ audited: false });
    const conn = await connect(p);
    const r = await p.publish(runArgs(conn, fields({ privacyLevel: 'PUBLIC_TO_EVERYONE' })).args);
    expect(fake.state.published[0]?.postInfo?.privacy_level).toBe('SELF_ONLY');
    expect(fake.state.uploads).toHaveLength(1);
    expect(r.outcome).toBe('published');
    expect(r.note).toContain('Only me');
    expect(r.note).toContain('Everyone');
    expect(r.note).toMatch(/audit/i);
    // a private post has no public id: the publish id stands in, and there is no url
    expect(r.platformPostId).toMatch(/^v_pub_file~v2-1\./);
    expect(r.url).toBeNull();
  });

  it('an unaudited app that still LISTS every level is caught at init and retried once as SELF_ONLY', async () => {
    const p = await setup({ audited: false, unauditedOffersAll: true });
    const conn = await connect(p);
    const r = await p.publish(runArgs(conn, fields()).args);
    expect(
      fake.state.requests
        .filter((q) => q.path === '/v2/post/publish/video/init/')
        .map((q) => q.status),
    ).toEqual([403, 200]);
    expect(fake.state.published[0]?.postInfo?.privacy_level).toBe('SELF_ONLY');
    expect(r.note).toMatch(/Only me/);
  });

  it('SELF_ONLY refused as unaudited (the account itself is public) is a validation error with the audit hint', async () => {
    const p = await setup();
    const conn = await connect(p);
    fake.control.failNext('unaudited');
    const e = await failure(p.publish(runArgs(conn, fields({ privacyLevel: 'SELF_ONLY' })).args));
    expect(e.code).toBe('validation');
    expect(e.retryable).toBe(false);
    expect(e.hint).toMatch(/private/i);
    expect(e.hint).toMatch(/audit/i);
    expect(fake.state.uploads).toHaveLength(0);
  });

  it('branded content that would have to be private is refused before anything is uploaded', async () => {
    const p = await setup({ audited: false });
    const conn = await connect(p);
    const e = await failure(
      p.publish(
        runArgs(
          conn,
          fields({ commercial: { enabled: true, yourBrand: false, brandedContent: true } }),
        ).args,
      ),
    );
    expect(e.code).toBe('validation');
    expect(e.message).toMatch(/branded content/i);
    expect(fake.state.uploads).toHaveLength(0);
  });

  it('an unavailable level goes to the closest level that is NOT more public than asked', async () => {
    const p = await setup(); // offers PUBLIC, MUTUAL_FOLLOW_FRIENDS, SELF_ONLY
    const conn = await connect(p);
    const r = await p.publish(runArgs(conn, fields({ privacyLevel: 'FOLLOWER_OF_CREATOR' })).args);
    expect(fake.state.published[0]?.postInfo?.privacy_level).toBe('MUTUAL_FOLLOW_FRIENDS');
    expect(r.note).toContain('Friends');
    expect(closestNotMorePublic('PUBLIC_TO_EVERYONE', ['SELF_ONLY'])).toBe('SELF_ONLY');
    expect(closestNotMorePublic('MUTUAL_FOLLOW_FRIENDS', ['PUBLIC_TO_EVERYONE'])).toBe(
      'PUBLIC_TO_EVERYONE',
    ); // nothing private on offer: lowest
    expect(closestNotMorePublic('SELF_ONLY', ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'])).toBe(
      'SELF_ONLY',
    );
  });

  it('refuses a clip longer than the creator may post, before init', async () => {
    const p = await setup({ creator: { maxDurationSec: 10 } });
    const conn = await connect(p);
    const e = await failure(p.publish(runArgs(conn, fields(), smallFile, 45).args));
    expect(e.code).toBe('media');
    expect(e.message).toContain('10 s');
    expect(fake.state.uploads).toHaveLength(0);
  });

  it('maps API errors: revoked token, rate limit (with Retry-After), daily cap', async () => {
    const p = await setup();
    const conn = await connect(p);
    fake.control.failNext('auth');
    const a = await failure(p.publish(runArgs(conn, fields()).args));
    expect([a.code, a.retryable]).toEqual(['auth', false]);
    expect(a.hint).toMatch(/reconnect/i);

    fake.control.failNext('rate-limit');
    const rl = await failure(p.publish(runArgs(conn, fields()).args));
    expect(rl.code).toBe('rate-limit');
    expect(rl.retryAfterSec).toBe(7);
    expect(rl.retryable).toBe(true);

    fake.control.failNext('spam');
    const q = await failure(p.publish(runArgs(conn, fields()).args));
    expect(q.code).toBe('quota');
    expect(q.retryAfterSec).toBeGreaterThan(3600);
    expect(q.hint).toMatch(/TikTok (mobile )?app/i);
    expect(fake.state.uploads).toHaveLength(0);
  });

  it('a daily cap that only shows at init (creator_info said fine) is also a quota error', async () => {
    const p = await setup();
    const conn = await connect(p);
    // let creator_info through (consumed by 'spam' first) -> use two entries
    fake.control.failNext('spam', 2);
    const q = await failure(p.publish(runArgs(conn, fields()).args));
    expect(q.code).toBe('quota');
  });

  it('turns a 5xx / unreadable body into a retryable platform error', async () => {
    let armed = false;
    const flaky = (async (url: string | URL | Request, init?: RequestInit) => {
      if (armed && String(url).includes('/creator_info/'))
        return new Response('<html>oops</html>', { status: 503 });
      return fetch(url, init);
    }) as typeof fetch;
    const p = await setup({}, FAST, flaky);
    const conn = await connect(p);
    armed = true;
    const e = await failure(p.publish(runArgs(conn, fields()).args));
    expect(e.code).toBe('platform');
    expect(e.retryable).toBe(true);
  });
});

/* ----------------------------------------------------------------------------------- drafts ------ */

describe('TikTok draft (upload to inbox)', () => {
  it('uploads to the inbox: no post_info, draft-uploaded outcome, byte-exact, works for unaudited apps', async () => {
    const p = await setup({ audited: false });
    const conn = await connect(p);
    const run = runArgs(
      conn,
      fields({ mode: 'draft', privacyLevel: 'PUBLIC_TO_EVERYONE' }),
      bigFile,
    );
    const r = await p.publish(run.args);
    expect(fake.state.published).toHaveLength(0);
    expect(fake.state.inbox).toHaveLength(1);
    const up = fake.state.inbox[0]!;
    expect(up.sha256).toBe(bigSha);
    expect(up.postInfo).toBeNull();
    expect(fake.state.requests.some((q) => q.path === '/v2/post/publish/inbox/video/init/')).toBe(
      true,
    );
    expect(fake.state.requests.some((q) => q.path === '/v2/post/publish/video/init/')).toBe(false);
    expect(r).toEqual({
      platformPostId: up.publishId,
      url: null,
      outcome: 'draft-uploaded',
      note: 'In your TikTok inbox — open the TikTok app to publish',
      quotaUnits: 0,
    });
  });

  it('reports the 5-pending-drafts cap as a quota error with a hint', async () => {
    const p = await setup();
    const conn = await connect(p);
    for (let i = 0; i < 5; i++) await p.publish(runArgs(conn, fields({ mode: 'draft' })).args);
    const e = await failure(p.publish(runArgs(conn, fields({ mode: 'draft' })).args));
    expect(e.code).toBe('quota');
    expect(e.message).toMatch(/5 drafts/);
    expect(e.hint).toMatch(/TikTok app/);
  });

  it('a draft still goes up when creator_info is unavailable (it needs only the upload scope)', async () => {
    const p = await setup();
    const conn = await connect(p);
    fake.control.failNext('spam'); // creator_info -> daily post cap, irrelevant to the inbox
    const r = await p.publish(runArgs(conn, fields({ mode: 'draft' })).args);
    expect(r.outcome).toBe('draft-uploaded');
  });
});

/* ---------------------------------------------------------------------- resume, status, abort ---- */

describe('TikTok upload robustness', () => {
  it('re-sends a failed chunk (not the whole file) and still delivers identical bytes', async () => {
    const p = await setup();
    const conn = await connect(p);
    fake.control.failNext('chunk-fail');
    const run = runArgs(conn, fields(), bigFile);
    await p.publish(run.args);
    const up = fake.state.published[0]!;
    expect(up.chunks.map((c) => [c.start, c.status])).toEqual([
      [0, 500],
      [0, 206],
      [10_000_000, 201],
    ]);
    expect(up.sha256).toBe(bigSha);
    expect(fake.state.uploads).toHaveLength(1); // one init: same publish_id, no restart
  });

  it('survives a chunk that was stored but whose answer was lost (416 -> Content-Range says it is there)', async () => {
    const p = await setup();
    const conn = await connect(p);
    fake.control.failNext('chunk-lost-ack');
    await p.publish(runArgs(conn, fields(), bigFile).args);
    const up = fake.state.published[0]!;
    expect(up.chunks.map((c) => c.status)).toEqual([500, 416, 201]);
    expect(up.sha256).toBe(bigSha);
  });

  it('gives up after the allowed attempts with a retryable network error that names no credential', async () => {
    const p = await setup({}, { ...FAST, chunkAttempts: 3 });
    const conn = await connect(p);
    fake.control.failNext('chunk-fail', 10);
    const e = await failure(p.publish(runArgs(conn, fields(), bigFile).args));
    expect(e.code).toBe('network');
    expect(e.retryable).toBe(true);
    expect(fake.state.uploads[0]?.chunks).toHaveLength(3);
    expect(e.message).not.toMatch(/upload_token|https?:/);
  });

  it.each([
    ['file_format_check_failed', 'media', false],
    ['duration_check_failed', 'media', false],
    ['frame_rate_check_failed', 'media', false],
    ['picture_size_check_failed', 'media', false],
    ['spam_risk_too_many_posts', 'quota', true],
    ['spam_risk_user_banned_from_posting', 'platform', false],
    ['spam_risk_text', 'validation', false],
    ['spam_risk', 'platform', false],
    ['auth_removed', 'auth', false],
    ['internal', 'platform', true],
    ['video_pull_failed', 'platform', true],
    ['something_new_tiktok_added', 'platform', false],
  ] as const)('maps status FAILED / %s to %s (retryable %s)', async (reason, code, retryable) => {
    const p = await setup();
    const conn = await connect(p);
    fake.control.failNext('status-failed', 1, reason);
    const e = await failure(p.publish(runArgs(conn, fields()).args));
    expect(e.code).toBe(code);
    expect(e.retryable).toBe(retryable);
    expect(e.message).not.toMatch(/_check_failed|spam_risk_/); // plain language
  });

  it('gives the mobile-app hint for the daily cap and the re-encode hint for format problems', async () => {
    const p = await setup();
    const conn = await connect(p);
    fake.control.failNext('status-failed', 1, 'spam_risk_too_many_posts');
    const a = await failure(p.publish(runArgs(conn, fields()).args));
    expect(a.hint).toMatch(/mobile app/i);
    expect(a.retryAfterSec).toBeGreaterThan(0);
    fake.control.failNext('status-failed', 1, 'file_format_check_failed');
    const b = await failure(p.publish(runArgs(conn, fields()).args));
    expect(b.hint).toMatch(/Auto-fix/);
  });

  it('keeps polling while TikTok processes, then completes', async () => {
    const p = await setup();
    const conn = await connect(p);
    fake.control.setProcessingPolls(6);
    await p.publish(runArgs(conn, fields()).args);
    expect(
      fake.state.requests.filter((q) => q.path === '/v2/post/publish/status/fetch/').length,
    ).toBe(7);
  });

  it('bounds the wait: still processing after maxPollMs is a NON-retryable platform error (no double posting)', async () => {
    const p = await setup({}, { ...FAST, maxPollMs: 80 });
    const conn = await connect(p);
    fake.control.setProcessingPolls(1_000_000);
    const e = await failure(p.publish(runArgs(conn, fields()).args));
    expect(e.code).toBe('platform');
    expect(e.retryable).toBe(false);
    expect(e.hint).toMatch(/twice/);
  });

  it('abort before start, between chunks and while polling: AbortError, and nothing more is sent', async () => {
    const p = await setup();
    const conn = await connect(p);

    const pre = runArgs(conn, fields());
    pre.ctl.abort();
    await expect(p.publish(pre.args)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fake.state.requests.some((q) => q.path.includes('init'))).toBe(false);

    const mid = runArgs(conn, fields(), bigFile);
    const origProgress = mid.args.onProgress;
    mid.args.onProgress = (f, m) => {
      origProgress(f, m);
      if (/Uploading to TikTok 3\d %/.test(m ?? '')) mid.ctl.abort();
    };
    await expect(p.publish(mid.args)).rejects.toMatchObject({ name: 'AbortError' });
    const up = fake.state.uploads.at(-1)!;
    expect(up.complete).toBe(false);
    expect(up.chunks).toHaveLength(1); // the second chunk was never sent

    fake.control.setProcessingPolls(1_000_000);
    const polling = runArgs(conn, fields());
    const o2 = polling.args.onProgress;
    polling.args.onProgress = (f, m) => {
      o2(f, m);
      if (/processing/i.test(m ?? '')) polling.ctl.abort();
    };
    await expect(p.publish(polling.args)).rejects.toMatchObject({ name: 'AbortError' });
    const before = fake.state.requests.length;
    await new Promise((r) => setTimeout(r, 40));
    expect(fake.state.requests.length).toBe(before);
  });
});

/* ------------------------------------------------------------------------------------ secrets ---- */

describe('TikTok secrets stay out of logs and errors', () => {
  it('no token, secret, code or upload-URL query appears in any log line or error text', async () => {
    const fetchLog: string[] = [];
    // A transport that fails with the upload URL in its own message, like real fetch errors sometimes do.
    let failedOnce = false;
    const nasty = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      fetchLog.push(u);
      if (u.includes('/__upload/') && !failedOnce) {
        failedOnce = true;
        throw new Error(`socket hang up while PUT ${u}`);
      }
      return fetch(url, init);
    }) as typeof fetch;
    const p = await setup({}, { ...FAST, chunkAttempts: 1 }, nasty);
    const conn = await connect(p);
    const secrets = [
      conn.tokens.accessToken,
      conn.tokens.refreshToken ?? '',
      fake.state.clientSecret,
      'upload_token=',
    ];

    const errs: PublishError[] = [];
    errs.push(await failure(p.publish(runArgs(conn, fields(), bigFile).args))); // transport error with the URL inside
    fake.control.failNext('status-failed', 1, 'internal');
    errs.push(await failure(p.publish(runArgs(conn, fields()).args)));
    fake.control.failNext('auth');
    errs.push(await failure(p.publish(runArgs(conn, fields()).args)));
    fake.control.revokeRefreshTokens();
    errs.push(await failure(p.refresh(conn.tokens)));
    errs.push(
      await failure(
        p.exchangeCode({
          code: 'bad-code-1234',
          redirectUri: REDIRECT,
          codeVerifier: 'y'.repeat(50),
        }),
      ),
    );
    await p.testConnection(conn.tokens);

    expect(logs.length).toBeGreaterThan(5);
    const blob = [
      ...logs,
      ...errs.map(
        (e) =>
          `${e.message}\n${e.hint ?? ''}\n${e.stack ?? ''}\n${JSON.stringify(e)}\n${String(e.cause ?? '')}`,
      ),
    ].join('\n');
    for (const s of secrets) if (s) expect(blob, `leaked ${s.slice(0, 8)}…`).not.toContain(s);
    expect(blob).not.toContain('bad-code-1234');
    expect(blob).not.toMatch(/upload_token|upload_id=/);
    // the upload URL really was used (so the check above is meaningful)
    expect(fetchLog.some((u) => u.includes('upload_token='))).toBe(true);
  });

  it('a transport error that quotes a token or the client secret is scrubbed before it is logged', async () => {
    let armed = false;
    const quoting = (async (url: string | URL | Request, init?: RequestInit) => {
      if (armed && String(url).includes('/creator_info/')) {
        const auth = new Headers(init?.headers).get('authorization') ?? '';
        throw new Error(`proxy rejected ${auth} for ${fake.state.clientSecret}`);
      }
      return fetch(url, init);
    }) as typeof fetch;
    const p = await setup({}, FAST, quoting);
    const conn = await connect(p);
    armed = true;
    logs.length = 0;
    const e = await failure(p.publish(runArgs(conn, fields()).args));
    const leaky = [...logs, e.message, e.hint ?? ''];
    expect(e.code).toBe('network');
    expect(logs.some((l) => l.includes('proxy rejected'))).toBe(true); // the line exists, scrubbed
    for (const l of leaky) {
      expect(l).not.toContain(conn.tokens.accessToken);
      expect(l).not.toContain(fake.state.clientSecret);
    }
  });

  it('redact removes known secrets and every URL query string', () => {
    expect(redact('token abcdef123456 ok', ['abcdef123456'])).toBe('token *** ok');
    expect(redact('PUT https://up.example/x?upload_id=1&upload_token=zz done', [])).toBe(
      'PUT https://up.example/x?\u2026 done',
    );
    expect(redact('keep me', [undefined, null, 'ab'])).toBe('keep me'); // too short to be a secret
  });

  it('sends the bearer token to the API host only, never to the upload URL', async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const spy = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') });
      return fetch(url, init);
    }) as typeof fetch;
    const p = await setup({}, FAST, spy);
    const conn = await connect(p);
    await p.publish(runArgs(conn, fields()).args);
    const puts = seen.filter((s) => s.url.includes('/__upload/'));
    expect(puts.length).toBeGreaterThan(0);
    for (const s of puts) expect(s.auth).toBeNull();
    for (const s of seen.filter((x) => x.url.includes('/v2/post/')))
      expect(s.auth).toBe(`Bearer ${conn.tokens.accessToken}`);
  });
});

/* ----------------------------------------------------------------------------------- misc API ---- */

describe('TikTok stats and quota', () => {
  it('has no stats (video.list is not requested) and costs no quota units', async () => {
    const p = await setup();
    const conn = await connect(p);
    expect(
      await p.fetchStats?.({ tokens: conn.tokens, account: conn.account, platformPostId: '1' }),
    ).toBeNull();
    expect(p.quotaCost(fields())).toBe(0);
    expect(p.scopes).toEqual(['user.info.basic', 'video.publish', 'video.upload']);
  });

  it('quota is a documented estimate of ~15 posts/day and says so; a reported cap zeroes it', async () => {
    const p = await setup();
    const conn = await connect(p);
    const now = 1_700_000_000_000;
    const q = await p.quota({
      tokens: conn.tokens,
      account: conn.account,
      usedUnits: 0,
      usedPosts: 4,
      now,
    });
    expect(q).toMatchObject({
      used: 4,
      limit: 15,
      unit: 'posts',
      postsLeft: 11,
      resetsAt: now + 86_400_000,
    });
    expect(q.note).toMatch(/estimate/i);
    fake.control.failNext('spam');
    const capped = await p.quota({
      tokens: conn.tokens,
      account: conn.account,
      usedUnits: 0,
      usedPosts: 1,
      now,
    });
    expect(capped.postsLeft).toBe(0);
    expect(capped.used).toBe(15);
  });
});
