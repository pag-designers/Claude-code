import type { ClipHooks, HookVariant } from '@shared/cp2';
import { PLATFORMS } from '@shared/cp2';
import type { LlmServiceV2 } from '../../pipeline/contracts2';
import type { BudgetGuard } from './budget';
import type { LlmEngine } from './client';
import { abortError, LlmError } from './errors';
import { buildClipStable, buildHooksVolatile, HOOKS_SYSTEM } from './prompts2';
import { toJsonSchema } from './schemas';
import { modelHooksSchema, type ModelHooks } from './schemas2';
import { normalizeForMatch } from './transcript';

/**
 * writeHooks - 5 variants for each of TikTok / Reels / Shorts (BRIEF §4.9).
 *
 * Model: the fast (Haiku-class) one - the clip context is a few hundred tokens, so a call costs a
 * fraction of a cent. Effort 'medium': hook quality is the creative part of the product and Haiku's
 * extra thinking costs ~$0.0005 at $0.50/MTok output, i.e. it is almost free; 'low' would skip
 * thinking on most requests. Design choice, not a measurement.
 *
 * Code enforces what a prompt cannot: <= 10 words, no empty/duplicate/near-duplicate variants, spoken
 * line <= 25 words. First attempt: problems go back to the model (one repair retry). Last attempt:
 * bad variants are DROPPED (never truncated - a cut-off hook can change its meaning) and at least
 * MIN_FINAL variants per platform must remain, else the call fails.
 */

const HOOKS_EFFORT = 'medium' as const;
export const HOOK_MAX_WORDS = 10;
const HOOK_MAX_CHARS = 90;
const SPOKEN_MAX_WORDS = 25;
const WANTED = 5;
const MIN_FINAL = 3;
const NEAR_DUPLICATE = 0.75;

export interface HooksContext {
  engine: LlmEngine;
  budget: BudgetGuard;
  getSettings: () => Promise<{ modelFast: string }>;
  log: (m: string) => void;
}

type HooksInput = Parameters<LlmServiceV2['writeHooks']>[0];
export type HooksResult = Omit<ClipHooks, 'applied' | 'generatedAt'>;

export async function runHooks(ctx: HooksContext, input: HooksInput): Promise<HooksResult> {
  ctx.engine.assertConfigured();
  if (input.signal?.aborted) throw abortError(input.signal);
  if (!input.clip.text.trim()) {
    throw new LlmError('empty-transcript', 'This clip has no speech to write hooks for.');
  }
  const settings = await ctx.getSettings();
  await ctx.budget.peek(); // throws BudgetExceededError at the hard cap

  const out = await ctx.engine.run<ModelHooks>({
    model: settings.modelFast,
    purpose: 'hooks',
    system: HOOKS_SYSTEM,
    stable: buildClipStable(input.info, input.clip),
    volatile: buildHooksVolatile(),
    schema: modelHooksSchema,
    jsonSchema: HOOKS_JSON_SCHEMA,
    effort: HOOKS_EFFORT,
    maxTokens: 16_000,
    expectedOutputChars: 3_200,
    estimatedOutputTokens: 1_800,
    signal: input.signal,
    onProgress: input.onProgress,
    validate: (parsed, { finalAttempt }) => {
      if (finalAttempt) return null;
      const r = cleanHooks(parsed, () => {});
      return r.problems.length
        ? `${r.problems.slice(0, 5).join('; ')}. Each platform needs exactly ${WANTED} different variants of at most ${HOOK_MAX_WORDS} words.`
        : null;
    },
  });

  const r = cleanHooks(out, ctx.log);
  for (const p of PLATFORMS) {
    if (r.hooks[p].length < MIN_FINAL) {
      throw new LlmError(
        'invalid-output',
        `Claude returned fewer than ${MIN_FINAL} usable ${p} hooks: ${r.problems.join('; ') || 'too many were duplicates'}.`,
      );
    }
  }
  return r.hooks;
}

const HOOKS_JSON_SCHEMA = toJsonSchema(modelHooksSchema);

const clean = (t: string) =>
  t
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, '')
    .trim();
const wordCount = (t: string) => t.split(/\s+/).filter(Boolean).length;

function tokens(t: string): Set<string> {
  return new Set(
    normalizeForMatch(t)
      .split(' ')
      .filter((w) => w.length > 1),
  );
}
function similarity(a: string, b: string): number {
  const x = tokens(a);
  const y = tokens(b);
  if (x.size === 0 || y.size === 0) return 0;
  let inter = 0;
  for (const w of x) if (y.has(w)) inter++;
  return inter / (x.size + y.size - inter);
}

/** Drops unusable variants and reports why. At most WANTED survive per platform, order preserved. */
export function cleanHooks(
  raw: ModelHooks,
  log: (m: string) => void,
): { hooks: HooksResult; problems: string[] } {
  const problems: string[] = [];
  const hooks = { tiktok: [], reels: [], shorts: [] } as unknown as HooksResult;
  for (const p of PLATFORMS) {
    const kept: HookVariant[] = [];
    raw[p].forEach((v, i) => {
      const where = `${p} #${i + 1}`;
      const text = clean(v.text);
      if (!text) return void problems.push(`${where} is empty`);
      if (wordCount(text) > HOOK_MAX_WORDS || text.length > HOOK_MAX_CHARS)
        return void problems.push(
          `${where} has ${wordCount(text)} words / ${text.length} characters (max ${HOOK_MAX_WORDS} words)`,
        );
      const dup = kept.find((k) => similarity(k.text, text) >= NEAR_DUPLICATE);
      if (dup) return void problems.push(`${where} repeats "${dup.text}"`);
      let spoken: string | null = v.spoken === null ? null : clean(v.spoken);
      if (spoken !== null && (spoken === '' || wordCount(spoken) > SPOKEN_MAX_WORDS)) {
        if (spoken) log(`hooks: ${where} spoken line over ${SPOKEN_MAX_WORDS} words; dropped it`);
        spoken = null;
      }
      const angle = clean(v.angle).toLowerCase().slice(0, 24) || 'general';
      kept.push({ text, spoken, angle });
    });
    if (raw[p].length < WANTED) problems.push(`${p} has only ${raw[p].length} variants`);
    if (kept.length >= 2 && new Set(kept.map((k) => k.angle)).size < Math.min(3, kept.length))
      problems.push(`${p} variants reuse the same angle - vary the angles`);
    for (const pr of problems) log(`hooks: ${pr}`);
    hooks[p] = kept.slice(0, WANTED);
  }
  return { hooks, problems };
}
