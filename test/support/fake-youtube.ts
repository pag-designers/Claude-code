/**
 * A fake Google OAuth + YouTube Data API v3 server for tests and e2e. A plain `node:http` server (no dependencies, runs
 * in any Node process, deterministic ids), speaking the shapes documented at
 *   https://developers.google.com/identity/protocols/oauth2/native-app   (authorize / token / revoke, PKCE)
 *   https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol  (308 / Range / Content-Range)
 *   https://developers.google.com/youtube/v3/docs/{channels/list,videos/list,videos/insert}
 * (docs checked 2026-10-15).
 *
 *   const fake = await startFakeYoutube();
 *   fake.urls   → { oauthBase, apiBase, uploadBase }   (pass as the provider's baseUrls)
 *   fake.state  → everything it saw/issued (tokens, videos with metadata + byte counts + sha256, quota, request log)
 *   fake.control→ failure injection and knobs;  await fake.stop()
 *
 * What it really enforces: client id/secret, redirect_uri match, one-shot auth codes, PKCE S256 against the stored
 * challenge, `state` echo, token expiry (virtual clock), revocation, bearer scopes, the documented field rules of
 * videos.insert (title/description/tags/category), 256 KiB chunk alignment, contiguous Content-Range, partial commits
 * of an interrupted chunk (rounded DOWN to 256 KiB, like the real service), status queries and completed-upload replay.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

export const SCOPE_UPLOAD = 'https://www.googleapis.com/auth/youtube.upload';
export const SCOPE_READONLY = 'https://www.googleapis.com/auth/youtube.readonly';
const ALIGN = 256 * 1024;

export interface FakeChannel {
  id: string;
  title: string;
  /** With the leading @, as the real API returns it. */
  customUrl: string | null;
  thumbnailUrl: string | null;
  subscriberCount: number;
  hiddenSubscriberCount: boolean;
  selfDeclaredMadeForKids: boolean;
}

export interface FakeYoutubeOptions {
  host?: string;
  /** 0 = any free port (default). */
  port?: number;
  clientId?: string;
  clientSecret?: string;
  accessTokenTtlSec?: number;
  /** videos.insert bucket (calls/day, 1 unit each). Default 100. */
  insertDailyLimit?: number;
  /** All other methods. Default 10 000. */
  generalDailyLimit?: number;
  /** null = the Google account has no YouTube channel. */
  channel?: Partial<FakeChannel> | null;
  /**
   * Hostile mode: every error text echoes the bearer token / client secret / auth code / PKCE verifier / refresh token
   * the request carried, to prove the client scrubs them before showing an error. Default false.
   */
  echoSecretsInErrors?: boolean;
  /** Reject `/authorize` without a PKCE S256 challenge (default true). */
  requirePkce?: boolean;
  maxUploadBytes?: number;
  /** Status of the final upload response (the docs say 201; the live service answers 200). Default 200. */
  finalStatus?: 200 | 201;
}

export type FailKind =
  | 'quota'
  | 'auth'
  | '5xx'
  | 'drop-connection'
  | 'invalid-title'
  /** 403 forbidden (the API's own message). */
  | 'forbidden'
  /** 400 uploadLimitExceeded (the channel's own daily upload limit). */
  | 'upload-limit'
  /** 429 with `Retry-After: 30`. */
  | 'rate-limit';
export type FailTarget = 'init' | 'chunk' | 'status' | 'api' | 'token';

export interface FailOpts {
  /** Where it applies. Defaults: quota/invalid-title → init; auth → init, chunk, status, api; 5xx and drop → chunk. */
  on?: FailTarget[];
  /** 5xx: the status to answer (default 503). */
  status?: number;
  /** drop-connection on a chunk: close the socket after this many body bytes (default: half of the chunk). */
  afterBytes?: number;
  /** drop-connection on a chunk: 'mid-body' (default) or 'after-commit' (the chunk is stored, the answer is lost). */
  phase?: 'mid-body' | 'after-commit';
  /** Only fail requests whose chunk starts at this offset (chunk target). */
  atOffset?: number;
}

export interface FakeVideo {
  id: string;
  sessionId: string;
  /** The JSON body of the initiating POST (snippet + status), as received. */
  metadata: {
    snippet?: { title?: string; description?: string; tags?: string[]; categoryId?: string };
    status?: { privacyStatus?: string; selfDeclaredMadeForKids?: boolean; publishAt?: string };
  };
  notifySubscribers: boolean;
  contentType: string;
  byteCount: number;
  sha256: string;
  privacyStatus: string;
}

export interface RequestLogEntry {
  method: string;
  route:
    | 'authorize'
    | 'token'
    | 'revoke'
    | 'channels'
    | 'videos.list'
    | 'upload.init'
    | 'upload.chunk'
    | 'upload.status'
    | 'unknown';
  status: number;
  /** upload.chunk: the Content-Range header as received. */
  contentRange?: string;
}

export interface AuthRequestRecord {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string | null;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
  accessType: string | null;
  prompt: string | null;
}

export interface FakeYoutubeState {
  authRequests: AuthRequestRecord[];
  tokenRequests: { grantType: string; ok: boolean; error: string | null }[];
  tokens: { accessIssued: string[]; refreshIssued: string[]; revoked: string[] };
  videos: FakeVideo[];
  sessions: { id: string; total: number; committed: number; complete: boolean }[];
  quota: { general: number; insert: number; generalLimit: number; insertLimit: number };
  requests: RequestLogEntry[];
  counters: {
    uploadInits: number;
    chunkRequests: number;
    statusQueries: number;
    /** Chunk PUTs that were refused for misalignment / a wrong offset (a correct client never causes one). */
    badChunks: number;
    droppedConnections: number;
  };
  /** Headers and query of the last upload-initiating POST. */
  lastInit: {
    headers: Record<string, string>;
    query: Record<string, string>;
  } | null;
}

export interface FakeYoutubeControl {
  failNext(kind: FailKind, times?: number, opts?: FailOpts): void;
  clearFailures(): void;
  /** The next /authorize redirects back with `error=access_denied`. */
  denyNextConsent(): void;
  /** Scopes the consent "grants" (simulates unticked boxes). null = what was requested. */
  setGrantedScopes(scopes: string[] | null): void;
  /** Access tokens stop working now (the refresh tokens still work). */
  expireAccessTokens(): void;
  /** Refresh tokens stop working (`invalid_grant`), e.g. a revoked grant or a 7-day "Testing" expiry. */
  expireRefreshTokens(): void;
  /** Moves the fake's clock forward (token expiry). */
  advanceClock(ms: number): void;
  setChannel(c: Partial<FakeChannel> | null): void;
  setStats(
    videoId: string,
    s: { viewCount?: number | null; likeCount?: number | null; commentCount?: number | null },
  ): void;
  setInsertDailyLimit(n: number): void;
  setMaxUploadBytes(n: number | null): void;
  /** Every open upload session answers 404 from now on. */
  expireSessions(): void;
  /** What YouTube "applies" to new uploads regardless of the request (e.g. 'private' for an unverified project). */
  forcePrivacy(p: 'public' | 'unlisted' | 'private' | null): void;
}

export interface FakeYoutube {
  urls: { oauthBase: string; apiBase: string; uploadBase: string };
  clientId: string;
  clientSecret: string;
  state: FakeYoutubeState;
  control: FakeYoutubeControl;
  stop(): Promise<void>;
}

/* ---------------------------------------------------------------------------------------- helpers ---- */

/** Set per request when `echoSecretsInErrors`: tokens/secrets the request carried, appended to error texts. */
let echoNow = '';
const echoed = (m: string): string => (echoNow ? `${m} [${echoNow}]` : m);

const googleError = (code: number, reason: string, message0: string, domain = 'global') => {
  const message = echoed(message0);
  return JSON.stringify({
    error: {
      code,
      message,
      errors: [{ message, domain, reason }],
      ...(code === 401 ? { status: 'UNAUTHENTICATED' } : {}),
    },
  });
};

const oauthError = (error: string, description: string) =>
  JSON.stringify({ error, error_description: echoed(description) });

const sha256Of = (s: string) => crypto.createHash('sha256').update(s).digest('base64url');

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
    req.on('close', () => resolve(Buffer.concat(parts)));
  });
}

interface Session {
  id: string;
  total: number;
  committed: number;
  hash: crypto.Hash;
  contentType: string;
  metadata: FakeVideo['metadata'];
  notifySubscribers: boolean;
  video: FakeVideo | null;
  expired: boolean;
}
interface AccessToken {
  scope: string;
  expiresAt: number;
  refresh: string;
  revoked: boolean;
}
interface RefreshToken {
  scope: string;
  revoked: boolean;
  expired: boolean;
}
interface AuthCode {
  challenge: string | null;
  redirectUri: string;
  scope: string;
  used: boolean;
}
interface Failure {
  kind: FailKind;
  remaining: number;
  opts: FailOpts;
}

const DEFAULT_TARGETS: Record<FailKind, FailTarget[]> = {
  quota: ['init'],
  'invalid-title': ['init'],
  forbidden: ['init'],
  'upload-limit': ['init'],
  'rate-limit': ['init'],
  auth: ['init', 'chunk', 'status', 'api'],
  '5xx': ['chunk'],
  'drop-connection': ['chunk'],
};

/* ------------------------------------------------------------------------------------------ server ---- */

export async function startFakeYoutube(opts: FakeYoutubeOptions = {}): Promise<FakeYoutube> {
  const host = opts.host ?? '127.0.0.1';
  const clientId = opts.clientId ?? 'fake-client-id.apps.googleusercontent.com';
  const clientSecret = opts.clientSecret ?? 'fake-client-secret';
  const ttl = opts.accessTokenTtlSec ?? 3600;
  const requirePkce = opts.requirePkce ?? true;
  let maxUploadBytes: number | null = opts.maxUploadBytes ?? null;

  let clockOffset = 0;
  const nowMs = () => Date.now() + clockOffset;

  let channel: FakeChannel | null =
    opts.channel === null
      ? null
      : {
          id: 'UCfakechannel0000000001',
          title: 'Fake Clips Channel',
          customUrl: '@fakeclips',
          thumbnailUrl: 'https://yt3.example/avatar-default.jpg',
          subscriberCount: 1234,
          hiddenSubscriberCount: false,
          selfDeclaredMadeForKids: false,
          ...opts.channel,
        };

  const state: FakeYoutubeState = {
    authRequests: [],
    tokenRequests: [],
    tokens: { accessIssued: [], refreshIssued: [], revoked: [] },
    videos: [],
    sessions: [],
    quota: {
      general: 0,
      insert: 0,
      generalLimit: opts.generalDailyLimit ?? 10_000,
      insertLimit: opts.insertDailyLimit ?? 100,
    },
    requests: [],
    counters: {
      uploadInits: 0,
      chunkRequests: 0,
      statusQueries: 0,
      badChunks: 0,
      droppedConnections: 0,
    },
    lastInit: null,
  };

  const codes = new Map<string, AuthCode>();
  const access = new Map<string, AccessToken>();
  const refresh = new Map<string, RefreshToken>();
  const sessions = new Map<string, Session>();
  const stats = new Map<string, Record<string, number | null>>();
  const failures: Failure[] = [];
  let denyConsent = false;
  let grantedScopes: string[] | null = null;
  let forcedPrivacy: string | null = null;
  const seq = { code: 0, access: 0, refresh: 0, session: 0, video: 0 };

  const takeFailure = (target: FailTarget, atOffset?: number): Failure | null => {
    for (const f of failures) {
      const targets = f.opts.on ?? DEFAULT_TARGETS[f.kind];
      if (f.remaining <= 0 || !targets.includes(target)) continue;
      if (target === 'chunk' && f.opts.atOffset !== undefined && f.opts.atOffset !== atOffset)
        continue;
      f.remaining--;
      return f;
    }
    return null;
  };

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((e) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(googleError(500, 'backendError', `fake server bug: ${String(e)}`));
      } else res.destroy();
    });
  });
  const sockets = new Set<Socket>();
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, host, resolve));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://${host}:${port}`;
  const urls = {
    oauthBase: `${origin}/oauth`,
    apiBase: `${origin}/youtube/v3`,
    uploadBase: `${origin}/upload/youtube/v3`,
  };

  function reply(
    res: http.ServerResponse,
    status: number,
    body: string,
    entry: Omit<RequestLogEntry, 'status'>,
    headers: Record<string, string> = {},
  ): void {
    state.requests.push({ ...entry, status });
    res.writeHead(status, {
      'content-type': 'application/json; charset=UTF-8',
      'content-length': String(Buffer.byteLength(body)),
      ...headers,
    });
    res.end(body);
  }

  /** Bearer check; replies 401/403 itself and returns null on failure. */
  function bearer(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    scope: string,
    entry: Omit<RequestLogEntry, 'status'>,
  ): AccessToken | null {
    const h = req.headers.authorization ?? '';
    const tok = /^Bearer (.+)$/i.exec(h)?.[1];
    const rec = tok ? access.get(tok) : undefined;
    if (!rec || rec.revoked || rec.expiresAt <= nowMs()) {
      reply(
        res,
        401,
        googleError(
          401,
          'authError',
          'Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential.',
        ),
        entry,
      );
      return null;
    }
    if (!rec.scope.split(' ').includes(scope)) {
      reply(
        res,
        403,
        googleError(
          403,
          'insufficientPermissions',
          'Request had insufficient authentication scopes.',
        ),
        entry,
      );
      return null;
    }
    return rec;
  }

  function injected(
    f: Failure,
    res: http.ServerResponse,
    entry: Omit<RequestLogEntry, 'status'>,
    target: FailTarget,
  ): void {
    switch (f.kind) {
      case 'quota':
        return reply(
          res,
          403,
          googleError(
            403,
            'quotaExceeded',
            'The request cannot be completed because you have exceeded your quota.',
            'youtube.quota',
          ),
          entry,
        );
      case 'auth':
        if (target === 'token')
          return reply(
            res,
            400,
            oauthError('invalid_grant', 'Token has been expired or revoked.'),
            entry,
          );
        return reply(res, 401, googleError(401, 'authError', 'Invalid Credentials'), entry);
      case '5xx': {
        const st = f.opts.status ?? 503;
        return reply(res, st, googleError(st, 'backendError', 'Backend Error'), entry);
      }
      case 'invalid-title':
        return reply(
          res,
          400,
          googleError(
            400,
            'invalidTitle',
            'The request metadata specifies an invalid or empty video title.',
            'youtube.video',
          ),
          entry,
        );
      case 'forbidden':
        return reply(
          res,
          403,
          googleError(
            403,
            'forbidden',
            'The caller does not have permission to upload to this channel.',
          ),
          entry,
        );
      case 'upload-limit':
        return reply(
          res,
          400,
          googleError(
            400,
            'uploadLimitExceeded',
            'The user has exceeded the number of videos they may upload.',
            'youtube.video',
          ),
          entry,
        );
      case 'rate-limit':
        return reply(res, 429, googleError(429, 'rateLimitExceeded', 'Too many requests.'), entry, {
          'retry-after': '30',
        });
      case 'drop-connection':
        state.counters.droppedConnections++;
        state.requests.push({ ...entry, status: 0 });
        res.socket?.destroy();
        return;
    }
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', origin);
    echoNow = opts.echoSecretsInErrors
      ? (/^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? '')
      : '';
    const p = url.pathname;
    const method = req.method ?? 'GET';

    /* ------------------------------------------------------------------ OAuth: authorize */
    if (method === 'GET' && p === '/oauth/authorize') {
      const entry = { method, route: 'authorize' as const };
      const q = url.searchParams;
      const redirectUri = q.get('redirect_uri') ?? '';
      state.authRequests.push({
        clientId: q.get('client_id') ?? '',
        redirectUri,
        scope: q.get('scope') ?? '',
        state: q.get('state'),
        codeChallenge: q.get('code_challenge'),
        codeChallengeMethod: q.get('code_challenge_method'),
        accessType: q.get('access_type'),
        prompt: q.get('prompt'),
      });
      const bad = (msg: string) =>
        reply(
          res,
          400,
          JSON.stringify({ error: 'invalid_request', error_description: msg }),
          entry,
        );
      if (q.get('client_id') !== clientId) return bad('Unknown client_id');
      if (q.get('response_type') !== 'code') return bad('response_type must be code');
      let target: URL;
      try {
        target = new URL(redirectUri);
      } catch {
        return bad('redirect_uri is not a URL');
      }
      if (
        target.protocol !== 'http:' ||
        !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)
      )
        return bad('redirect_uri must be a loopback http URL');
      const challenge = q.get('code_challenge');
      if (requirePkce && (!challenge || q.get('code_challenge_method') !== 'S256'))
        return bad('Missing or unsupported code_challenge (S256 required)');
      const stateParam = q.get('state');
      const loc = new URL(target);
      if (denyConsent) {
        denyConsent = false;
        loc.searchParams.set('error', 'access_denied');
      } else {
        const requested = (q.get('scope') ?? '').split(/\s+/).filter(Boolean);
        const granted = grantedScopes ?? requested;
        const code = `fake-code-${++seq.code}`;
        codes.set(code, {
          challenge,
          redirectUri,
          scope: granted.join(' '),
          used: false,
        });
        loc.searchParams.set('code', code);
      }
      if (stateParam !== null) loc.searchParams.set('state', stateParam);
      state.requests.push({ ...entry, status: 302 });
      res.writeHead(302, { location: loc.toString(), 'content-length': '0' });
      res.end();
      return;
    }

    /* ------------------------------------------------------------------ OAuth: token */
    if (method === 'POST' && p === '/oauth/token') {
      const entry = { method, route: 'token' as const };
      const form = new URLSearchParams((await readBody(req)).toString('utf8'));
      const grant = form.get('grant_type') ?? '';
      if (opts.echoSecretsInErrors)
        echoNow = ['client_secret', 'code', 'code_verifier', 'refresh_token']
          .map((k) => form.get(k) ?? '')
          .filter(Boolean)
          .join(' ');
      const fail = (status: number, error: string, desc: string) => {
        state.tokenRequests.push({ grantType: grant, ok: false, error });
        reply(res, status, oauthError(error, desc), entry);
      };
      const inj = takeFailure('token');
      if (inj) {
        state.tokenRequests.push({ grantType: grant, ok: false, error: 'injected' });
        return injected(inj, res, entry, 'token');
      }
      if (form.get('client_id') !== clientId)
        return fail(401, 'invalid_client', 'The OAuth client was not found.');
      if (form.get('client_secret') !== clientSecret)
        return fail(401, 'invalid_client', 'Unauthorized');
      if (grant === 'authorization_code') {
        const rec = codes.get(form.get('code') ?? '');
        if (!rec || rec.used) return fail(400, 'invalid_grant', 'Bad Request');
        rec.used = true;
        if (form.get('redirect_uri') !== rec.redirectUri)
          return fail(400, 'redirect_uri_mismatch', 'Bad Request');
        if (rec.challenge) {
          const verifier = form.get('code_verifier') ?? '';
          if (!verifier || sha256Of(verifier) !== rec.challenge)
            return fail(400, 'invalid_grant', 'Invalid code verifier.');
        }
        const rt = `fake-refresh-${++seq.refresh}`;
        refresh.set(rt, { scope: rec.scope, revoked: false, expired: false });
        state.tokens.refreshIssued.push(rt);
        const at = `fake-access-${++seq.access}`;
        access.set(at, {
          scope: rec.scope,
          expiresAt: nowMs() + ttl * 1000,
          refresh: rt,
          revoked: false,
        });
        state.tokens.accessIssued.push(at);
        state.tokenRequests.push({ grantType: grant, ok: true, error: null });
        return reply(
          res,
          200,
          JSON.stringify({
            access_token: at,
            expires_in: ttl,
            refresh_token: rt,
            scope: rec.scope,
            token_type: 'Bearer',
          }),
          entry,
        );
      }
      if (grant === 'refresh_token') {
        const rt = form.get('refresh_token') ?? '';
        const rec = refresh.get(rt);
        if (!rec || rec.revoked || rec.expired)
          return fail(400, 'invalid_grant', 'Token has been expired or revoked.');
        const at = `fake-access-${++seq.access}`;
        access.set(at, {
          scope: rec.scope,
          expiresAt: nowMs() + ttl * 1000,
          refresh: rt,
          revoked: false,
        });
        state.tokens.accessIssued.push(at);
        state.tokenRequests.push({ grantType: grant, ok: true, error: null });
        return reply(
          res,
          200,
          JSON.stringify({
            access_token: at,
            expires_in: ttl,
            scope: rec.scope,
            token_type: 'Bearer',
          }),
          entry,
        );
      }
      return fail(400, 'unsupported_grant_type', 'Invalid grant_type');
    }

    /* ------------------------------------------------------------------ OAuth: revoke */
    if (method === 'POST' && p === '/oauth/revoke') {
      const entry = { method, route: 'revoke' as const };
      const token = new URLSearchParams((await readBody(req)).toString('utf8')).get('token') ?? '';
      const a = access.get(token);
      const r = refresh.get(token);
      if (!a && !r)
        return reply(res, 400, oauthError('invalid_token', 'Token expired or revoked'), entry);
      if (a) a.revoked = true;
      if (r) {
        r.revoked = true;
        for (const at of access.values()) if (refresh.get(at.refresh) === r) at.revoked = true;
      }
      state.tokens.revoked.push(token);
      return reply(res, 200, '{}', entry);
    }

    /* ------------------------------------------------------------------ channels.list */
    if (method === 'GET' && p === '/youtube/v3/channels') {
      const entry = { method, route: 'channels' as const };
      const inj = takeFailure('api');
      if (inj) return injected(inj, res, entry, 'api');
      if (!bearer(req, res, SCOPE_READONLY, entry)) return;
      if (state.quota.general >= state.quota.generalLimit)
        return injected({ kind: 'quota', remaining: 0, opts: {} }, res, entry, 'api');
      state.quota.general += 1;
      if (url.searchParams.get('mine') !== 'true')
        return reply(
          res,
          400,
          googleError(400, 'invalidCriteria', 'Specify exactly one filter.'),
          entry,
        );
      const parts = (url.searchParams.get('part') ?? '').split(',');
      const items = channel
        ? [
            {
              kind: 'youtube#channel',
              id: channel.id,
              ...(parts.includes('snippet')
                ? {
                    snippet: {
                      title: channel.title,
                      ...(channel.customUrl ? { customUrl: channel.customUrl } : {}),
                      thumbnails: channel.thumbnailUrl
                        ? {
                            default: { url: channel.thumbnailUrl, width: 88, height: 88 },
                            medium: {
                              url: channel.thumbnailUrl.replace('default', 'medium'),
                              width: 240,
                              height: 240,
                            },
                          }
                        : {},
                    },
                  }
                : {}),
              ...(parts.includes('statistics')
                ? {
                    statistics: {
                      viewCount: '99999',
                      subscriberCount: String(channel.subscriberCount),
                      hiddenSubscriberCount: channel.hiddenSubscriberCount,
                      videoCount: '12',
                    },
                  }
                : {}),
              ...(parts.includes('status')
                ? {
                    status: {
                      privacyStatus: 'public',
                      selfDeclaredMadeForKids: channel.selfDeclaredMadeForKids,
                    },
                  }
                : {}),
            },
          ]
        : [];
      return reply(
        res,
        200,
        JSON.stringify({
          kind: 'youtube#channelListResponse',
          pageInfo: { totalResults: items.length, resultsPerPage: 5 },
          ...(items.length ? { items } : {}),
        }),
        entry,
      );
    }

    /* ------------------------------------------------------------------ videos.list */
    if (method === 'GET' && p === '/youtube/v3/videos') {
      const entry = { method, route: 'videos.list' as const };
      const inj = takeFailure('api');
      if (inj) return injected(inj, res, entry, 'api');
      if (!bearer(req, res, SCOPE_READONLY, entry)) return;
      state.quota.general += 1;
      const ids = (url.searchParams.get('id') ?? '').split(',').filter(Boolean);
      const items = ids
        .filter((id) => state.videos.some((v) => v.id === id))
        .map((id) => {
          const s = stats.get(id) ?? { viewCount: 0, likeCount: 0, commentCount: 0 };
          const out: Record<string, string> = {};
          for (const [k, v] of Object.entries(s)) if (v !== null) out[k] = String(v);
          return { kind: 'youtube#video', id, statistics: { ...out, favoriteCount: '0' } };
        });
      return reply(
        res,
        200,
        JSON.stringify({
          kind: 'youtube#videoListResponse',
          items,
          pageInfo: { totalResults: items.length, resultsPerPage: items.length },
        }),
        entry,
      );
    }

    /* ------------------------------------------------------------------ upload: initiate */
    if (method === 'POST' && p === '/upload/youtube/v3/videos') {
      const entry = { method, route: 'upload.init' as const };
      const body = (await readBody(req)).toString('utf8');
      state.counters.uploadInits++;
      const inj = takeFailure('init');
      if (inj) return injected(inj, res, entry, 'init');
      if (!bearer(req, res, SCOPE_UPLOAD, entry)) return;
      const q = url.searchParams;
      state.lastInit = {
        headers: {
          'content-type': String(req.headers['content-type'] ?? ''),
          'x-upload-content-length': String(req.headers['x-upload-content-length'] ?? ''),
          'x-upload-content-type': String(req.headers['x-upload-content-type'] ?? ''),
        },
        query: Object.fromEntries(q.entries()),
      };
      const invalid = (reason: string, message: string) =>
        reply(res, 400, googleError(400, reason, message, 'youtube.video'), entry);
      if (q.get('uploadType') !== 'resumable')
        return invalid('invalidVideoMetadata', 'This fake only speaks uploadType=resumable.');
      const total = Number(req.headers['x-upload-content-length']);
      if (!Number.isInteger(total) || total <= 0)
        return invalid('mediaBodyRequired', 'X-Upload-Content-Length is required.');
      if (
        !/^(video\/|application\/octet-stream)/.test(
          String(req.headers['x-upload-content-type'] ?? ''),
        )
      )
        return invalid('unsupportedMediaType', 'X-Upload-Content-Type must be video/*.');
      if (maxUploadBytes !== null && total > maxUploadBytes)
        return reply(
          res,
          413,
          googleError(413, 'uploadTooLarge', 'The video is too large.'),
          entry,
        );
      let meta: FakeVideo['metadata'];
      try {
        meta = JSON.parse(body) as FakeVideo['metadata'];
      } catch {
        return invalid('invalidVideoMetadata', 'The request body is not valid JSON.');
      }
      const sn = meta.snippet ?? {};
      const title = sn.title ?? '';
      if (!title.trim() || Array.from(title).length > 100 || /[<>]/.test(title))
        return invalid(
          'invalidTitle',
          'The request metadata specifies an invalid or empty video title.',
        );
      const desc = sn.description ?? '';
      if (Buffer.byteLength(desc, 'utf8') > 5000 || /[<>]/.test(desc))
        return invalid(
          'invalidDescription',
          'The request metadata specifies an invalid video description.',
        );
      const tags = sn.tags ?? [];
      const budget =
        tags.reduce((n, t) => n + Array.from(t).length + (/\s/.test(t) ? 2 : 0), 0) +
        Math.max(0, tags.length - 1);
      if (budget > 500)
        return invalid('invalidTags', 'The request metadata specifies invalid video keywords.');
      if (sn.categoryId !== undefined && !/^\d+$/.test(sn.categoryId))
        return invalid('invalidCategoryId', 'The video category is invalid.');
      const priv = meta.status?.privacyStatus;
      if (priv !== undefined && !['public', 'unlisted', 'private'].includes(priv))
        return invalid('invalidVideoMetadata', 'privacyStatus is invalid.');
      if (state.quota.insert >= state.quota.insertLimit)
        return injected({ kind: 'quota', remaining: 0, opts: {} }, res, entry, 'init');
      state.quota.insert += 1;
      const id = `up-${++seq.session}`;
      sessions.set(id, {
        id,
        total,
        committed: 0,
        hash: crypto.createHash('sha256'),
        contentType: String(req.headers['x-upload-content-type']),
        metadata: meta,
        notifySubscribers: q.get('notifySubscribers') !== 'false',
        video: null,
        expired: false,
      });
      return reply(res, 200, '', entry, {
        location: `${urls.uploadBase}/videos?uploadType=resumable&upload_id=${id}`,
      });
    }

    /* ------------------------------------------------------------------ upload: chunk / status */
    if (method === 'PUT' && p === '/upload/youtube/v3/videos') {
      const id = url.searchParams.get('upload_id') ?? '';
      const range = String(req.headers['content-range'] ?? '');
      const isStatus = /^bytes \*\//.test(range);
      const entry = {
        method,
        route: (isStatus ? 'upload.status' : 'upload.chunk') as 'upload.status' | 'upload.chunk',
        contentRange: range,
      };
      const session = sessions.get(id);
      if (!session || session.expired) {
        req.resume();
        return reply(res, 404, googleError(404, 'notFound', 'Upload session not found.'), entry);
      }
      const resource = () => {
        const v = session.video;
        if (!v) return '{}';
        return JSON.stringify({
          kind: 'youtube#video',
          id: v.id,
          snippet: {
            title: v.metadata.snippet?.title ?? '',
            categoryId: v.metadata.snippet?.categoryId,
          },
          status: {
            uploadStatus: 'uploaded',
            privacyStatus: v.privacyStatus,
            selfDeclaredMadeForKids: v.metadata.status?.selfDeclaredMadeForKids ?? false,
          },
        });
      };
      const progress = () =>
        reply(
          res,
          308,
          '',
          entry,
          session.committed > 0 ? { range: `bytes=0-${session.committed - 1}` } : {},
        );

      if (isStatus) {
        await readBody(req);
        state.counters.statusQueries++;
        const inj = takeFailure('status');
        if (inj) return injected(inj, res, entry, 'status');
        if (session.video) return reply(res, opts.finalStatus ?? 200, resource(), entry);
        return progress();
      }

      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
      const start = m ? Number(m[1]) : -1;
      const end = m ? Number(m[2]) : -1;
      state.counters.chunkRequests++;
      const inj = takeFailure('chunk', start);
      if (inj && !(inj.kind === 'drop-connection')) {
        req.resume();
        return injected(inj, res, entry, 'chunk');
      }
      const badRequest = (msg: string) => {
        state.counters.badChunks++;
        req.resume();
        reply(res, 400, googleError(400, 'badRequest', msg), entry);
      };
      if (!m || Number(m[3]) !== session.total) return badRequest('Invalid Content-Range.');
      const length = end - start + 1;
      if (length <= 0 || end >= session.total) return badRequest('Invalid Content-Range.');
      if (Number(req.headers['content-length']) !== length)
        return badRequest('Content-Length does not match Content-Range.');
      if (length % ALIGN !== 0 && end + 1 !== session.total)
        return badRequest('Chunk size must be a multiple of 256 KiB (except the last chunk).');
      if (session.video) {
        req.resume();
        return reply(res, opts.finalStatus ?? 200, resource(), entry);
      }
      if (start !== session.committed) {
        // Overlapping/skipped bytes: nothing is stored; tell the client where we are.
        state.counters.badChunks++;
        req.resume();
        return progress();
      }

      const finalize = (): void => {
        const priv = forcedPrivacy ?? session.metadata.status?.privacyStatus ?? 'public';
        const v: FakeVideo = {
          id: `FAKEVID${String(++seq.video).padStart(4, '0')}`,
          sessionId: session.id,
          metadata: session.metadata,
          notifySubscribers: session.notifySubscribers,
          contentType: session.contentType,
          byteCount: session.committed,
          sha256: session.hash.digest('hex'),
          privacyStatus: priv,
        };
        session.video = v;
        state.videos.push(v);
      };

      const dropAfter =
        inj?.kind === 'drop-connection' && inj.opts.phase !== 'after-commit'
          ? (inj.opts.afterBytes ?? Math.floor(length / 2))
          : null;
      const received: Buffer[] = [];
      let receivedBytes = 0;
      let finished = false;
      req.on('data', (c: Buffer) => {
        if (finished) return;
        received.push(c);
        receivedBytes += c.length;
        if (dropAfter !== null && receivedBytes >= dropAfter) {
          finished = true;
          state.counters.droppedConnections++;
          state.requests.push({ ...entry, status: 0 });
          commit(Buffer.concat(received), true);
          req.socket.destroy();
        }
      });
      const commit = (data: Buffer, partial: boolean) => {
        // The real service persists whole 256 KiB blocks of an interrupted chunk.
        const keep = partial ? Math.floor(data.length / ALIGN) * ALIGN : data.length;
        if (keep > 0) {
          session.hash.update(data.subarray(0, keep));
          session.committed += keep;
        }
      };
      req.on('close', () => {
        if (finished) return;
        finished = true;
        if (!req.complete) {
          state.counters.droppedConnections++;
          state.requests.push({ ...entry, status: 0 });
          commit(Buffer.concat(received), true);
        }
      });
      req.on('end', () => {
        if (finished) return;
        finished = true;
        const data = Buffer.concat(received);
        if (data.length !== length) {
          state.counters.badChunks++;
          return reply(
            res,
            400,
            googleError(400, 'badRequest', 'Body shorter than Content-Range.'),
            entry,
          );
        }
        commit(data, false);
        if (inj?.kind === 'drop-connection') {
          // phase 'after-commit': stored, answer lost
          state.counters.droppedConnections++;
          if (session.committed === session.total) finalize();
          state.requests.push({ ...entry, status: 0 });
          req.socket.destroy();
          return;
        }
        if (session.committed === session.total) {
          finalize();
          return reply(res, opts.finalStatus ?? 200, resource(), entry);
        }
        progress();
      });

      return;
    }

    req.resume();
    reply(res, 404, googleError(404, 'notFound', `No such fake route: ${method} ${p}`), {
      method,
      route: 'unknown',
    });
  }

  // Live view of the sessions for assertions.
  Object.defineProperty(state, 'sessions', {
    enumerable: true,
    get: () =>
      [...sessions.values()].map((s) => ({
        id: s.id,
        total: s.total,
        committed: s.committed,
        complete: !!s.video,
      })),
  });

  const control: FakeYoutubeControl = {
    failNext(kind, times = 1, o = {}) {
      failures.push({ kind, remaining: times, opts: o });
    },
    clearFailures() {
      failures.length = 0;
    },
    denyNextConsent() {
      denyConsent = true;
    },
    setGrantedScopes(s) {
      grantedScopes = s;
    },
    expireAccessTokens() {
      for (const t of access.values()) t.expiresAt = nowMs();
    },
    expireRefreshTokens() {
      for (const r of refresh.values()) r.expired = true;
    },
    advanceClock(ms) {
      clockOffset += ms;
    },
    setChannel(c) {
      channel = c === null ? null : ({ ...(channel ?? defaultChannel()), ...c } as FakeChannel);
    },
    setStats(videoId, s) {
      stats.set(videoId, {
        ...(stats.get(videoId) ?? { viewCount: 0, likeCount: 0, commentCount: 0 }),
        ...s,
      });
    },
    setInsertDailyLimit(n) {
      state.quota.insertLimit = n;
    },
    setMaxUploadBytes(n) {
      maxUploadBytes = n;
    },
    expireSessions() {
      for (const s of sessions.values()) s.expired = true;
    },
    forcePrivacy(p) {
      forcedPrivacy = p;
    },
  };

  function defaultChannel(): FakeChannel {
    return {
      id: 'UCfakechannel0000000001',
      title: 'Fake Clips Channel',
      customUrl: '@fakeclips',
      thumbnailUrl: 'https://yt3.example/avatar-default.jpg',
      subscriberCount: 1234,
      hiddenSubscriberCount: false,
      selfDeclaredMadeForKids: false,
    };
  }

  return {
    urls,
    clientId,
    clientSecret,
    state,
    control,
    async stop() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
