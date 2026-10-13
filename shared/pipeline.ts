import { z } from 'zod';
import { reframeModeSchema } from './cp2';

/* ------------------------------------------------------------------------------------------------
 * CP1 pipeline domain types (BRIEF §4). Shared by main, preload and renderer.
 * Storage layout (R2/B2 keys):
 *   videos/<videoId>/proxy.mp4          480p proxy (kept; the full-res source is NOT kept by default)
 *   videos/<videoId>/transcript.json    Transcript
 *   videos/<videoId>/analysis.json      VideoAnalysis
 *   videos/<videoId>/signals.json       AudioSignals
 *   clips/<clipId>/clip.mp4             rendered 1080x1920 clip
 *   clips/<clipId>/thumb.jpg            thumbnail
 *   clips/<clipId>/captions.{ass,srt,vtt}
 * ---------------------------------------------------------------------------------------------- */

export const PIPELINE_STAGES = [
  'ingest',
  'prepare',
  'transcribe',
  'understand',
  'moments',
  'render',
  'finalize',
] as const;
export const pipelineStageSchema = z.enum(PIPELINE_STAGES);
export type PipelineStage = z.infer<typeof pipelineStageSchema>;

export const STAGE_LABELS: Record<PipelineStage, string> = {
  ingest: 'Download',
  prepare: 'Prepare media',
  transcribe: 'Transcribe',
  understand: 'Understand',
  moments: 'Find moments',
  render: 'Render clips',
  finalize: 'Upload & clean up',
};

export const stageStatusSchema = z.enum([
  'pending',
  'running',
  'done',
  'failed',
  'skipped',
  'canceled',
]);
export type StageStatus = z.infer<typeof stageStatusSchema>;

export const stageStateSchema = z.object({
  stage: pipelineStageSchema,
  status: stageStatusSchema,
  /** 0..1 or null when indeterminate */
  progress: z.number().nullable(),
  message: z.string().nullable(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  error: z.string().nullable(),
  /** Free-form ETA/speed text, e.g. "3.2 MB/s · 00:41 left". */
  detail: z.string().nullable(),
});
export type StageState = z.infer<typeof stageStateSchema>;

export const clipPresetSchema = z.enum(['15-30', '30-60', '60-90', 'custom']);
export const aspectSchema = z.enum(['9:16', '1:1', '4:5', '16:9']);

export const pipelineOptionsSchema = z.object({
  clipPreset: clipPresetSchema.default('30-60'),
  /** Used when clipPreset === 'custom'; otherwise derived from the preset. */
  minSec: z.number().min(5).max(180).optional(),
  maxSec: z.number().min(5).max(300).optional(),
  /** Number of clips wanted. `null` = every moment at or above `minScore`. */
  clipCount: z.number().int().min(1).max(50).nullable().default(10),
  minScore: z.number().min(0).max(100).default(60),
  aspect: aspectSchema.default('9:16'),
  /** Free-text steering, e.g. "only funny moments" (BRIEF §4.5). */
  prompt: z.string().max(500).default(''),
  captions: z.boolean().default(true),
  hookCard: z.boolean().default(true),
  /** 'analysis' = summary/transcript/chapters only: no moment finding, no rendering (Tools hub). */
  mode: z.enum(['clips', 'analysis']).default('clips'),
  /** Caption preset (built-in id or a saved custom preset) for the clips of this run. */
  captionStyleId: z.string().default('clean-pop'),
  reframeMode: reframeModeSchema.default('auto'),
  /** Spoken language override; null = auto-detect. */
  language: z.string().nullable().default(null),
  maxResolution: z
    .union([z.literal(720), z.literal(1080), z.literal(1440), z.literal(2160)])
    .default(1080),
});
/**
 * Patch form: every field optional WITHOUT its default (zod's `.partial()` would re-apply defaults to
 * omitted keys, silently overriding the user's saved defaults when a caller sends only one option).
 */
export const pipelineOptionsPatchSchema = z
  .object(
    Object.fromEntries(
      Object.entries(pipelineOptionsSchema.shape).map(([k, f]) => [
        k,
        f instanceof z.ZodDefault ? f.removeDefault().optional() : (f as z.ZodType).optional(),
      ]),
    ),
  )
  .strict() as unknown as z.ZodType<Partial<z.output<typeof pipelineOptionsSchema>>>;
export type PipelineOptions = z.output<typeof pipelineOptionsSchema>;
export type PipelineOptionsInput = z.input<typeof pipelineOptionsSchema>;

export function durationRange(o: Pick<PipelineOptions, 'clipPreset' | 'minSec' | 'maxSec'>): {
  minSec: number;
  maxSec: number;
} {
  switch (o.clipPreset) {
    case '15-30':
      return { minSec: 15, maxSec: 30 };
    case '30-60':
      return { minSec: 30, maxSec: 60 };
    case '60-90':
      return { minSec: 60, maxSec: 90 };
    default: {
      const minSec = o.minSec ?? 20;
      const maxSec = Math.max(o.maxSec ?? 60, minSec + 5);
      return { minSec, maxSec };
    }
  }
}

/* ---------------------------------- transcript & audio signals --------------------------------- */

export const wordSchema = z.object({
  w: z.string(),
  s: z.number(),
  e: z.number(),
  /** ASR probability 0..1 */
  p: z.number().optional(),
});
export type Word = z.infer<typeof wordSchema>;

export const sentenceSchema = z.object({
  id: z.number().int(),
  s: z.number(),
  e: z.number(),
  text: z.string(),
  speaker: z.string().nullable(),
  /** Inclusive index range into `Transcript.words`. */
  wordStart: z.number().int(),
  wordEnd: z.number().int(),
});
export type Sentence = z.infer<typeof sentenceSchema>;

export const transcriptSchema = z.object({
  language: z.string(),
  languageProbability: z.number(),
  durationSec: z.number(),
  model: z.string(),
  words: z.array(wordSchema),
  sentences: z.array(sentenceSchema),
});
export type Transcript = z.infer<typeof transcriptSchema>;

export const audioSignalsSchema = z.object({
  /** Seconds per sample of the arrays below. */
  hopSec: z.number(),
  durationSec: z.number(),
  /** Short-term loudness in LUFS (or dBFS RMS if LUFS is unavailable), one value per hop. */
  loudness: z.array(z.number()),
  /** Words per second in a sliding window, one value per hop. */
  speechRate: z.array(z.number()),
  silences: z.array(z.object({ s: z.number(), e: z.number() })),
  /** Loud non-speech bursts (laughter/applause heuristic). `score` 0..1. */
  laughter: z.array(z.object({ s: z.number(), e: z.number(), score: z.number() })),
  /** Times (s) at which the speaker probably changes (pause + pitch/energy shift heuristic). */
  speakerChanges: z.array(z.number()),
  sceneCuts: z.array(z.number()).default([]),
});
export type AudioSignals = z.infer<typeof audioSignalsSchema>;

/* ------------------------------------------- analysis ------------------------------------------- */

export const chapterSchema = z.object({
  title: z.string(),
  start: z.number(),
  end: z.number(),
  summary: z.string(),
  /** 'youtube' when taken from the uploader's chapters. */
  source: z.enum(['youtube', 'ai']).default('ai'),
});
export type Chapter = z.infer<typeof chapterSchema>;

export const videoAnalysisSchema = z.object({
  overview: z.object({
    summary: z.string(),
    tone: z.string(),
    participants: z.array(z.string()),
    takeaways: z.array(z.string()),
  }),
  chapters: z.array(chapterSchema),
  notes: z.object({
    keyPoints: z.array(z.string()),
    quotes: z.array(z.object({ text: z.string(), at: z.number() })),
    numbers: z.array(z.object({ text: z.string(), at: z.number() })),
    claims: z.array(z.object({ text: z.string(), at: z.number() })),
    actionItems: z.array(z.string()),
  }),
  topics: z.array(z.string()),
  entities: z.array(z.string()),
  keywords: z.array(z.string()),
});
export type VideoAnalysis = z.infer<typeof videoAnalysisSchema>;

/* -------------------------------------------- moments ------------------------------------------- */

export const scoreBreakdownSchema = z.object({
  /** 0..25 */
  hook: z.number().min(0).max(25),
  /** 0..25 */
  retention: z.number().min(0).max(25),
  /** 0..20 */
  emotion: z.number().min(0).max(20),
  /** 0..15 */
  clarity: z.number().min(0).max(15),
  /** 0..15 */
  shareability: z.number().min(0).max(15),
});
export type ScoreBreakdown = z.infer<typeof scoreBreakdownSchema>;

export function totalScore(b: ScoreBreakdown): number {
  return Math.round(b.hook + b.retention + b.emotion + b.clarity + b.shareability);
}

export const momentCandidateSchema = z.object({
  id: z.string(),
  /** Word-aligned start/end in seconds (already snapped, padded 120–250 ms). */
  s: z.number(),
  e: z.number(),
  /** Pre-LLM heuristic score 0..1 (never shown to the user as a virality score). */
  prior: z.number(),
  /** Sentence ids covered. */
  sentenceIds: z.array(z.number().int()),
  text: z.string(),
  signals: z.object({
    hookStrength: z.number(),
    energy: z.number(),
    speechRateChange: z.number(),
    laughter: z.number(),
    hasQuestion: z.boolean(),
    hasNumber: z.boolean(),
    selfContained: z.number(),
  }),
});
export type MomentCandidate = z.infer<typeof momentCandidateSchema>;

export const rankedMomentSchema = z.object({
  candidateId: z.string().nullable(),
  startSec: z.number(),
  endSec: z.number(),
  title: z.string(),
  hook: z.string(),
  whyItWorks: z.string(),
  captionStyle: z.string().default('clean-pop'),
  breakdown: scoreBreakdownSchema,
  /** 0..1 */
  confidence: z.number().min(0).max(1),
  keywords: z.array(z.string()).default([]),
});
export type RankedMoment = z.infer<typeof rankedMomentSchema>;

/* ---------------------------------------- reframe / render -------------------------------------- */

export const cropKeyframeSchema = z.object({
  /** Seconds relative to the clip start. */
  t: z.number(),
  /** Top-left of the crop window in SOURCE pixels. */
  x: z.number(),
  y: z.number(),
  /** Crop window size in SOURCE pixels (constant per plan unless zoom is used). */
  w: z.number(),
  h: z.number(),
});
export type CropKeyframe = z.infer<typeof cropKeyframeSchema>;

export const reframePanelSchema = z.object({
  /** Where the panel sits in the OUTPUT frame (px). */
  out: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
  /** Source-pixel crop path feeding this panel (aspect = out.w/out.h). */
  keyframes: z.array(cropKeyframeSchema),
  role: z.enum(['face-a', 'face-b', 'screen', 'face']),
});
export type ReframePanel = z.infer<typeof reframePanelSchema>;

export const reframePlanSchema = z.object({
  mode: z.enum(['single-face', 'center', 'multi-face', 'screen-face']),
  aspect: aspectSchema,
  srcW: z.number(),
  srcH: z.number(),
  outW: z.number(),
  outH: z.number(),
  /** Single-panel crop path (layout 'single'). For multi-panel layouts this is the primary face track. */
  keyframes: z.array(cropKeyframeSchema),
  /** Scene cuts (clip-relative seconds) where the crop is allowed to jump. */
  cuts: z.array(z.number()),
  /** Fraction of sampled frames with a detected face (diagnostics). */
  faceCoverage: z.number(),
  /** 'single' = one crop filling the frame; 'split' = two stacked face panels; 'screen-face' = screen on top, face below. */
  layout: z.enum(['single', 'split', 'screen-face']).optional(),
  /** Present for 'split' and 'screen-face' layouts: panels top→bottom. */
  panels: z.array(reframePanelSchema).optional(),
});
export type ReframePlan = z.infer<typeof reframePlanSchema>;

/* ---------------------------------------------- views ------------------------------------------- */

export const videoStatusSchema = z.enum([
  'new',
  'ingesting',
  'processing',
  'ready',
  'failed',
  'canceled',
]);
export type VideoStatus = z.infer<typeof videoStatusSchema>;

export const videoViewSchema = z.object({
  id: z.string(),
  sourceUrl: z.string(),
  sourceId: z.string().nullable(),
  title: z.string(),
  channel: z.string().nullable(),
  durationSec: z.number().nullable(),
  /** Remote thumbnail URL (YouTube CDN) — safe to show in <img>. */
  thumbnail: z.string().nullable(),
  status: videoStatusSchema,
  stage: pipelineStageSchema.nullable(),
  progress: z.number().nullable(),
  error: z.string().nullable(),
  favorite: z.boolean(),
  clipCount: z.number(),
  renderedCount: z.number(),
  topScore: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** Whether a 480p proxy exists in storage (enables in-app playback of the source). */
  hasProxy: z.boolean(),
  options: pipelineOptionsSchema,
  /** Bumped whenever subtitle edits are saved; clips older than this show "captions outdated". */
  subtitleRev: z.number(),
});
export type VideoView = z.infer<typeof videoViewSchema>;

export const clipStatusSchema = z.enum(['candidate', 'queued', 'rendering', 'rendered', 'failed']);
export type ClipStatus = z.infer<typeof clipStatusSchema>;

export const clipViewSchema = z.object({
  id: z.string(),
  videoId: z.string(),
  videoTitle: z.string().nullable(),
  title: z.string(),
  hook: z.string().nullable(),
  startSec: z.number(),
  endSec: z.number(),
  durationSec: z.number(),
  score: z.number().nullable(),
  breakdown: scoreBreakdownSchema.nullable(),
  confidence: z.number().nullable(),
  whyItWorks: z.string().nullable(),
  status: clipStatusSchema,
  renderProgress: z.number().nullable(),
  error: z.string().nullable(),
  favorite: z.boolean(),
  tags: z.array(z.string()),
  /** Aspect of the rendered file. */
  aspect: aspectSchema,
  hasRender: z.boolean(),
  hasThumb: z.boolean(),
  rank: z.number().nullable(),
  createdAt: z.number(),
  /** 'highlight' = One-Click Highlights reel (several segments stitched). */
  kind: z.enum(['clip', 'highlight']),
  /** Moment run that found it (steered re-runs); null for the initial automatic run. */
  runId: z.string().nullable(),
  runPrompt: z.string().nullable(),
  captionStyleId: z.string(),
  reframeMode: z.enum(['auto', 'single-face', 'multi-face', 'screen-face', 'center']),
  /** Layout actually used by the last render. */
  layout: z.enum(['single', 'split', 'screen-face']).nullable(),
  /** The hook text currently burned in (null = no title card). */
  hookApplied: z.string().nullable(),
  hasHooks: z.boolean(),
  hasMeta: z.boolean(),
  hasThumbOptions: z.boolean(),
  /** Subtitle revision the render was built from. */
  subtitleRev: z.number(),
});
export type ClipView = z.infer<typeof clipViewSchema>;

export const pipelineEventSchema = z.object({
  videoId: z.string(),
  stage: pipelineStageSchema,
  status: stageStatusSchema,
  progress: z.number().nullable(),
  message: z.string().nullable(),
  detail: z.string().nullable(),
  at: z.number(),
});
export type PipelineEvent = z.infer<typeof pipelineEventSchema>;

export const urlInfoSchema = z.object({
  id: z.string(),
  title: z.string(),
  channel: z.string().nullable(),
  durationSec: z.number().nullable(),
  thumbnail: z.string().nullable(),
  description: z.string().nullable(),
  isLive: z.boolean(),
  chapters: z.array(z.object({ title: z.string(), start: z.number(), end: z.number() })),
  uploadDate: z.string().nullable(),
  /** e.g. "Standard YouTube License" / "Creative Commons Attribution license (reuse allowed)" */
  license: z.string().nullable(),
});
export type UrlInfo = z.infer<typeof urlInfoSchema>;

/** Storage keys (single place so every module agrees). */
export const keys = {
  proxy: (videoId: string) => `videos/${videoId}/proxy.mp4`,
  source: (videoId: string) => `videos/${videoId}/source.mp4`,
  transcript: (videoId: string) => `videos/${videoId}/transcript.json`,
  analysis: (videoId: string) => `videos/${videoId}/analysis.json`,
  signals: (videoId: string) => `videos/${videoId}/signals.json`,
  clip: (clipId: string) => `clips/${clipId}/clip.mp4`,
  thumb: (clipId: string) => `clips/${clipId}/thumb.jpg`,
  ass: (clipId: string) => `clips/${clipId}/captions.ass`,
  srt: (clipId: string) => `clips/${clipId}/captions.srt`,
  vtt: (clipId: string) => `clips/${clipId}/captions.vtt`,
} as const;

/** Parses a YouTube URL; returns the video id or null. */
export function parseYouTubeId(input: string): string | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\.|^m\./, '');
  if (host === 'youtu.be')
    return /^[\w-]{11}$/.test(u.pathname.slice(1)) ? u.pathname.slice(1) : null;
  if (host === 'youtube.com' || host === 'music.youtube.com') {
    const v = u.searchParams.get('v');
    if (v && /^[\w-]{11}$/.test(v)) return v;
    const m = /^\/(?:shorts|live|embed)\/([\w-]{11})/.exec(u.pathname);
    if (m?.[1]) return m[1];
  }
  return null;
}
