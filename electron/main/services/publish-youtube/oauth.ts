/**
 * Google OAuth 2.0 for installed (desktop) apps: loopback redirect + PKCE S256 + `state`.
 * Docs checked 2026-10-15: https://developers.google.com/identity/protocols/oauth2/native-app
 * (authorization endpoint, token endpoint `grant_type=authorization_code|refresh_token`, `/revoke`).
 * `access_type=offline` + `prompt=consent` make Google always issue a refresh token (the docs page for native apps
 * does not list these two parameters but the Google authorization server honours them, as for every Google flow).
 */
import type { OAuthTokens } from '../../pipeline/contracts5';
import { PublishError } from '../publish/errors';
import { SCOPES } from './constants';
import { mapTokenError, transportError } from './errors';
import { TransportError, parseJson, send, type HttpCtx } from './http';
import { z } from 'zod';

export interface OAuthUrls {
  auth: string;
  token: string;
  revoke: string;
}
export interface Credentials {
  clientId: string;
  clientSecret: string;
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.coerce.number().finite().optional().catch(undefined),
  refresh_token: z.string().min(1).optional().catch(undefined),
  scope: z.string().optional().catch(undefined),
});

export function buildAuthUrl(
  urls: OAuthUrls,
  creds: Credentials,
  a: { redirectUri: string; state: string; codeChallenge: string },
): string {
  const u = new URL(urls.auth);
  const q = u.searchParams;
  q.set('client_id', creds.clientId);
  q.set('redirect_uri', a.redirectUri);
  q.set('response_type', 'code');
  q.set('scope', SCOPES.join(' '));
  q.set('code_challenge', a.codeChallenge);
  q.set('code_challenge_method', 'S256');
  q.set('state', a.state);
  q.set('access_type', 'offline');
  q.set('prompt', 'consent');
  return u.toString();
}

async function postForm(
  ctx: HttpCtx,
  url: string,
  form: Record<string, string>,
  signal: AbortSignal | undefined,
) {
  try {
    return await send(ctx, url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
      signal,
    });
  } catch (e) {
    if (e instanceof TransportError) throw transportError(e);
    throw e;
  }
}

function readTokens(
  text: string,
  nowMs: number,
  previous: OAuthTokens | null,
): { tokens: OAuthTokens; gotRefreshToken: boolean } {
  const r = tokenResponseSchema.safeParse(parseJson(text));
  if (!r.success)
    throw new PublishError('platform', 'Google sent a sign-in response Clipfern could not read.', {
      retryable: true,
    });
  const t = r.data;
  return {
    gotRefreshToken: !!t.refresh_token,
    tokens: {
      accessToken: t.access_token,
      refreshToken: t.refresh_token ?? previous?.refreshToken ?? null,
      expiresAt: t.expires_in !== undefined ? nowMs + t.expires_in * 1000 : null,
      scope: t.scope ?? previous?.scope ?? null,
      extra: previous?.extra ?? {},
    },
  };
}

export async function exchangeAuthCode(
  ctx: HttpCtx,
  urls: OAuthUrls,
  creds: Credentials,
  a: { code: string; redirectUri: string; codeVerifier: string },
  signal?: AbortSignal,
): Promise<OAuthTokens> {
  const secrets = [creds.clientSecret, a.code, a.codeVerifier];
  const form: Record<string, string> = {
    grant_type: 'authorization_code',
    client_id: creds.clientId,
    code: a.code,
    code_verifier: a.codeVerifier,
    redirect_uri: a.redirectUri,
  };
  if (creds.clientSecret) form.client_secret = creds.clientSecret;
  const reply = await postForm(ctx, urls.token, form, signal);
  if (reply.status < 200 || reply.status >= 300)
    throw mapTokenError(reply, 'exchange', secrets, ctx.now());
  const { tokens, gotRefreshToken } = readTokens(reply.text, ctx.now(), null);
  if (!gotRefreshToken)
    throw new PublishError('auth', 'Google did not issue a long-lived sign-in (no refresh token).', {
      retryable: false,
      hint: 'Remove Clipfern at myaccount.google.com/permissions and connect again so Google asks for consent anew.',
    });
  return tokens;
}

export async function refreshAccessToken(
  ctx: HttpCtx,
  urls: OAuthUrls,
  creds: Credentials,
  tokens: OAuthTokens,
  signal?: AbortSignal,
): Promise<OAuthTokens> {
  if (!tokens.refreshToken)
    throw new PublishError('auth', 'There is no saved long-lived sign-in for this channel.', {
      retryable: false,
      hint: 'Connect the YouTube channel again in Settings → Integrations.',
    });
  const secrets = [creds.clientSecret, tokens.refreshToken, tokens.accessToken];
  const form: Record<string, string> = {
    grant_type: 'refresh_token',
    client_id: creds.clientId,
    refresh_token: tokens.refreshToken,
  };
  if (creds.clientSecret) form.client_secret = creds.clientSecret;
  const reply = await postForm(ctx, urls.token, form, signal);
  if (reply.status < 200 || reply.status >= 300)
    throw mapTokenError(reply, 'refresh', secrets, ctx.now());
  return readTokens(reply.text, ctx.now(), tokens).tokens;
}

/** Best effort: revoking the refresh token also invalidates its access tokens. Never throws (but honours abort). */
export async function revokeToken(
  ctx: HttpCtx,
  urls: OAuthUrls,
  tokens: OAuthTokens,
): Promise<void> {
  const token = tokens.refreshToken ?? tokens.accessToken;
  if (!token) return;
  try {
    const reply = await send(ctx, urls.revoke, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    });
    if (reply.status >= 400) ctx.log(`youtube: revoke answered HTTP ${reply.status} (ignored)`);
  } catch {
    ctx.log('youtube: revoke could not reach Google (ignored)');
  }
}
