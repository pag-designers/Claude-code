import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createYoutubeProvider } from '@main/services/publish-youtube';
import { isPublishError, PublishError } from '@main/services/publish/errors';
import {
  startFakeYoutube,
  SCOPE_READONLY,
  SCOPE_UPLOAD,
  type FakeYoutube,
} from '../support/fake-youtube';
import { REDIRECT, connect, consent, makeProvider, pkce } from './publish-youtube-helpers';

let fake: FakeYoutube;
beforeAll(async () => {
  fake = await startFakeYoutube({ accessTokenTtlSec: 3600 });
});
afterAll(async () => {
  await fake.stop();
});

async function rejection(p: Promise<unknown>): Promise<PublishError> {
  try {
    await p;
  } catch (e) {
    if (isPublishError(e)) return e;
    throw e;
  }
  throw new Error('expected a PublishError');
}

describe('YouTube OAuth (desktop, loopback, PKCE)', () => {
  it('builds a consent URL with PKCE S256, state, both scopes, offline access and forced consent', () => {
    const provider = makeProvider(fake);
    const u = new URL(
      provider.authUrl({ redirectUri: REDIRECT, state: 'st-1', codeChallenge: 'chal-1' }),
    );
    expect(u.origin + u.pathname).toBe(`${fake.urls.oauthBase}/authorize`);
    const q = u.searchParams;
    expect(q.get('client_id')).toBe(fake.clientId);
    expect(q.get('redirect_uri')).toBe(REDIRECT);
    expect(q.get('response_type')).toBe('code');
    expect(q.get('scope')!.split(' ')).toEqual([SCOPE_UPLOAD, SCOPE_READONLY]);
    expect(q.get('code_challenge')).toBe('chal-1');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('state')).toBe('st-1');
    expect(q.get('access_type')).toBe('offline');
    expect(q.get('prompt')).toBe('consent');
    expect(q.has('client_secret')).toBe(false);
    expect(provider.scopes).toEqual([SCOPE_UPLOAD, SCOPE_READONLY]);
  });

  it('uses the real Google endpoints without overrides', () => {
    const real = createYoutubeProvider({
      getCredentials: () => ({ clientId: 'id', clientSecret: 'secret' }),
    });
    const u = new URL(real.authUrl({ redirectUri: REDIRECT, state: 's', codeChallenge: 'c' }));
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
  });

  it('refuses to build a URL before the OAuth client is saved', () => {
    const provider = makeProvider(fake, { credentials: null });
    expect(() =>
      provider.authUrl({ redirectUri: REDIRECT, state: 's', codeChallenge: 'c' }),
    ).toThrow(PublishError);
  });

  it('full flow: consent echoes state, the code is exchanged, the channel becomes the account', async () => {
    let t = 1_700_000_000_000;
    const provider = makeProvider(fake, { now: () => t });
    const c = await consent(provider, 'the-state');
    expect(c.state).toBe('the-state');
    const last = fake.state.authRequests.at(-1)!;
    expect(last.codeChallengeMethod).toBe('S256');
    expect(last.accessType).toBe('offline');
    expect(last.prompt).toBe('consent');

    const { tokens, account } = await provider.exchangeCode({
      code: c.code,
      redirectUri: REDIRECT,
      codeVerifier: c.verifier,
    });
    expect(tokens.accessToken).toMatch(/^fake-access-/);
    expect(tokens.refreshToken).toMatch(/^fake-refresh-/);
    expect(tokens.expiresAt).toBe(t + 3600_000);
    expect(tokens.scope!.split(' ')).toContain(SCOPE_UPLOAD);
    expect(account).toMatchObject({
      externalId: 'UCfakechannel0000000001',
      displayName: 'Fake Clips Channel',
      handle: 'fakeclips',
      avatarUrl: 'https://yt3.example/avatar-medium.jpg',
      info: { subscribers: 1234, madeForKidsDefault: false },
    });
    expect(account.scopes).toEqual([SCOPE_UPLOAD, SCOPE_READONLY]);
    t += 1;
  });

  it('PKCE is verified by the server: a wrong verifier is rejected as an auth error', async () => {
    const provider = makeProvider(fake);
    const c = await consent(provider);
    const err = await rejection(
      provider.exchangeCode({ code: c.code, redirectUri: REDIRECT, codeVerifier: pkce().verifier }),
    );
    expect(err.code).toBe('auth');
    expect(err.retryable).toBe(false);
    expect(fake.state.tokenRequests.at(-1)).toMatchObject({ ok: false, error: 'invalid_grant' });
    // …and the auth code is single-use
    const err2 = await rejection(
      provider.exchangeCode({ code: c.code, redirectUri: REDIRECT, codeVerifier: c.verifier }),
    );
    expect(err2.code).toBe('auth');
  });

  it('a wrong client secret is an auth error that names no secret', async () => {
    const provider = makeProvider(fake, {
      credentials: { clientId: fake.clientId, clientSecret: 'definitely-wrong-secret' },
    });
    const c = await consent(provider);
    const err = await rejection(
      provider.exchangeCode({ code: c.code, redirectUri: REDIRECT, codeVerifier: c.verifier }),
    );
    expect(err.code).toBe('auth');
    expect(`${err.message} ${err.hint}`).not.toContain('definitely-wrong-secret');
    expect(`${err.message} ${err.hint}`).toMatch(/client ID or secret/i);
  });

  it('refuses a grant that lacks the upload or readonly scope (unticked boxes)', async () => {
    const provider = makeProvider(fake);
    fake.control.setGrantedScopes([SCOPE_READONLY]);
    try {
      const c = await consent(provider);
      const err = await rejection(
        provider.exchangeCode({ code: c.code, redirectUri: REDIRECT, codeVerifier: c.verifier }),
      );
      expect(err.code).toBe('auth');
      expect(err.message).toMatch(/upload/i);
      expect(err.hint).toMatch(/permission/i);
    } finally {
      fake.control.setGrantedScopes(null);
    }
  });

  it('an account without a YouTube channel is an auth error with a hint', async () => {
    const provider = makeProvider(fake);
    fake.control.setChannel(null);
    try {
      const err = await rejection(connect(provider));
      expect(err.code).toBe('auth');
      expect(err.message).toMatch(/no YouTube channel/i);
    } finally {
      fake.control.setChannel({});
    }
  });

  it('hidden subscriber counts are not reported; handle falls back to null without a customUrl', async () => {
    const provider = makeProvider(fake);
    fake.control.setChannel({
      hiddenSubscriberCount: true,
      customUrl: null,
      selfDeclaredMadeForKids: true,
    });
    try {
      const { account } = await connect(provider);
      expect(account.info.subscribers).toBeUndefined();
      expect(account.info.madeForKidsDefault).toBe(true);
      expect(account.handle).toBeNull();
    } finally {
      fake.control.setChannel({
        hiddenSubscriberCount: false,
        customUrl: '@fakeclips',
        selfDeclaredMadeForKids: false,
      });
    }
  });

  it('refresh: an expired access token is replaced; the refresh token and scope are kept', async () => {
    let t = 5_000_000;
    const provider = makeProvider(fake, { now: () => t });
    const { tokens } = await connect(provider);
    fake.control.expireAccessTokens();
    // the old token no longer works…
    const dead = await provider.testConnection(tokens);
    expect(dead.ok).toBe(false);
    // …a refreshed one does
    t += 3_700_000;
    const fresh = await provider.refresh(tokens);
    expect(fresh.accessToken).not.toBe(tokens.accessToken);
    expect(fresh.refreshToken).toBe(tokens.refreshToken);
    expect(fresh.scope).toBe(tokens.scope);
    expect(fresh.expiresAt).toBe(t + 3600_000);
    const alive = await provider.testConnection(fresh);
    expect(alive.ok).toBe(true);
    expect(
      fake.state.tokenRequests.filter((r) => r.grantType === 'refresh_token' && r.ok).length,
    ).toBeGreaterThan(0);
  });

  it('invalid_grant on refresh is an auth error that explains the 7-day "Testing" expiry', async () => {
    const provider = makeProvider(fake);
    const { tokens } = await connect(provider);
    fake.control.expireRefreshTokens();
    const err = await rejection(provider.refresh(tokens));
    expect(err.code).toBe('auth');
    expect(err.retryable).toBe(false);
    expect(err.hint).toMatch(/Testing/);
    expect(err.hint).toMatch(/7 days/);
    expect(err.hint).toMatch(/production/i);
  });

  it('refresh without a stored refresh token is an auth error', async () => {
    const provider = makeProvider(fake);
    const { tokens } = await connect(provider);
    const err = await rejection(provider.refresh({ ...tokens, refreshToken: null }));
    expect(err.code).toBe('auth');
  });

  it('revoke hits the revoke endpoint, and never throws for an already revoked token', async () => {
    const provider = makeProvider(fake);
    const { tokens } = await connect(provider);
    await provider.revoke(tokens);
    expect(fake.state.tokens.revoked).toContain(tokens.refreshToken);
    // the access token died with it
    expect((await provider.testConnection(tokens)).ok).toBe(false);
    await expect(provider.revoke(tokens)).resolves.toBeUndefined();
  });

  it('revoke swallows an unreachable server', async () => {
    const dead = await startFakeYoutube();
    const provider = makeProvider(dead);
    const { tokens } = await connect(provider);
    await dead.stop();
    await expect(provider.revoke(tokens)).resolves.toBeUndefined();
  });

  it('testConnection reports the channel, or the reason it failed', async () => {
    const provider = makeProvider(fake);
    const { tokens } = await connect(provider);
    const ok = await provider.testConnection(tokens);
    expect(ok).toMatchObject({ ok: true, detail: '1234 subscribers' });
    expect(ok.message).toContain('Fake Clips Channel');
    expect(ok.account?.externalId).toBe('UCfakechannel0000000001');

    const bad = await provider.testConnection({ ...tokens, accessToken: 'nope-nope-nope' });
    expect(bad.ok).toBe(false);
    expect(bad.account).toBeNull();
    expect(bad.detail).toMatch(/connect/i);
  });

  it('error texts never contain tokens, the client secret, the code or the verifier', async () => {
    const provider = makeProvider(fake);
    const { tokens } = await connect(provider);
    const c = await consent(provider);
    const secrets = [
      fake.clientSecret,
      tokens.accessToken,
      tokens.refreshToken!,
      c.code,
      c.verifier,
    ];
    const errs: PublishError[] = [];
    errs.push(
      await rejection(
        provider.exchangeCode({
          code: c.code,
          redirectUri: REDIRECT,
          codeVerifier: 'x'.repeat(50),
        }),
      ),
    );
    fake.control.expireRefreshTokens();
    errs.push(await rejection(provider.refresh(tokens)));
    errs.push(
      await rejection(
        provider.exchangeCode({ code: c.code, redirectUri: REDIRECT, codeVerifier: c.verifier }),
      ),
    );
    fake.control.failNext('auth', 1, { on: ['api'] });
    const t = await provider.testConnection(tokens);
    for (const e of errs) {
      const text = `${e.message} ${e.hint ?? ''} ${String(e.stack)}`;
      for (const s of secrets) expect(text).not.toContain(s);
    }
    for (const s of secrets) expect(`${t.message} ${t.detail}`).not.toContain(s);
  });

  it('logs never contain tokens or the secret', async () => {
    const lines: string[] = [];
    const provider = makeProvider(fake, { log: (m) => lines.push(m) });
    const { tokens } = await connect(provider);
    await provider.revoke(tokens);
    const all = lines.join('\n');
    expect(all).not.toContain(fake.clientSecret);
    expect(all).not.toContain(tokens.accessToken);
    expect(all).not.toContain(tokens.refreshToken!);
  });

  it('scrubs secrets that a hostile token endpoint echoes back', async () => {
    const hostile = await startFakeYoutube({ echoSecretsInErrors: true });
    try {
      const provider = makeProvider(hostile);
      const { tokens } = await connect(provider);
      const c = await consent(provider);
      const e1 = await rejection(
        provider.exchangeCode({
          code: c.code,
          redirectUri: REDIRECT,
          codeVerifier: 'v'.repeat(50),
        }),
      );
      hostile.control.expireRefreshTokens();
      const e2 = await rejection(provider.refresh(tokens));
      const bad = makeProvider(hostile, {
        credentials: { clientId: hostile.clientId, clientSecret: 'another-wrong-secret' },
      });
      const c2 = await consent(bad);
      const e3 = await rejection(
        bad.exchangeCode({ code: c2.code, redirectUri: REDIRECT, codeVerifier: c2.verifier }),
      );
      const secrets = [
        hostile.clientSecret,
        'another-wrong-secret',
        c.code,
        c2.code,
        c2.verifier,
        tokens.refreshToken!,
      ];
      for (const e of [e1, e2, e3])
        for (const s of secrets) expect(`${e.message} ${e.hint}`).not.toContain(s);
      expect(`${e1.message} ${e1.hint}`).toContain('***'); // it did echo, and was scrubbed
    } finally {
      await hostile.stop();
    }
  });
});
