import type { PublishErrorCode } from '@shared/publish';

/**
 * The one error type publishers throw. The scheduler decides what to do from `code` / `retryable`:
 *  - auth        → the account needs re-connecting (never retried automatically)
 *  - rate-limit  → retry after `retryAfterSec` (provider-given) else backoff
 *  - quota       → retry after the quota resets (`retryAfterSec`), never sooner
 *  - validation  → the platform rejected the fields (user must edit), not retried
 *  - media       → the platform rejected the video (spec, codec, processing failure), not retried
 *  - network     → retried with backoff
 *  - platform    → platform-side 5xx / unexpected: retried a few times
 * `message` is what the user reads: the platform's own words where it gave any (never containing tokens or secrets).
 */
export class PublishError extends Error {
  readonly code: PublishErrorCode;
  readonly retryable: boolean;
  readonly retryAfterSec: number | null;
  readonly hint: string | null;

  constructor(
    code: PublishErrorCode,
    message: string,
    opts: {
      retryable?: boolean;
      retryAfterSec?: number | null;
      hint?: string | null;
      cause?: unknown;
    } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'PublishError';
    this.code = code;
    this.retryable =
      opts.retryable ??
      (code === 'rate-limit' || code === 'network' || code === 'platform' || code === 'quota');
    this.retryAfterSec = opts.retryAfterSec ?? null;
    this.hint = opts.hint ?? null;
  }
}

export const isPublishError = (e: unknown): e is PublishError => e instanceof PublishError;
