/**
 * YouTube Shorts publisher (platform 'shorts'): OAuth 2.0 (desktop/loopback + PKCE), `videos.insert` resumable
 * upload, statistics, quota. Official YouTube Data API v3 only. See constants.ts for the docs checked and the quota
 * model (1 unit per upload in its own 100-calls/day bucket since 2026-06-01; the older 1600-unit model is gone).
 *
 * `deps.baseUrls` keys (all optional, tests/dev): `oauthBase` (serves /authorize /token /revoke), `apiBase`
 * (serves /channels /videos), `uploadBase` (serves /videos for the resumable upload).
 *
 * Tokens, the client secret, authorization codes and PKCE verifiers never appear in logs or error texts.
 */
import type { FieldIssue, PostFields, PostStats } from '@shared/publish';
import { shortsFieldsSchema } from '@shared/publish';
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
import { fetchChannel, fetchVideoStats } from './api';
import {
  CHUNK_TIMEOUT_MS,
  DEFAULT_API_BASE,
  DEFAULT_AUTH_URL,
  DEFAULT_CHUNK_BYTES,
  DEFAULT_DAILY_UPLOAD_LIMIT,
  DEFAULT_REVOKE_URL,
  DEFAULT_TOKEN_URL,
  DEFAULT_UPLOAD_BASE,
  MAX_RETRIES,
  MAX_SESSION_RESTARTS,
  QUOTA_EXTENSION_HINT,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  SCOPES,
  SCOPE_READONLY,
  SCOPE_UPLOAD,
  SHORTS_URL,
  UPLOAD_COST_UNITS,
} from './constants';
import { isAbort, type HttpCtx } from './http';
import {
  buildAuthUrl,
  exchangeAuthCode,
  refreshAccessToken,
  revokeToken,
  type Credentials,
  type OAuthUrls,
} from './oauth';
import { nextPacificMidnight } from './pacific';
import { alignChunk, defaultSleep, resumableInsert, type UploadTuning } from './upload';
import { validateShortsFields } from './validate';

export { nextPacificMidnight, secondsUntilQuotaReset } from './pacific';
export { effectiveDescription, tagBudgetUsed, validateShortsFields } from './validate';
export { QUOTA_EXTENSION_HINT, UPLOAD_COST_UNITS } from './constants';

export interface YoutubeProviderOptions {
  /** Calls/day of the videos.insert bucket (default 100; higher after a quota extension). */
  dailyUploadLimit?: number;
  /** Upload chunk size in bytes, rounded down to a multiple of 256 KiB (default 4 MiB). Tests use small values. */
  chunkBytes?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  chunkTimeoutMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const trimBase = (s: string | undefined, fallback: string): string =>
  (s?.trim() || fallback).replace(/\/+$/, '');

export function createYoutubeProvider(
  deps: ProviderDeps,
  options: YoutubeProviderOptions = {},
): PublisherProvider {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const ctx: HttpCtx = {
    fetchImpl: deps.fetch ?? fetch,
    timeoutMs: deps.timeoutMs ?? 30_000,
    log,
    now,
  };
  const oauthBase = deps.baseUrls?.oauthBase?.trim();
  const urls: OAuthUrls = oauthBase
    ? {
        auth: `${oauthBase.replace(/\/+$/, '')}/authorize`,
        token: `${oauthBase.replace(/\/+$/, '')}/token`,
        revoke: `${oauthBase.replace(/\/+$/, '')}/revoke`,
      }
    : { auth: DEFAULT_AUTH_URL, token: DEFAULT_TOKEN_URL, revoke: DEFAULT_REVOKE_URL };
  const apiBase = trimBase(deps.baseUrls?.apiBase, DEFAULT_API_BASE);
  const uploadBase = trimBase(deps.baseUrls?.uploadBase, DEFAULT_UPLOAD_BASE);
  const dailyLimit = Math.max(
    1,
    Math.floor(options.dailyUploadLimit ?? DEFAULT_DAILY_UPLOAD_LIMIT),
  );
  const tuning: UploadTuning = {
    chunkBytes: alignChunk(options.chunkBytes ?? DEFAULT_CHUNK_BYTES),
    maxRetries: options.maxRetries ?? MAX_RETRIES,
    retryBaseMs: options.retryBaseMs ?? RETRY_BASE_MS,
    retryMaxMs: options.retryMaxMs ?? RETRY_MAX_MS,
    chunkTimeoutMs: options.chunkTimeoutMs ?? CHUNK_TIMEOUT_MS,
    maxSessionRestarts: MAX_SESSION_RESTARTS,
    sleep: options.sleep ?? defaultSleep,
  };

  const credentials = (): Credentials => {
    const c = deps.getCredentials();
    if (!c || !c.clientId.trim())
      throw new PublishError('auth', 'The Google OAuth client is not set up yet.', {
        retryable: false,
        hint: 'Open Settings → Integrations → YouTube and paste the client ID and client secret of your Google Cloud "Desktop app" OAuth client.',
      });
    return { clientId: c.clientId.trim(), clientSecret: c.clientSecret.trim() };
  };

  const withScopes = (acct: ProviderAccount, tokens: OAuthTokens): ProviderAccount => ({
    ...acct,
    scopes: tokens.scope ? tokens.scope.split(/\s+/).filter(Boolean) : [...SCOPES],
  });

  const provider: PublisherProvider = {
    platform: 'shorts',
    scopes: SCOPES,

    authUrl(a) {
      return buildAuthUrl(urls, credentials(), a);
    },

    async exchangeCode(a, opts) {
      const creds = credentials();
      const tokens = await exchangeAuthCode(ctx, urls, creds, a, opts?.signal);
      const granted = (tokens.scope ?? '').split(/\s+/);
      if (tokens.scope && !granted.includes(SCOPE_UPLOAD))
        throw new PublishError(
          'auth',
          'Clipfern was not allowed to upload videos to your channel.',
          {
            retryable: false,
            hint: 'Connect again and keep every permission box ticked on the Google consent screen.',
          },
        );
      if (tokens.scope && !granted.includes(SCOPE_READONLY))
        throw new PublishError('auth', 'Clipfern was not allowed to read your channel details.', {
          retryable: false,
          hint: 'Connect again and keep every permission box ticked on the Google consent screen.',
        });
      const account = withScopes(await fetchChannel(ctx, apiBase, tokens, opts?.signal), tokens);
      return { tokens, account };
    },

    async refresh(tokens, opts) {
      return refreshAccessToken(ctx, urls, credentials(), tokens, opts?.signal);
    },

    async revoke(tokens) {
      await revokeToken(ctx, urls, tokens);
    },

    async testConnection(tokens) {
      try {
        const account = withScopes(await fetchChannel(ctx, apiBase, tokens), tokens);
        return {
          ok: true,
          message: `Connected to the YouTube channel "${account.displayName}".`,
          detail:
            typeof account.info.subscribers === 'number'
              ? `${account.info.subscribers} subscribers`
              : null,
          account,
        };
      } catch (e) {
        if (isAbort(e)) throw e;
        const pe = isPublishError(e) ? e : null;
        return {
          ok: false,
          message: pe?.message ?? 'Could not check the YouTube connection.',
          detail: pe?.hint ?? null,
          account: null,
        };
      }
    },

    validateFields(fields: PostFields): FieldIssue[] {
      return validateShortsFields(fields);
    },

    quotaCost(): number {
      return UPLOAD_COST_UNITS;
    },

    async publish(a: PublishArgs): Promise<PublishResult> {
      const parsed = shortsFieldsSchema.safeParse(a.fields);
      const issues = validateShortsFields(a.fields);
      if (!parsed.success || issues.length > 0)
        throw new PublishError(
          'validation',
          `YouTube would refuse this post: ${issues.map((i) => i.message).join(' ')}`,
          { retryable: false, hint: 'Edit the post and schedule it again.' },
        );
      if (!a.tokens.accessToken)
        throw new PublishError('auth', 'There is no saved sign-in for this YouTube channel.', {
          retryable: false,
          hint: 'Connect the YouTube channel again in Settings → Integrations.',
        });
      const fields = parsed.data;
      a.log(`youtube: uploading ${a.media.sizeBytes} bytes (${fields.visibility})`);
      const video = await resumableInsert({
        ctx: { ...ctx, log: a.log },
        uploadBase,
        tokens: a.tokens,
        fields,
        media: a.media,
        tuning,
        signal: a.signal,
        onProgress: a.onProgress,
      });
      const note =
        video.privacyStatus && video.privacyStatus !== fields.visibility
          ? `YouTube set the video to "${video.privacyStatus}" instead of "${fields.visibility}".`
          : null;
      return {
        platformPostId: video.id,
        url: SHORTS_URL(video.id),
        outcome: 'published',
        note,
        quotaUnits: UPLOAD_COST_UNITS,
      };
    },

    async fetchStats(a): Promise<PostStats | null> {
      return fetchVideoStats(ctx, apiBase, a.tokens, a.platformPostId);
    },

    async quota(a): Promise<ProviderQuota> {
      // Cost per upload is 1 unit, so units and posts agree; take the larger in case the caller only tracks one.
      const used = Math.max(a.usedPosts, Math.floor(a.usedUnits / UPLOAD_COST_UNITS));
      return {
        used,
        limit: dailyLimit,
        unit: 'posts',
        resetsAt: nextPacificMidnight(a.now),
        postsLeft: Math.max(0, dailyLimit - used),
        note:
          `YouTube allows ${dailyLimit} uploads a day for this Google project (resets at midnight Pacific Time). ` +
          'If you need more, request a free quota extension: ' +
          QUOTA_EXTENSION_HINT.split('. ').slice(1).join('. '),
      };
    },
  };
  return provider;
}
