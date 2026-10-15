/**
 * CP2 module contracts (see contracts.ts for the CP1 ones and the conventions: seconds, absolute paths,
 * AbortSignal + onProgress on long calls). Implemented by different engineers; the orchestrator only
 * depends on THESE interfaces. Tell the lead instead of editing this file.
 */
import type { ClipHooks, ClipMeta, Cue, HighlightPlan, Platform, SubtitleEdits } from '@shared/cp2';
import type {
  PipelineOptions,
  Sentence,
  Transcript,
  UrlInfo,
  VideoAnalysis,
  Word,
} from '@shared/pipeline';
import type { CommonOpts } from './contracts';

/* --------------------------------------------- subtitles ---------------------------------------------- */

export interface SubtitleService {
  /**
   * Words as they should appear in captions after `edits`: text replaced, times shifted, hidden words
   * dropped. Each returned word keeps `origIndex` (its index in the ASR transcript).
   */
  applyEdits(words: Word[], edits: SubtitleEdits): (Word & { origIndex: number })[];
  /** Phrase-level cues (≤ ~42 chars, ≤ ~6 s, break on punctuation/pauses) honouring edits.breaks/merges. */
  cues(words: Word[], edits: SubtitleEdits): Cue[];
  /** User typed new text for a cue: maps it back to word-level edits (diff-based, timings interpolated). */
  editCueText(words: Word[], edits: SubtitleEdits, cueId: number, text: string): SubtitleEdits;
  splitCue(words: Word[], edits: SubtitleEdits, cueId: number, atWordIndex: number): SubtitleEdits;
  mergeWithNext(words: Word[], edits: SubtitleEdits, cueId: number): SubtitleEdits;
  /** Move a whole cue by `deltaSec` (retime). */
  shiftCue(words: Word[], edits: SubtitleEdits, cueId: number, deltaSec: number): SubtitleEdits;
  toSrt(cues: Cue[], range?: { startSec: number; endSec: number }): string;
  toVtt(cues: Cue[], range?: { startSec: number; endSec: number }): string;
}

/* -------------------------------------------- thumbnails ---------------------------------------------- */

export interface FrameScore {
  sharpness: number;
  brightness: number;
  faces: { x: number; y: number; w: number; h: number; score: number }[];
}

/** Scores image files (implemented through the sidecar's /frames/score). */
export type FrameScorer = (files: string[], signal?: AbortSignal) => Promise<FrameScore[]>;

export interface ThumbnailService {
  /**
   * Extracts `count` candidate frames from a RENDERED clip (evenly spread, skipping the hook-card
   * window, nudged toward moments with speech) as JPEGs in `outDir`.
   */
  sample(
    args: {
      ffmpegPath: string;
      clipPath: string;
      durationSec: number;
      hookSeconds: number;
      count: number;
      outDir: string;
    } & CommonOpts,
  ): Promise<{ t: number; file: string }[]>;
  /** Sharpness + face presence/size/centring + composition → 0..1 scores and a total. */
  score(
    frames: { t: number; file: string }[],
    scorer: FrameScorer,
    signal?: AbortSignal,
  ): Promise<
    {
      t: number;
      file: string;
      sharpness: number;
      face: number;
      composition: number;
      total: number;
    }[]
  >;
  /** Draws bold overlay text (brand text style; shipped font) on a frame → final thumbnail JPEG. */
  compose(
    args: {
      ffmpegPath: string;
      framePath: string;
      overlayText: string | null;
      fontsDir: string | null;
      outJpg: string;
      maxWidth?: number;
    } & CommonOpts,
  ): Promise<void>;
}

/* ---------------------------------------------- LLM (CP2) --------------------------------------------- */

export interface ClipContext {
  title: string;
  hook: string | null;
  startSec: number;
  endSec: number;
  /** Spoken text of the clip (sentences joined). */
  text: string;
  whyItWorks: string | null;
  score: number | null;
}

export interface HighlightCandidate extends ClipContext {
  id: string;
  /** Sentences of the clip with absolute times — the model picks sub-spans from these. */
  sentences: Sentence[];
}

export interface ChatToolResult {
  ok: boolean;
  /** Short human-readable outcome (shown on the action card and fed back to the model). */
  summary: string;
  href?: string | null;
}

export interface ChatRunInput {
  info: Pick<UrlInfo, 'title' | 'channel' | 'description'>;
  analysis: VideoAnalysis | null;
  transcript: Transcript;
  /** Present when the drawer was opened on a clip. */
  clip: (ClipContext & { id: string }) | null;
  history: { role: 'user' | 'assistant'; text: string }[];
  userText: string;
  /**
   * Executes a tool the model asked for. The implementation is non-destructive (creates clips as
   * candidates, adds markers, writes metadata, proposes hooks, starts a steered moment run).
   */
  executeTool(
    name: 'create_clip' | 'add_marker' | 'write_metadata' | 'rewrite_hook' | 'find_moments',
    input: Record<string, unknown>,
  ): Promise<ChatToolResult>;
  onDelta(text: string): void;
  onCitation(c: { t: number; label: string }): void;
  onAction(a: {
    id: string;
    tool: string;
    input: Record<string, unknown>;
    status: 'running' | 'done' | 'failed';
    summary: string | null;
    href: string | null;
  }): void;
  signal?: AbortSignal;
}

export interface ChatRunResult {
  text: string;
  citations: { t: number; label: string }[];
}

export interface LlmServiceV2 {
  /**
   * One-Click Highlights: choose 3–5 micro-moments (8–25 s each, from `candidates`' sentences) and the
   * narrative ORDER (hook first, payoff last), a transition style, a title and a hook line. Total
   * duration within [minSec,maxSec].
   */
  composeHighlights(
    input: {
      info: Pick<UrlInfo, 'title' | 'channel'>;
      analysis: Pick<VideoAnalysis, 'overview' | 'topics'> | null;
      candidates: HighlightCandidate[];
      prompt: string;
      minSec: number;
      maxSec: number;
    } & CommonOpts,
  ): Promise<HighlightPlan>;
  /** 5 hook variants per platform (text overlay ≤ 10 words + optional spoken line), true to the clip. */
  writeHooks(
    input: { info: Pick<UrlInfo, 'title' | 'channel'>; clip: ClipContext } & CommonOpts,
  ): Promise<Omit<ClipHooks, 'applied' | 'generatedAt'>>;
  /** Per platform: title, description, hashtags, best posting time (+ why). Cheap model. */
  writeMeta(
    input: {
      info: Pick<UrlInfo, 'title' | 'channel'>;
      clip: ClipContext;
      /** Currently applied hook, for consistent copy. */
      hook: string | null;
    } & CommonOpts,
  ): Promise<Omit<ClipMeta, 'generatedAt'>>;
  /** 3-5 stock-footage search queries for a transcript passage (fast model). */
  suggestBroll(input: { text: string } & CommonOpts): Promise<string[]>;
  /** Vision: rank candidate thumbnail frames (images) and suggest ≤ 5-word overlay text. */
  rankThumbnails(
    input: {
      clip: ClipContext;
      frames: { index: number; file: string }[];
    } & CommonOpts,
  ): Promise<{ ranking: { index: number; rank: number; note: string }[]; overlayText: string }>;
  /** Context-aware chat with executable actions; streams through the on* callbacks. */
  chat(input: ChatRunInput): Promise<ChatRunResult>;
}

export type { Platform, PipelineOptions, Transcript };
