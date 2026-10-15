/** decideRetry / backoffDelayMs: table-driven. */
import { describe, expect, it } from 'vitest';
import type { PublishErrorCode } from '../../shared/publish';
import {
  EXTRA_DICTATED_ATTEMPTS,
  QUOTA_MARGIN_MS,
  QUOTA_MAX_WAIT_MS,
  QUOTA_UNKNOWN_WAIT_MS,
  RATE_LIMIT_MAX_MS,
  RATE_LIMIT_MIN_MS,
  backoffDelayMs,
  decideRetry,
  unit,
  type RetryInput,
} from '../../electron/main/services/publish/retry';
import { PublishError } from '../../electron/main/services/publish/errors';

const NOW = 1_800_000_000_000;
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

const call = (
  code: PublishErrorCode,
  o: Partial<RetryInput> & { retryable?: boolean; retryAfterSec?: number | null } = {},
) =>
  decideRetry({
    error: {
      code,
      retryable: o.retryable ?? new PublishError(code, 'x').retryable, // the default each code gets in errors.ts
      retryAfterSec: o.retryAfterSec ?? null,
    },
    attempts: o.attempts ?? 1,
    maxAttempts: o.maxAttempts,
    now: o.now ?? NOW,
    quotaResetsAt: o.quotaResetsAt,
    seed: o.seed,
  });

describe('decideRetry: never retried', () => {
  it.each<PublishErrorCode>(['auth', 'validation', 'media'])('%s', (code) => {
    // even when a provider wrongly marks them retryable
    for (const retryable of [true, false]) {
      const d = call(code, { retryable, attempts: 1 });
      expect(d).toMatchObject({ retryAt: null, giveUp: true });
      expect(d.reason.length).toBeGreaterThan(10);
    }
  });

  it('unknown errors and anything flagged non-retryable', () => {
    expect(call('unknown').giveUp).toBe(true);
    expect(call('network', { retryable: false }).giveUp).toBe(true);
    expect(call('platform', { retryable: false }).giveUp).toBe(true);
    expect(call('rate-limit', { retryable: false, retryAfterSec: 60 }).giveUp).toBe(true);
    expect(call('quota', { retryable: false, quotaResetsAt: NOW + HOUR }).giveUp).toBe(true);
  });
});

describe('decideRetry: network / platform backoff', () => {
  it.each<[PublishErrorCode, number, number, number]>([
    // code, attempts made, min delay, max delay (±20 % jitter around 1 min, 5 min, 20 min)
    ['network', 1, 48 * SEC, 72 * SEC],
    ['network', 2, 4 * MIN, 6 * MIN],
    ['network', 3, 16 * MIN, 24 * MIN],
    ['platform', 1, 48 * SEC, 72 * SEC],
    ['platform', 2, 4 * MIN, 6 * MIN],
  ])('%s after %i failed attempt(s) waits %i..%i ms', (code, attempts, lo, hi) => {
    for (let seed = 0; seed < 50; seed++) {
      const d = call(code, { attempts, seed });
      expect(d.giveUp).toBe(false);
      expect(d.retryAt! - NOW).toBeGreaterThanOrEqual(lo);
      expect(d.retryAt! - NOW).toBeLessThanOrEqual(hi);
    }
  });

  it('gives up when the attempts are used (default 4)', () => {
    expect(call('network', { attempts: 3 }).giveUp).toBe(false);
    expect(call('network', { attempts: 4 })).toMatchObject({ giveUp: true, retryAt: null });
    expect(call('platform', { attempts: 7 }).giveUp).toBe(true);
    expect(call('network', { attempts: 4, maxAttempts: 6 }).giveUp).toBe(false);
    expect(call('network', { attempts: 1, maxAttempts: 1 }).giveUp).toBe(true);
  });

  it('rate-limit without a retryAfter falls back to backoff (min 30 s)', () => {
    const d = call('rate-limit', { attempts: 1, seed: 1 });
    expect(d.giveUp).toBe(false);
    expect(d.retryAt! - NOW).toBeGreaterThanOrEqual(RATE_LIMIT_MIN_MS);
  });

  it('is deterministic and pure', () => {
    expect(call('network', { attempts: 2, seed: 9 })).toEqual(
      call('network', { attempts: 2, seed: 9 }),
    );
    expect(call('network', { attempts: 2 })).toEqual(call('network', { attempts: 2 })); // default seed from now/attempts
    expect(call('network', { attempts: 2, seed: 1 }).retryAt).not.toBe(
      call('network', { attempts: 2, seed: 2 }).retryAt,
    );
  });
});

describe('backoffDelayMs', () => {
  it('grows 1 min, 5 min, 20 min, 1 h, 2 h and then stays', () => {
    const base = [1 * MIN, 5 * MIN, 20 * MIN, 1 * HOUR, 2 * HOUR, 2 * HOUR, 2 * HOUR];
    base.forEach((b, i) => {
      for (let seed = 0; seed < 30; seed++) {
        const d = backoffDelayMs(i + 1, seed);
        expect(d).toBeGreaterThanOrEqual(b * 0.8 - 1);
        expect(d).toBeLessThanOrEqual(b * 1.2 + 1);
      }
    });
  });

  it('jitter is deterministic per seed and actually varies', () => {
    expect(backoffDelayMs(2, 42)).toBe(backoffDelayMs(2, 42));
    expect(
      new Set(Array.from({ length: 40 }, (_, s) => backoffDelayMs(2, s))).size,
    ).toBeGreaterThan(20);
    for (let s = 0; s < 200; s++) {
      expect(unit(s)).toBeGreaterThanOrEqual(0);
      expect(unit(s)).toBeLessThan(1);
    }
  });

  it('clamps nonsense attempts', () => {
    expect(backoffDelayMs(0, 1)).toBeLessThanOrEqual(72 * SEC);
    expect(backoffDelayMs(-5, 1)).toBeLessThanOrEqual(72 * SEC);
    expect(backoffDelayMs(99, 1)).toBeLessThanOrEqual(2.4 * HOUR);
  });
});

describe('decideRetry: rate limit with retryAfter', () => {
  it.each<[number, number, number]>([
    // retryAfterSec, expected min wait ms, expected max wait ms (includes 1-5 s margin)
    [10, RATE_LIMIT_MIN_MS, RATE_LIMIT_MIN_MS + 5 * SEC], // raised to 30 s
    [30, 30 * SEC, 35 * SEC],
    [120, 120 * SEC, 125 * SEC],
    [3600, HOUR, HOUR + 5 * SEC],
    [24 * 3600, RATE_LIMIT_MAX_MS, RATE_LIMIT_MAX_MS + 5 * SEC],
    [3 * 24 * 3600, RATE_LIMIT_MAX_MS, RATE_LIMIT_MAX_MS + 5 * SEC], // capped at 24 h
  ])('retryAfter %i s', (sec, lo, hi) => {
    const d = call('rate-limit', { retryAfterSec: sec });
    expect(d.giveUp).toBe(false);
    expect(d.retryAt! - NOW).toBeGreaterThanOrEqual(lo);
    expect(d.retryAt! - NOW).toBeLessThanOrEqual(hi);
  });

  it('is allowed two more attempts than maxAttempts because the platform named the time', () => {
    expect(call('rate-limit', { retryAfterSec: 60, attempts: 4 }).giveUp).toBe(false);
    expect(call('rate-limit', { retryAfterSec: 60, attempts: 5 }).giveUp).toBe(false);
    expect(
      call('rate-limit', { retryAfterSec: 60, attempts: 4 + EXTRA_DICTATED_ATTEMPTS }).giveUp,
    ).toBe(true);
  });
});

describe('decideRetry: quota', () => {
  it('waits for the reset plus a margin, never sooner', () => {
    for (let seed = 0; seed < 40; seed++) {
      const reset = NOW + 5 * HOUR;
      const d = call('quota', { quotaResetsAt: reset, seed });
      expect(d.giveUp).toBe(false);
      expect(d.retryAt!).toBeGreaterThanOrEqual(reset + QUOTA_MARGIN_MS);
      expect(d.retryAt!).toBeLessThanOrEqual(reset + 2 * QUOTA_MARGIN_MS);
    }
  });

  it('a reset in the past retries shortly (margin only)', () => {
    const d = call('quota', { quotaResetsAt: NOW - HOUR });
    expect(d.retryAt! - NOW).toBeGreaterThanOrEqual(QUOTA_MARGIN_MS);
    expect(d.retryAt! - NOW).toBeLessThanOrEqual(2 * QUOTA_MARGIN_MS);
  });

  it('uses retryAfterSec when the reset time is unknown, a fixed wait when both are missing', () => {
    const a = call('quota', { retryAfterSec: 7200 });
    expect(a.retryAt! - NOW).toBeGreaterThanOrEqual(2 * HOUR + QUOTA_MARGIN_MS);
    const b = call('quota', {});
    expect(b.retryAt).toBe(NOW + QUOTA_UNKNOWN_WAIT_MS);
    expect(b.giveUp).toBe(false);
  });

  it('prefers the explicit reset over retryAfterSec', () => {
    const reset = NOW + 3 * HOUR;
    const d = call('quota', { quotaResetsAt: reset, retryAfterSec: 60 });
    expect(d.retryAt!).toBeGreaterThanOrEqual(reset + QUOTA_MARGIN_MS);
  });

  it('gives up when the reset is more than 36 hours away, or after too many tries', () => {
    expect(call('quota', { quotaResetsAt: NOW + QUOTA_MAX_WAIT_MS + HOUR })).toMatchObject({
      giveUp: true,
      retryAt: null,
    });
    expect(call('quota', { quotaResetsAt: NOW + HOUR, attempts: 4 }).giveUp).toBe(false);
    expect(
      call('quota', { quotaResetsAt: NOW + HOUR, attempts: 4 + EXTRA_DICTATED_ATTEMPTS }).giveUp,
    ).toBe(true);
  });

  it('a quota wait never gets a shorter delay than a rate limit would', () => {
    for (const hours of [1, 6, 23]) {
      const d = call('quota', { quotaResetsAt: NOW + hours * HOUR });
      expect(d.retryAt! - NOW).toBeGreaterThan(hours * HOUR);
    }
  });
});

describe('decideRetry: shape of the answer', () => {
  it('retryAt is null exactly when giveUp, and the reason is always a sentence', () => {
    const codes: PublishErrorCode[] = [
      'auth',
      'rate-limit',
      'quota',
      'validation',
      'media',
      'network',
      'platform',
      'unknown',
    ];
    for (const code of codes) {
      for (const attempts of [1, 2, 4, 6, 9]) {
        for (const retryAfterSec of [null, 5, 90, 200_000]) {
          const d = call(code, {
            attempts,
            retryAfterSec,
            quotaResetsAt: code === 'quota' ? NOW + 2 * HOUR : null,
          });
          expect(d.giveUp).toBe(d.retryAt === null);
          if (d.retryAt !== null) expect(d.retryAt).toBeGreaterThan(NOW);
          expect(d.reason).toMatch(/^[A-Z].{10,}\.$/);
        }
      }
    }
  });

  it('attempts below 1 are treated as the first failure', () => {
    expect(call('network', { attempts: 0 }).giveUp).toBe(false);
    expect(call('network', { attempts: -3 }).retryAt! - NOW).toBeLessThanOrEqual(72 * SEC);
  });
});
