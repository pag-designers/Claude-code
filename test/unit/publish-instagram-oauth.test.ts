import { afterEach, describe, expect, it } from 'vitest';
import { PublishError } from '@main/services/publish/errors';
import {
  graphErrorResponse,
  interceptFetch,
  makeHarness,
  REDIRECT_URI,
  type Harness,
} from './publish-instagram-helpers';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const catchErr = async (p: Promise<unknown>): Promise<PublishError> => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(PublishError);
    return e as PublishError;
  }
  throw new Error('expected a PublishError');
};

describe('instagram oauth', () => {
  it('builds the Instagram Login consent URL with the documented parameters', async () => {
    h = await makeHarness();
    const u = new URL(
      h.provider.authUrl({ redirectUri: REDIRECT_URI, state: 's1', codeChallenge: 'c' }),
    );
    expect(u.origin + u.pathname).toBe(`${h.fake.urls.oauthBase}/oauth/authorize`);
    expect(u.searchParams.get('client_id')).toBe(h.fake.state.appId);
    expect(u.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('state')).toBe('s1');
    expect(u.searchParams.get('scope')?.split(',')).toEqual([
      'instagram_business_basic',
      'instagram_business_content_publish',
      'instagram_business_manage_comments',
    ]);
    expect(u.toString()).not.toContain(h.fake.state.appSecret);
  });

  it('uses the real Instagram hosts when no override is given', async () => {
    const { createInstagramProvider } = await import('@main/services/publish-instagram');
    const p = createInstagramProvider({
      getCredentials: () => ({ clientId: '1', clientSecret: 's3cret-value' }),
    });
    expect(p.authUrl({ redirectUri: REDIRECT_URI, state: 'x', codeChallenge: 'c' })).toMatch(
      /^https:\/\/www\.instagram\.com\/oauth\/authorize\?/,
    );
  });

  it('exchanges the code for a LONG-LIVED token and resolves the account', async () => {
    h = await makeHarness();
    const consent = await h.authorize();
    expect(consent.state).toBe('st-123');
    expect(consent.raw.endsWith('#_')).toBe(true); // Instagram appends #_
    const t0 = Date.now();
    const { tokens, account } = await h.provider.exchangeCode({
      code: consent.code,
      redirectUri: REDIRECT_URI,
      codeVerifier: 'v',
    });
    const long = h.fake.state.tokens.find((t) => t.value === tokens.accessToken);
    expect(long?.kind).toBe('long'); // not the 1 h short-lived one
    expect(tokens.refreshToken).toBeNull();
    expect(tokens.expiresAt).toBeGreaterThan(t0 + 59 * 86_400_000);
    expect(tokens.expiresAt).toBeLessThan(t0 + 61 * 86_400_000);
    expect(Number(tokens.extra.issuedAt)).toBeGreaterThanOrEqual(t0);
    expect(tokens.scope).toContain('instagram_business_content_publish');
    // The id is the exact string from /me, although the OAuth reply carried it as an imprecise JSON number.
    expect(account).toMatchObject({
      externalId: '17841405793187218',
      displayName: 'Clipfern Test',
      handle: 'clipfern_test',
      avatarUrl: 'https://example.invalid/avatar.jpg',
      info: { accountType: 'Business' },
    });
    expect(account.scopes).toContain('instagram_business_basic');
    const reqs = h.fake.state.requests.map((r) => `${r.method} ${r.path}`);
    expect(reqs).toEqual([
      'GET /oauth/authorize',
      'POST /oauth/access_token',
      'GET /access_token',
      'GET /me',
    ]);
    const exchange = h.fake.state.requests[2]!;
    expect(exchange.query).toMatchObject({
      grant_type: 'ig_exchange_token',
      client_secret: h.fake.state.appSecret,
    });
    // The profile is read with the long-lived token.
    expect(h.fake.state.requests[3]!.query.access_token).toBe(tokens.accessToken);
  });

  it('reports a Creator account as such', async () => {
    h = await makeHarness({ fake: { user: { accountType: 'MEDIA_CREATOR' } } });
    expect((await h.connect()).account.info.accountType).toBe('Creator');
  });

  it('turns a wrong app secret / a reused code into an auth error without leaking either', async () => {
    h = await makeHarness({
      credentials: { clientId: 'fake-ig-app-id', clientSecret: 'wrong-secret-value-1' },
    });
    const { code } = await h.authorize();
    const e = await catchErr(
      h.provider.exchangeCode({ code, redirectUri: REDIRECT_URI, codeVerifier: 'v' }),
    );
    expect(e.code).toBe('auth');
    expect(e.retryable).toBe(false);
    expect(e.message).not.toContain('wrong-secret-value-1');
    expect(e.message).not.toContain(code);
    await h.close();

    h = await makeHarness();
    const c = await h.authorize();
    await h.provider.exchangeCode({ code: c.code, redirectUri: REDIRECT_URI, codeVerifier: 'v' });
    const again = await catchErr(
      h.provider.exchangeCode({ code: c.code, redirectUri: REDIRECT_URI, codeVerifier: 'v' }),
    );
    expect(again.code).toBe('auth');
    expect(again.message).not.toContain(c.code);
  });

  it('refuses to start without app credentials', async () => {
    h = await makeHarness({ credentials: null });
    expect(() =>
      h!.provider.authUrl({ redirectUri: REDIRECT_URI, state: 's', codeChallenge: 'c' }),
    ).toThrow(PublishError);
    const e = await catchErr(
      h.provider.exchangeCode({ code: 'abc', redirectUri: REDIRECT_URI, codeVerifier: 'v' }),
    );
    expect(e.code).toBe('auth');
    expect(h.fake.state.requests).toHaveLength(0);
  });

  it('rejects a personal account with a plain explanation', async () => {
    h = await makeHarness({ fake: { user: { accountType: 'PERSONAL' } } });
    const e = await catchErr(h.connect());
    expect(e.code).toBe('auth');
    expect(e.message).toMatch(/Business or Creator/);
  });
});

describe('instagram refresh / revoke / test', () => {
  it('leaves a token younger than 24 h alone (Instagram would refuse it)', async () => {
    h = await makeHarness();
    const c = await h.connect();
    const before = h.fake.state.requests.length;
    const out = await h.provider.refresh(c.tokens);
    expect(out).toEqual(c.tokens);
    expect(h.fake.state.requests.length).toBe(before);
  });

  it('extends a long-lived token that is 24 h old', async () => {
    h = await makeHarness();
    const c = await h.connect();
    h.fake.control.ageTokens(25 * 3600_000);
    const t0 = Date.now();
    const out = await h.provider.refresh({
      ...c.tokens,
      extra: { ...c.tokens.extra, issuedAt: String(t0 - 25 * 3600_000) },
    });
    expect(out.accessToken).not.toBe(c.tokens.accessToken);
    expect(h.fake.state.tokens.some((t) => t.value === out.accessToken && t.kind === 'long')).toBe(
      true,
    );
    expect(out.expiresAt).toBeGreaterThan(t0 + 59 * 86_400_000);
    expect(Number(out.extra.issuedAt)).toBeGreaterThanOrEqual(t0);
    expect(out.extra.igUserId).toBe('17841405793187218');
    const last = h.fake.state.requests.at(-1)!;
    expect(last.path).toBe('/refresh_access_token');
    expect(last.query.grant_type).toBe('ig_refresh_token');
  });

  it('an expired token needs re-connecting, without calling Instagram', async () => {
    h = await makeHarness();
    const c = await h.connect();
    const before = h.fake.state.requests.length;
    const e = await catchErr(h.provider.refresh({ ...c.tokens, expiresAt: Date.now() - 1000 }));
    expect(e.code).toBe('auth');
    expect(e.retryable).toBe(false);
    expect(e.hint).toMatch(/Reconnect/);
    expect(h.fake.state.requests.length).toBe(before);
  });

  it('a revoked token (error 190) becomes an auth error on refresh', async () => {
    h = await makeHarness();
    const c = await h.connect();
    h.fake.control.ageTokens(30 * 3600_000);
    h.fake.control.revokeTokens();
    const e = await catchErr(
      h.provider.refresh({
        ...c.tokens,
        extra: { ...c.tokens.extra, issuedAt: String(Date.now() - 30 * 3600_000) },
      }),
    );
    expect(e.code).toBe('auth');
    expect(e.message).not.toContain(c.tokens.accessToken);
  });

  it('revoke never throws and sends nothing', async () => {
    h = await makeHarness();
    const c = await h.connect();
    const before = h.fake.state.requests.length;
    await expect(h.provider.revoke(c.tokens)).resolves.toBeUndefined();
    expect(h.fake.state.requests.length).toBe(before);
  });

  it('testConnection reports the account, the quota and a revoked token', async () => {
    h = await makeHarness({ fake: { quotaUsage: 4 } });
    const c = await h.connect();
    const ok = await h.provider.testConnection(c.tokens);
    expect(ok.ok).toBe(true);
    expect(ok.message).toBe('Connected to Instagram as @clipfern_test');
    expect(ok.detail).toContain('4 of 50');
    expect(ok.account?.externalId).toBe('17841405793187218');
    h.fake.control.revokeTokens();
    const bad = await h.provider.testConnection(c.tokens);
    expect(bad).toMatchObject({ ok: false, account: null });
    expect(bad.message).not.toContain(c.tokens.accessToken);
  });
});

describe('instagram quota and stats', () => {
  it('reads the publishing limit from Instagram', async () => {
    h = await makeHarness({ fake: { quotaUsage: 3, quotaTotal: 25 } });
    const c = await h.connect();
    const now = Date.now();
    const q = await h.provider.quota({ ...c, usedUnits: 0, usedPosts: 99, now });
    expect(q).toMatchObject({ used: 3, limit: 25, unit: 'posts', postsLeft: 22 });
    expect(q.resetsAt).toBe(now + 86_400_000);
    expect(h.provider.quotaCost({ platform: 'reels' } as never)).toBe(0);
  });

  it('falls back to the local count when the endpoint is down, but never hides a bad token', async () => {
    const f = interceptFetch(({ url }) =>
      url.pathname.endsWith('content_publishing_limit')
        ? new Response('boom', { status: 500 })
        : undefined,
    );
    h = await makeHarness({ fetch: f });
    const c = await h.connect();
    const q = await h.provider.quota({ ...c, usedUnits: 0, usedPosts: 7, now: Date.now() });
    expect(q).toMatchObject({ used: 7, limit: 50, postsLeft: 43 });
    expect(q.note).toMatch(/did not report/);
    await h.close();

    h = await makeHarness();
    const c2 = await h.connect();
    h.fake.control.revokeTokens();
    const e = await catchErr(
      h.provider.quota({ ...c2, usedUnits: 0, usedPosts: 0, now: Date.now() }),
    );
    expect(e.code).toBe('auth');
  });

  it('collects plays/likes/comments/shares and tolerates missing metrics', async () => {
    h = await makeHarness();
    const c = await h.connect();
    const post = await h.provider.publish(h.args(c, { fields: { firstComment: null } }));
    const full = await h.provider.fetchStats!({ ...c, platformPostId: post.platformPostId });
    expect(full).toMatchObject({ views: 1234, likes: 56, comments: 7, shares: 12 });
    h.fake.control.setMetrics({ views: null, shares: null });
    const partial = await h.provider.fetchStats!({ ...c, platformPostId: post.platformPostId });
    expect(partial).toMatchObject({ views: null, shares: null, likes: 56, comments: 7 });
  });

  it('asks metric by metric when Instagram refuses a combined request', async () => {
    const f = interceptFetch(({ url }) =>
      url.pathname.endsWith('/insights') && (url.searchParams.get('metric') ?? '').includes(',')
        ? graphErrorResponse(100, '(#100) metric[3] must be one of the following values')
        : undefined,
    );
    h = await makeHarness({ fetch: f });
    const c = await h.connect();
    const post = await h.provider.publish(h.args(c, { fields: { firstComment: null } }));
    const s = await h.provider.fetchStats!({ ...c, platformPostId: post.platformPostId });
    expect(s).toMatchObject({ views: 1234, shares: 12, likes: 56 });
  });

  it('returns null when Instagram gives nothing at all', async () => {
    const f = interceptFetch(({ url }) =>
      url.pathname.includes('/18000')
        ? graphErrorResponse(100, 'Unsupported get request')
        : undefined,
    );
    h = await makeHarness({ fetch: f });
    const c = await h.connect();
    expect(await h.provider.fetchStats!({ ...c, platformPostId: '1800000000000099' })).toBeNull();
  });
});
