/**
 * CP4 (Brand Kit) module contracts for the MAIN process. Conventions as in contracts.ts (seconds, absolute paths,
 * AbortSignal + onProgress). The lead owns this file: tell the lead instead of editing it.
 *
 * Data shapes live in shared/brand.ts (kits, assets, watermark geometry, hook style). The editor-side pure functions
 * (`applyBrandToProject`) live in shared/brand-apply.ts.
 */
import type {
  BrandAssetKind,
  BrandFontInfo,
  BrollItem,
  BrollProvider,
  BrollSearchResult,
  HookStyle,
} from '@shared/brand';
import type { CommonOpts } from './contracts';

/* ----------------------------------------------------------------------------- brand media ------ */

/** What processing one uploaded file produced. Paths are inside `outDir`; the caller uploads them and owns cleanup. */
export interface ProcessedBrandAsset {
  width: number | null;
  height: number | null;
  durationSec: number | null;
  hasAudio: boolean;
  fps: number | null;
  /** Integrated loudness (LUFS) of the original audio, null when it has none / could not be measured. */
  loudnessLufs: number | null;
  /** Fonts only: parsed names + the sfnt (TTF/OTF) file libass can read (WOFF/WOFF2 are converted). */
  font: (Omit<BrandFontInfo, 'file'> & { sfntPath: string; sfntExt: 'ttf' | 'otf' }) | null;
  /** SVG → PNG raster, animated GIF → first frame PNG, WOFF → sfnt is `font.sfntPath`. */
  usable: { path: string; ext: string; contentType: string } | null;
  /** Video: 480p H.264 faststart mp4. Audio: loudness-normalised (−14 LUFS, TP ≤ −1) m4a/AAC for auditioning. */
  preview: { path: string; ext: 'mp4' | 'm4a'; contentType: string } | null;
  /** JPEG ≤ 480 px on the long side (logos/images/videos; fonts get a rendered "Aa" specimen; audio null). */
  thumb: { path: string } | null;
}

/** Rasterises an SVG file to a PNG no larger than `maxPx` on its long side (provided by main: an offscreen Electron window). */
export type SvgRasterizer = (
  svgPath: string,
  outPng: string,
  maxPx: number,
) => Promise<{ width: number; height: number }>;

export interface BrandMediaService {
  /**
   * Validates (throws a user-readable `Error` for unreadable / unsupported / corrupt files), probes and derives
   * everything the app needs from one uploaded file of the given section.
   */
  process(
    args: {
      kind: BrandAssetKind;
      file: string;
      ext: string;
      outDir: string;
      /** Stage label + fraction 0..1 within this file (null = indeterminate). Replaces CommonOpts.onProgress. */
      onProgress?: (stage: string, fraction: number | null) => void;
    } & Omit<CommonOpts, 'onProgress'>,
  ): Promise<ProcessedBrandAsset>;
  /** Dominant colours (#RRGGBB, most prominent first, perceptually distinct, transparent pixels ignored). */
  extractColors(imagePath: string, count: number): Promise<string[]>;
}

/**
 * The directory libass reads fonts from. One merged directory = the shipped fonts + every brand font (sfnt files),
 * kept in sync as fonts are added/removed. `captions/fontbook` is told about the same directory so caption layout
 * measures the real glyph advances of uploaded fonts.
 */
export interface FontsHub {
  /** Merged fonts dir (created on first use); null only when there are no shipped fonts and no brand fonts. */
  dir(): string | null;
  /** Registers a brand font file (idempotent per assetId). */
  add(assetId: string, sfntPath: string, sfntExt: 'ttf' | 'otf'): Promise<void>;
  remove(assetId: string): Promise<void>;
  /** Drops brand fonts not in `keep` (startup reconciliation after the DB is read). */
  prune(keep: string[]): Promise<void>;
}

/* ----------------------------------------------------------------------------- brand finisher ---- */

/** A local file of the kit with what the finisher needs to know. */
export interface FinisherMedia {
  path: string;
  hasAudio: boolean;
  durationSec: number;
  /** Pixel size, needed for the watermark aspect and to scale intro/outro. */
  width: number;
  height: number;
}

export interface FinishRequest {
  ffmpegPath: string;
  /** The rendered clip (captions + hook already burned in): H.264 + AAC, loudness-normalised. */
  input: FinisherMedia & { fps: number };
  outPath: string;
  /** Logo, PNG with alpha (SVG already rasterised). Placement = `watermarkRect()` of shared/brand.ts. */
  watermark: {
    media: FinisherMedia;
    position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center';
    sizePct: number;
    opacity: number;
    marginPct: number;
    safeArea: 'none' | 'all' | 'tiktok' | 'reels' | 'shorts';
  } | null;
  /** Intro/outro are scaled/padded (contain, black bars) to the clip's size and fps and joined with hard cuts. */
  intro: FinisherMedia | null;
  outro: FinisherMedia | null;
  /** Music bed under the WHOLE result (looped/trimmed to length), ducked by the speech of the clip (sidechain). */
  music: {
    media: FinisherMedia;
    gainDb: number;
    duckEnabled: boolean;
    duckAmountDb: number;
    fadeInSec: number;
    fadeOutSec: number;
  } | null;
  encoder: 'libx264' | 'h264_nvenc' | 'h264_videotoolbox';
  /** Final loudness target for the joined audio (LUFS); the finisher normalises the intro/outro/music mix to it. */
  loudnessTarget: number;
}

export interface FinishResult {
  durationSec: number;
  /** What was really applied (e.g. an unreadable intro is reported, not silently dropped). */
  applied: { watermark: boolean; intro: boolean; outro: boolean; music: boolean };
  notes: string[];
}

/** One extra FFmpeg pass over a rendered clip: watermark overlay, intro/outro join, ducked music bed. */
export interface BrandFinisher {
  finish(
    req: FinishRequest,
    opts?: Omit<CommonOpts, 'onProgress'> & { onProgress?: (fraction: number) => void },
  ): Promise<FinishResult>;
}

/* ----------------------------------------------------------------------------- stock B-roll ------ */

export interface BrollDownload {
  /** Direct https URL of the chosen rendition (mp4, ≤ 1080p, closest to the target orientation). */
  url: string;
  ext: 'mp4';
  width: number;
  height: number;
  durationSec: number;
  credit: { source: BrollProvider; author: string | null; url: string | null };
}

export interface BrollService {
  /** Which providers have an API key (Settings → API Keys). */
  status(): { pexels: boolean; pixabay: boolean };
  search(
    args: {
      provider: BrollProvider;
      query: string;
      orientation: 'any' | 'portrait' | 'landscape' | 'square';
      page: number;
    } & CommonOpts,
  ): Promise<BrollSearchResult>;
  /** Re-fetches the item from its provider and picks the file to download. Throws a user-readable error. */
  resolveDownload(item: BrollItem, opts?: CommonOpts): Promise<BrollDownload>;
}

/** Hook card style resolved for rendering (kit spec or the built-in default). */
export type ResolvedHookStyle = HookStyle;
