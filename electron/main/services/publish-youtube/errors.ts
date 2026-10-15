/**
 * Maps Google/YouTube HTTP failures to `PublishError`. Messages carry Google's own words (scrubbed of any token or
 * secret); hints say what the person can do. Docs checked 2026-10-15: videos.insert error table
 * (https://developers.google.com/youtube/v3/docs/videos/insert), channels.list, videos.list, OAuth `invalid_grant`.
 *
 * NOT detectable here: videos that YouTube accepts at upload time and rejects later while processing
 * (`processingFailed`, `rejected`, duplicate / copyright claims): `videos.insert` has already answered 200 by then.
 */
import { PublishError } from '../publish/errors';
import { QUOTA_EXTENSION_HINT } from './constants';
import { TransportError, parseJson, retryAfterSec, scrub, type Reply } from './http';
import { secondsUntilQuotaReset } from './pacific';
import { z } from 'zod';

const googleErrorSchema = z.object({
  error: z.union([
    z.object({
      code: z.number().optional().catch(undefined),
      message: z.string().optional().catch(undefined),
      status: z.string().optional().catch(undefined),
      errors: z
        .array(
          z.object({
            reason: z.string().optional().catch(undefined),
            message: z.string().optional().catch(undefined),
          }),
        )
        .optional()
        .catch(undefined),
    }),
    // OAuth endpoints: { error: 'invalid_grant', error_description: '…' }
    z.string(),
  ]),
  error_description: z.string().optional().catch(undefined),
});

export interface ParsedGoogleError {
  reasons: string[];
  message: string | null;
  /** OAuth-style error code (`invalid_grant`, …) when the body had one. */
  oauthCode: string | null;
}

export function parseGoogleError(text: string): ParsedGoogleError {
  const r = googleErrorSchema.safeParse(parseJson(text));
  if (!r.success) return { reasons: [], message: null, oauthCode: null };
  const e = r.data.error;
  if (typeof e === 'string')
    return { reasons: [e], message: r.data.error_description ?? null, oauthCode: e };
  const reasons = (e.errors ?? []).map((x) => x.reason).filter((x): x is string => !!x);
  if (e.status) reasons.push(e.status);
  const message = e.message ?? e.errors?.find((x) => x.message)?.message ?? null;
  return { reasons, message, oauthCode: null };
}

const clip = (s: string, n = 300): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function transportError(e: TransportError): PublishError {
  return new PublishError(
    'network',
    e.timedOut
      ? 'YouTube/Google did not answer in time. Check your connection; Clipfern will try again.'
      : 'Could not reach YouTube/Google. Check your internet connection; Clipfern will try again.',
    { retryable: true, cause: e },
  );
}

const VALIDATION_REASONS = new Set([
  'invalidTitle',
  'invalidDescription',
  'invalidTags',
  'invalidCategoryId',
  'invalidVideoMetadata',
  'invalidPublishAt',
  'invalidRecordingDetails',
  'defaultLanguageNotSet',
  'forbiddenPrivacySetting',
  'forbiddenLicenseSetting',
]);
const MEDIA_REASONS = new Set(['mediaBodyRequired', 'unsupportedMediaType', 'invalidFilename']);
const QUOTA_REASONS = new Set(['quotaExceeded', 'dailyLimitExceeded', 'dailyLimitExceededUnreg']);
const RATE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);
const AUTH_REASONS = new Set([
  'authError',
  'invalidCredentials',
  'UNAUTHENTICATED',
  'insufficientPermissions',
  'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
  'youtubeSignupRequired',
]);

/**
 * `reply` is a non-2xx response of a YouTube Data API / upload call. `secrets` are scrubbed from the text we derive.
 */
export function mapApiError(
  reply: Reply,
  ctx: { now: number; secrets: readonly string[] },
): PublishError {
  const { status } = reply;
  const g = parseGoogleError(reply.text);
  const apiMsg = g.message ? clip(scrub(g.message, ctx.secrets)) : null;
  const has = (set: Set<string>): boolean => g.reasons.some((r) => set.has(r));
  const reason = g.reasons[0] ?? null;

  if (has(QUOTA_REASONS)) {
    return new PublishError(
      'quota',
      'YouTube says the daily quota of this Google project is used up.',
      {
        retryable: true,
        retryAfterSec: secondsUntilQuotaReset(ctx.now),
        hint: QUOTA_EXTENSION_HINT,
      },
    );
  }
  if (status === 429 || has(RATE_REASONS)) {
    return new PublishError('rate-limit', apiMsg ?? 'YouTube is rate limiting requests.', {
      retryable: true,
      retryAfterSec: retryAfterSec(reply.headers, ctx.now) ?? 60,
    });
  }
  if (status === 401 || has(AUTH_REASONS)) {
    const scopeProblem = g.reasons.some(
      (r) => r === 'insufficientPermissions' || r === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
    );
    const noChannel = g.reasons.includes('youtubeSignupRequired');
    return new PublishError(
      'auth',
      noChannel
        ? 'This Google account has no YouTube channel.'
        : (apiMsg ?? 'Google rejected the saved sign-in for this YouTube channel.'),
      {
        retryable: false,
        hint: scopeProblem
          ? 'Connect the channel again and keep every permission box ticked on the Google consent screen.'
          : noChannel
            ? 'Create a channel at youtube.com, then connect again.'
            : 'Connect the YouTube channel again in Settings → Integrations.',
      },
    );
  }
  if (g.reasons.includes('accessNotConfigured') || g.reasons.includes('SERVICE_DISABLED')) {
    return new PublishError(
      'platform',
      apiMsg ?? 'The YouTube Data API is not enabled for this Google project.',
      {
        retryable: false,
        hint: 'In Google Cloud Console open "APIs & Services → Library", enable "YouTube Data API v3" for the project of your OAuth client, then try again.',
      },
    );
  }
  if (has(VALIDATION_REASONS)) {
    return new PublishError(
      'validation',
      `YouTube: ${apiMsg ?? reason ?? 'the fields were refused'}`,
      {
        retryable: false,
        hint: 'Edit the post (title, description, tags, category) and schedule it again.',
      },
    );
  }
  if (has(MEDIA_REASONS) || status === 413 || status === 415) {
    return new PublishError('media', `YouTube: ${apiMsg ?? 'the video file was refused'}`, {
      retryable: false,
    });
  }
  if (g.reasons.includes('uploadLimitExceeded')) {
    return new PublishError('platform', apiMsg ?? 'This channel reached its upload limit.', {
      retryable: false,
      hint: 'YouTube limits how many videos a channel can upload in a day. Try again tomorrow, or verify the channel at youtube.com/verify for a higher limit.',
    });
  }
  if (status === 403) {
    return new PublishError('platform', apiMsg ?? 'YouTube refused the request (HTTP 403).', {
      retryable: false,
      hint:
        reason === 'forbidden' || reason === 'channelForbidden'
          ? 'Check that the connected Google account owns the channel and that the channel is allowed to upload.'
          : null,
    });
  }
  if (status >= 500) {
    return new PublishError(
      'platform',
      `YouTube is having trouble (HTTP ${status}). Clipfern will try again.`,
      {
        retryable: true,
      },
    );
  }
  if (status === 408) {
    return new PublishError('network', 'YouTube timed out. Clipfern will try again.', {
      retryable: true,
    });
  }
  return new PublishError('platform', `YouTube: ${apiMsg ?? `request refused (HTTP ${status})`}`, {
    retryable: false,
  });
}

/** Errors of the OAuth token endpoint (`/token`). */
export function mapTokenError(
  reply: Reply,
  kind: 'exchange' | 'refresh',
  secrets: readonly string[],
  now: number,
): PublishError {
  const g = parseGoogleError(reply.text);
  const code = g.oauthCode ?? g.reasons[0] ?? null;
  const desc = g.message ? clip(scrub(g.message, secrets), 200) : null;
  if (code === 'invalid_grant') {
    if (kind === 'refresh')
      return new PublishError(
        'auth',
        'Google no longer accepts the saved sign-in for this channel.',
        {
          retryable: false,
          hint:
            'Connect the channel again. If your Google OAuth consent screen is still in "Testing" mode, Google expires ' +
            'refresh tokens after 7 days: open Google Cloud Console → "OAuth consent screen" and publish the app to ' +
            '"In production" (fine for personal use, no review needed for your own account), then reconnect.',
        },
      );
    return new PublishError('auth', 'Google rejected the sign-in code.', {
      retryable: false,
      hint:
        'Start the connection again from Settings → Integrations.' +
        (desc ? ` (Google: ${desc})` : ''),
    });
  }
  if (code === 'invalid_client' || code === 'unauthorized_client' || reply.status === 401) {
    return new PublishError('auth', 'Google does not accept the OAuth client ID or secret.', {
      retryable: false,
      hint: 'Open Settings → Integrations → YouTube and re-enter the client ID and client secret of a "Desktop app" OAuth client.',
    });
  }
  if (reply.status >= 500)
    return new PublishError(
      'platform',
      `Google sign-in is having trouble (HTTP ${reply.status}).`,
      {
        retryable: true,
      },
    );
  if (reply.status === 429)
    return new PublishError('rate-limit', 'Google is rate limiting sign-in requests.', {
      retryable: true,
      retryAfterSec: retryAfterSec(reply.headers, now) ?? 60,
    });
  return new PublishError(
    'auth',
    `Google refused the sign-in${code ? ` (${clip(scrub(code, secrets), 60)})` : ` (HTTP ${reply.status})`}.`,
    { retryable: false, hint: desc },
  );
}
