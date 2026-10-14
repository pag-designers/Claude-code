/**
 * CP3 (editor) module contracts for the MAIN process. Conventions as in contracts.ts (seconds, absolute paths,
 * AbortSignal + onProgress). The lead owns this file: tell the lead instead of editing it.
 *
 * Preview-side contracts (compositor, store) live in renderer/lib/editor/ and are described in the CP3 agent briefs;
 * every visual/audio RULE both sides share lives in shared/editor.ts + shared/editor-eval.ts.
 */
import type { CaptionStyle } from '@shared/cp2';
import type { ExportSettings, Project, Waveform } from '@shared/editor';
import type { CaptionService, CommonOpts } from './contracts';

/** A local media file backing one project asset (resolved by main before compiling). */
export interface EditorAssetFile {
  assetId: string;
  kind: 'video' | 'audio' | 'image' | 'lut';
  path: string;
  width: number | null;
  height: number | null;
  fps: number | null;
  durationSec: number | null;
  hasAudio: boolean;
}

export interface CompileExportArgs {
  project: Project;
  settings: ExportSettings;
  /** assetId → local file (full resolution; for library videos this is the re-downloaded source). */
  files: Record<string, EditorAssetFile>;
  /** Scratch directory the compiler may write ASS files / LUTs / concat lists into. */
  workDir: string;
  outPath: string;
  fontsDir: string | null;
  encoder: 'libx264' | 'h264_nvenc' | 'h264_videotoolbox';
  /** Render only this timeline window (parity tests render a single frame this way). */
  range?: { startSec: number; endSec: number };
  /** Caption preset lookup for subtitle items (`styleId`). */
  getStyle(id: string): CaptionStyle;
  captions: Pick<CaptionService, 'buildAss' | 'buildSrt' | 'buildVtt'>;
}

export interface CompiledExport {
  /** Complete ffmpeg argument list (without the binary), ending with `outPath`. Includes `-progress pipe:1` friendly flags. */
  args: string[];
  /** Timeline seconds actually rendered (range or whole project) — progress denominator. */
  durationSec: number;
  /** Subtitle-track captions as SRT/VTT text when the project has a subtitle track, else null. */
  srt: string | null;
  vtt: string | null;
  /** Human-readable summary of what was compiled (logged; shown on failure). */
  notes: string[];
}

/**
 * Project JSON → FFmpeg. Everything visual/audible follows shared/editor-eval.ts (transitions, speed/reverse/freeze,
 * crop keyframes, colour maths, ducking envelope, fades, text animation…) and must match the preview within the
 * parity tolerance asserted by test/e2e/editor-parity.spec.ts.
 */
export interface ExportCompiler {
  compile(args: CompileExportArgs): Promise<CompiledExport>;
}

export interface EditorMediaService {
  /** ffprobe → asset metadata (kind inferred from streams / extension). */
  probe(
    file: string,
  ): Promise<
    Pick<EditorAssetFile, 'kind' | 'width' | 'height' | 'fps' | 'durationSec' | 'hasAudio'>
  >;
  /** Peak envelope (`rate` windows per second) of the first audio stream. */
  waveform(file: string, rate: number, opts?: CommonOpts): Promise<Waveform>;
  /** Beat times (s) via onset detection + tempo estimate on the audio. */
  beats(file: string, opts?: CommonOpts): Promise<number[]>;
  /** One JPEG sprite sheet (cols × rows) of `count` evenly spaced frames in [startSec, endSec). */
  thumbStrip(
    args: {
      file: string;
      startSec: number;
      endSec: number;
      count: number;
      height: number;
      outJpg: string;
    } & CommonOpts,
  ): Promise<{ tileW: number; tileH: number; cols: number; rows: number; times: number[] }>;
  /** 480p H.264 preview copy of an imported video (faststart) so the preview can seek it smoothly. */
  makePreview(src: string, out: string, opts?: CommonOpts): Promise<void>;
  /** Runs ffmpeg with `args` from the compiler, reporting progress 0..1 from `-progress` output against `durationSec`. */
  runFfmpeg(
    args: { ffmpegPath: string; args: string[]; durationSec: number } & CommonOpts,
  ): Promise<void>;
}
