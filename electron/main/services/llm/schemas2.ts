import { z } from 'zod';
import { transitionSchema } from '@shared/cp2';

/**
 * MODEL-FACING output schemas of the CP2 tasks (hooks, metadata, highlights, thumbnail ranking,
 * retrieval). Same conventions as schemas.ts: sent as `output_config.format`, re-validated with zod,
 * numeric/length limits only in `.describe()` text and enforced in code. Property ORDER is the order
 * the model writes in, so the reasoning-bearing fields come first.
 */

/* ---------------------------------------------- highlights ---------------------------------------------- */

export const modelHighlightSchema = z.object({
  segments: z
    .array(
      z.object({
        candidateId: z.string().describe('Id of the candidate the sentences come from, e.g. "c3".'),
        startSentence: z
          .number()
          .int()
          .describe('Number after "S" of the FIRST sentence of this micro-moment (inclusive).'),
        endSentence: z
          .number()
          .int()
          .describe('Number after "S" of the LAST sentence of this micro-moment (inclusive).'),
        role: z
          .string()
          .describe(
            'One line: what this beat does in the story (e.g. "Opens on the 40% churn claim").',
          ),
      }),
    )
    .describe(
      'The micro-moments IN PLAYBACK ORDER (narrative order, not necessarily chronological): strongest hook first, escalation in the middle, payoff last. 3-5 items; fewer when the material cannot support them.',
    ),
  transition: transitionSchema.describe(
    'ONE transition style for the whole reel, chosen by content.',
  ),
  title: z.string().describe('At most 60 characters. Specific, true to the reel.'),
  hook: z
    .string()
    .describe('At most 10 words of on-screen text for the first 2-3 seconds. Must be true.'),
  whyItWorks: z
    .string()
    .describe(
      '2-3 sentences in English: the story arc (hook, escalation, payoff) AND why this transition fits the content.',
    ),
});
export type ModelHighlight = z.infer<typeof modelHighlightSchema>;

/* -------------------------------------------------- hooks ------------------------------------------------- */

const hookVariantModel = z.object({
  text: z
    .string()
    .describe('On-screen text for the first 2-3 seconds. At most 10 words. True to the clip.'),
  spoken: z
    .string()
    .nullable()
    .describe(
      'Optional line the creator could SAY as a voiceover/re-record (at most 25 words), or null.',
    ),
  angle: z
    .string()
    .describe('1-2 word label of the angle: curiosity, contrarian, number, question, story, ...'),
});

export const modelHooksSchema = z.object({
  tiktok: z.array(hookVariantModel).describe('Exactly 5 genuinely different variants, best first.'),
  reels: z.array(hookVariantModel).describe('Exactly 5 genuinely different variants, best first.'),
  shorts: z.array(hookVariantModel).describe('Exactly 5 genuinely different variants, best first.'),
});
export type ModelHooks = z.infer<typeof modelHooksSchema>;

/* ------------------------------------------------ metadata ------------------------------------------------ */

const platformMetaModel = z.object({
  title: z.string(),
  description: z.string().describe('Plain text WITHOUT hashtags; the app appends the hashtags.'),
  hashtags: z
    .array(z.string())
    .describe('4-6 hashtags, one word each, no spaces, mix of broad and niche.'),
  postingTime: z.object({
    dayOfWeek: z
      .number()
      .int()
      .nullable()
      .describe('0 = Sunday ... 6 = Saturday, or null for "any day".'),
    hour: z.number().int().describe("Hour of the day in the viewer's local time, 0-23."),
    reason: z
      .string()
      .describe(
        'One sentence. It is a general best-practice suggestion; you have NO audience data. Never claim otherwise.',
      ),
  }),
});

export const modelMetaSchema = z.object({
  tiktok: platformMetaModel.describe(
    'TikTok: title = short caption-style first line, at most 90 characters.',
  ),
  reels: platformMetaModel.describe(
    'Instagram Reels: title = first line of the caption, at most 100 characters.',
  ),
  shorts: platformMetaModel.describe(
    'YouTube Shorts: title at most 100 characters, search-friendly.',
  ),
});
export type ModelMeta = z.infer<typeof modelMetaSchema>;

/* ----------------------------------------------- thumbnails ----------------------------------------------- */

export const modelThumbRankSchema = z.object({
  ranking: z
    .array(
      z.object({
        frame: z.number().int().describe('The frame number from its "Frame N" label.'),
        note: z
          .string()
          .describe(
            'One short line on what is good or bad about this frame (expression, focus, blur...).',
          ),
      }),
    )
    .describe('EVERY frame exactly once, best thumbnail first.'),
  overlayText: z
    .string()
    .describe(
      'At most 5 words of overlay text, true to the clip; empty string when no text would help.',
    ),
});
export type ModelThumbRank = z.infer<typeof modelThumbRankSchema>;

/* ---------------------------------------------- retrieval (chat) ------------------------------------------ */

export const retrievalSchema = z.object({
  windows: z
    .array(
      z.object({
        startSentence: z
          .number()
          .int()
          .describe('Number after "S" of the first sentence (inclusive).'),
        endSentence: z
          .number()
          .int()
          .describe('Number after "S" of the last sentence (inclusive).'),
        relevance: z.number().describe('Integer 1-10: how directly it helps answer the question.'),
      }),
    )
    .describe(
      'At most 4 windows, each at most about 60 sentences. Empty when nothing here is relevant.',
    ),
});
export type RetrievalOutput = z.infer<typeof retrievalSchema>;
