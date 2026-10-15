/**
 * Lenient zod building blocks for TikTok's JSON: a field of the wrong type becomes `undefined` instead of failing
 * the whole response; unknown extra fields are ignored.
 */
import { z } from 'zod';

export const lenString = z.string().optional().catch(undefined);

/** number | numeric string -> number; anything else -> undefined. */
export const lenNumber = z
  .preprocess(
    (v) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v),
    z.number().finite().optional(),
  )
  .catch(undefined);

export const lenBool = z.boolean().optional().catch(undefined);

/** A string array whose non-string elements are dropped; a non-array becomes []. */
export const lenStrings = z
  .unknown()
  .transform((v): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [],
  );

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
