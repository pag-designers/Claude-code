/**
 * Instagram Reels publisher: "Instagram API with Instagram Login" (graph.instagram.com).
 *
 * Docs checked 2026-10-15 (Meta changes this API often; re-verify before changing anything here):
 *  - Business Login for Instagram (authorize, short-lived → long-lived exchange, refresh):
 *      https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login
 *      https://developers.facebook.com/documentation/instagram-platform/reference/oauth-authorize.md
 *      https://developers.facebook.com/documentation/instagram-platform/reference/refresh_access_token.md
 *  - Content publishing (container → status poll → media_publish):
 *      https://developers.facebook.com/docs/instagram-platform/content-publishing
 *      https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media
 *      https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/content_publishing_limit
 *  - Errors: https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/error-codes
 *
 * WHY this flow and not "Facebook Login + a linked Page": Meta documents both as supported for publishing, but the
 * Instagram-Login flow is the one Meta now builds new apps on (the `instagram_business_*` scopes, one token, no
 * Facebook Page / Business Manager needed). It posts to the developer's OWN professional account while the app is in
 * Development mode (Standard Access; the account must be added to the app as an Instagram tester / admin).
 *
 * Flow: authorize (www.instagram.com) → POST api.instagram.com/oauth/access_token (1 h token)
 *       → GET graph.instagram.com/access_token?grant_type=ig_exchange_token (60 day token)
 *       → GET graph.instagram.com/refresh_access_token (+60 days, only for tokens 24 h .. 60 days old).
 *
 * ACCOUNT CHOICE: a grant is always for exactly ONE Instagram account (the one the person logs into on Instagram's
 * consent screen), so there is no "first of several" rule; connecting another account = connecting again.
 *
 * Secrets: the access token travels as the documented `access_token` parameter. No URL is ever logged and every
 * error text is redacted (token, app secret, authorization code, presigned-URL query).
 */
import type { FieldIssue, PostFields, PostStats } from '@shared/publish';
import type {
  ProviderAccount,
  ProviderDeps,
  ProviderQuota,
  PublisherProvider,
  PublishArgs,
  PublishResult,
} from '../../pipeline/contracts5';
import { PublishError } from '../publish/errors';
import { createClient } from './client';
import {
  abortError,
  graphCodeOf,
  InstagramApiError,
  isAbort,
  mapContainerFailure,
  QUOTA_RECHECK_SEC,
  subcodeOf,
} from './errors';
import { SecretSet } from './redact';
import {
  parseContainerStatus,
  parseId,
  parseInsights,
  parseLongToken,
  parseMe,
  parseMediaCounts,
  parsePermalink,
  parsePublishingLimit,
  parseShortToken,
  type IgProfile,
} from './schemas';
import { cleanUsername, validateReelsFields } from './validate';

export const GRAPH_VERSION = 'v25.0';
export const IG_SCOPES = [
  'instagram_business_basic',
  'instagram_business_content_publish',
  // Needed only for the optional first comment; Reels publish without it.
  'instagram_business_manage_comments',
] as const;
const DEFAULT_AUTH_HOST = 'https://www.instagram.com';
const DEFAULT_TOKEN_HOST = 'https://api.instagram.com';
const DEFAULT_GRAPH_HOST = 'https://graph.instagram.com';
/** Lifetime of a long-lived token when Instagram does not state it. */
const LONG_TOKEN_SEC = 60 * 24 * 3600;
/** Instagram only refreshes tokens that are at least 24 h old. */
const MIN_REFRESH_AGE_MS = 24 * 3600_000 + 60_000;
/** The reference documents 50 API-published posts per rolling 24 h (the guide page says 100); the API's own number wins. */
const FALLBACK_QUOTA_TOTAL = 50;
const DAY_SEC = 86_400;
/** The presigned link only has to live until Instagram has downloaded the video. */
const PRESIGN_TTL_SEC = 2 * 3600;

export interface PollPlan {
  initialMs: number;
  factor: number;
  maxMs: number;
  /** Overall budget for IN_PROGRESS → FINISHED, scaled with the video length. */
  timeoutMs(durationSec: number): number;
  /** Consecutive failed status requests (network / 5xx) tolerated before giving up. */
  maxStatusErrors: number;
}

export const DEFAULT_POLL: PollPlan = {
  initialMs: 2_000,
  factor: 1.6,
  maxMs: 20_000,
  timeoutMs: (durationSec) =>
    Math.min(30 * 60_000, Math.max(5 * 60_000, 180_000 + Math.ceil(durationSec) * 5_000)),
  maxStatusErrors: 3,
};

export interface InstagramProviderOptions {
  poll?: Partial<PollPlan>;
  /** Test seam: waits `ms`, rejecting with an AbortError when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const realSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

const trimSlash = (s: string): string => s.replace(/\/+$/, '');

export function createInstagramProvider(
  deps: ProviderDeps,
  options: InstagramProviderOptions = {},
): PublisherProvider {
  const now = deps.now ?? Date.now;
  const secrets = new SecretSet();
  const log = (m: string) => deps.log?.(secrets.redact(m));
  const call = createClient({
    fetchImpl: deps.fetch ?? fetch,
    timeoutMs: deps.timeoutMs ?? 30_000,
    now,
    secrets,
    log,
  });
  const poll: PollPlan = { ...DEFAULT_POLL, ...options.poll };
  const sleep = options.sleep ?? realSleep;

  // `CLIPFERN_META_OAUTH_BASE` replaces BOTH the authorize and the token-exchange host (a test double serves both).
  const oauthOverride = deps.baseUrls?.metaOauth?.trim();
  const authHost = trimSlash(oauthOverride || DEFAULT_AUTH_HOST);
  const tokenHost = trimSlash(oauthOverride || DEFAULT_TOKEN_HOST);
  const graphHost = trimSlash(deps.baseUrls?.graph?.trim() || DEFAULT_GRAPH_HOST);
  const gv = (path: string) => `${graphHost}/${GRAPH_VERSION}/${path}`;

  function credentials(): { clientId: string; clientSecret: string } {
    const c = deps.getCredentials();
    if (!c || !c.clientId.trim() || !c.clientSecret.trim())
      throw new PublishError(
        'auth',
        'Add your Instagram app ID and app secret in Settings → Integrations first.',
        { retryable: false },
      );
    secrets.add(c.clientSecret);
    return { clientId: c.clientId.trim(), clientSecret: c.clientSecret.trim() };
  }

  const throwIfAborted = (signal?: AbortSignal) => {
    if (signal?.aborted) throw abortError();
  };

  /* ------------------------------------------------------------------------------- account */

  async function fetchProfile(token: string, signal?: AbortSignal): Promise<IgProfile> {
    secrets.add(token);
    const json = await call({
      method: 'GET',
      url: gv('me'),
      query: {
        fields: 'user_id,username,name,account_type,profile_picture_url',
        access_token: token,
      },
      label: 'GET /me',
      signal,
    });
    const p = parseMe(json);
    if (!p)
      throw new PublishError(
        'platform',
        'Instagram did not return the account details. Make sure the account is a Business or Creator account and try again.',
      );
    if (p.accountType && /personal|consumer/i.test(p.accountType))
      throw new PublishError(
        'auth',
        'This Instagram account is a personal account. Switch it to a Business or Creator account in the Instagram app, then connect again.',
        { retryable: false },
      );
    return p;
  }

  function toAccount(p: IgProfile, scopes: string[]): ProviderAccount {
    const info: ProviderAccount['info'] = {};
    if (p.accountType)
      info.accountType = /creator|media_creator/i.test(p.accountType) ? 'Creator' : 'Business';
    return {
      externalId: p.igUserId,
      displayName: p.name ?? p.username ?? p.igUserId,
      handle: p.username,
      avatarUrl: p.pictureUrl,
      scopes,
      info,
    };
  }

  /* ------------------------------------------------------------------------------- publishing limit */

  async function fetchLimit(
    token: string,
    igUserId: string,
    signal?: AbortSignal,
  ): Promise<{ used: number; total: number; durationSec: number } | null> {
    secrets.add(token);
    const json = await call({
      method: 'GET',
      url: gv(`${igUserId}/content_publishing_limit`),
      query: { fields: 'quota_usage,config', access_token: token },
      label: 'GET /{ig-user}/content_publishing_limit',
      signal,
    });
    const l = parsePublishingLimit(json);
    if (!l) return null;
    return {
      used: l.used,
      total: l.total && l.total > 0 ? l.total : FALLBACK_QUOTA_TOTAL,
      durationSec: l.durationSec && l.durationSec > 0 ? l.durationSec : DAY_SEC,
    };
  }

  /* ------------------------------------------------------------------------------- the provider */

  const provider: PublisherProvider = {
    platform: 'reels',
    scopes: IG_SCOPES,

    authUrl(a) {
      const { clientId } = credentials();
      // Instagram Login has no PKCE; `codeChallenge` is unused (the secret stays on this machine at exchange time).
      const q = new URLSearchParams({
        client_id: clientId,
        redirect_uri: a.redirectUri,
        response_type: 'code',
        scope: IG_SCOPES.join(','),
        state: a.state,
      });
      return `${authHost}/oauth/authorize?${q.toString()}`;
    },

    async exchangeCode(a, opts) {
      const { clientId, clientSecret } = credentials();
      // Instagram appends `#_` to the redirect; a browser keeps it out of the query, but be safe.
      const code = a.code.replace(/#_?$/, '').trim();
      secrets.add(code);
      if (!code)
        throw new PublishError('auth', 'Instagram did not send an authorization code.', {
          retryable: false,
        });
      const shortJson = await call({
        method: 'POST',
        url: `${tokenHost}/oauth/access_token`,
        form: {
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'authorization_code',
          redirect_uri: a.redirectUri,
          code,
        },
        label: 'POST /oauth/access_token',
        signal: opts?.signal,
      }).catch((e: unknown) => {
        // A rejected code / secret / redirect URI is the person's setup, never a retry candidate.
        if (
          e instanceof InstagramApiError &&
          (e.code === 'platform' || e.code === 'validation') &&
          !e.retryable
        )
          throw new PublishError(
            'auth',
            `${e.message} Check the app ID, app secret and redirect URI in Settings → Integrations.`,
            { retryable: false },
          );
        throw e;
      });
      const short = parseShortToken(shortJson);
      if (!short)
        throw new PublishError(
          'platform',
          'Instagram did not return an access token. Try connecting again.',
        );
      secrets.add(short.accessToken);

      const longJson = await call({
        method: 'GET',
        url: `${graphHost}/access_token`,
        query: {
          grant_type: 'ig_exchange_token',
          client_secret: clientSecret,
          access_token: short.accessToken,
        },
        label: 'GET /access_token (long-lived exchange)',
        signal: opts?.signal,
      });
      const long = parseLongToken(longJson);
      if (!long)
        throw new PublishError(
          'platform',
          'Instagram did not return a long-lived access token. Try connecting again.',
        );
      secrets.add(long.accessToken);

      const issuedAt = now();
      const profile = await fetchProfile(long.accessToken, opts?.signal);
      const scopes = short.permissions.length > 0 ? short.permissions : [...IG_SCOPES];
      return {
        tokens: {
          accessToken: long.accessToken,
          refreshToken: null,
          expiresAt: issuedAt + (long.expiresInSec ?? LONG_TOKEN_SEC) * 1000,
          scope: scopes.join(','),
          extra: { issuedAt: String(issuedAt), igUserId: profile.igUserId },
        },
        account: toAccount(profile, scopes),
      };
    },

    async refresh(tokens, opts) {
      secrets.add(tokens.accessToken);
      const t = now();
      if (tokens.expiresAt !== null && tokens.expiresAt <= t)
        throw new PublishError(
          'auth',
          'The Instagram connection expired because it was not refreshed within 60 days.',
          { retryable: false, hint: 'Reconnect the Instagram account in Settings → Integrations.' },
        );
      const issued = Number(tokens.extra.issuedAt);
      // Instagram rejects a refresh of a token younger than 24 h; it is still good for ~60 days, so keep it.
      if (Number.isFinite(issued) && t - issued < MIN_REFRESH_AGE_MS) return tokens;
      const json = await call({
        method: 'GET',
        url: `${graphHost}/refresh_access_token`,
        query: { grant_type: 'ig_refresh_token', access_token: tokens.accessToken },
        label: 'GET /refresh_access_token',
        signal: opts?.signal,
      });
      const fresh = parseLongToken(json);
      if (!fresh)
        throw new PublishError('platform', 'Instagram did not return a refreshed access token.');
      secrets.add(fresh.accessToken);
      return {
        ...tokens,
        accessToken: fresh.accessToken,
        expiresAt: t + (fresh.expiresInSec ?? LONG_TOKEN_SEC) * 1000,
        extra: { ...tokens.extra, issuedAt: String(t) },
      };
    },

    async revoke(tokens) {
      // Instagram documents no token-revocation endpoint (a person removes the app under Instagram → Settings →
      // Apps and websites). Dropping the stored tokens is all Clipfern can do; the token lapses by itself in 60 days.
      secrets.add(tokens.accessToken);
      log('instagram: no revoke endpoint exists; the stored token was discarded locally');
    },

    async testConnection(tokens) {
      try {
        const profile = await fetchProfile(tokens.accessToken);
        const scopes = tokens.scope ? tokens.scope.split(',').filter(Boolean) : [...IG_SCOPES];
        const account = toAccount(profile, scopes);
        const parts: string[] = [];
        if (tokens.expiresAt !== null) {
          const days = Math.max(0, Math.floor((tokens.expiresAt - now()) / 86_400_000));
          parts.push(
            `Access renews automatically (expires in ${days} days if the app stays closed).`,
          );
        }
        const lim = await fetchLimit(tokens.accessToken, profile.igUserId).catch(() => null);
        if (lim) parts.push(`${lim.used} of ${lim.total} API posts used in the last 24 hours.`);
        return {
          ok: true,
          message: `Connected to Instagram as @${profile.username ?? profile.igUserId}`,
          detail: parts.join(' ') || null,
          account,
        };
      } catch (e) {
        if (isAbort(e)) throw e;
        const pe = e instanceof PublishError ? e : null;
        return {
          ok: false,
          message: pe ? pe.message : 'Could not check the Instagram connection.',
          detail: pe?.hint ?? null,
          account: null,
        };
      }
    },

    validateFields(fields: PostFields): FieldIssue[] {
      return validateReelsFields(fields);
    },

    quotaCost() {
      return 0;
    },

    async quota(a): Promise<ProviderQuota> {
      let lim: Awaited<ReturnType<typeof fetchLimit>> = null;
      try {
        lim = await fetchLimit(a.tokens.accessToken, a.account.externalId);
      } catch (e) {
        // A wrong token must surface; anything else falls back to the app's own bookkeeping.
        if (e instanceof PublishError && e.code === 'auth') throw e;
        if (isAbort(e)) throw e;
        log(
          `instagram: could not read the publishing limit (${e instanceof PublishError ? e.code : 'error'})`,
        );
      }
      const total = lim?.total ?? FALLBACK_QUOTA_TOTAL;
      const used = lim?.used ?? a.usedPosts;
      const windowSec = lim?.durationSec ?? DAY_SEC;
      return {
        used,
        limit: total,
        unit: 'posts',
        // Rolling window: by now + window every post made so far has left it.
        resetsAt: a.now + windowSec * 1000,
        postsLeft: Math.max(0, total - used),
        note: lim
          ? `Instagram allows ${total} API-published posts in any rolling 24 hours.`
          : `Instagram did not report its limit; counting Clipfern's own posts against ${total} per 24 hours.`,
      };
    },

    async publish(a: PublishArgs): Promise<PublishResult> {
      return publishReel(a);
    },

    async fetchStats(a): Promise<PostStats | null> {
      const token = a.tokens.accessToken;
      secrets.add(token);
      const id = a.platformPostId;
      let likes: number | null = null;
      let comments: number | null = null;
      let got = false;
      try {
        const m = parseMediaCounts(
          await call({
            method: 'GET',
            url: gv(id),
            query: { fields: 'like_count,comments_count', access_token: token },
            label: 'GET /{media} counts',
          }),
        );
        likes = m.likes;
        comments = m.comments;
        got = got || likes !== null || comments !== null;
      } catch (e) {
        if (e instanceof PublishError && (e.code === 'auth' || e.code === 'rate-limit')) throw e;
        log('instagram: media counts unavailable');
      }
      // Reels metrics (the old `plays` was retired on 2025-04-21; `views` replaces it).
      const wanted = ['views', 'likes', 'comments', 'shares'];
      let metrics: Record<string, number> = {};
      const insights = async (list: string[]): Promise<Record<string, number>> =>
        parseInsights(
          await call({
            method: 'GET',
            url: gv(`${id}/insights`),
            query: { metric: list.join(','), access_token: token },
            label: 'GET /{media}/insights',
          }),
        );
      try {
        metrics = await insights(wanted);
      } catch (e) {
        if (e instanceof PublishError && (e.code === 'auth' || e.code === 'rate-limit')) throw e;
        // One unsupported metric fails the whole call: ask one by one and keep what exists.
        for (const m of wanted) {
          try {
            Object.assign(metrics, await insights([m]));
          } catch (e2) {
            if (e2 instanceof PublishError && (e2.code === 'auth' || e2.code === 'rate-limit'))
              throw e2;
          }
        }
      }
      const views = metrics.views ?? null;
      const shares = metrics.shares ?? null;
      likes = metrics.likes ?? likes;
      comments = metrics.comments ?? comments;
      got = got || views !== null || shares !== null || likes !== null || comments !== null;
      if (!got) return null;
      return { views, likes, comments, shares, fetchedAt: now() };
    },
  };

  /* ------------------------------------------------------------------------------- publish */

  async function publishReel(a: PublishArgs): Promise<PublishResult> {
    const { fields, media, signal } = a;
    const token = a.tokens.accessToken;
    secrets.add(token);
    const plog = (m: string) => a.log(secrets.redact(m));
    if (fields.platform !== 'reels')
      throw new PublishError('validation', 'These fields are not for Instagram Reels.', {
        retryable: false,
      });
    const issues = validateReelsFields(fields);
    if (issues.length > 0)
      throw new PublishError('validation', issues.map((i) => i.message).join(' '), {
        retryable: false,
        hint: 'Edit the post and fix the highlighted fields.',
      });
    throwIfAborted(signal);
    const igId = a.account.externalId;

    // 1. The publishing limit: do not even start a container that cannot be published.
    a.onProgress(0, 'Checking Instagram’s publishing limit');
    try {
      const lim = await fetchLimit(token, igId, signal);
      if (lim && lim.used >= lim.total)
        throw new PublishError(
          'quota',
          `Instagram allows ${lim.total} API-published posts per rolling 24 hours and ${lim.used} are already used.`,
          { retryAfterSec: QUOTA_RECHECK_SEC, retryable: true },
        );
    } catch (e) {
      // The check is an optimisation: when Instagram cannot answer it, the real publish decides.
      if (!(e instanceof PublishError) || !['platform', 'unknown'].includes(e.code)) throw e;
      plog('instagram: publishing limit unavailable, continuing');
    }
    throwIfAborted(signal);

    // 2. The container. Instagram downloads the file itself from the presigned link.
    a.onProgress(0.05, 'Handing the video to Instagram');
    const videoUrl = await media.presignedUrl(PRESIGN_TTL_SEC);
    secrets.add(videoUrl);
    try {
      secrets.add(new URL(videoUrl).search.replace(/^\?/, ''));
    } catch {
      /* not a URL: the exact string is registered above */
    }
    const notes: string[] = [];
    const collaborators = fields.collaborators.map(cleanUsername).filter(Boolean);
    let thumbOffset: number | undefined;
    if (fields.coverOffsetMs !== null) {
      if (fields.coverOffsetMs < media.durationSec * 1000) thumbOffset = fields.coverOffsetMs;
      else
        notes.push(
          'The chosen cover time is outside the video, so Instagram picked the cover frame.',
        );
    }
    const containerJson = await call({
      method: 'POST',
      url: gv(`${igId}/media`),
      form: {
        media_type: 'REELS',
        video_url: videoUrl,
        caption: fields.caption.trim() === '' ? undefined : fields.caption,
        share_to_feed: fields.shareToFeed ? 'true' : 'false',
        thumb_offset: thumbOffset === undefined ? undefined : String(Math.round(thumbOffset)),
        collaborators: collaborators.length > 0 ? JSON.stringify(collaborators) : undefined,
        location_id: fields.locationId?.trim() || undefined,
        access_token: token,
      },
      label: 'POST /{ig-user}/media (REELS)',
      signal,
    });
    const containerId = parseId(containerJson);
    if (!containerId)
      throw new PublishError(
        'platform',
        'Instagram did not return an upload id for the Reel. Try again.',
      );

    // 3. Wait for processing.
    await waitUntilFinished(containerId, token, media.durationSec, a, plog);

    // 4. Publish.
    a.onProgress(0.88, 'Publishing the Reel');
    const mediaId = await publishContainer(igId, containerId, token, signal);

    // From here on the Reel EXISTS: nothing below may fail the post.
    a.onProgress(0.94, 'Reel published');
    let url: string | null = null;
    for (let i = 0; i < 2 && url === null; i++) {
      try {
        url = parsePermalink(
          await call({
            method: 'GET',
            url: gv(mediaId),
            query: { fields: 'permalink', access_token: token },
            label: 'GET /{media} permalink',
            signal,
          }),
        );
      } catch (e) {
        if (isAbort(e)) break;
        plog('instagram: permalink not available yet');
        if (i === 0) await sleep(Math.min(poll.initialMs, 1500), signal).catch(() => undefined);
      }
    }

    const comment = fields.firstComment?.trim();
    if (comment) {
      if (signal?.aborted)
        notes.push(
          'The first comment was skipped because the post was canceled right after publishing.',
        );
      else {
        try {
          const cj = await call({
            method: 'POST',
            url: gv(`${mediaId}/comments`),
            form: { message: comment, access_token: token },
            label: 'POST /{media}/comments',
            signal,
          });
          if (!parseId(cj)) notes.push('Instagram did not confirm the first comment.');
        } catch (e) {
          const why = e instanceof PublishError ? e.message : 'unknown error';
          plog('instagram: first comment failed');
          notes.push(
            `The Reel is live, but the first comment could not be posted: ${why}` +
              (e instanceof PublishError && e.code === 'auth'
                ? ' Reconnect the account to grant comment access.'
                : ''),
          );
        }
      }
    }
    a.onProgress(1, 'Published');
    return {
      platformPostId: mediaId,
      url,
      outcome: 'published',
      note: notes.length > 0 ? notes.join(' ') : null,
      quotaUnits: 0,
    };
  }

  async function waitUntilFinished(
    containerId: string,
    token: string,
    durationSec: number,
    a: PublishArgs,
    plog: (m: string) => void,
  ): Promise<void> {
    const started = now();
    const deadline = started + poll.timeoutMs(durationSec);
    let delay = poll.initialMs;
    let failures = 0;
    for (;;) {
      throwIfAborted(a.signal);
      try {
        const st = parseContainerStatus(
          await call({
            method: 'GET',
            url: gv(containerId),
            query: { fields: 'status_code,status', access_token: token },
            label: 'GET /{container} status',
            signal: a.signal,
          }),
        );
        failures = 0;
        if (st.statusCode === 'FINISHED' || st.statusCode === 'PUBLISHED') return;
        if (st.statusCode === 'ERROR' || st.statusCode === 'EXPIRED')
          throw mapContainerFailure(st.statusCode, st.status, secrets);
        // IN_PROGRESS (or a status we do not know yet): keep waiting.
      } catch (e) {
        if (isAbort(e)) throw e;
        const transient =
          e instanceof PublishError &&
          (e.code === 'network' || e.code === 'platform') &&
          e.retryable;
        if (!transient || ++failures > poll.maxStatusErrors) throw e;
        plog(`instagram: status check failed (${failures}/${poll.maxStatusErrors}), retrying`);
      }
      const t = now();
      if (t >= deadline)
        throw new PublishError(
          'platform',
          `Instagram is still processing the video after ${Math.round((t - started) / 60_000) || 1} min. Nothing was published; Clipfern will try again.`,
          { retryable: true },
        );
      const elapsed = t - started;
      a.onProgress(
        0.1 + 0.75 * (1 - Math.exp(-elapsed / 45_000)),
        'Instagram is processing the video',
      );
      await sleep(Math.max(1, Math.min(delay, deadline - t)), a.signal);
      delay = Math.min(delay * poll.factor, poll.maxMs);
    }
  }

  /** `media_publish`; Instagram sometimes answers "media not ready" (9007 / 2207027) right after FINISHED. */
  async function publishContainer(
    igId: string,
    containerId: string,
    token: string,
    signal?: AbortSignal,
  ): Promise<string> {
    for (let attempt = 1; ; attempt++) {
      try {
        const json = await call({
          method: 'POST',
          url: gv(`${igId}/media_publish`),
          form: { creation_id: containerId, access_token: token },
          label: 'POST /{ig-user}/media_publish',
          signal,
        });
        const id = parseId(json);
        if (!id)
          throw new PublishError(
            'platform',
            'Instagram accepted the publish request but did not return the Reel id. Check your Instagram profile before retrying.',
            { retryable: false },
          );
        return id;
      } catch (e) {
        const notReady = subcodeOf(e) === 2207027 || graphCodeOf(e) === 9007;
        if (!notReady || attempt >= 4) throw e;
        await sleep(poll.initialMs * attempt, signal);
      }
    }
  }

  return provider;
}
