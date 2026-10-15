/**
 * Retry policy for failed publishes. PURE (no clock, no randomness: the jitter is derived from a seed), so the scheduler
 * and the tests get identical answers.
 *
 *   auth / validation / media / unknown → never retried (a person has to act: reconnect, edit the fields, change the video)
 *   network / platform                  → exponential backoff 1 min, 5 min, 20 min, 1 h … (±20 % jitter), up to `maxAttempts`
 *   rate-limit                          → the platform's `retryAfter` (clamped to 30 s … 24 h) + a few seconds; else backoff
 *   quota                               → the quota reset + a margin; never sooner
 * `attempts` = how many tries have been made INCLUDING the one that just failed (the first failure passes 1).
 * Waits the platform dictated itself (quota reset, retryAfter) may use `EXTRA_DICTATED_ATTEMPTS` more tries than
 * `maxAttempts`: waiting for a published reset is not a flaky platform.
 */
import type { PublishErrorCode } from '@shared/publish';

export const DEFAULT_MAX_ATTEMPTS = 4;
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

/** Backoff steps by attempt number (1-based); later attempts reuse the last step. */
const BACKOFF_STEPS_MS = [1 * MIN, 5 * MIN, 20 * MIN, 1 * HOUR, 2 * HOUR] as const;
const JITTER = 0.2;
export const RATE_LIMIT_MIN_MS = 30 * SEC;
export const RATE_LIMIT_MAX_MS = 24 * HOUR;
/** Added after a quota reset: clocks differ, resets are not exact to the second. */
export const QUOTA_MARGIN_MS = 60 * SEC;
/** If the quota only resets later than this, retrying automatically makes no sense. */
export const QUOTA_MAX_WAIT_MS = 36 * HOUR;
/** Quota error without any reset time: look again after this. */
export const QUOTA_UNKNOWN_WAIT_MS = 1 * HOUR;
export const EXTRA_DICTATED_ATTEMPTS = 2;

/** Deterministic value in [0, 1) from a seed (mulberry32 step). */
export function unit(seed: number): number {
  let t = (Math.floor(seed) + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Delay before retry number `attempt` (1 = after the first failure): 1 min, 5 min, 20 min, 1 h, 2 h; ±20 % by `seed`. */
export function backoffDelayMs(attempt: number, seed: number): number {
  const i = Math.min(Math.max(1, Math.floor(attempt)), BACKOFF_STEPS_MS.length) - 1;
  const base = BACKOFF_STEPS_MS[i]!;
  const factor = 1 + (unit(seed + attempt * 7919) * 2 - 1) * JITTER;
  return Math.round(base * factor);
}

export interface RetryInput {
  error: { code: PublishErrorCode; retryable: boolean; retryAfterSec: number | null };
  attempts: number;
  maxAttempts?: number;
  now: number;
  /** Epoch ms the quota counter resets (quota errors). */
  quotaResetsAt?: number | null;
  /** Jitter seed; default derives from `now` and `attempts`. */
  seed?: number;
}

export interface RetryDecision {
  retryAt: number | null;
  giveUp: boolean;
  reason: string;
}

const give = (reason: string): RetryDecision => ({ retryAt: null, giveUp: true, reason });
const at = (retryAt: number, reason: string): RetryDecision => ({
  retryAt,
  giveUp: false,
  reason,
});

const human = (ms: number): string => {
  const s = Math.round(ms / SEC);
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  return `${+(m / 60).toFixed(1)} h`;
};

export function decideRetry(input: RetryInput): RetryDecision {
  const { error, now } = input;
  const max = Math.max(1, input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const attempts = Math.max(1, Math.floor(input.attempts));
  const seed = input.seed ?? Math.floor(now / 1000) * 31 + attempts;

  switch (error.code) {
    case 'auth':
      return give('The account must be reconnected; retrying cannot help.');
    case 'validation':
      return give('The platform rejected the post fields; edit the post and try again.');
    case 'media':
      return give('The platform rejected the video; fix or replace the video.');
    default:
      break;
  }
  if (!error.retryable) return give('The error is not retryable.');

  if (error.code === 'quota') {
    if (attempts >= max + EXTRA_DICTATED_ATTEMPTS) {
      return give(`Gave up after ${attempts} attempts hitting the platform quota.`);
    }
    let waitUntil: number;
    if (input.quotaResetsAt !== undefined && input.quotaResetsAt !== null) {
      waitUntil = Math.max(now, input.quotaResetsAt);
    } else if (error.retryAfterSec !== null && error.retryAfterSec > 0) {
      waitUntil = now + error.retryAfterSec * SEC;
    } else {
      return at(
        now + QUOTA_UNKNOWN_WAIT_MS,
        `Quota reached; checking again in ${human(QUOTA_UNKNOWN_WAIT_MS)}.`,
      );
    }
    if (waitUntil - now > QUOTA_MAX_WAIT_MS) {
      return give('The quota resets more than 36 hours from now; reschedule the post.');
    }
    const retryAt = waitUntil + QUOTA_MARGIN_MS + Math.round(unit(seed) * QUOTA_MARGIN_MS);
    return at(
      retryAt,
      `Quota reached; retrying ${human(retryAt - now)} from now, after it resets.`,
    );
  }

  if (error.code === 'rate-limit' && error.retryAfterSec !== null && error.retryAfterSec > 0) {
    if (attempts >= max + EXTRA_DICTATED_ATTEMPTS) {
      return give(`Gave up after ${attempts} attempts hitting the platform rate limit.`);
    }
    const wait = Math.min(
      RATE_LIMIT_MAX_MS,
      Math.max(RATE_LIMIT_MIN_MS, error.retryAfterSec * SEC),
    );
    // a few seconds of margin so the retry does not land exactly on the boundary
    const retryAt = now + wait + 1000 + Math.round(unit(seed) * 4000);
    return at(retryAt, `Rate limited; retrying in ${human(retryAt - now)} as the platform asked.`);
  }

  if (attempts >= max) {
    return give(`Gave up after ${attempts} attempts.`);
  }
  let delay = backoffDelayMs(attempts, seed);
  if (error.code === 'rate-limit') delay = Math.max(RATE_LIMIT_MIN_MS, delay);
  return at(now + delay, `Retrying in ${human(delay)} (attempt ${attempts + 1} of ${max}).`);
}
