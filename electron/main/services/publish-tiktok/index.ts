/**
 * TikTok publisher: Login Kit OAuth v2 (+PKCE) and the Content Posting API (Direct Post and upload-to-inbox).
 * Official APIs only. Docs read on 2026-10-15:
 *  - Login Kit for Desktop (PKCE, redirect URIs)  https://developers.tiktok.com/doc/login-kit-desktop
 *  - Login Kit for Web (authorize URL, callback)  https://developers.tiktok.com/doc/login-kit-web
 *  - Token management (token / refresh / revoke)  https://developers.tiktok.com/doc/oauth-user-access-token-management
 *  - User info                                    https://developers.tiktok.com/doc/tiktok-api-v2-get-user-info
 *  - Query creator info                           https://developers.tiktok.com/doc/content-posting-api-reference-query-creator-info
 *  - Direct Post                                  https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
 *  - Upload to inbox (drafts)                     https://developers.tiktok.com/doc/content-posting-api-reference-upload-video
 *  - Media transfer (chunks)                      https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide
 *  - Post status                                  https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status
 *  - UX / audit / caps                            https://developers.tiktok.com/doc/content-sharing-guidelines
 * Facts this file relies on (and where they differ from the brief):
 *  - Desktop apps MUST use PKCE and the docs require the code challenge as the HEX encoding of SHA-256(verifier)
 *    (not RFC 7636 base64url). `authUrl` converts a base64url challenge to hex, so the core can pass either.
 *  - Redirect URI for desktop: absolute http(s) URI, host `localhost` or `127.0.0.1` only, a port is REQUIRED
 *    (a wildcard port `*` may be registered), no query, no fragment, < 512 chars, max 10 per app.
 *  - `username` needs the user.info.profile scope, which we do not request; the handle comes from creator_info.
 *  - Access token lives 24 h, refresh token 365 days; the refresh response may carry a NEW refresh token.
 *  - Per creator roughly 15 API posts / day (shared across apps), 5 pending inbox drafts / 24 h; unaudited apps: only
 *    SELF_ONLY, only for private accounts, and at most 5 posting users per 24 h.
 *  - Rate limits per user token: video/init 6/min, creator_info 20/min, status/fetch 30/min.
 */
import fs from 'node:fs/promises';
import { z } from 'zod';
import type { FieldIssue, PostFields, PostStats } from '@shared/publish';
import type {
  OAuthTokens,
  ProviderAccount,
  ProviderDeps,
  ProviderQuota,
  PublishArgs,
  PublishResult,
  PublisherProvider,
} from '../../pipeline/contracts5';
import { PublishError, isPublishError } from '../publish/errors';
import {
  DAILY_CAP_RETRY_SEC,
  REAUTH_HINT,
  mapApiFailure,
  mapFailReason,
  redact,
  AUDIT_HINT,
} from './errors';
import { TiktokClient, abortError, parseJson, retryAfterSeconds, type Fetch } from './http';
import {
  DEFAULT_CHUNK_BYTES,
  MAX_VIDEO_BYTES,
  planChunks,
  readRange,
  receivedFromContentRange,
} from './chunks';
import { isObject, lenBool, lenNumber, lenString, lenStrings } from './lenient';
import { PRIVACY_LABEL, PRIVACY_RANK, parsePrivacyOptions, validateTiktokFields } from './validate';

export { planChunks, DEFAULT_CHUNK_BYTES } from './chunks';
export { validateTiktokFields } from './validate';

export const TIKTOK_SCOPES = ['user.info.basic', 'video.publish', 'video.upload'] as const;
const DEFAULT_AUTH_BASE = 'https://www.tiktok.com';
const DEFAULT_API_BASE = 'https://open.tiktokapis.com';
/** Documented soft cap of API posts per creator per day (not exposed by any endpoint). */
export const TIKTOK_DAILY_POST_ESTIMATE = 15;
const DAY_MS = 24 * 3600 * 1000;

export interface TiktokTuning {
  /** Preferred chunk size in bytes (default 10 000 000). */
  chunkBytes?: number;
  /** First delay between status polls (grows to 8 s). Default 2000. */
  pollIntervalMs?: number;
  /** Give up waiting for TikTok's processing after this long. Default 10 minutes. */
  maxPollMs?: number;
  /** Attempts per chunk before giving up. Default 4. */
  chunkAttempts?: number;
  /** First delay before re-sending a failed chunk (doubles). Default 1500. */
  retryDelayMs?: number;
  /** Per chunk PUT timeout. Default 120 s. */
  uploadTimeoutMs?: number;
  /** Injectable sleep (tests). Must reject with an AbortError when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** The provider plus the one optional extension of `validateFields` (the account's known privacy options). */
export interface TiktokPublisher extends PublisherProvider {
  readonly platform: 'tiktok';
  validateFields(
    fields: PostFields,
    ctx?: { account?: Pick<ProviderAccount, 'info'> },
  ): FieldIssue[];
}

/* ------------------------------------------------------------------------------------ schemas ----- */

const tokenResp = z.object({
  access_token: lenString,
  refresh_token: lenString,
  expires_in: lenNumber,
  refresh_expires_in: lenNumber,
  open_id: lenString,
  scope: lenString,
});
const userResp = z.object({
  user: z
    .object({
      open_id: lenString,
      union_id: lenString,
      avatar_url: lenString,
      display_name: lenString,
    })
    .optional()
    .catch(undefined),
});
const creatorResp = z.object({
  creator_avatar_url: lenString,
  creator_username: lenString,
  creator_nickname: lenString,
  privacy_level_options: lenStrings,
  comment_disabled: lenBool,
  duet_disabled: lenBool,
  stitch_disabled: lenBool,
  max_video_post_duration_sec: lenNumber,
});
type Creator = z.output<typeof creatorResp>;
const initResp = z.object({ publish_id: lenString, upload_url: lenString });
const statusResp = z.object({
  status: lenString,
  fail_reason: lenString,
  uploaded_bytes: lenNumber,
});

/* -------------------------------------------------------------------------------------- helpers ---- */

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** TikTok wants hex(SHA-256(verifier)); the core normally produces base64url of the same digest. */
export function toHexChallenge(challenge: string): string {
  if (/^[0-9a-f]{64}$/i.test(challenge)) return challenge.toLowerCase();
  if (/^[A-Za-z0-9_-]{43}$/.test(challenge))
    return Buffer.from(challenge, 'base64url').toString('hex');
  return challenge;
}

const seconds = (n: number | undefined, fallback: number): number =>
  n !== undefined && Number.isFinite(n) && n > 0 ? n : fallback;

function isAbort(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

function creatorInfoProps(c: Creator | null): ProviderAccount['info'] {
  if (!c) return {};
  const opts = parsePrivacyOptions(c.privacy_level_options.join(','));
  const info: ProviderAccount['info'] = {};
  if (opts.length > 0) {
    info.privacyOptions = opts.join(',');
    // Only SELF_ONLY on offer = what an unaudited app sees. More than that proves nothing either way.
    info.audited = opts.length === 1 && opts[0] === 'SELF_ONLY' ? false : null;
  }
  if (c.max_video_post_duration_sec !== undefined)
    info.maxDurationSec = c.max_video_post_duration_sec;
  if (c.comment_disabled !== undefined) info.commentDisabled = c.comment_disabled;
  if (c.duet_disabled !== undefined) info.duetDisabled = c.duet_disabled;
  if (c.stitch_disabled !== undefined) info.stitchDisabled = c.stitch_disabled;
  return info;
}

/* -------------------------------------------------------------------------------------- provider --- */

export function createTiktokProvider(
  deps: ProviderDeps,
  tuning: TiktokTuning = {},
): TiktokPublisher {
  const fetchImpl: Fetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const b = deps.baseUrls ?? {};
  const strip = (u: string): string => u.replace(/\/+$/, '');
  const authBase = strip(
    b.CLIPFERN_TIKTOK_AUTH_BASE ?? b.tiktokAuth ?? b.auth ?? DEFAULT_AUTH_BASE,
  );
  const apiBase = strip(b.CLIPFERN_TIKTOK_API_BASE ?? b.tiktokApi ?? b.api ?? DEFAULT_API_BASE);
  const sleep = tuning.sleep ?? defaultSleep;

  const credentials = (): { clientId: string; clientSecret: string } => {
    const c = deps.getCredentials();
    if (!c || !c.clientId || !c.clientSecret)
      throw new PublishError('auth', 'The TikTok client key and client secret are not saved yet.', {
        retryable: false,
        hint: 'Paste them in Settings → Integrations → TikTok.',
      });
    return c;
  };

  const client = (extra: (string | null | undefined)[] = [], timeoutMs?: number): TiktokClient => {
    const c = deps.getCredentials();
    return new TiktokClient({
      fetchImpl,
      apiBase,
      timeoutMs: timeoutMs ?? deps.timeoutMs ?? 30_000,
      log: deps.log,
      now,
      secrets: [c?.clientSecret, ...extra],
    });
  };

  const tokensFrom = (r: z.output<typeof tokenResp>, prev: OAuthTokens | null): OAuthTokens => {
    if (!r.access_token)
      throw new PublishError(
        'platform',
        'TikTok answered without an access token. Try again in a moment.',
      );
    const t = now();
    const extra: Record<string, string> = { ...(prev?.extra ?? {}) };
    const openId = r.open_id ?? prev?.extra.openId;
    if (openId) extra.openId = openId;
    extra.refreshExpiresAt = String(t + seconds(r.refresh_expires_in, 365 * 86400) * 1000);
    return {
      accessToken: r.access_token,
      // The refresh response MAY rotate the refresh token: always keep the newest one.
      refreshToken: r.refresh_token ?? prev?.refreshToken ?? null,
      expiresAt: t + seconds(r.expires_in, 86400) * 1000,
      scope: r.scope ?? prev?.scope ?? null,
      extra,
    };
  };

  async function userInfo(c: TiktokClient, token: string, signal?: AbortSignal) {
    const { data } = await c.api({
      method: 'GET',
      path: '/v2/user/info/',
      query: { fields: 'open_id,union_id,avatar_url,display_name' },
      token,
      signal,
      doing: 'reading the account',
    });
    return userResp.parse(isObject(data) ? data : {}).user ?? {};
  }

  async function queryCreator(
    c: TiktokClient,
    token: string,
    signal?: AbortSignal,
  ): Promise<Creator> {
    const { data } = await c.api({
      method: 'POST',
      path: '/v2/post/publish/creator_info/query/',
      token,
      body: {},
      signal,
      doing: 'checking what the account may post',
    });
    return creatorResp.parse(isObject(data) ? data : {});
  }

  async function buildAccount(
    c: TiktokClient,
    tokens: OAuthTokens,
    signal?: AbortSignal,
  ): Promise<{
    account: ProviderAccount;
    creator: Creator | null;
    creatorError: PublishError | null;
  }> {
    const user = await userInfo(c, tokens.accessToken, signal);
    let creator: Creator | null = null;
    let creatorError: PublishError | null = null;
    try {
      creator = await queryCreator(c, tokens.accessToken, signal);
    } catch (e) {
      if (isAbort(e)) throw e;
      if (isPublishError(e)) creatorError = e;
      else throw e;
    }
    const externalId = tokens.extra.openId ?? user.open_id;
    if (!externalId)
      throw new PublishError('platform', 'TikTok did not say which account this is.');
    const scopes = (tokens.scope ?? TIKTOK_SCOPES.join(','))
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    return {
      account: {
        externalId,
        displayName: user.display_name || creator?.creator_nickname || 'TikTok account',
        handle: creator?.creator_username || null,
        avatarUrl: user.avatar_url || creator?.creator_avatar_url || null,
        scopes,
        info: creatorInfoProps(creator),
      },
      creator,
      creatorError,
    };
  }

  /* -------------------------------------------------------------------------------- upload ----- */

  async function putChunk(
    c: TiktokClient,
    a: {
      uploadUrl: string;
      buf: Buffer;
      start: number;
      end: number;
      total: number;
      signal?: AbortSignal;
    },
  ): Promise<'accepted' | 'retry'> {
    const res = await c.raw({
      method: 'PUT',
      url: a.uploadUrl,
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': String(a.buf.length),
        'Content-Range': `bytes ${a.start}-${a.end}/${a.total}`,
      },
      body: a.buf,
      signal: a.signal,
      timeoutMs: tuning.uploadTimeoutMs ?? 120_000,
      label: '(upload_url)',
      doing: 'uploading the video',
    });
    if (res.status === 201 || res.status === 206 || res.status === 200) return 'accepted';
    if (res.status === 416) {
      // The server's progress differs from ours: its Content-Range says how much it really holds.
      const have = receivedFromContentRange(res.headers.get('content-range'));
      if (have !== null && have >= a.end + 1) return 'accepted'; // it got the chunk, only the answer was lost
      if (have !== null && have === a.start) return 'retry';
      throw new PublishError(
        'platform',
        'TikTok lost track of the upload. Clipfern will start it again.',
      );
    }
    if (res.status >= 500 || res.status === 429) return 'retry';
    if (res.status === 403 || res.status === 404)
      throw new PublishError(
        'platform',
        'TikTok’s upload link expired. Clipfern will start the upload again.',
      );
    throw new PublishError('platform', `TikTok refused a part of the video (HTTP ${res.status}).`, {
      retryable: false,
    });
  }

  async function uploadAll(
    c: TiktokClient,
    a: PublishArgs,
    file: string,
    plan: ReturnType<typeof planChunks>,
    uploadUrl: string,
  ): Promise<void> {
    const attempts = Math.max(1, tuning.chunkAttempts ?? 4);
    for (let i = 0; i < plan.ranges.length; i++) {
      const r = plan.ranges[i];
      if (!r) continue;
      const buf = await readRange(file, r.start, r.end);
      for (let attempt = 1; ; attempt++) {
        if (a.signal?.aborted) throw abortError();
        let outcome: 'accepted' | 'retry';
        try {
          outcome = await putChunk(c, {
            uploadUrl,
            buf,
            start: r.start,
            end: r.end,
            total: plan.videoSize,
            signal: a.signal,
          });
        } catch (e) {
          if (isAbort(e)) throw e;
          if (isPublishError(e) && e.code === 'network' && attempt < attempts) outcome = 'retry';
          else throw e;
        }
        if (outcome === 'accepted') break;
        if (attempt >= attempts)
          throw new PublishError(
            'network',
            `Uploading to TikTok kept failing at ${Math.round((r.start / plan.videoSize) * 100)} %. Clipfern will retry.`,
            { retryable: true },
          );
        c.log(
          `tiktok: chunk ${i + 1}/${plan.ranges.length} failed, retrying (attempt ${attempt + 1})`,
        );
        await sleep((tuning.retryDelayMs ?? 1500) * 2 ** (attempt - 1), a.signal);
      }
      const frac = (r.end + 1) / plan.videoSize;
      a.onProgress(0.05 + frac * 0.8, `Uploading to TikTok ${Math.round(frac * 100)} %`);
    }
  }

  async function pollStatus(
    c: TiktokClient,
    a: PublishArgs,
    token: string,
    publishId: string,
  ): Promise<{ status: string; postIds: string[] }> {
    const started = now();
    const maxMs = tuning.maxPollMs ?? 10 * 60_000;
    let delay = tuning.pollIntervalMs ?? 2000;
    let transient = 0;
    for (let n = 0; ; n++) {
      if (a.signal?.aborted) throw abortError();
      try {
        const { data, text } = await c.api({
          method: 'POST',
          path: '/v2/post/publish/status/fetch/',
          token,
          body: { publish_id: publishId },
          signal: a.signal,
          doing: 'checking the upload',
        });
        transient = 0;
        const s = statusResp.parse(isObject(data) ? data : {});
        // post ids are int64: read them from the raw text so they never go through a double
        const idList = /"public\w*_available_post_id"\s*:\s*\[([^\]]*)\]/.exec(text)?.[1] ?? '';
        const postIds = idList.match(/\d+/g) ?? [];
        switch (s.status) {
          case 'PUBLISH_COMPLETE':
          case 'SEND_TO_USER_INBOX':
            return { status: s.status, postIds };
          case 'FAILED':
            throw mapFailReason(s.fail_reason);
          default:
            a.onProgress(null, 'TikTok is processing the video');
        }
      } catch (e) {
        if (isAbort(e)) throw e;
        if (!isPublishError(e)) throw e;
        if (e.code === 'rate-limit') delay = Math.max(delay, (e.retryAfterSec ?? 30) * 1000);
        else if (
          (e.code === 'network' || e.code === 'platform') &&
          e.retryable &&
          ++transient <= 3
        ) {
          /* a hiccup while polling: keep waiting, the post itself is fine */
        } else throw e;
      }
      if (now() - started + delay > maxMs)
        throw new PublishError(
          'platform',
          'TikTok is still processing the video after 10 minutes.',
          {
            retryable: false,
            hint: 'Check the TikTok app before trying again so the video is not posted twice.',
          },
        );
      await sleep(delay, a.signal);
      delay = Math.min(8000, Math.round(delay * 1.4));
    }
  }

  /* -------------------------------------------------------------------------------- provider ---- */

  const provider: TiktokPublisher = {
    platform: 'tiktok',
    scopes: TIKTOK_SCOPES,

    authUrl({ redirectUri, state, codeChallenge }) {
      const { clientId } = credentials();
      const u = new URL(`${authBase}/v2/auth/authorize/`);
      u.searchParams.set('client_key', clientId);
      u.searchParams.set('scope', TIKTOK_SCOPES.join(','));
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('redirect_uri', redirectUri);
      u.searchParams.set('state', state);
      u.searchParams.set('code_challenge', toHexChallenge(codeChallenge));
      u.searchParams.set('code_challenge_method', 'S256');
      return u.toString();
    },

    async exchangeCode({ code, redirectUri, codeVerifier }, opts) {
      const cred = credentials();
      const c = client([code, codeVerifier]);
      const r = await c.oauth({
        path: '/v2/oauth/token/',
        signal: opts?.signal,
        doing: 'signing in',
        form: {
          client_key: cred.clientId,
          client_secret: cred.clientSecret,
          code,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        },
      });
      const tokens = tokensFrom(tokenResp.parse(r), null);
      c.addSecret(tokens.accessToken);
      c.addSecret(tokens.refreshToken);
      const { account } = await buildAccount(c, tokens, opts?.signal);
      return { tokens, account };
    },

    async refresh(tokens, opts) {
      const cred = credentials();
      if (!tokens.refreshToken)
        throw new PublishError('auth', 'There is no TikTok refresh token on file.', {
          retryable: false,
          hint: REAUTH_HINT,
        });
      const c = client([tokens.accessToken, tokens.refreshToken]);
      const r = await c.oauth({
        path: '/v2/oauth/token/',
        signal: opts?.signal,
        doing: 'renewing the login',
        form: {
          client_key: cred.clientId,
          client_secret: cred.clientSecret,
          grant_type: 'refresh_token',
          refresh_token: tokens.refreshToken,
        },
      });
      return tokensFrom(tokenResp.parse(r), tokens);
    },

    async revoke(tokens) {
      try {
        const cred = credentials();
        const c = client([tokens.accessToken, tokens.refreshToken], 10_000);
        await c.oauth({
          path: '/v2/oauth/revoke/',
          doing: 'disconnecting',
          form: {
            client_key: cred.clientId,
            client_secret: cred.clientSecret,
            token: tokens.accessToken,
          },
        });
      } catch {
        /* best effort: already revoked / offline */
      }
    },

    async testConnection(tokens) {
      const c = client([tokens.accessToken, tokens.refreshToken]);
      try {
        const { account, creator, creatorError } = await buildAccount(c, tokens);
        if (creatorError && creatorError.code === 'quota')
          return {
            ok: true,
            message: `Connected as ${account.displayName}, but TikTok will not take more posts from apps right now.`,
            detail: creatorError.message,
            account,
          };
        if (creatorError)
          return {
            ok: false,
            message: creatorError.message,
            detail: creatorError.hint,
            account: null,
          };
        const options = parsePrivacyOptions(creator?.privacy_level_options.join(','));
        const onlyPrivate = options.length === 1 && options[0] === 'SELF_ONLY';
        const labels = options.map((o) => PRIVACY_LABEL[o] ?? o).join(', ');
        return {
          ok: true,
          message: onlyPrivate
            ? `Connected as ${account.displayName}. Only private posts (Only me) are available.`
            : `Connected as ${account.displayName}.`,
          detail:
            (options.length ? `Visibility options TikTok offers: ${labels}. ` : '') +
            (onlyPrivate ? AUDIT_HINT : ''),
          account,
        };
      } catch (e) {
        if (isAbort(e)) throw e;
        if (isPublishError(e))
          return { ok: false, message: e.message, detail: e.hint, account: null };
        return {
          ok: false,
          message: 'Could not check the TikTok connection.',
          detail: null,
          account: null,
        };
      }
    },

    validateFields(fields, ctx) {
      const info = ctx?.account?.info;
      return validateTiktokFields(fields, {
        privacyOptions: parsePrivacyOptions(info?.privacyOptions),
      });
    },

    quotaCost: () => 0,

    async publish(a) {
      const f = a.fields;
      if (f.platform !== 'tiktok')
        throw new PublishError('validation', 'These are not TikTok post settings.', {
          retryable: false,
        });
      const token = a.tokens.accessToken;
      const c = client([token, a.tokens.refreshToken]);
      const log = (m: string): void => a.log(c.scrub(m));
      if (a.signal?.aborted) throw abortError();
      const direct = f.mode === 'direct';

      // 1) What may this creator do right now?
      let creator: Creator | null = null;
      try {
        creator = await queryCreator(c, token, a.signal);
      } catch (e) {
        // For drafts only the upload scope matters: a missing/odd creator_info must not block them.
        if (
          direct ||
          isAbort(e) ||
          !isPublishError(e) ||
          e.code === 'auth' ||
          e.code === 'rate-limit'
        )
          throw e;
        log(`tiktok: creator_info unavailable for a draft upload (${e.code}); continuing`);
      }

      const issues = validateTiktokFields(f, {});
      if (issues.some((i) => i.field === 'title'))
        throw new PublishError(
          'validation',
          issues.find((i) => i.field === 'title')?.message ?? 'Invalid caption.',
          {
            retryable: false,
          },
        );

      const stat = await fs.stat(a.media.file).catch(() => null);
      const size = stat?.size ?? a.media.sizeBytes;
      if (!size || size <= 0)
        throw new PublishError('media', 'The video file is empty or missing.', {
          retryable: false,
        });
      if (size > MAX_VIDEO_BYTES)
        throw new PublishError('media', 'TikTok accepts videos up to 4 GB.', { retryable: false });
      const maxDur = creator?.max_video_post_duration_sec;
      if (maxDur && a.media.durationSec > maxDur + 0.5)
        throw new PublishError(
          'media',
          `This clip is ${Math.round(a.media.durationSec)} s long; this TikTok account can post up to ${maxDur} s.`,
          {
            retryable: false,
            hint: 'Trim the clip, or upload it to drafts and post it from the TikTok app.',
          },
        );

      // 2) Visibility: never more public than asked, never silently different.
      const notes: string[] = [];
      let privacy: string = f.privacyLevel;
      const allowed = creator ? parsePrivacyOptions(creator.privacy_level_options.join(',')) : [];
      if (direct && allowed.length > 0 && !allowed.includes(privacy)) {
        privacy = closestNotMorePublic(privacy, allowed);
        notes.push(downgradeNote(f.privacyLevel, privacy));
      }
      const branded = f.commercial.enabled && f.commercial.brandedContent;
      if (direct && branded && privacy === 'SELF_ONLY')
        throw new PublishError(
          'validation',
          'Branded content cannot be posted privately, and this TikTok account can only post privately right now.',
          { retryable: false, hint: `${AUDIT_HINT} Or turn off "Branded content".` },
        );

      const plan = planChunks(size, tuning.chunkBytes ?? DEFAULT_CHUNK_BYTES);
      const sourceInfo = {
        source: 'FILE_UPLOAD',
        video_size: plan.videoSize,
        chunk_size: plan.chunkSize,
        total_chunk_count: plan.totalChunkCount,
      };
      const postInfo = (privacyLevel: string): Record<string, unknown> => {
        const commentOff = !f.allowComment || creator?.comment_disabled === true;
        const duetOff = !f.allowDuet || creator?.duet_disabled === true;
        const stitchOff = !f.allowStitch || creator?.stitch_disabled === true;
        const p: Record<string, unknown> = {
          privacy_level: privacyLevel,
          disable_comment: commentOff,
          disable_duet: duetOff,
          disable_stitch: stitchOff,
          brand_content_toggle: branded,
          brand_organic_toggle: f.commercial.enabled && f.commercial.yourBrand,
          is_aigc: f.aigc,
        };
        if (f.title) p.title = f.title;
        if (f.coverTimestampMs !== null && f.coverTimestampMs < a.media.durationSec * 1000)
          p.video_cover_timestamp_ms = f.coverTimestampMs;
        return p;
      };

      // 3) Init (retrying once as SELF_ONLY when TikTok says the app is unaudited).
      const init = async (privacyLevel: string): Promise<z.output<typeof initResp>> => {
        const { data } = await c.api({
          method: 'POST',
          path: direct ? '/v2/post/publish/video/init/' : '/v2/post/publish/inbox/video/init/',
          token,
          body: direct
            ? { post_info: postInfo(privacyLevel), source_info: sourceInfo }
            : { source_info: sourceInfo },
          signal: a.signal,
          doing: 'starting the upload',
        });
        const r = initResp.parse(isObject(data) ? data : {});
        if (!r.publish_id || !r.upload_url)
          throw new PublishError(
            'platform',
            'TikTok did not give an upload address. Try again in a moment.',
          );
        c.addSecret(r.upload_url);
        return r;
      };

      a.onProgress(0.02, 'Starting the TikTok upload');
      let started: z.output<typeof initResp>;
      try {
        started = await init(privacy);
      } catch (e) {
        if (
          direct &&
          isPublishError(e) &&
          e.code === 'validation' &&
          /unaudited|audit/i.test(`${e.hint ?? ''} ${e.message}`)
        ) {
          if (privacy !== 'SELF_ONLY' && !branded) {
            log('tiktok: app is not audited; retrying as SELF_ONLY');
            notes.push(downgradeNote(f.privacyLevel, 'SELF_ONLY'));
            started = await init('SELF_ONLY');
          } else {
            throw new PublishError(
              'validation',
              branded
                ? 'Branded content cannot be posted privately, and the app is not audited yet.'
                : 'TikTok only lets apps that have not been audited post to accounts that are set to private.',
              {
                retryable: false,
                hint: branded
                  ? `${AUDIT_HINT} Or turn off "Branded content".`
                  : `Set the TikTok account to private in the TikTok app’s privacy settings for now. ${AUDIT_HINT}`,
              },
            );
          }
        } else throw e;
      }

      // 4) Upload (the upload URL's query string is a credential: it never reaches a log or message).
      await uploadAll(c, a, a.media.file, plan, started.upload_url ?? '');
      a.onProgress(null, 'TikTok is processing the video');

      // 5) Wait for TikTok.
      const done = await pollStatus(c, a, token, started.publish_id ?? '');
      a.onProgress(1, 'Done');

      const postId = done.postIds[0] ?? null;
      const url =
        postId && a.account.handle
          ? `https://www.tiktok.com/@${a.account.handle}/video/${postId}`
          : null;
      if (done.status === 'SEND_TO_USER_INBOX' && !(direct && done.postIds.length > 0)) {
        return {
          platformPostId: started.publish_id ?? '',
          url: null,
          outcome: 'draft-uploaded',
          note: 'In your TikTok inbox — open the TikTok app to publish',
          quotaUnits: 0,
        };
      }
      return {
        platformPostId: postId ?? started.publish_id ?? '',
        url,
        outcome: 'published',
        note: notes.length ? notes.join(' ') : null,
        quotaUnits: 0,
      } satisfies PublishResult;
    },

    /** Stats need the video.list scope, which Clipfern does not request: nothing to read. */
    async fetchStats(): Promise<PostStats | null> {
      return null;
    },

    async quota(a): Promise<ProviderQuota> {
      const limit = TIKTOK_DAILY_POST_ESTIMATE;
      let used = a.usedPosts;
      try {
        await queryCreator(
          client([a.tokens.accessToken, a.tokens.refreshToken]),
          a.tokens.accessToken,
        );
      } catch (e) {
        // creator_info itself reports the daily cap as `spam_risk_too_many_posts`.
        if (isPublishError(e) && e.code === 'quota') used = Math.max(used, limit);
      }
      return {
        used,
        limit,
        unit: 'posts',
        resetsAt: a.now + DAY_MS,
        postsLeft: Math.max(0, limit - used),
        note: 'Estimate: TikTok allows roughly 15 posts per day per account through apps (shared with other apps) and does not report the exact number. Drafts: at most 5 waiting in the inbox.',
      };
    },
  };
  return provider;
}

/** Most public allowed level that is not more public than `wanted` (else the most private allowed one). */
export function closestNotMorePublic(wanted: string, allowed: readonly string[]): string {
  const w = PRIVACY_RANK[wanted] ?? 0;
  const ranked = allowed
    .filter((o) => o in PRIVACY_RANK)
    .sort((x, y) => (PRIVACY_RANK[x] ?? 0) - (PRIVACY_RANK[y] ?? 0));
  const notMore = ranked.filter((o) => (PRIVACY_RANK[o] ?? 0) <= w);
  return notMore[notMore.length - 1] ?? ranked[0] ?? 'SELF_ONLY';
}

function downgradeNote(wanted: string, applied: string): string {
  const w = PRIVACY_LABEL[wanted] ?? wanted;
  const a = PRIVACY_LABEL[applied] ?? applied;
  return (
    `Posted as “${a}” instead of “${w}”: TikTok does not offer “${w}” for this app/account. ` +
    'Apps that have not passed TikTok’s audit can only post privately; after the audit, public posting works automatically.'
  );
}

// Re-exports used by the lead's wiring / tests.
export { parsePrivacyOptions } from './validate';
export { redact, retryAfterSeconds, parseJson, mapApiFailure, DAILY_CAP_RETRY_SEC };
