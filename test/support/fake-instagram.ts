/**
 * A deterministic, in-process fake of the "Instagram API with Instagram Login" for tests and the real-Electron e2e.
 * Plain `node:http`, no timers: everything advances on requests. Written from the documented shapes
 * (Meta docs checked 2026-10-15; see electron/main/services/publish-instagram/provider.ts for the URLs):
 *   GET  {oauthBase}/oauth/authorize                 → 302 to redirect_uri?code=…&state=…#_
 *   POST {oauthBase}/oauth/access_token              → { data: [{ access_token, user_id (JSON number!), permissions }] }
 *   GET  {graphBase}/access_token                    → ig_exchange_token: long-lived token (expires_in)
 *   GET  {graphBase}/refresh_access_token            → ig_refresh_token (token must be ≥ 24 h old)
 *   GET  {graphBase}/[vNN.N/]me                      → professional account
 *   POST {graphBase}/[vNN.N/]{ig}/media              → REELS container; the fake GETs `video_url` like Instagram does
 *   GET  {graphBase}/[vNN.N/]{container}             → status_code IN_PROGRESS … FINISHED | ERROR (| PUBLISHED)
 *   POST {graphBase}/[vNN.N/]{ig}/media_publish      → { id }
 *   GET  {graphBase}/[vNN.N/]{media}                 → permalink, like_count, comments_count
 *   POST {graphBase}/[vNN.N/]{media}/comments        → { id }
 *   GET  {graphBase}/[vNN.N/]{media}/insights        → Reels metrics (unknown metric → error 100)
 *   GET  {graphBase}/[vNN.N/]{ig}/content_publishing_limit
 * `oauthBase` and `graphBase` are the same origin here (the real hosts differ; the paths do not collide).
 */
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type FailKind =
  'auth' | 'rate-limit' | 'container-error' | 'status-timeout' | 'comment-fail' | 'publish-limit';

export interface FakeInstagramOptions {
  appId?: string;
  appSecret?: string;
  user?: Partial<{
    id: string;
    username: string;
    name: string;
    accountType: string;
    pictureUrl: string;
  }>;
  /** When set, authorize / token exchange require redirect_uri to equal one of these. */
  redirectUris?: string[];
  /** IN_PROGRESS answers before a container reports FINISHED (default 2). */
  processingPolls?: number;
  /** API posts allowed per rolling 24 h (default 50). */
  quotaTotal?: number;
  /** Posts already counted before the test starts (default 0). */
  quotaUsage?: number;
  /** expires_in of a long-lived token in seconds (default 5183944 ≈ 60 days). */
  longTokenTtlSec?: number;
  now?: () => number;
}

export interface FakeToken {
  value: string;
  kind: 'short' | 'long';
  issuedAt: number;
  expiresAt: number;
  revoked: boolean;
}
export interface FakeContainer {
  id: string;
  params: Record<string, string>;
  polls: number;
  /** null = never finishes. */
  processingPolls: number | null;
  forcedError: boolean;
  fetch: { state: 'pending' | 'ok' | 'failed'; httpStatus: number | null; error: string | null };
  published: boolean;
  createdAt: number;
}
export interface FakeMedia {
  id: string;
  containerId: string;
  permalink: string;
  caption: string;
  publishedAt: number;
  comments: { id: string; message: string }[];
}
export interface FakeFetchedVideo {
  /** The URL exactly as the app gave it (presigned query included). */
  url: string;
  ok: boolean;
  httpStatus: number | null;
  bytes: number;
  sha256: string | null;
  error: string | null;
}
export interface FakeRequest {
  method: string;
  /** Path without the /vNN.N prefix. */
  path: string;
  version: string | null;
  query: Record<string, string>;
  body: Record<string, string>;
  hasBearer: boolean;
}

export interface FakeInstagram {
  urls: { oauthBase: string; graphBase: string };
  state: {
    appId: string;
    appSecret: string;
    user: { id: string; username: string; name: string; accountType: string; pictureUrl: string };
    tokens: FakeToken[];
    authCodes: { code: string; redirectUri: string; used: boolean }[];
    containers: FakeContainer[];
    media: FakeMedia[];
    fetchedVideos: FakeFetchedVideo[];
    requests: FakeRequest[];
    /** Metrics returned by /insights; set one to null to make Instagram omit it. */
    metrics: Record<string, number | null>;
  };
  control: {
    /** Fail the next `times` matching graph requests / actions. `where` = RegExp on `METHOD /path` (auth, rate-limit). */
    failNext(kind: FailKind, times?: number, where?: RegExp): void;
    /** IN_PROGRESS answers for containers created from now on. */
    setProcessingPolls(n: number): void;
    setQuotaUsage(n: number): void;
    setMetrics(m: Record<string, number | null>): void;
    /** Pretend every token was issued `ms` earlier (refresh needs ≥ 24 h). */
    ageTokens(ms: number): void;
    /** Make every issued token invalid (Instagram error 190). */
    revokeTokens(): void;
  };
  stop(): Promise<void>;
}

const ALLOWED_METRICS = [
  'views',
  'reach',
  'likes',
  'comments',
  'shares',
  'saved',
  'total_interactions',
  'ig_reels_avg_watch_time',
  'ig_reels_video_view_total_time',
];

function graphError(
  res: http.ServerResponse,
  httpStatus: number,
  code: number,
  message: string,
  extra: { subcode?: number; type?: string } = {},
): void {
  const body = {
    error: {
      message,
      type: extra.type ?? 'OAuthException',
      code,
      ...(extra.subcode !== undefined ? { error_subcode: extra.subcode } : {}),
      fbtrace_id: `fake${crypto.randomBytes(5).toString('hex')}`,
    },
  };
  res.writeHead(httpStatus, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

const json = (res: http.ServerResponse, body: unknown, status = 200): void => {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
};

async function readBody(req: http.IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  const type = String(req.headers['content-type'] ?? '');
  const out: Record<string, string> = {};
  if (type.includes('json')) {
    try {
      const o = JSON.parse(text) as Record<string, unknown>;
      for (const [k, v] of Object.entries(o))
        out[k] = typeof v === 'string' ? v : JSON.stringify(v);
    } catch {
      /* ignore */
    }
    return out;
  }
  for (const [k, v] of new URLSearchParams(text)) out[k] = v;
  return out;
}

export async function startFakeInstagram(opts: FakeInstagramOptions = {}): Promise<FakeInstagram> {
  const now = opts.now ?? Date.now;
  const user = {
    id: opts.user?.id ?? '17841405793187218',
    username: opts.user?.username ?? 'clipfern_test',
    name: opts.user?.name ?? 'Clipfern Test',
    accountType: opts.user?.accountType ?? 'BUSINESS',
    pictureUrl: opts.user?.pictureUrl ?? 'https://example.invalid/avatar.jpg',
  };
  const state: FakeInstagram['state'] = {
    appId: opts.appId ?? 'fake-ig-app-id',
    appSecret: opts.appSecret ?? 'fake-ig-app-secret-0123456789',
    user,
    tokens: [],
    authCodes: [],
    containers: [],
    media: [],
    fetchedVideos: [],
    requests: [],
    metrics: {
      views: 1234,
      reach: 987,
      likes: 56,
      comments: 7,
      shares: 12,
      saved: 3,
      total_interactions: 78,
    },
  };
  let processingPolls = opts.processingPolls ?? 2;
  let quotaUsage = opts.quotaUsage ?? 0;
  const quotaTotal = opts.quotaTotal ?? 50;
  const longTtl = opts.longTokenTtlSec ?? 5183944;
  const fails: { kind: FailKind; remaining: number; where?: RegExp }[] = [];
  let seq = 0;
  const rid = () => crypto.randomBytes(6).toString('hex');
  const pending: Promise<unknown>[] = [];

  const takeFail = (kind: FailKind, key?: string): boolean => {
    const f = fails.find(
      (x) =>
        x.kind === kind &&
        x.remaining > 0 &&
        (!x.where || (key !== undefined && x.where.test(key))),
    );
    if (!f) return false;
    f.remaining -= 1;
    return true;
  };

  const newToken = (kind: 'short' | 'long'): FakeToken => {
    const t = now();
    const tok: FakeToken = {
      value: `IGAAfake${kind}${(++seq).toString().padStart(3, '0')}${rid()}${rid()}${rid()}`,
      kind,
      issuedAt: t,
      expiresAt: t + (kind === 'short' ? 3600_000 : longTtl * 1000),
      revoked: false,
    };
    state.tokens.push(tok);
    return tok;
  };

  const containerStatus = (c: FakeContainer, count: boolean): { code: string; text: string } => {
    if (c.published) return { code: 'PUBLISHED', text: 'Published: Media has been published' };
    if (c.fetch.state === 'failed')
      return {
        code: 'ERROR',
        text: 'Error: Media upload has failed with error code 2207052',
      };
    // Instagram is still downloading the file: that is not processing progress yet, so the poll is not counted.
    if (c.fetch.state === 'pending')
      return { code: 'IN_PROGRESS', text: 'In progress: Media is being downloaded' };
    if (count) c.polls += 1;
    if (c.processingPolls === null || c.polls <= c.processingPolls)
      return { code: 'IN_PROGRESS', text: 'In progress: Media is being processed' };
    if (c.forcedError)
      return { code: 'ERROR', text: 'Error: Media upload has failed with error code 2207026' };
    return { code: 'FINISHED', text: 'Finished: Media is ready to be published' };
  };

  const fetchVideo = async (c: FakeContainer, url: string): Promise<void> => {
    const rec: FakeFetchedVideo = {
      url,
      ok: false,
      httpStatus: null,
      bytes: 0,
      sha256: null,
      error: null,
    };
    state.fetchedVideos.push(rec);
    try {
      const r = await fetch(url);
      rec.httpStatus = r.status;
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
      const hash = crypto.createHash('sha256');
      for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
        hash.update(chunk);
        rec.bytes += chunk.byteLength;
      }
      rec.sha256 = hash.digest('hex');
      rec.ok = true;
      c.fetch = { state: 'ok', httpStatus: r.status, error: null };
    } catch (e) {
      rec.error = e instanceof Error ? e.message : String(e);
      c.fetch = { state: 'failed', httpStatus: rec.httpStatus, error: rec.error };
    }
  };

  const tokenFrom = (
    query: Record<string, string>,
    body: Record<string, string>,
    req: http.IncomingMessage,
  ): string => {
    const auth = String(req.headers.authorization ?? '');
    const m = /^(?:Bearer|OAuth)\s+(.+)$/i.exec(auth);
    return query.access_token ?? body.access_token ?? m?.[1] ?? '';
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://fake');
      const query: Record<string, string> = {};
      for (const [k, v] of url.searchParams) query[k] = v;
      const method = req.method ?? 'GET';
      const vm = /^\/(v\d+\.\d+)(\/.*)$/.exec(url.pathname);
      const path = vm?.[2] ?? url.pathname;
      const body = method === 'POST' ? await readBody(req) : {};
      state.requests.push({
        method,
        path,
        version: vm?.[1] ?? null,
        query,
        body,
        hasBearer: /^Bearer /i.test(String(req.headers.authorization ?? '')),
      });
      const key = `${method} ${path}`;

      /* ---------------------------------------------------------------- OAuth hosts */
      if (method === 'GET' && path === '/oauth/authorize') {
        const redirectUri = query.redirect_uri ?? '';
        const bad = (msg: string) =>
          res.writeHead(400, { 'content-type': 'text/plain' }).end(`Invalid request: ${msg}`);
        if (query.client_id !== state.appId) return bad('client_id');
        if (query.response_type !== 'code') return bad('response_type');
        if (!(query.scope ?? '').includes('instagram_business_basic')) return bad('scope');
        if (opts.redirectUris && !opts.redirectUris.includes(redirectUri))
          return bad('redirect_uri');
        let target: URL;
        try {
          target = new URL(redirectUri);
        } catch {
          return bad('redirect_uri');
        }
        const code = `fakecode${(++seq).toString().padStart(3, '0')}${rid()}${rid()}`;
        state.authCodes.push({ code, redirectUri, used: false });
        target.searchParams.set('code', code);
        if (query.state !== undefined) target.searchParams.set('state', query.state);
        // Instagram appends `#_` to the redirect.
        res.writeHead(302, { location: `${target.toString()}#_` }).end();
        return;
      }
      if (method === 'POST' && path === '/oauth/access_token') {
        const oerr = (message: string) =>
          json(res, { error_type: 'OAuthException', code: 400, error_message: message }, 400);
        if (body.client_id !== state.appId) return oerr('Invalid client_id');
        if (body.client_secret !== state.appSecret) return oerr('Invalid client secret');
        if (body.grant_type !== 'authorization_code') return oerr('Invalid grant_type');
        const entry = state.authCodes.find((c) => c.code === body.code);
        if (!entry || entry.used) return oerr('Matching code was not found or was already used');
        if (entry.redirectUri !== body.redirect_uri) return oerr('Redirect URI does not match');
        entry.used = true;
        const tok = newToken('short');
        // Instagram sends user_id as a JSON NUMBER (which can exceed 2^53): reproduce that literally.
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(
            `{"data":[{"access_token":"${tok.value}","user_id":${user.id},"permissions":"instagram_business_basic,instagram_business_content_publish,instagram_business_manage_comments"}]}`,
          );
        return;
      }

      /* ---------------------------------------------------------------- graph host */
      if (takeFail('rate-limit', key))
        return graphError(res, 400, 4, '(#4) Application request limit reached', {
          type: 'OAuthException',
        });
      if (takeFail('auth', key))
        return graphError(res, 400, 190, 'Error validating access token: Session has expired', {
          subcode: 463,
        });

      if (method === 'GET' && path === '/access_token') {
        if (query.grant_type !== 'ig_exchange_token')
          return graphError(res, 400, 100, 'Unsupported grant_type');
        if (query.client_secret !== state.appSecret)
          return graphError(res, 400, 100, 'Error validating client secret.');
        const short = state.tokens.find(
          (t) => t.value === query.access_token && t.kind === 'short',
        );
        if (!short || short.revoked || short.expiresAt <= now())
          return graphError(res, 400, 190, 'Invalid OAuth access token.');
        const long = newToken('long');
        return json(res, { access_token: long.value, token_type: 'bearer', expires_in: longTtl });
      }
      if (method === 'GET' && path === '/refresh_access_token') {
        const tok = state.tokens.find((t) => t.value === query.access_token && t.kind === 'long');
        if (query.grant_type !== 'ig_refresh_token')
          return graphError(res, 400, 100, 'Unsupported grant_type');
        if (!tok || tok.revoked || tok.expiresAt <= now())
          return graphError(res, 400, 190, 'Cannot refresh an expired or invalid token', {
            subcode: 463,
          });
        if (now() - tok.issuedAt < 24 * 3600_000)
          return graphError(res, 400, 100, 'Token must be at least 24 hours old to be refreshed');
        const fresh = newToken('long');
        return json(res, { access_token: fresh.value, token_type: 'bearer', expires_in: longTtl });
      }

      // Everything below needs a valid token.
      const presented = tokenFrom(query, body, req);
      const tok = state.tokens.find((t) => t.value === presented);
      if (!tok || tok.revoked || tok.expiresAt <= now())
        return graphError(res, 400, 190, 'Invalid OAuth access token - Cannot parse access token');

      if (method === 'GET' && path === '/me') {
        const wanted = (query.fields ?? 'user_id,username').split(',');
        const all: Record<string, string> = {
          id: '24000000000000001',
          user_id: user.id,
          username: user.username,
          name: user.name,
          account_type: user.accountType,
          profile_picture_url: user.pictureUrl,
        };
        const out: Record<string, string> = {};
        for (const f of wanted) if (all[f] !== undefined) out[f] = all[f];
        out.id = all.id as string;
        return json(res, out);
      }

      const seg = path.split('/').filter(Boolean);
      const [id, action] = seg;
      if (!id || seg.length > 2)
        return graphError(res, 400, 100, 'Unsupported request', { type: 'GraphMethodException' });

      if (method === 'GET' && action === 'content_publishing_limit' && id === user.id) {
        return json(res, {
          data: [
            {
              quota_usage: quotaUsage + state.media.length,
              config: { quota_total: quotaTotal, quota_duration: 86400 },
            },
          ],
        });
      }

      if (method === 'POST' && action === 'media' && id === user.id) {
        if (body.media_type !== 'REELS')
          return graphError(res, 400, 100, 'Only REELS containers are supported by this fake', {
            subcode: 2207023,
          });
        if (!body.video_url)
          return graphError(res, 400, 100, 'The parameter video_url is required');
        const caption = body.caption ?? '';
        if ([...caption].length > 2200)
          return graphError(res, 400, 36004, 'The caption is too long', { subcode: 2207010 });
        if ((caption.match(/(?<![\p{L}\p{N}_.@])@[A-Za-z0-9._]{1,30}/gu)?.length ?? 0) > 20)
          return graphError(res, 400, 100, 'Too many @ tags', { subcode: 2207040 });
        if (body.collaborators) {
          try {
            const list = JSON.parse(body.collaborators) as unknown;
            if (!Array.isArray(list) || list.length > 3) throw new Error('too many');
          } catch {
            return graphError(res, 400, 100, 'Invalid collaborators parameter');
          }
        }
        if (body.thumb_offset !== undefined && !/^\d+$/.test(body.thumb_offset))
          return graphError(res, 400, 100, 'Invalid thumb_offset');
        const c: FakeContainer = {
          id: `1790000000${(++seq).toString().padStart(6, '0')}`,
          params: { ...body, access_token: '***' },
          polls: 0,
          processingPolls: takeFail('status-timeout') ? null : processingPolls,
          forcedError: takeFail('container-error'),
          fetch: { state: 'pending', httpStatus: null, error: null },
          published: false,
          createdAt: now(),
        };
        state.containers.push(c);
        pending.push(fetchVideo(c, body.video_url));
        return json(res, { id: c.id });
      }

      if (method === 'POST' && action === 'media_publish' && id === user.id) {
        const c = state.containers.find((x) => x.id === body.creation_id);
        if (!c) return graphError(res, 400, 100, 'Invalid creation_id', { subcode: 2207008 });
        if (c.published)
          return graphError(res, 400, 100, 'This container was already published', {
            subcode: 2207020,
          });
        if (containerStatus(c, false).code !== 'FINISHED')
          return graphError(res, 400, 9007, 'Media ID is not available', { subcode: 2207027 });
        if (takeFail('publish-limit') || quotaUsage + state.media.length >= quotaTotal)
          return graphError(res, 400, 9, 'The daily Content Publishing API limit is reached', {
            subcode: 2207042,
          });
        c.published = true;
        const m: FakeMedia = {
          id: `1800000000${(++seq).toString().padStart(6, '0')}`,
          containerId: c.id,
          permalink: `https://www.instagram.com/reel/F${rid()}/`,
          caption: c.params.caption ?? '',
          publishedAt: now(),
          comments: [],
        };
        state.media.push(m);
        return json(res, { id: m.id });
      }

      if (method === 'POST' && action === 'comments') {
        const m = state.media.find((x) => x.id === id);
        if (!m) return graphError(res, 400, 100, 'Unsupported post request. Object does not exist');
        if (takeFail('comment-fail'))
          return graphError(
            res,
            400,
            10,
            '(#10) Application does not have permission for this action',
          );
        if (!body.message) return graphError(res, 400, 100, 'The parameter message is required');
        const cm = {
          id: `1780000000${(++seq).toString().padStart(6, '0')}`,
          message: body.message,
        };
        m.comments.push(cm);
        return json(res, { id: cm.id });
      }

      if (method === 'GET' && action === 'insights') {
        const m = state.media.find((x) => x.id === id);
        if (!m) return graphError(res, 400, 100, 'Unsupported get request. Object does not exist');
        const asked = (query.metric ?? '').split(',').filter(Boolean);
        const bad = asked.findIndex((x) => !ALLOWED_METRICS.includes(x));
        if (asked.length === 0 || bad >= 0)
          return graphError(
            res,
            400,
            100,
            `(#100) metric[${Math.max(bad, 0)}] must be one of the following values: ${ALLOWED_METRICS.join(', ')}`,
          );
        const data = asked
          .filter((n) => state.metrics[n] !== null && state.metrics[n] !== undefined)
          .map((n) => ({
            name: n,
            period: 'lifetime',
            values: [{ value: state.metrics[n] }],
            title: n,
            id: `${m.id}/insights/${n}/lifetime`,
          }));
        return json(res, { data });
      }

      if (method === 'GET' && !action) {
        const c = state.containers.find((x) => x.id === id);
        if (c) {
          const st = containerStatus(c, true);
          const wanted = (query.fields ?? 'id').split(',');
          const out: Record<string, string> = { id: c.id };
          if (wanted.includes('status_code')) out.status_code = st.code;
          if (wanted.includes('status')) out.status = st.text;
          return json(res, out);
        }
        const m = state.media.find((x) => x.id === id);
        if (m) {
          const wanted = (query.fields ?? 'id').split(',');
          const all: Record<string, unknown> = {
            permalink: m.permalink,
            like_count: state.metrics.likes ?? undefined,
            comments_count: m.comments.length + (state.metrics.comments ?? 0),
            media_product_type: 'REELS',
            caption: m.caption,
          };
          const out: Record<string, unknown> = { id: m.id };
          for (const f of wanted) if (all[f] !== undefined) out[f] = all[f];
          return json(res, out);
        }
        return graphError(res, 400, 100, 'Unsupported get request. Object does not exist', {
          subcode: 33,
          type: 'GraphMethodException',
        });
      }
      return graphError(res, 400, 100, 'Unsupported request', { type: 'GraphMethodException' });
    })().catch((e: unknown) => {
      if (!res.headersSent)
        res.writeHead(500, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            error: { message: `fake crashed: ${String(e)}`, code: 2, type: 'OAuthException' },
          }),
        );
      else res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    urls: { oauthBase: origin, graphBase: origin },
    state,
    control: {
      failNext(kind, times = 1, where) {
        fails.push({ kind, remaining: times, where });
      },
      setProcessingPolls(n) {
        processingPolls = n;
      },
      setQuotaUsage(n) {
        quotaUsage = n;
      },
      setMetrics(m) {
        Object.assign(state.metrics, m);
      },
      ageTokens(ms) {
        for (const t of state.tokens) {
          t.issuedAt -= ms;
          t.expiresAt -= ms;
        }
      },
      revokeTokens() {
        for (const t of state.tokens) t.revoked = true;
      },
    },
    async stop() {
      await Promise.allSettled(pending);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
