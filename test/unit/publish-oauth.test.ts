import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileKeyCipher } from '@main/services/secrets';
import { OAuthFlowError, OAuthLoopback, newPkce } from '@main/services/publish/oauth';
import { TokenStore } from '@main/services/publish/token-store';
import crypto from 'node:crypto';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const get = (url: string): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });

let nextPort = 54100 + Math.floor(Math.random() * 500);
const loopback = (over: Partial<ConstructorParameters<typeof OAuthLoopback>[0]> = {}) => {
  const port = nextPort++;
  return { port, oauth: new OAuthLoopback({ port: () => port, openExternal: async () => {}, ...over }) };
};

describe('PKCE', () => {
  it('derives an S256 challenge from the verifier', () => {
    const { verifier, challenge } = newPkce();
    expect(challenge).toBe(crypto.createHash('sha256').update(verifier).digest('base64url'));
    expect(verifier.length).toBeGreaterThanOrEqual(43);
  });
});

describe('OAuthLoopback', () => {
  it('opens the consent URL, accepts the redirect with the right state and returns the code + verifier', async () => {
    let opened = '';
    const { oauth, port } = loopback({
      openExternal: async (u) => {
        opened = u;
        const url = new URL(u);
        const redirect = `${url.searchParams.get('redirect_uri')}?code=abc123&state=${url.searchParams.get('state')}`;
        setTimeout(() => void get(redirect), 20);
      },
    });
    const res = await oauth.authorize('shorts', (a) => {
      const u = new URL('https://accounts.example/auth');
      u.searchParams.set('redirect_uri', a.redirectUri);
      u.searchParams.set('state', a.state);
      u.searchParams.set('code_challenge', a.codeChallenge);
      return u.toString();
    });
    expect(res.code).toBe('abc123');
    expect(res.redirectUri).toBe(`http://127.0.0.1:${port}/oauth/shorts`);
    const challenge = new URL(opened).searchParams.get('code_challenge');
    expect(crypto.createHash('sha256').update(res.codeVerifier).digest('base64url')).toBe(challenge);
    expect(oauth.isActive()).toBe(false);
  });

  it('ignores a request with the wrong state and keeps waiting for the real one', async () => {
    let bad = 0;
    const { oauth } = loopback({
      openExternal: async (u) => {
        const url = new URL(u);
        const ru = url.searchParams.get('redirect_uri') as string;
        setTimeout(async () => {
          bad = (await get(`${ru}?code=evil&state=nope`)).status;
          await get(`${ru}?code=good&state=${url.searchParams.get('state')}`);
        }, 20);
      },
    });
    const res = await oauth.authorize('tiktok', (a) => `https://x.example/?redirect_uri=${encodeURIComponent(a.redirectUri)}&state=${a.state}`);
    expect(bad).toBe(400);
    expect(res.code).toBe('good');
  });

  it('rejects with "denied" when the user refuses', async () => {
    const { oauth } = loopback({
      openExternal: async (u) => {
        const url = new URL(u);
        setTimeout(
          () => void get(`${url.searchParams.get('redirect_uri')}?error=access_denied&state=${url.searchParams.get('state')}`),
          20,
        );
      },
    });
    await expect(
      oauth.authorize('reels', (a) => `https://x.example/?redirect_uri=${encodeURIComponent(a.redirectUri)}&state=${a.state}`),
    ).rejects.toMatchObject({ kind: 'denied' });
  });

  it('times out, can be canceled and allows only one flow at a time', async () => {
    const t = loopback({ timeoutMs: 80 });
    await expect(t.oauth.authorize('shorts', () => 'https://x.example/')).rejects.toMatchObject({
      kind: 'timeout',
    });

    const c = loopback({ timeoutMs: 5000 });
    const p = c.oauth.authorize('shorts', () => 'https://x.example/');
    await new Promise((r) => setTimeout(r, 30));
    await expect(c.oauth.authorize('tiktok', () => 'https://x.example/')).rejects.toMatchObject({
      kind: 'busy',
    });
    expect(c.oauth.cancel('shorts')).toBe(true);
    await expect(p).rejects.toBeInstanceOf(OAuthFlowError);
    await expect(p).rejects.toMatchObject({ kind: 'canceled' });
  });

  it('explains an occupied port', async () => {
    const blocker = http.createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
    const port = (blocker.address() as { port: number }).port;
    const oauth = new OAuthLoopback({ port: () => port, openExternal: async () => {} });
    await expect(oauth.authorize('shorts', () => 'https://x.example/')).rejects.toMatchObject({
      kind: 'port',
    });
    blocker.close();
  });
});

describe('TokenStore', () => {
  it('persists tokens encrypted, never in plain text', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-tok-'));
    dirs.push(dir);
    const cipher = new FileKeyCipher(path.join(dir, 'k'));
    const file = path.join(dir, 'tokens.bin');
    const a = new TokenStore(file, cipher);
    a.set('acc1', { accessToken: 'SECRET-ACCESS', refreshToken: 'SECRET-REFRESH', expiresAt: 5, scope: null, extra: {} });
    expect(fs.readFileSync(file).toString('utf8')).not.toContain('SECRET');
    const b = new TokenStore(file, cipher);
    expect(b.get('acc1')?.refreshToken).toBe('SECRET-REFRESH');
    b.delete('acc1');
    expect(new TokenStore(file, cipher).has('acc1')).toBe(false);
  });
});
