import { z } from 'zod';

/**
 * MODEL-FACING output schemas. They are sent to the API as `output_config.format` (structured
 * outputs) and re-validated with zod on arrival. Structured outputs do not support numeric bounds
 * or length limits, so those live in `.describe()` text (read by the model) and are enforced /
 * clamped in code afterwards. Property ORDER matters: the model writes fields in this order, so
 * reasoning-bearing fields come before the scores that depend on them.
 */

/**
 * zod -> JSON Schema for `output_config.format`. Only the subset structured outputs support is
 * used (object/array/string/number/integer/anyOf-null + descriptions); this strips the noise zod
 * adds (draft marker, safe-integer bounds) and enforces `additionalProperties: false`.
 */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema, { reused: 'inline', unrepresentable: 'throw' });
  return strictify(raw) as Record<string, unknown>;
}

const SAFE_INT = Number.MAX_SAFE_INTEGER;

function strictify(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictify);
  if (node === null || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === '$schema') continue;
    if ((k === 'minimum' || k === 'maximum') && typeof v === 'number' && Math.abs(v) >= SAFE_INT)
      continue;
    out[k] = strictify(v);
  }
  if (out.type === 'object') out.additionalProperties = false;
  if (Array.isArray(out.type)) {
    // ["string","null"] -> anyOf, the nullable spelling structured outputs document.
    const { type, description, ...rest } = out;
    return {
      ...(description !== undefined ? { description } : {}),
      anyOf: (type as string[]).map((t) => ({ ...rest, type: t })),
    };
  }
  return out;
}

/* ------------------------------------------------ rank ------------------------------------------------ */

export const modelMomentSchema = z.object({
  candidateId: z
    .string()
    .nullable()
    .describe(
      'Id of the candidate this moment is based on (e.g. "c3"), or null for your own span.',
    ),
  startSentence: z
    .number()
    .int()
    .describe(
      'Number after "S" of the FIRST sentence of the clip (inclusive). It must work as a hook.',
    ),
  endSentence: z
    .number()
    .int()
    .describe(
      'Number after "S" of the LAST sentence of the clip (inclusive). It must complete the thought.',
    ),
  title: z
    .string()
    .describe('At most 60 characters. Curiosity-driven, specific, true to the clip.'),
  hook: z
    .string()
    .describe(
      'At most 10 words of on-screen text for the first 2-3 seconds. Must be true to the clip.',
    ),
  whyItWorks: z.string().describe('1-2 concrete sentences in English: hook, tension, payoff.'),
  keywords: z
    .array(z.string())
    .describe('Up to 6 single words exactly as spoken in the clip that deserve caption emphasis.'),
  scores: z.object({
    hook: z.number().describe('Integer 0-25.'),
    retention: z.number().describe('Integer 0-25.'),
    emotion: z.number().describe('Integer 0-20.'),
    clarity: z.number().describe('Integer 0-15.'),
    shareability: z.number().describe('Integer 0-15.'),
  }),
  confidence: z
    .number()
    .describe('0.0-1.0: certainty that start/end are right and it performs as scored.'),
});
export type ModelMoment = z.infer<typeof modelMomentSchema>;

export const rankOutputSchema = z.object({
  moments: z
    .array(modelMomentSchema)
    .describe(
      'Best first. Fewer than the maximum - even none - when the window has nothing worth posting.',
    ),
  windowNotes: z
    .string()
    .describe(
      'One short sentence explaining why fewer moments (or none) were returned; empty string otherwise.',
    ),
});
export type RankOutput = z.infer<typeof rankOutputSchema>;

/* ---------------------------------------------- understand ---------------------------------------------- */

const refSchema = z.object({
  text: z.string(),
  sentence: z.number().int().describe('Number after "S" of the line the item comes from.'),
});

const overviewSchema = z.object({
  summary: z
    .string()
    .describe('3-5 sentences: what the video is, who is in it, what happens or is argued.'),
  tone: z.string().describe('2-6 words, e.g. "casual, humorous, technical".'),
  participants: z
    .array(z.string())
    .describe('Names only if stated in the material, otherwise roles.'),
  takeaways: z
    .array(z.string())
    .describe('Exactly 5 one-sentence takeaways, most important first.'),
});

const notesSchema = z.object({
  keyPoints: z.array(z.string()).describe('5-12 concise bullet points.'),
  quotes: z
    .array(refSchema)
    .describe('Up to 8 quotable lines, copied VERBATIM from the transcript.'),
  numbers: z
    .array(refSchema)
    .describe('Up to 10 concrete figures/dates/prices as short self-contained statements.'),
  claims: z.array(refSchema).describe('Up to 8 notable claims, attributed to the speaker.'),
  actionItems: z
    .array(z.string())
    .describe('Advice/to-dos given to the viewer. Empty array if none.'),
});

const tailSchema = {
  topics: z.array(z.string()).describe('3-8 topic phrases.'),
  entities: z.array(z.string()).describe('Up to 15 named people, organisations, products, places.'),
  keywords: z.array(z.string()).describe('Up to 12 search-style keywords.'),
};

/** Chapters the model must invent (no YouTube chapters available). */
export const understandAiSchema = z.object({
  overview: overviewSchema,
  chapters: z
    .array(
      z.object({
        title: z.string().describe('3-8 words.'),
        startSentence: z
          .number()
          .int()
          .describe('Number after "S" of the first sentence of the chapter.'),
        summary: z.string().describe('One sentence.'),
      }),
    )
    .describe('In order. The first chapter starts at the first sentence. No gaps, no overlaps.'),
  notes: notesSchema,
  ...tailSchema,
});
export type UnderstandAiOutput = z.infer<typeof understandAiSchema>;

/** Uploader chapters exist: the model only writes a one-line summary for each. */
export const understandYtSchema = z.object({
  overview: overviewSchema,
  chapterSummaries: z
    .array(
      z.object({
        index: z
          .number()
          .int()
          .describe('The chapter number from the CHAPTER marker (starting at 0).'),
        summary: z.string().describe('One sentence about what happens in that chapter.'),
      }),
    )
    .describe('One entry for every chapter, in order.'),
  notes: notesSchema,
  ...tailSchema,
});
export type UnderstandYtOutput = z.infer<typeof understandYtSchema>;
