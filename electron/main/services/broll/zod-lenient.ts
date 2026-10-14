/**
 * Lenient zod building blocks for third-party JSON: a field with the wrong type becomes `undefined` instead of
 * failing the whole item; arrays are parsed element by element and malformed elements are dropped.
 */
import { z } from 'zod';

/** number | numeric string -> number; anything else -> undefined. */
export const lenNumber = z
  .preprocess(
    (v) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v),
    z.number().finite().optional(),
  )
  .catch(undefined);

export const lenString = z.string().optional().catch(undefined);

/** Positive integer id (number or numeric string) kept as a canonical string. */
export const lenId = z
  .preprocess(
    (v) => (typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : v),
    z.number().int().positive().optional(),
  )
  .catch(undefined);

/** An array whose malformed elements are skipped; a non-array becomes []. */
export function lenArray<S extends z.ZodType>(schema: S) {
  return z.unknown().transform((v): z.output<S>[] => {
    if (!Array.isArray(v)) return [];
    const out: z.output<S>[] = [];
    for (const el of v) {
      const r = schema.safeParse(el);
      if (r.success) out.push(r.data);
    }
    return out;
  });
}

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
