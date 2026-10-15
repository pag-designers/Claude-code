/**
 * Maps Instagram / Graph API failures onto `PublishError`. Sources (checked 2026-10-15):
 *  - https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/error-codes
 *  - https://developers.facebook.com/docs/graph-api/guides/error-handling   (190 / 102 / 4 / 17 / 32 / 613 / 463 / 467)
 * `message` never contains a token, the app secret, an authorization code or a presigned-URL signature (redacted).
 */
import { z } from 'zod';
import { PublishError } from '../publish/errors';
import type { SecretSet } from './redact';

/** A PublishError that remembers the Graph `code` / `error_subcode` so the provider can react to specific ones. */
export class InstagramApiError extends PublishError {
  constructor(
    code: ConstructorParameters<typeof PublishError>[0],
    message: string,
    readonly graphCode: number | null,
    readonly subcode: number | null,
    opts: ConstructorParameters<typeof PublishError>[2] = {},
  ) {
    super(code, message, opts);
    this.name = 'InstagramApiError';
  }
}

export const graphCodeOf = (e: unknown): number | null =>
  e instanceof InstagramApiError ? e.graphCode : null;
export const subcodeOf = (e: unknown): number | null =>
  e instanceof InstagramApiError ? e.subcode : null;

export function abortError(): Error {
  const e = new Error('Aborted');
  e.name = 'AbortError';
  return e;
}
export const isAbort = (e: unknown): boolean => e instanceof Error && e.name === 'AbortError';

/* ------------------------------------------------------------------------------- body parsing */

const lenStr = z.string().optional().catch(undefined);
const lenNum = z
  .preprocess(
    (v) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v),
    z.number().finite().optional(),
  )
  .catch(undefined);

const graphErrorSchema = z.object({
  error: z.union([
    z.object({
      message: lenStr,
      type: lenStr,
      code: lenNum,
      error_subcode: lenNum,
      error_user_title: lenStr,
      error_user_msg: lenStr,
      is_transient: z.boolean().optional().catch(undefined),
    }),
    // `{ "error": "invalid_request", "error_description": "…" }`
    z.string(),
  ]),
  error_description: lenStr,
});
/** `api.instagram.com/oauth/access_token` failures: `{ error_type, code, error_message }`. */
const oauthErrorSchema = z.object({ error_type: lenStr, code: lenNum, error_message: lenStr });

export interface ParsedGraphError {
  code: number | null;
  subcode: number | null;
  message: string | null;
  transient: boolean;
}

export function parseErrorBody(body: unknown): ParsedGraphError | null {
  const g = graphErrorSchema.safeParse(body);
  if (g.success) {
    const e = g.data.error;
    if (typeof e === 'string')
      return {
        code: null,
        subcode: null,
        message: g.data.error_description ?? e,
        transient: false,
      };
    return {
      code: e.code ?? null,
      subcode: e.error_subcode ?? null,
      message: e.error_user_msg ?? e.message ?? null,
      transient: e.is_transient === true,
    };
  }
  const o = oauthErrorSchema.safeParse(body);
  if (o.success && (o.data.error_message || o.data.error_type))
    return {
      code: o.data.code ?? null,
      subcode: null,
      message: o.data.error_message ?? o.data.error_type ?? null,
      transient: false,
    };
  return null;
}

/* ------------------------------------------------------------------------------- the mapping */

const RECONNECT = 'Reconnect the Instagram account in Settings → Integrations.';

interface Known {
  code: 'media' | 'validation' | 'platform';
  retryable: boolean;
  text: string;
}

/** Plain-language text for the `error_subcode`s Meta documents (and the container `status` text). */
export const SUBCODE_TEXT: Record<number, Known> = {
  2207026: {
    code: 'media',
    retryable: false,
    text: 'Instagram does not support this video format. Reels need an MP4 or MOV with H.264 or HEVC video and AAC audio.',
  },
  2207003: {
    code: 'media',
    retryable: true,
    text: 'Instagram timed out while downloading the video from your storage.',
  },
  2207052: {
    code: 'media',
    retryable: true,
    text: 'Instagram could not download the video from the temporary link Clipfern gave it. Check that your storage bucket is reachable from the internet.',
  },
  2207053: {
    code: 'media',
    retryable: true,
    text: 'Instagram failed to process the uploaded video (unknown upload error).',
  },
  2207032: {
    code: 'media',
    retryable: true,
    text: 'Instagram could not create the Reel from this video.',
  },
  2207023: { code: 'media', retryable: false, text: 'Instagram did not recognise the media type.' },
  2207020: {
    code: 'media',
    retryable: true,
    text: 'The upload expired at Instagram before it was published.',
  },
  2207008: {
    code: 'media',
    retryable: true,
    text: 'Instagram no longer has this upload (it expired or never existed).',
  },
  2207001: {
    code: 'platform',
    retryable: true,
    text: 'Instagram had a server error. Try again shortly.',
  },
  2207027: {
    code: 'platform',
    retryable: true,
    text: 'Instagram was not done processing the video yet.',
  },
  2207057: {
    code: 'validation',
    retryable: false,
    text: 'The cover frame is outside the video. Pick a cover time inside the clip.',
  },
  2207040: {
    code: 'validation',
    retryable: false,
    text: 'The caption has more than 20 @mentions.',
  },
  2207010: {
    code: 'validation',
    retryable: false,
    text: 'The caption is too long (2,200 characters, 30 hashtags and 20 @mentions at most).',
  },
  2207050: {
    code: 'platform',
    retryable: false,
    text: 'Your Instagram professional account is inactive, restricted or needs a security check. Resolve it in the Instagram app.',
  },
  2207051: {
    code: 'platform',
    retryable: false,
    text: 'Instagram flagged this post as spam and restricted publishing for now.',
  },
};

/** Legacy top-level codes Instagram pairs with the subcodes above. */
const CODE_TO_SUBCODE: Record<number, number> = {
  9004: 2207052,
  9007: 2207027,
  352: 2207026,
  36004: 2207010,
};

const AUTH_CODES = new Set([190, 102, 458, 459, 460, 463, 464, 467]);
const RATE_CODES = new Set([4, 17, 32, 613, 80002]);
/** Meta's app / user throttles are rolling windows of about an hour. */
const DEFAULT_RATE_RETRY_SEC = 3600;
/** Used when the daily publishing cap is hit: the window is rolling, so re-check hourly. */
export const QUOTA_RECHECK_SEC = 3600;

function retryAfterSeconds(header: string | null, nowMs: number): number | null {
  if (!header) return null;
  const n = Number(header.trim());
  if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - nowMs) / 1000)) : null;
}

export function mapFailure(a: {
  status: number;
  retryAfterHeader: string | null;
  body: unknown;
  now: number;
  secrets: SecretSet;
}): InstagramApiError {
  const parsed = parseErrorBody(a.body);
  const code = parsed?.code ?? null;
  let sub = parsed?.subcode ?? null;
  if (sub === null && code !== null && CODE_TO_SUBCODE[code] !== undefined)
    sub = CODE_TO_SUBCODE[code] ?? null;
  const apiText = parsed?.message ? a.secrets.redact(parsed.message).slice(0, 300) : null;
  const said = apiText ? ` (Instagram said: ${apiText})` : '';
  const mk = (
    c: ConstructorParameters<typeof PublishError>[0],
    msg: string,
    opts: ConstructorParameters<typeof PublishError>[2] = {},
  ) => new InstagramApiError(c, msg, code, sub, opts);

  // Daily Content Publishing API limit.
  if (sub === 2207042)
    return mk('quota', `Instagram's daily limit of API-published posts is reached.${said}`, {
      retryAfterSec: QUOTA_RECHECK_SEC,
      hint: 'Posts go out again as older ones leave the rolling 24 hour window.',
    });
  const known = sub !== null ? SUBCODE_TEXT[sub] : undefined;
  if (known) return mk(known.code, `${known.text}${said}`, { retryable: known.retryable });
  if (a.status === 429 || (code !== null && RATE_CODES.has(code))) {
    const ra = retryAfterSeconds(a.retryAfterHeader, a.now) ?? DEFAULT_RATE_RETRY_SEC;
    return mk('rate-limit', `Instagram is limiting requests from this app right now.${said}`, {
      retryAfterSec: ra,
    });
  }
  const isPermission = code !== null && (code === 10 || (code >= 200 && code <= 299));
  if (code !== null && (AUTH_CODES.has(code) || isPermission))
    return mk(
      'auth',
      isPermission
        ? `Instagram says Clipfern is missing a permission for this action.${said}`
        : `Instagram no longer accepts this connection (the access token expired or was revoked).${said}`,
      { retryable: false, hint: RECONNECT },
    );
  if (a.status === 401 || a.status === 403)
    return mk('auth', `Instagram refused the request as not authorised.${said}`, {
      retryable: false,
      hint: RECONNECT,
    });
  if (code === 100)
    return mk('validation', `Instagram rejected a value of this post.${said || ''}`.trim(), {
      retryable: false,
      hint: 'Check the caption, collaborators and location, then try again.',
    });
  if (a.status >= 500 || code === 1 || code === 2 || parsed?.transient)
    return mk('platform', `Instagram is having trouble right now.${said}`, { retryable: true });
  return mk(
    'platform',
    apiText ? `Instagram: ${apiText}` : `Instagram refused the request (HTTP ${a.status}).`,
    // A 4xx answer is a verdict on the request, not a hiccup: repeating it unchanged cannot help.
    { retryable: false },
  );
}

/** Container `status_code` ERROR / EXPIRED → a media error in plain words (the `status` text is Instagram's own). */
export function mapContainerFailure(
  statusCode: string,
  statusText: string | null,
  secrets: SecretSet,
): PublishError {
  const raw = statusText ? secrets.redact(statusText).slice(0, 300) : null;
  if (statusCode === 'EXPIRED')
    return new PublishError(
      'media',
      'Instagram discarded the video because it was not published within 24 hours. Try again.',
      { retryable: true },
    );
  const m = raw ? /\b(2207\d{3})\b/.exec(raw) : null;
  const sub = m?.[1] ? Number(m[1]) : null;
  const known = sub !== null ? SUBCODE_TEXT[sub] : undefined;
  if (known)
    return new PublishError(
      known.code === 'platform' ? 'media' : known.code,
      `${known.text}${raw ? ` (Instagram said: ${raw})` : ''}`,
      { retryable: known.retryable },
    );
  return new PublishError(
    'media',
    raw
      ? `Instagram could not process the video: ${raw}`
      : 'Instagram could not process the video. Check that it is an MP4 within Instagram’s Reels limits (3 s to 15 min, 9:16, H.264 + AAC, under 300 MB).',
    { retryable: false },
  );
}
