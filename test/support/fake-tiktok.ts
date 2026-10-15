/**
 * A deterministic fake of the TikTok Login Kit (OAuth v2 + PKCE) and Content Posting API, on plain `node:http`.
 * Written from the official docs (read 2026-10-15):
 *   https://developers.tiktok.com/doc/login-kit-desktop                      (hex SHA-256 PKCE, loopback redirects)
 *   https://developers.tiktok.com/doc/oauth-user-access-token-management     (token / rotating refresh / revoke)
 *   https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
 *   https://developers.tiktok.com/doc/content-posting-api-reference-upload-video
 *   https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide (chunk rules, Content-Range, 206/201/416)
 *   https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status
 *   https://developers.tiktok.com/doc/content-posting-api-reference-query-creator-info
 * Used by test/unit/publish-tiktok*.test.ts and by the lead's real-Electron e2e (point CLIPFERN_TIKTOK_AUTH_BASE and
 * CLIPFERN_TIKTOK_API_BASE at `urls.authBase` / `urls.apiBase`; client key/secret default to the values in `state`).
 *
 * Strictness that matters for the real thing: the authorize call refuses redirect URIs TikTok would refuse (host must
 * be localhost / 127.0.0.1, port required, no query/fragment) and PKCE challenges that are not hex(SHA-256(verifier));
 * chunk uploads are checked for Content-Length, Content-Range continuity (416 otherwise), chunk sizes (5..64 MB, final
 * chunk up to 128 MB), the declared total_chunk_count = floor(size / chunk_size); refresh tokens ROTATE.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type FailKind =
  'auth' | 'rate-limit' | 'unaudited' | 'chunk-fail' | 'chunk-lost-ack' | 'status-failed' | 'spam';

export interface FakeTiktokOpts {
  /** Audited app: creator_info offers every level. Unaudited (false): see `unauditedOffersAll`. Default true. */
  audited?: boolean;
  /** Unaudited only. true = creator_info still lists every level and `video/init` refuses non-private ones with
   *  `unaudited_client_can_only_post_to_private_accounts` (what a real unaudited app may see). Default false: only SELF_ONLY. */
  unauditedOffersAll?: boolean;
  clientKey?: string;
  clientSecret?: string;
  /** Registered redirect URIs (a `*` port is a wildcard). Default: accept any loopback URI that obeys TikTok's rules. */
  redirectUris?: string[];
  creator?: Partial<FakeCreator>;
  /** Seconds reported as `expires_in` of access tokens. Default 86400. */
  accessTtlSec?: number;
}

export interface FakeCreator {
  openId: string;
  nickname: string;
  username: string;
  avatarUrl: string;
  maxDurationSec: number;
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
}

export interface FakeUpload {
  publishId: string;
  mode: 'direct' | 'draft';
  openId: string;
  /** The `post_info` exactly as the app sent it (direct only). */
  postInfo: Record<string, unknown> | null;
  videoSize: number;
  chunkSize: number;
  totalChunkCount: number;
  /** The upload URL handed out (contains a credential in its query string). */
  uploadUrl: string;
  /** Every chunk PUT: range, response status. */
  chunks: { start: number; end: number; status: number }[];
  receivedBytes: number;
  complete: boolean;
  /** sha256 hex of the bytes received once complete. */
  sha256: string | null;
  statusPolls: number;
  finalStatus: 'PUBLISH_COMPLETE' | 'SEND_TO_USER_INBOX' | 'FAILED' | null;
}

export interface FakeTiktok {
  urls: { authBase: string; apiBase: string };
  state: {
    clientKey: string;
    clientSecret: string;
    /** Direct posts whose upload completed (status per `finalStatus` of the upload record). */
    published: FakeUpload[];
    /** Drafts whose upload completed. */
    inbox: FakeUpload[];
    /** Every init, complete or not. */
    uploads: FakeUpload[];
    requests: { method: string; path: string; status: number }[];
    tokensIssued: { access: string[]; refresh: string[] };
    /** Currently valid refresh token(s). */
    validRefreshTokens(): string[];
    revokeCalls: number;
    authorizeCalls: number;
    lastAuthorize: {
      redirectUri: string;
      scope: string;
      state: string;
      codeChallenge: string;
    } | null;
    creator: FakeCreator;
    audited: boolean;
  };
  control: {
    failNext(kind: FailKind, times?: number, detail?: string): void;
    /** How many `status/fetch` polls answer PROCESSING_UPLOAD after the upload is complete (default 1). */
    setProcessingPolls(n: number): void;
    /** Every access token issued so far now answers 401 `access_token_invalid`. */
    expireAccessTokens(): void;
    /** Every refresh token issued so far is refused with `invalid_grant`. */
    revokeRefreshTokens(): void;
    setCreator(c: Partial<FakeCreator>): void;
  };
  stop(): Promise<void>;
}

const ALL_LEVELS = ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'];
const MB = 1024 * 1024;
const PUBLIC_POST_ID_RAW = '7300000000000000001'; // > 2^53: must never go through a JS number

const sha256Hex = (b: Buffer | string): string =>
  crypto.createHash('sha256').update(b).digest('hex');

function redirectOk(uri: string, registered: string[] | undefined): string | null {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return 'redirect_uri is not an absolute URI';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'redirect_uri must be http(s)';
  if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1')
    return 'only localhost or 127.0.0.1 are allowed host names';
  if (!u.port) return 'a port number is required';
  if (u.search || u.hash || uri.includes('?') || uri.includes('#'))
    return 'redirect_uri must be static';
  if (uri.length >= 512) return 'redirect_uri too long';
  if (registered) {
    const ok = registered.some((r) => {
      const re = new RegExp(
        `^${r.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/:\*/g, ':\\d+')}$`,
      );
      return re.test(uri);
    });
    if (!ok) return 'redirect_uri is not registered';
  }
  return null;
}

export async function startFakeTiktok(opts: FakeTiktokOpts = {}): Promise<FakeTiktok> {
  const audited = opts.audited ?? true;
  const clientKey = opts.clientKey ?? 'fake-client-key';
  const clientSecret = opts.clientSecret ?? 'fake-client-secret-0123456789';
  const accessTtl = opts.accessTtlSec ?? 86400;
  const creator: FakeCreator = {
    openId: 'open-id-0001',
    nickname: 'Fern Clips',
    username: 'fernclips',
    avatarUrl: 'https://example.invalid/avatar.jpg',
    maxDurationSec: 600,
    commentDisabled: false,
    duetDisabled: false,
    stitchDisabled: false,
    ...opts.creator,
  };

  let seq = 0;
  const next = (): number => ++seq;
  const codes = new Map<string, { redirectUri: string; challenge: string; scope: string }>();
  const access = new Map<string, { scope: string; expired: boolean }>();
  const refresh = new Map<string, { scope: string; valid: boolean }>();
  const issued = { access: [] as string[], refresh: [] as string[] };
  const uploads: FakeUpload[] = [];
  const bodies = new Map<string, Buffer[]>();
  const uploadTokens = new Map<string, string>();
  const requests: FakeTiktok['state']['requests'] = [];
  const fails: { kind: FailKind; left: number; detail?: string }[] = [];
  let processingPolls = 1;
  let revokeCalls = 0;
  let authorizeCalls = 0;
  let lastAuthorize: FakeTiktok['state']['lastAuthorize'] = null;

  const takeFail = (...kinds: FailKind[]): { kind: FailKind; detail?: string } | null => {
    const f = fails.find((x) => x.left > 0 && kinds.includes(x.kind));
    if (!f) return null;
    f.left--;
    return { kind: f.kind, detail: f.detail };
  };

  const levels = (): string[] =>
    audited ? ALL_LEVELS : opts.unauditedOffersAll ? ALL_LEVELS : ['SELF_ONLY'];

  const readBody = (req: http.IncomingMessage): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const parts: Buffer[] = [];
      req.on('data', (d: Buffer) => parts.push(d));
      req.on('end', () => resolve(Buffer.concat(parts)));
      req.on('error', reject);
    });

  const send = (
    res: http.ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
    raw = false,
  ): void => {
    const text = raw ? (body as string) : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=UTF-8', ...headers });
    res.end(text);
  };
  const apiErr = (
    res: http.ServerResponse,
    status: number,
    code: string,
    message: string,
    h = {},
  ): void => send(res, status, { data: {}, error: { code, message, log_id: `log-${next()}` } }, h);
  const ok = (res: http.ServerResponse, data: unknown, rawJson?: string): void =>
    rawJson !== undefined
      ? send(res, 200, rawJson, {}, true)
      : send(res, 200, { data, error: { code: 'ok', message: '', log_id: `log-${next()}` } });

  /** Bearer + scope check; answers the error itself and returns null on failure. */
  const authed = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    anyOf: string[],
  ): { token: string; scope: string } | null => {
    const f = takeFail('auth', 'rate-limit');
    if (f?.kind === 'auth')
      return (
        void apiErr(
          res,
          401,
          'access_token_invalid',
          'The access token is invalid or not found in the request.',
        ),
        null
      );
    if (f?.kind === 'rate-limit')
      return (
        void apiErr(res, 429, 'rate_limit_exceeded', 'Too many requests.', { 'Retry-After': '7' }),
        null
      );
    const m = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''));
    const rec = m?.[1] ? access.get(m[1]) : undefined;
    if (!m?.[1] || !rec || rec.expired)
      return (
        void apiErr(
          res,
          401,
          'access_token_invalid',
          'The access token is invalid or not found in the request.',
        ),
        null
      );
    const have = rec.scope.split(',');
    if (!anyOf.some((s) => have.includes(s)))
      return (
        void apiErr(
          res,
          401,
          'scope_not_authorized',
          `The user did not authorize the scope ${anyOf.join(' or ')}.`,
        ),
        null
      );
    return { token: m[1], scope: rec.scope };
  };

  const issue = (scope: string, prevRefresh?: string): Record<string, unknown> => {
    const n = next();
    const a = `act.fake-access-${n}-${sha256Hex(`a${n}`).slice(0, 16)}`;
    const r = `rft.fake-refresh-${n}-${sha256Hex(`r${n}`).slice(0, 16)}`;
    access.set(a, { scope, expired: false });
    refresh.set(r, { scope, valid: true });
    if (prevRefresh) {
      const old = refresh.get(prevRefresh);
      if (old) old.valid = false; // rotation: the previous refresh token is spent
    }
    issued.access.push(a);
    issued.refresh.push(r);
    return {
      access_token: a,
      expires_in: accessTtl,
      open_id: creator.openId,
      refresh_expires_in: 31536000,
      refresh_token: r,
      scope,
      token_type: 'Bearer',
    };
  };

  const finish = (up: FakeUpload, fail: { detail?: string } | null): void => {
    up.complete = true;
    up.sha256 = sha256Hex(Buffer.concat(bodies.get(up.publishId) ?? []));
    if (fail) failReasons.set(up.publishId, fail.detail ?? 'file_format_check_failed');
    (up.mode === 'direct' ? published : inbox).push(up);
  };
  const failReasons = new Map<string, string>();
  const published: FakeUpload[] = [];
  const inbox: FakeUpload[] = [];

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const p = url.pathname;
    const method = req.method ?? 'GET';

    /* ---- Login Kit ---- */
    if (method === 'GET' && p === '/v2/auth/authorize/') {
      authorizeCalls++;
      const q = url.searchParams;
      const bad = (m: string): void => {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end(`authorize error: ${m}`);
      };
      if (q.get('client_key') !== clientKey) return bad('invalid client_key');
      if (q.get('response_type') !== 'code') return bad('response_type must be code');
      const redirectUri = q.get('redirect_uri') ?? '';
      const why = redirectOk(redirectUri, opts.redirectUris);
      if (why) return bad(why);
      const challenge = q.get('code_challenge') ?? '';
      if (q.get('code_challenge_method') !== 'S256' || !/^[0-9a-f]{64}$/.test(challenge))
        return bad(
          'PKCE: code_challenge must be the hex encoding of SHA-256(code_verifier), method S256',
        );
      const state = q.get('state') ?? '';
      if (!state) return bad('state is required');
      const scope = (q.get('scope') ?? '').split(',').filter(Boolean).join(',');
      lastAuthorize = { redirectUri, scope, state, codeChallenge: challenge };
      const code = `fake-code-${next()}`;
      codes.set(code, { redirectUri, challenge, scope });
      const loc = new URL(redirectUri);
      loc.searchParams.set('code', code);
      loc.searchParams.set('scopes', scope);
      loc.searchParams.set('state', state);
      res.writeHead(302, { Location: loc.toString() });
      res.end();
      return;
    }

    if (method === 'POST' && p === '/v2/oauth/token/') {
      const form = new URLSearchParams((await readBody(req)).toString('utf8'));
      const oauthErr = (status: number, error: string, desc: string): void =>
        send(res, status, { error, error_description: desc, log_id: `log-${next()}` });
      if (form.get('client_key') !== clientKey || form.get('client_secret') !== clientSecret)
        return oauthErr(401, 'invalid_client', 'Client key or secret is incorrect.');
      const grant = form.get('grant_type');
      if (grant === 'authorization_code') {
        const code = form.get('code') ?? '';
        const rec = codes.get(code);
        if (!rec)
          return oauthErr(400, 'invalid_grant', 'Authorization code is expired or invalid.');
        codes.delete(code); // single use
        if (form.get('redirect_uri') !== rec.redirectUri)
          return oauthErr(400, 'invalid_grant', 'redirect_uri does not match.');
        const verifier = form.get('code_verifier') ?? '';
        if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier) || sha256Hex(verifier) !== rec.challenge)
          return oauthErr(400, 'invalid_grant', 'code_verifier does not match the code_challenge.');
        return send(res, 200, issue(rec.scope));
      }
      if (grant === 'refresh_token') {
        const rt = form.get('refresh_token') ?? '';
        const rec = refresh.get(rt);
        if (!rec || !rec.valid)
          return oauthErr(400, 'invalid_grant', 'Refresh token is invalid or expired.');
        return send(res, 200, issue(rec.scope, rt));
      }
      return oauthErr(400, 'invalid_request', 'The request parameters are malformed.');
    }

    if (method === 'POST' && p === '/v2/oauth/revoke/') {
      const form = new URLSearchParams((await readBody(req)).toString('utf8'));
      revokeCalls++;
      const t = form.get('token') ?? '';
      const a = access.get(t);
      if (a) a.expired = true;
      return send(res, 200, {});
    }

    /* ---- user + creator ---- */
    if (method === 'GET' && p === '/v2/user/info/') {
      const a = authed(req, res, ['user.info.basic']);
      if (!a) return;
      const want = (url.searchParams.get('fields') ?? '').split(',');
      const user: Record<string, string> = {};
      if (want.includes('open_id')) user.open_id = creator.openId;
      if (want.includes('union_id')) user.union_id = `union-${creator.openId}`;
      if (want.includes('avatar_url')) user.avatar_url = creator.avatarUrl;
      if (want.includes('display_name')) user.display_name = creator.nickname;
      // `username` needs user.info.profile, which Clipfern does not request.
      if (want.includes('username') && a.scope.split(',').includes('user.info.profile'))
        user.username = creator.username;
      return ok(res, { user });
    }

    if (method === 'POST' && p === '/v2/post/publish/creator_info/query/') {
      const a = authed(req, res, ['video.publish']);
      if (!a) return;
      const f = takeFail('spam');
      if (f)
        return apiErr(
          res,
          200,
          'spam_risk_too_many_posts',
          'Daily post cap reached for the current user.',
        );
      return ok(res, {
        creator_avatar_url: creator.avatarUrl,
        creator_username: creator.username,
        creator_nickname: creator.nickname,
        privacy_level_options: levels(),
        comment_disabled: creator.commentDisabled,
        duet_disabled: creator.duetDisabled,
        stitch_disabled: creator.stitchDisabled,
        max_video_post_duration_sec: creator.maxDurationSec,
      });
    }

    /* ---- init (Direct Post + inbox) ---- */
    const isDirect = p === '/v2/post/publish/video/init/';
    const isDraft = p === '/v2/post/publish/inbox/video/init/';
    if (method === 'POST' && (isDirect || isDraft)) {
      const a = authed(req, res, [isDirect ? 'video.publish' : 'video.upload']);
      if (!a) return;
      let body: { post_info?: Record<string, unknown>; source_info?: Record<string, unknown> };
      try {
        body = JSON.parse((await readBody(req)).toString('utf8')) as typeof body;
      } catch {
        return apiErr(res, 400, 'invalid_param', 'The request body is not valid JSON.');
      }
      const f = takeFail('unaudited', 'spam');
      if (f?.kind === 'spam')
        return isDirect
          ? apiErr(res, 403, 'spam_risk_too_many_posts', 'The user reached the daily post cap.')
          : apiErr(
              res,
              403,
              'spam_risk_too_many_pending_share',
              'At most 5 pending shares within 24 hours.',
            );
      if (f?.kind === 'unaudited')
        return apiErr(
          res,
          403,
          'unaudited_client_can_only_post_to_private_accounts',
          'Unaudited clients can only post to private accounts.',
        );
      let postInfo: Record<string, unknown> | null = null;
      if (isDirect) {
        postInfo = body.post_info ?? null;
        const pl = postInfo?.privacy_level;
        if (typeof pl !== 'string' || !levels().includes(pl))
          return apiErr(
            res,
            403,
            'privacy_level_option_mismatch',
            'privacy_level is missing or not one of the creator\u2019s options.',
          );
        if (!audited && pl !== 'SELF_ONLY')
          return apiErr(
            res,
            403,
            'unaudited_client_can_only_post_to_private_accounts',
            'Unaudited clients can only post to private accounts.',
          );
        const title = postInfo?.title;
        if (title !== undefined && (typeof title !== 'string' || title.length > 2200))
          return apiErr(res, 400, 'invalid_param', 'title is longer than 2200 UTF-16 runes.');
        if (
          typeof postInfo?.brand_content_toggle === 'boolean' &&
          postInfo.brand_content_toggle &&
          pl === 'SELF_ONLY'
        )
          return apiErr(
            res,
            400,
            'invalid_param',
            'Branded content visibility cannot be set to private.',
          );
      }
      if (
        isDraft &&
        uploads.filter((u) => u.mode === 'draft' && u.finalStatus === 'SEND_TO_USER_INBOX')
          .length >= 5
      )
        return apiErr(
          res,
          403,
          'spam_risk_too_many_pending_share',
          'At most 5 pending shares within any 24-hour period.',
        );
      const si = body.source_info ?? {};
      const size = Number(si.video_size);
      const chunk = Number(si.chunk_size);
      const count = Number(si.total_chunk_count);
      if (si.source !== 'FILE_UPLOAD')
        return apiErr(res, 400, 'invalid_param', 'Only FILE_UPLOAD is supported by this fake.');
      if (![size, chunk, count].every((n) => Number.isInteger(n) && n > 0))
        return apiErr(
          res,
          400,
          'invalid_param',
          'video_size, chunk_size and total_chunk_count must be positive integers.',
        );
      if (size > 4 * 1024 * MB)
        return apiErr(res, 400, 'invalid_param', 'video_size exceeds 4 GB.');
      if (count > 1000) return apiErr(res, 400, 'invalid_param', 'total_chunk_count exceeds 1000.');
      const whole = count === 1 && chunk === size && size <= 64_000_000;
      if (!whole && (chunk < 5 * MB || chunk > 64_000_000))
        return apiErr(
          res,
          400,
          'invalid_param',
          'chunk_size must be between 5 MB and 64 MB (or the whole file when it is small).',
        );
      if (count !== Math.max(1, Math.floor(size / chunk)))
        return apiErr(
          res,
          400,
          'invalid_param',
          'total_chunk_count must be floor(video_size / chunk_size).',
        );
      const lastLen = size - (count - 1) * chunk;
      if (lastLen > 128 * MB)
        return apiErr(res, 400, 'invalid_param', 'The final chunk may not exceed 128 MB.');
      const publishId = `v_pub_file~v2-1.${7_000_000_000_000_000_000n + BigInt(next())}`;
      const token = sha256Hex(`upload-${seq}`).slice(0, 24);
      const uploadUrl = `${apiBase()}/__upload/${encodeURIComponent(publishId)}?upload_id=${seq}&upload_token=${token}`;
      uploadTokens.set(publishId, token);
      const up: FakeUpload = {
        publishId,
        mode: isDirect ? 'direct' : 'draft',
        openId: creator.openId,
        postInfo,
        videoSize: size,
        chunkSize: chunk,
        totalChunkCount: count,
        uploadUrl,
        chunks: [],
        receivedBytes: 0,
        complete: false,
        sha256: null,
        statusPolls: 0,
        finalStatus: null,
      };
      uploads.push(up);
      bodies.set(publishId, []);
      return ok(res, { publish_id: publishId, upload_url: uploadUrl });
    }

    /* ---- chunk upload ---- */
    if (method === 'PUT' && p.startsWith('/__upload/')) {
      const publishId = decodeURIComponent(p.slice('/__upload/'.length));
      const up = uploads.find((u) => u.publishId === publishId);
      const body = await readBody(req);
      const respond = (status: number, headers: Record<string, string> = {}): void => {
        res.writeHead(status, headers);
        res.end();
      };
      if (!up || uploadTokens.get(publishId) !== url.searchParams.get('upload_token'))
        return respond(up ? 403 : 404);
      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(req.headers['content-range'] ?? ''));
      const progress = (): Record<string, string> =>
        up.receivedBytes > 0
          ? { 'Content-Range': `bytes 0-${up.receivedBytes - 1}/${up.videoSize}` }
          : {};
      if (!m) return respond(400);
      const [start, end, total] = [Number(m[1]), Number(m[2]), Number(m[3])];
      const ct = String(req.headers['content-type'] ?? '');
      if (!/^video\/(mp4|quicktime|webm)$/.test(ct)) return respond(400);
      if (
        Number(req.headers['content-length']) !== body.length ||
        end - start + 1 !== body.length ||
        total !== up.videoSize
      )
        return respond(400);
      const f = takeFail('chunk-fail', 'chunk-lost-ack');
      if (f?.kind === 'chunk-fail') {
        up.chunks.push({ start, end, status: 500 });
        return respond(500);
      }
      if (start !== up.receivedBytes) {
        up.chunks.push({ start, end, status: 416 });
        return respond(416, progress());
      }
      const idx = Math.floor(start / up.chunkSize);
      const last = idx === up.totalChunkCount - 1;
      const expectEnd = last ? up.videoSize - 1 : start + up.chunkSize - 1;
      if (end !== expectEnd) {
        up.chunks.push({ start, end, status: 416 });
        return respond(416, progress());
      }
      bodies.get(publishId)?.push(body);
      up.receivedBytes += body.length;
      const status = last ? 201 : 206;
      up.chunks.push({ start, end, status });
      if (last) finish(up, takeFail('status-failed'));
      if (f?.kind === 'chunk-lost-ack') {
        // the chunk WAS stored; only the answer is lost
        up.chunks[up.chunks.length - 1] = { start, end, status: 500 };
        return respond(500);
      }
      return respond(status, progress());
    }

    /* ---- status ---- */
    if (method === 'POST' && p === '/v2/post/publish/status/fetch/') {
      const a = authed(req, res, ['video.upload', 'video.publish']);
      if (!a) return;
      let pid = '';
      try {
        pid = String(
          (JSON.parse((await readBody(req)).toString('utf8')) as { publish_id?: unknown })
            .publish_id ?? '',
        );
      } catch {
        /* falls through */
      }
      const up = uploads.find((u) => u.publishId === pid);
      if (!up) return apiErr(res, 400, 'invalid_publish_id', 'publish_id does not exist.');
      up.statusPolls++;
      if (!up.complete)
        return ok(res, { status: 'PROCESSING_UPLOAD', uploaded_bytes: up.receivedBytes });
      const failReason = failReasons.get(up.publishId);
      if (up.statusPolls <= processingPolls && !failReason)
        return ok(res, { status: 'PROCESSING_UPLOAD', uploaded_bytes: up.receivedBytes });
      if (failReason) {
        up.finalStatus = 'FAILED';
        return ok(res, { status: 'FAILED', fail_reason: failReason });
      }
      if (up.mode === 'draft') {
        up.finalStatus = 'SEND_TO_USER_INBOX';
        return ok(res, { status: 'SEND_TO_USER_INBOX' });
      }
      up.finalStatus = 'PUBLISH_COMPLETE';
      const isPublic = up.postInfo?.privacy_level === 'PUBLIC_TO_EVERYONE';
      // The id list is written by hand: an int64 above 2^53 as a JSON number, like the real API.
      return ok(
        res,
        null,
        `{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[${isPublic ? PUBLIC_POST_ID_RAW : ''}]},"error":{"code":"ok","message":"","log_id":"log-${next()}"}}`,
      );
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  };

  const server = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    res.on('finish', () =>
      requests.push({ method: req.method ?? '', path, status: res.statusCode }),
    );
    handle(req, res).catch((e: unknown) => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`fake error: ${e instanceof Error ? e.message : String(e)}`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  function apiBase(): string {
    return base;
  }

  return {
    urls: { authBase: base, apiBase: base },
    state: {
      clientKey,
      clientSecret,
      published,
      inbox,
      uploads,
      requests,
      tokensIssued: issued,
      validRefreshTokens: () => [...refresh.entries()].filter(([, v]) => v.valid).map(([k]) => k),
      get revokeCalls() {
        return revokeCalls;
      },
      get authorizeCalls() {
        return authorizeCalls;
      },
      get lastAuthorize() {
        return lastAuthorize;
      },
      creator,
      audited,
    },
    control: {
      failNext(kind, times = 1, detail) {
        fails.push({ kind, left: times, detail });
      },
      setProcessingPolls(n) {
        processingPolls = n;
      },
      expireAccessTokens() {
        for (const v of access.values()) v.expired = true;
      },
      revokeRefreshTokens() {
        for (const v of refresh.values()) v.valid = false;
      },
      setCreator(c) {
        Object.assign(creator, c);
      },
    },
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
