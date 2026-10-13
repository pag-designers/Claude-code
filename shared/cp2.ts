import { z } from 'zod';

/* ------------------------------------------------------------------------------------------------
 * CP2 domain types: caption styles, subtitles, hooks, metadata, thumbnails, highlights, steering,
 * chat. Shared by main, preload and renderer. Storage keys for CP2 artifacts are in `keys2` below.
 * ---------------------------------------------------------------------------------------------- */

export const PLATFORMS = ['tiktok', 'reels', 'shorts'] as const;
export const platformSchema = z.enum(PLATFORMS);
export type Platform = z.infer<typeof platformSchema>;
export const PLATFORM_LABELS: Record<Platform, string> = {
  tiktok: 'TikTok',
  reels: 'Instagram Reels',
  shorts: 'YouTube Shorts',
};

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'use #RRGGBB');

/* ----------------------------------------- caption styles ---------------------------------------- */

export const captionAnimationSchema = z.enum([
  'none',
  'pop',
  'bounce',
  'typewriter',
  'fade',
  'slide-up',
  'karaoke',
]);
export type CaptionAnimation = z.infer<typeof captionAnimationSchema>;

/**
 * Data-driven subtitle style (BRIEF §7 "Subtitle Styles"). Sizes are percentages so a style is
 * resolution independent. The caption service maps this onto libass; the live preview editor edits
 * exactly these fields and shows REAL libass output (see `captions:preview`).
 */
export const captionStyleSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(40),
  /** Built-in presets are read-only; "Duplicate" creates a custom copy. */
  builtin: z.boolean().default(false),
  font: z.object({
    /** Family libass resolves. Shipped fonts are listed by `captions:fonts`. */
    family: z.string().min(1),
    weight: z.number().int().min(100).max(900).default(800),
    italic: z.boolean().default(false),
    /** Font size as % of the frame's short side (portrait: width). */
    sizePct: z.number().min(2).max(14).default(7.8),
    letterSpacingPct: z.number().min(-2).max(6).default(0),
  }),
  textCase: z.enum(['none', 'upper', 'lower', 'title']).default('upper'),
  fill: hex,
  stroke: z.object({ color: hex, widthPct: z.number().min(0).max(1.5).default(0.6) }),
  shadow: z.object({
    color: hex,
    opacity: z.number().min(0).max(1).default(0.5),
    blurPx: z.number().min(0).max(24).default(0),
    offsetPx: z.number().min(0).max(24).default(3),
  }),
  box: z.object({
    enabled: z.boolean().default(false),
    color: hex,
    opacity: z.number().min(0).max(1).default(0.7),
    paddingPct: z.number().min(0).max(4).default(1),
  }),
  /** How the CURRENTLY SPOKEN word is emphasised. */
  highlight: z.object({
    mode: z.enum(['none', 'color', 'box', 'scale', 'color-scale']).default('color-scale'),
    color: hex,
    boxColor: hex,
    scale: z.number().min(1).max(1.5).default(1.16),
  }),
  /** Colour for LLM-chosen emphasis keywords (not the active word). */
  keywordColor: hex,
  animation: captionAnimationSchema.default('pop'),
  layout: z.object({
    /** Vertical centre of the caption block, % of frame height from the top (portrait safe area: 55–72). */
    yPct: z.number().min(5).max(95).default(69),
    marginXPct: z.number().min(0).max(20).default(6),
    align: z.enum(['center', 'left']).default('center'),
  }),
  chunking: z.object({
    maxWords: z.number().int().min(1).max(5).default(3),
    maxChars: z.number().int().min(6).max(48).default(14),
    maxLines: z.number().int().min(1).max(3).default(1),
  }),
});
export type CaptionStyle = z.infer<typeof captionStyleSchema>;
export type CaptionStyleInput = z.input<typeof captionStyleSchema>;

/** The 14 presets the brief requires (BRIEF §7). `clean-pop` is the default. */
export const BUILTIN_STYLE_IDS = [
  'clean-pop',
  'hormozi-bold',
  'karaoke-highlight',
  'tiktok-classic',
  'minimal-lower-third',
  'neon-glow',
  'boxed-highlight',
  'typewriter',
  'bounce-word',
  'gradient-glow',
  'outline-only',
  'caption-bubble',
  'podcast-lower-third',
  'subtle-serif',
] as const;
export const DEFAULT_STYLE_ID = 'clean-pop';

/* ------------------------------------------ subtitles / cues ------------------------------------- */

export const cueSchema = z.object({
  id: z.number().int(),
  s: z.number(),
  e: z.number(),
  text: z.string(),
  /** Inclusive word index range into the (edited) transcript words. */
  wordStart: z.number().int(),
  wordEnd: z.number().int(),
});
export type Cue = z.infer<typeof cueSchema>;

/**
 * Subtitle edits layered over the ASR transcript. Words keep their index; `text` overrides the
 * spoken text (timings stay), `shift` moves a word's start/end, `breaks` lists word indices at which a
 * new cue must begin (merge = remove a break, split = add one). Persisted per video; clips pick it up
 * when they are (re-)rendered.
 */
export const subtitleEditsSchema = z.object({
  rev: z.number().int().default(0),
  words: z
    .record(
      z.string(),
      z.object({
        text: z.string().optional(),
        /** seconds, added to the word's start and end */
        shift: z.number().optional(),
        /** true = word removed from captions */
        hidden: z.boolean().optional(),
      }),
    )
    .default({}),
  breaks: z.array(z.number().int()).default([]),
  /** Word indices where a break was explicitly REMOVED (forced merge). */
  merges: z.array(z.number().int()).default([]),
});
export type SubtitleEdits = z.infer<typeof subtitleEditsSchema>;

/* ------------------------------------------------- hooks ------------------------------------------ */

export const hookVariantSchema = z.object({
  /** On-screen text for the first 2–3 s (≤ 10 words, true to the clip). */
  text: z.string(),
  /** Optional line the creator could SAY at the start of the clip (e.g. for a re-record / voiceover). */
  spoken: z.string().nullable(),
  /** Short label of the angle, e.g. "curiosity", "contrarian", "number", "question", "story". */
  angle: z.string(),
});
export type HookVariant = z.infer<typeof hookVariantSchema>;

export const clipHooksSchema = z.object({
  /** 5 variants per platform. */
  tiktok: z.array(hookVariantSchema),
  reels: z.array(hookVariantSchema),
  shorts: z.array(hookVariantSchema),
  /** The variant currently burned in as the title card (null = card off). */
  applied: z.object({ platform: platformSchema, index: z.number().int() }).nullable(),
  generatedAt: z.number(),
});
export type ClipHooks = z.infer<typeof clipHooksSchema>;

/* ---------------------------------------------- metadata ----------------------------------------- */

export const platformMetaSchema = z.object({
  title: z.string(),
  description: z.string(),
  hashtags: z.array(z.string()),
  postingTime: z.object({
    /** 0 = Sunday … 6 = Saturday, null = any day */
    dayOfWeek: z.number().int().min(0).max(6).nullable(),
    /** local-time hour 0..23 */
    hour: z.number().int().min(0).max(23),
    reason: z.string(),
  }),
});
export type PlatformMeta = z.infer<typeof platformMetaSchema>;

export const clipMetaSchema = z.object({
  tiktok: platformMetaSchema,
  reels: platformMetaSchema,
  shorts: platformMetaSchema,
  generatedAt: z.number(),
});
export type ClipMeta = z.infer<typeof clipMetaSchema>;

/* ------------------------------------------------ thumbnails ------------------------------------- */

export const thumbnailCandidateSchema = z.object({
  /** Seconds relative to the CLIP start. */
  t: z.number(),
  /** Presigned URL is resolved on demand; key identifies the JPEG in storage. */
  key: z.string(),
  scores: z.object({
    sharpness: z.number(),
    face: z.number(),
    composition: z.number(),
    total: z.number(),
  }),
  /** LLM vision rank (1 = best) when the vision pass ran. */
  llmRank: z.number().int().nullable(),
  llmNote: z.string().nullable(),
});
export type ThumbnailCandidate = z.infer<typeof thumbnailCandidateSchema>;

export const clipThumbnailsSchema = z.object({
  candidates: z.array(thumbnailCandidateSchema),
  chosenT: z.number().nullable(),
  overlayText: z.string().nullable(),
  generatedAt: z.number(),
});
export type ClipThumbnails = z.infer<typeof clipThumbnailsSchema>;

/* ---------------------------------------------- highlights --------------------------------------- */

export const transitionSchema = z.enum(['cut', 'crossfade', 'dip-black', 'dip-white', 'slide', 'zoom']);
export type Transition = z.infer<typeof transitionSchema>;

export const highlightPlanSchema = z.object({
  title: z.string(),
  hook: z.string(),
  /** In narrative order (NOT necessarily chronological). Each 8–25 s, word-aligned by the caller. */
  segments: z.array(
    z.object({
      startSec: z.number(),
      endSec: z.number(),
      /** One line: why this beat is here in the story. */
      role: z.string(),
    }),
  ),
  transition: transitionSchema,
  whyItWorks: z.string(),
});
export type HighlightPlan = z.infer<typeof highlightPlanSchema>;

/* ------------------------------------------------ steering --------------------------------------- */

export const momentRunSchema = z.object({
  id: z.string(),
  videoId: z.string(),
  prompt: z.string(),
  status: z.enum(['running', 'done', 'failed', 'canceled']),
  found: z.number(),
  error: z.string().nullable(),
  createdAt: z.number(),
  finishedAt: z.number().nullable(),
});
export type MomentRun = z.infer<typeof momentRunSchema>;

/* ------------------------------------------------- reframe --------------------------------------- */

export const reframeModeSchema = z.enum(['auto', 'single-face', 'multi-face', 'screen-face', 'center']);
export type ReframeMode = z.infer<typeof reframeModeSchema>;
export const REFRAME_MODE_LABELS: Record<ReframeMode, string> = {
  auto: 'Auto',
  'single-face': 'Follow one face',
  'multi-face': 'Split screen (two people)',
  'screen-face': 'Screen + face',
  center: 'Centre crop',
};

/* -------------------------------------------------- chat ---------------------------------------- */

export const chatToolNameSchema = z.enum([
  'create_clip',
  'add_marker',
  'write_metadata',
  'rewrite_hook',
  'find_moments',
]);
export type ChatToolName = z.infer<typeof chatToolNameSchema>;

export const chatActionSchema = z.object({
  id: z.string(),
  tool: chatToolNameSchema,
  /** What the model asked for (JSON, tool-specific). */
  input: z.record(z.string(), z.unknown()),
  status: z.enum(['running', 'done', 'failed']),
  /** Human-readable outcome shown on the card, e.g. "Created clip 'The 3am call' (0:42–1:31)". */
  summary: z.string().nullable(),
  /** Deep link into the app (clip, marker, metadata tab), when there is one. */
  href: z.string().nullable(),
});
export type ChatAction = z.infer<typeof chatActionSchema>;

export const citationSchema = z.object({
  /** Seconds in the source video. */
  t: z.number(),
  label: z.string(),
});
export type Citation = z.infer<typeof citationSchema>;

export const chatMessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  citations: z.array(citationSchema),
  actions: z.array(chatActionSchema),
  createdAt: z.number(),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const chatThreadSchema = z.object({
  id: z.string(),
  videoId: z.string(),
  clipId: z.string().nullable(),
  title: z.string(),
  updatedAt: z.number(),
});
export type ChatThread = z.infer<typeof chatThreadSchema>;

/** Streamed to the renderer while the assistant answers. */
export const chatEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start'), threadId: z.string(), messageId: z.string() }),
  z.object({ type: z.literal('delta'), threadId: z.string(), messageId: z.string(), text: z.string() }),
  z.object({ type: z.literal('citation'), threadId: z.string(), messageId: z.string(), citation: citationSchema }),
  z.object({ type: z.literal('action'), threadId: z.string(), messageId: z.string(), action: chatActionSchema }),
  z.object({ type: z.literal('done'), threadId: z.string(), message: chatMessageSchema }),
  z.object({ type: z.literal('error'), threadId: z.string(), message: z.string() }),
]);
export type ChatEvent = z.infer<typeof chatEventSchema>;

/* ------------------------------------------------ markers ---------------------------------------- */

export const markerSchema = z.object({
  id: z.string(),
  videoId: z.string(),
  atSec: z.number(),
  label: z.string(),
  createdAt: z.number(),
});
export type Marker = z.infer<typeof markerSchema>;

/* -------------------------------------------- storage keys (CP2) --------------------------------- */

export const keys2 = {
  subtitleEdits: (videoId: string) => `videos/${videoId}/subtitle-edits.json`,
  /** Candidate thumbnail frames of a clip. */
  thumbCandidate: (clipId: string, i: number) => `clips/${clipId}/thumbs/c${i}.jpg`,
} as const;
