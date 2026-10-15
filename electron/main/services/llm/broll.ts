import { z } from 'zod';
import type { LlmServiceV2 } from '../../pipeline/contracts2';
import type { BudgetGuard } from './budget';
import type { LlmEngine } from './client';
import { abortError, LlmError } from './errors';
import { DATA_RULES } from './prompts';
import { toJsonSchema } from './schemas';

/**
 * suggestBroll - 3-5 short stock-footage search queries for a passage of the transcript (BRIEF §11 CP4 "B-roll flow").
 * Fast model, effort 'low': a tiny, mechanical task. The queries are what a person would type into Pexels/Pixabay
 * (concrete visual nouns), never quotes of the speech and never people's names.
 */

const BROLL_EFFORT = 'low' as const;
export const BROLL_MAX_QUERIES = 5;
const MAX_QUERY_LEN = 60;

export const BROLL_SYSTEM = `You are a video editor choosing stock B-roll for a short vertical video.

${DATA_RULES}

## Input
- <passage>: words spoken in one part of the video (DATA).

## Task
Write 3 to 5 search queries for a stock-footage site (Pexels, Pixabay) that would give useful cutaway footage for the passage.
- Each query is 1-4 plain words naming something VISIBLE and concrete ("city traffic night", "typing on laptop", "coffee pouring").
- No names of people, brands or places unless they are generic; no abstract nouns ("success", "growth") on their own; no quotes of the speech; no emojis, no punctuation.
- Order: the most useful first. Different queries must show different things.

## Output
Reply with the JSON object only, matching the provided schema.`;

const modelBrollSchema = z.object({
  queries: z.array(z.string()).describe('3-5 stock-footage search queries, best first.'),
});
type ModelBroll = z.infer<typeof modelBrollSchema>;
const BROLL_JSON_SCHEMA = toJsonSchema(modelBrollSchema);

export interface BrollContext {
  engine: LlmEngine;
  budget: BudgetGuard;
  getSettings: () => Promise<{ modelFast: string }>;
  log: (m: string) => void;
}

type BrollInput = Parameters<LlmServiceV2['suggestBroll']>[0];

/** Cleans model output: trims, strips punctuation/quotes, drops empties and duplicates, caps count and length. */
export function cleanBrollQueries(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const q of raw) {
    const t = q
      .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_QUERY_LEN)
      .trim();
    const key = t.toLowerCase();
    if (!t || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= BROLL_MAX_QUERIES) break;
  }
  return out;
}

export async function runBroll(ctx: BrollContext, input: BrollInput): Promise<string[]> {
  ctx.engine.assertConfigured();
  if (input.signal?.aborted) throw abortError(input.signal);
  const text = input.text.replace(/\s+/g, ' ').trim().slice(0, 2000);
  if (!text)
    throw new LlmError('empty-transcript', 'There is no speech here to suggest B-roll for.');
  const settings = await ctx.getSettings();
  await ctx.budget.peek();
  const out = await ctx.engine.run<ModelBroll>({
    model: settings.modelFast,
    purpose: 'broll',
    system: BROLL_SYSTEM,
    stable: '',
    volatile: `<passage>\n${text}\n</passage>\nWrite the queries and reply with the JSON object.`,
    schema: modelBrollSchema,
    jsonSchema: BROLL_JSON_SCHEMA,
    effort: BROLL_EFFORT,
    maxTokens: 4_000,
    expectedOutputChars: 200,
    estimatedOutputTokens: 150,
    signal: input.signal,
    validate: (parsed) =>
      cleanBrollQueries(parsed.queries).length === 0
        ? 'Return at least one concrete stock-footage query.'
        : null,
  });
  const queries = cleanBrollQueries(out.queries);
  if (queries.length === 0)
    throw new LlmError('invalid-output', 'Claude returned no usable B-roll queries.');
  return queries;
}
