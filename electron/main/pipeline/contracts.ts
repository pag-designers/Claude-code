/**
 * CP1 module contracts. Each module below is implemented by a different engineer; the orchestrator
 * (electron/main/pipeline/orchestrator.ts) only depends on THESE interfaces, never on internals.
 * Keep them stable: if one must change, tell the lead instead of editing this file.
 *
 * Conventions: all times are SECONDS (float); all paths are absolute local paths; every long-running
 * function takes an AbortSignal and reports progress through `onProgress(0..1, message?)`.
 */
import type {
  AudioSignals,
  MomentCandidate,
  PipelineOptions,
  RankedMoment,
  ReframePlan,
  Sentence,
  Transcript,
  UrlInfo,
  VideoAnalysis,
  Word,
} from '@shared/pipeline';

export type OnProgress = (fraction: number | null, message?: string) => void;

export interface CommonOpts {
  signal?: AbortSignal;
  onProgress?: OnProgress;
}

/* ---------------------------------------- media (yt-dlp / ffmpeg) ---------------------------------------- */

export interface MediaInfo {
  durationSec: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  hasAudio: boolean;
  hasVideo: boolean;
  sizeBytes: number | null;
}

export interface IngestService {
  /** `yt-dlp --dump-single-json` (no download). Throws IngestError with a user-facing message. */
  probe(url: string, opts?: { cookiesFromBrowser?: string } & CommonOpts): Promise<UrlInfo>;
  /**
   * Downloads best video <= maxResolution + best audio, merged to MP4 in `outDir`.
   * Progress carries speed/ETA in `message`, e.g. "3.2 MiB/s · 00:41 left".
   * Must be resumable (yt-dlp --continue) and honour `signal` by killing the child process.
   */
  download(
    url: string,
    outDir: string,
    opts: { maxResolution: number; cookiesFromBrowser?: string } & CommonOpts,
  ): Promise<{ filePath: string }>;
}

export interface MediaService {
  probe(file: string): Promise<MediaInfo>;
  /** 16 kHz mono PCM WAV. Optional [startSec, startSec+durSec) window. */
  extractAudio16k(src: string, out: string, opts?: { startSec?: number; durSec?: number } & CommonOpts): Promise<void>;
  /** 480p H.264 proxy, AAC audio, faststart. */
  makeProxy(src: string, out: string, opts?: { height?: number } & CommonOpts): Promise<void>;
  /** One JPEG frame at time t (seconds), scaled to maxWidth. */
  extractFrame(src: string, t: number, out: string, opts?: { maxWidth?: number }): Promise<void>;
}

/* ----------------------------------------- transcript & signals ------------------------------------------- */

export interface AnalysisService {
  /** Groups words into sentences (punctuation + pauses), assigns heuristic speaker labels. */
  segmentSentences(words: Word[], signals?: Pick<AudioSignals, 'silences' | 'speakerChanges'>): Sentence[];
  /**
   * Silence map, loudness envelope (ffmpeg ebur128), speech-rate map, laughter/applause heuristic
   * (loud non-speech bursts), speaker-change heuristic. Scene cuts are filled by the orchestrator.
   */
  computeSignals(args: {
    wavPath: string;
    words: Word[];
    durationSec: number;
    ffmpegPath: string;
  } & CommonOpts): Promise<AudioSignals>;
}

/* --------------------------------------------- LLM layer -------------------------------------------------- */

export interface LlmService {
  /** True when an Anthropic API key is available (stored or .env). */
  isConfigured(): boolean;
  /** Overview, chapters (merged with YouTube chapters when present), notes, topics/entities/keywords. */
  understand(
    input: {
      info: Pick<UrlInfo, 'title' | 'channel' | 'description' | 'chapters'>;
      transcript: Transcript;
    } & CommonOpts,
  ): Promise<VideoAnalysis>;
  /**
   * Ranks/refines candidates inside one transcript window. Returns at most `maxClips` moments with
   * word-aligned boundaries that the caller will re-snap. Must respect options.prompt (user steering)
   * and options duration range. Throws BudgetExceededError when the monthly hard cap is reached.
   */
  rankMoments(
    input: {
      videoId: string;
      info: Pick<UrlInfo, 'title' | 'channel'>;
      analysis: Pick<VideoAnalysis, 'overview' | 'topics'> | null;
      options: PipelineOptions;
      window: { startSec: number; endSec: number };
      sentences: Sentence[];
      candidates: MomentCandidate[];
      maxClips: number;
    } & CommonOpts,
  ): Promise<RankedMoment[]>;
}

/* ------------------------------------------ moment candidates --------------------------------------------- */

export interface MomentService {
  /**
   * Multi-signal candidate generation (BRIEF §4.5): sentence-aligned windows within the duration
   * range, scored by hook strength in the first 3 s, energy, speech-rate change, laughter, questions,
   * numbers, self-containment; never starts/ends mid-word; snapped to word boundaries with
   * 120–250 ms padding and to silences when possible. Pure function.
   */
  generateCandidates(args: {
    transcript: Transcript;
    signals: AudioSignals;
    options: PipelineOptions;
    window: { startSec: number; endSec: number };
    maxCandidates: number;
  }): MomentCandidate[];
  /** Re-snaps an LLM-proposed [start,end] to word boundaries + padding + duration range. */
  snap(args: {
    startSec: number;
    endSec: number;
    transcript: Transcript;
    signals: AudioSignals;
    options: PipelineOptions;
  }): { startSec: number; endSec: number };
}

/* ------------------------------------------- reframe / captions / render ---------------------------------- */

export interface FaceSample {
  t: number;
  /** Normalised 0..1 boxes in source frame. */
  boxes: { x: number; y: number; w: number; h: number; score: number }[];
}

export interface ReframeService {
  /**
   * Builds a smoothed crop path for [startSec,endSec). `faces` come from the sidecar /faces endpoint
   * (sampled at 2–5 fps); `sceneCuts` are absolute seconds. Single-face tracking with EMA/Kalman
   * smoothing, scene-cut aware (no smoothing across a cut), static centre crop fallback.
   */
  plan(args: {
    startSec: number;
    endSec: number;
    srcW: number;
    srcH: number;
    aspect: PipelineOptions['aspect'];
    faces: FaceSample[];
    sceneCuts: number[];
  }): ReframePlan;
}

export interface CaptionService {
  /** Clean Pop ASS (word-level, active word emphasised, 1–3 words per line, emoji-safe). */
  buildAss(args: {
    words: Word[];
    startSec: number;
    endSec: number;
    width: number;
    height: number;
    styleId: string;
    /** LLM-chosen emphasis words. */
    keywords?: string[];
    maskProfanity?: boolean;
  }): string;
  buildSrt(words: Word[], startSec: number, endSec: number): string;
  buildVtt(words: Word[], startSec: number, endSec: number): string;
}

export interface RenderRequest {
  ffmpegPath: string;
  sourcePath: string;
  outPath: string;
  startSec: number;
  endSec: number;
  plan: ReframePlan;
  /** Path to a .ass file to burn in, or null for no captions. */
  assPath: string | null;
  /** Directory containing fonts for libass (fontsdir). */
  fontsDir: string | null;
  hook: { text: string; durationSec: number } | null;
  /** -14 LUFS by default. */
  loudnessTarget: number;
  /** 'auto' picks NVENC / VideoToolbox / libx264 by availability. */
  encoder: 'auto' | 'libx264' | 'h264_nvenc' | 'h264_videotoolbox';
  fps: number | null;
}

export interface RenderService {
  render(req: RenderRequest & CommonOpts): Promise<{ encoder: string; durationSec: number }>;
  /** Picks the best available H.264 encoder (verifies by encoding 1 frame, not by listing). */
  detectEncoder(ffmpegPath: string): Promise<'libx264' | 'h264_nvenc' | 'h264_videotoolbox'>;
}

export class IngestError extends Error {
  constructor(
    message: string,
    public readonly kind: 'private' | 'age-restricted' | 'bot-check' | 'unavailable' | 'live' | 'network' | 'other' = 'other',
  ) {
    super(message);
    this.name = 'IngestError';
  }
}

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}
