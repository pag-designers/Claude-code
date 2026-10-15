/**
 * Typed, user-readable errors of the stock B-roll service. `message` is safe to show in the UI as is: it never
 * contains an API key or a request URL.
 */
import type { BrollProvider } from '@shared/brand';

export type BrollErrorCode =
  /** No API key saved for the provider. */
  | 'missing-key'
  /** 401 / 403 (or Pixabay's 400 "invalid key"). */
  | 'rejected'
  /** 429. `retryAfterSec` is set when the provider told us (or we could work it out). */
  | 'rate-limit'
  /** The provider could not be reached (offline, DNS, refused, timeout). */
  | 'network'
  /** The provider answered, but not with anything usable (malformed JSON, wrong shape, 5xx, 404). */
  | 'provider'
  /** The clip exists but has no downloadable MP4 rendition we accept (<= 1080p). */
  | 'no-file'
  /** The caller asked for something invalid (empty query, unknown id). */
  | 'invalid';

export const PROVIDER_NAME: Record<BrollProvider, string> = {
  pexels: 'Pexels',
  pixabay: 'Pixabay',
};

export class BrollError extends Error {
  override readonly name = 'BrollError';
  constructor(
    readonly code: BrollErrorCode,
    message: string,
    readonly provider: BrollProvider | null = null,
    readonly retryAfterSec: number | null = null,
  ) {
    super(message);
  }
}

export const isBrollError = (e: unknown): e is BrollError => e instanceof BrollError;

export const missingKeyError = (p: BrollProvider) =>
  new BrollError('missing-key', `Add your ${PROVIDER_NAME[p]} API key in Settings -> API Keys`, p);

export const rejectedError = (p: BrollProvider) =>
  new BrollError(
    'rejected',
    `${PROVIDER_NAME[p]} rejected this key. Check it in Settings -> API Keys.`,
    p,
  );

export function rateLimitError(p: BrollProvider, retryAfterSec: number | null): BrollError {
  const name = PROVIDER_NAME[p];
  if (retryAfterSec === null || !Number.isFinite(retryAfterSec) || retryAfterSec <= 0)
    return new BrollError(
      'rate-limit',
      `${name} rate limit reached; try again in a few minutes`,
      p,
      null,
    );
  const s = Math.ceil(retryAfterSec);
  const when = s < 120 ? `${s} s` : `${Math.ceil(s / 60)} min`;
  return new BrollError('rate-limit', `${name} rate limit reached; try again in ${when}`, p, s);
}

export const networkError = (p: BrollProvider, timedOut = false) =>
  new BrollError(
    'network',
    timedOut
      ? `${PROVIDER_NAME[p]} did not answer in time. Check your connection and try again.`
      : `Could not reach ${PROVIDER_NAME[p]}. Check your internet connection and try again.`,
    p,
  );

export const providerError = (p: BrollProvider, detail: string) =>
  new BrollError('provider', `${PROVIDER_NAME[p]}: ${detail}`, p);

export const noFileError = (p: BrollProvider) =>
  new BrollError(
    'no-file',
    `${PROVIDER_NAME[p]} has no downloadable HD MP4 for this clip. Pick another one.`,
    p,
  );

/** A user abort must stay an abort (callers distinguish it from failures). */
export function abortError(): Error {
  const e = new Error('Aborted');
  e.name = 'AbortError';
  return e;
}
