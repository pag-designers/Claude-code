import type { PostMediaInfo } from '@shared/publish';

/**
 * What `probe` returns: the contract's `PostMediaInfo` plus facts the validator needs and the schema has no field for.
 * Every extra is optional; `validate` skips a check when its fact is unknown (e.g. after the info went through zod).
 */
export interface ProbedMediaInfo extends PostMediaInfo {
  /** Short container names (`mp4`, `mov`, `webm`, …). */
  container?: string[];
  /** e.g. `yuv420p`, `yuv444p`, `yuv420p10le`. */
  pixFmt?: string | null;
  /** The video is interlaced (field order other than progressive). */
  interlaced?: boolean;
  /** Frame timestamps are irregular (average rate differs from the nominal stream rate). */
  variableFps?: boolean;
  audioSampleRate?: number | null;
  audioChannels?: number | null;
  /** Sample aspect ratio (width of a pixel / height); 1 = square pixels. `width`/`height` are already DISPLAY size. */
  sar?: number;
}

/** Per-call limits that differ from the static spec (TikTok: the creator's own `max_video_post_duration_sec`). */
export interface SpecOverrides {
  maxDurationSec?: number | null;
}
