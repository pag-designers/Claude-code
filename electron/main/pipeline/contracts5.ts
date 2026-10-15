/**
 * CP5 (posting + scheduler) module contracts for the MAIN process. Conventions as in contracts.ts. The lead owns this
 * file: tell the lead instead of editing it. Data shapes: shared/publish.ts. Errors: services/publish/errors.ts.
 *
 * Environment overrides for tests/dev ONLY (never needed in production), read by the lead's wiring and passed in as
 * `baseUrls`: CLIPFERN_GOOGLE_OAUTH_BASE, CLIPFERN_YOUTUBE_API_BASE, CLIPFERN_YOUTUBE_UPLOAD_BASE, CLIPFERN_META_OAUTH_BASE,
 * CLIPFERN_GRAPH_BASE, CLIPFERN_TIKTOK_AUTH_BASE, CLIPFERN_TIKTOK_API_BASE.
 */
import type {
  FieldIssue,
  MediaReport,
  Platform,
  PostFields,
  PostMediaInfo,
  PostStats,
} from '@shared/publish';
import type { CommonOpts } from './contracts';

export interface OAuthTokens {
  accessToken: string;
  /** null when the platform issues none (long-lived Instagram tokens are refreshed with the access token itself). */
  refreshToken: string | null;
  /** Epoch ms the access token stops working; null = unknown / does not expire. */
  expiresAt: number | null;
  scope: string | null;
  /** Platform extras that must travel with the tokens (e.g. Instagram page token, TikTok open_id). Strings only. */
  extra: Record<string, string>;
}

export interface ProviderAccount {
  externalId: string;
  displayName: string;
  handle: string | null;
  avatarUrl: string | null;
  scopes: string[];
  info: Record<string, string | number | boolean | null>;
}

export interface ProviderDeps {
  /** The developer-app credentials from the secret store; null when not saved yet. */
  getCredentials(): { clientId: string; clientSecret: string } | null;
  /** Test/dev overrides of the platform hosts (see the header). */
  baseUrls?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  log?: (m: string) => void;
  now?: () => number;
  /** Per-request timeout (default 30 s; uploads use their own, longer limits). */
  timeoutMs?: number;
}

export interface PublishMedia {
  /** Local path of the video to upload (an absolute path; already downloaded and validated by the core). */
  file: string;
  sizeBytes: number;
  durationSec: number;
  width: number;
  height: number;
  contentType: 'video/mp4';
  /** A short-lived GET URL of the same file in object storage (Instagram pulls the video from a URL). */
  presignedUrl(ttlSec?: number): Promise<string>;
}

export interface PublishArgs extends Pick<CommonOpts, 'signal'> {
  /** Fresh tokens (the core refreshed them if they were about to expire). */
  tokens: OAuthTokens;
  account: ProviderAccount;
  fields: PostFields;
  media: PublishMedia;
  /** 0..1 or null (indeterminate) + a short message ("Uploading 40 %", "Instagram is processing the video"). */
  onProgress(fraction: number | null, message?: string): void;
  log(m: string): void;
}

export interface PublishResult {
  platformPostId: string;
  /** Public link (null when the platform gives none, e.g. a TikTok draft). */
  url: string | null;
  outcome: 'published' | 'draft-uploaded';
  /** What the platform actually applied when it differs from the request (TikTok forcing SELF_ONLY, …). */
  note: string | null;
  /** Quota units this post consumed (YouTube: 1600). 0 when the platform meters posts instead. */
  quotaUnits: number;
}

export interface ProviderQuota {
  used: number;
  limit: number;
  unit: 'units' | 'posts';
  resetsAt: number;
  postsLeft: number | null;
  note: string | null;
}

/**
 * One official platform API. Implementations throw `PublishError` (never raw fetch errors), never log tokens or
 * secrets, honour `signal`, and parse every response tolerantly (zod, unknown extra fields ignored).
 */
export interface PublisherProvider {
  readonly platform: Platform;
  /** Scopes requested at consent. */
  readonly scopes: readonly string[];
  /** Consent URL. PKCE (S256) for providers that support it; `state` is echoed back by the platform. */
  authUrl(a: { redirectUri: string; state: string; codeChallenge: string }): string;
  exchangeCode(
    a: { code: string; redirectUri: string; codeVerifier: string },
    opts?: Pick<CommonOpts, 'signal'>,
  ): Promise<{ tokens: OAuthTokens; account: ProviderAccount }>;
  /** Throws `PublishError('auth', …)` when the grant was revoked/expired (the account then needs re-connecting). */
  refresh(tokens: OAuthTokens, opts?: Pick<CommonOpts, 'signal'>): Promise<OAuthTokens>;
  /** Best effort; never throws for "already revoked". */
  revoke(tokens: OAuthTokens): Promise<void>;
  testConnection(tokens: OAuthTokens): Promise<{
    ok: boolean;
    message: string;
    detail: string | null;
    account: ProviderAccount | null;
  }>;
  /** Platform rules beyond the zod schema (title characters, tag budget, hashtag/mention counts, privacy options…). */
  validateFields(fields: PostFields): FieldIssue[];
  /** Quota units one post of these fields costs (0 when the platform meters posts instead of units). */
  quotaCost(fields: PostFields): number;
  publish(a: PublishArgs): Promise<PublishResult>;
  /** Views/likes/comments of a published post; null when the platform/scope cannot provide them. */
  fetchStats?(a: {
    tokens: OAuthTokens;
    account: ProviderAccount;
    platformPostId: string;
  }): Promise<PostStats | null>;
  /** Platform-reported quota where there is an endpoint (Instagram `content_publishing_limit`); else computed from `usedUnits`/`usedPosts`. */
  quota(a: {
    tokens: OAuthTokens;
    account: ProviderAccount;
    usedUnits: number;
    usedPosts: number;
    now: number;
  }): Promise<ProviderQuota>;
}

/* ------------------------------------------------------------------------------- media checks ---- */

export interface PublishMediaService {
  /** ffprobe → size/codec/fps summary. Throws a user-readable Error for unreadable files. */
  probe(file: string, opts?: Pick<CommonOpts, 'signal'>): Promise<PostMediaInfo>;
  /** Checks the file against the platform's published limits (shared/platform-specs.ts). Pure given `info`. */
  validate(a: { info: PostMediaInfo; platform: Platform }): MediaReport;
  /**
   * Re-encodes `file` to `outFile` so that every FIXABLE issue of `report` is gone (H.264 yuv420p + AAC, fps cap,
   * resolution cap, bitrate to fit the size limit, faststart) without cropping or trimming. Throws when an issue is
   * not fixable. Returns the probe of the output.
   */
  fix(
    a: {
      file: string;
      outFile: string;
      platform: Platform;
      report: MediaReport;
      ffmpegPath: string;
    } & CommonOpts,
  ): Promise<PostMediaInfo>;
}
