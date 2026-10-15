import type { Platform } from './cp2';

/* ------------------------------------------------------------------------------------------------
 * Published video limits of the three posting platforms (CP5). PURE DATA + tiny pure helpers; used by the media
 * validator/fixer in main (electron/main/services/publish-media) and by the UI (`SPEC_SUMMARY`).
 *
 * Every number records where it came from in `sources`, with the date it was last checked against the official page
 * (2026-10-15). Pages were read through a page-to-text summariser; when you change a number, re-read the page itself.
 * Where a platform publishes NO limit (e.g. TikTok minimum duration, YouTube file bitrate) the field is `null` and the
 * validator does not invent one.
 *
 * ffprobe names are used for codecs (`h264`, `hevc`, `aac`) and short names for containers (`mp4`, `mov`, `webm`).
 * Sizes are DECIMAL bytes (1 MB = 1,000,000): the platforms do not say which "MB" they mean, so the smaller one is used.
 * ---------------------------------------------------------------------------------------------- */

export type SpecKey =
  | 'duration'
  | 'size'
  | 'container'
  | 'videoCodec'
  | 'audioCodec'
  | 'fps'
  | 'aspect'
  | 'resolution'
  | 'bitrate';

export interface SpecSource {
  url: string;
  /** ISO date the number was last compared with the page. */
  checkedOn: string;
  /** What the page says (short quote / paraphrase). */
  note: string;
}

export interface PlatformSpec {
  platform: Platform;
  label: string;
  /** The page a person should read for the full rules. */
  docsUrl: string;
  /** ISO date this record was last verified. */
  checkedOn: string;
  /** Seconds. `null` = the platform publishes no such bound. */
  durationSec: { min: number | null; max: number | null };
  maxSizeBytes: number | null;
  /** Accepted containers (short names), null = any. */
  containers: readonly string[] | null;
  /** Accepted video codecs (ffprobe names), null = any. */
  videoCodecs: readonly string[] | null;
  /** Accepted audio codecs (ffprobe names), null = any. */
  audioCodecs: readonly string[] | null;
  fps: { min: number | null; max: number | null };
  aspect: {
    /** The shape the platform recommends (width / height). */
    recommended: number;
    /** Relative tolerance around `recommended` that still counts as "recommended" (0.03 = 3 %). */
    tolerance: number;
    /** Hard bounds on width / height; a clip outside is rejected / not treated as the product (Short). */
    min: number | null;
    max: number | null;
  };
  resolution: {
    maxWidth: number | null;
    maxHeight: number | null;
    minWidth: number | null;
    minHeight: number | null;
  };
  /** Max AVERAGE video bitrate in bit/s. */
  maxVideoBitrateBps: number | null;
  /** AAC sample rate ceiling (Hz) and channel ceiling. */
  maxAudioSampleRate: number | null;
  maxAudioChannels: number | null;
  /** 4:2:0 chroma subsampling and progressive scan are required. */
  requires420Progressive: boolean;
  sources: Partial<Record<SpecKey, SpecSource>>;
}

const CHECKED = '2026-10-15';
const IG_REF =
  'https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media';
const TT_MEDIA = 'https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide';
const TT_CREATOR =
  'https://developers.tiktok.com/doc/content-posting-api-reference-query-creator-info';
const YT_SHORTS = 'https://support.google.com/youtube/answer/10059070';
const YT_ENCODE = 'https://support.google.com/youtube/answer/1722171';
const YT_INSERT = 'https://developers.google.com/youtube/v3/docs/videos/insert';

const src = (url: string, note: string): SpecSource => ({ url, checkedOn: CHECKED, note });

export const PLATFORM_SPECS: Record<Platform, PlatformSpec> = {
  shorts: {
    platform: 'shorts',
    label: 'YouTube Shorts',
    docsUrl: YT_SHORTS,
    checkedOn: CHECKED,
    // Shorts "can be up to 3 minutes" (YouTube Help, Shorts; raised from 60 s on 2024-10-15). No minimum is published.
    durationSec: { min: null, max: 180 },
    // videos.insert: maximum file size 256 GB (YouTube Data API reference).
    maxSizeBytes: 256 * 1024 ** 3,
    // videos.insert accepts `video/*`; YouTube's recommended upload format is MP4 with the moov atom first. Any container
    // is accepted by the API, so none is enforced (the fixer still writes MP4).
    containers: null,
    videoCodecs: null,
    audioCodecs: null,
    fps: { min: null, max: null },
    // A Short must be vertical or square: width/height <= 1 (YouTube Help: vertical videos; 1:1 is accepted by the app).
    // Wider clips upload as ordinary videos, NOT Shorts.
    aspect: { recommended: 9 / 16, tolerance: 0.03, min: null, max: 1.0 },
    resolution: { maxWidth: null, maxHeight: null, minWidth: null, minHeight: null },
    maxVideoBitrateBps: null,
    maxAudioSampleRate: null,
    maxAudioChannels: null,
    requires420Progressive: false,
    sources: {
      duration: src(
        YT_SHORTS,
        '"Shorts can be up to 3 minutes long"; no minimum length is published',
      ),
      size: src(YT_INSERT, 'videos.insert: maximum file size 256GB'),
      container: src(
        YT_INSERT,
        'videos.insert accepts video/* and application/octet-stream; MP4 + faststart recommended (YT_ENCODE)',
      ),
      videoCodec: src(
        YT_ENCODE,
        'H.264 High Profile, progressive, 4:2:0 recommended; other codecs are transcoded by YouTube',
      ),
      audioCodec: src(YT_ENCODE, 'AAC-LC recommended, 48 kHz; not enforced'),
      fps: src(YT_ENCODE, 'upload at the recorded frame rate; no limit published'),
      aspect: src(
        YT_SHORTS,
        'Shorts are vertical (square also accepted by the app); wider videos are regular videos. 9:16 is the usual target',
      ),
      resolution: src(YT_ENCODE, 'no maximum published for upload'),
    },
  },
  reels: {
    platform: 'reels',
    label: 'Instagram Reels',
    docsUrl: IG_REF,
    checkedOn: CHECKED,
    durationSec: { min: 3, max: 15 * 60 },
    maxSizeBytes: 300 * 1000 * 1000,
    containers: ['mp4', 'mov'],
    videoCodecs: ['h264', 'hevc'],
    audioCodecs: ['aac'],
    fps: { min: 23, max: 60 },
    aspect: { recommended: 9 / 16, tolerance: 0.03, min: 0.01, max: 10 },
    resolution: { maxWidth: 1920, maxHeight: null, minWidth: null, minHeight: null },
    maxVideoBitrateBps: 25_000_000,
    maxAudioSampleRate: 48_000,
    maxAudioChannels: 2,
    requires420Progressive: true,
    sources: {
      duration: src(IG_REF, 'Reels specifications: "Duration: 15 mins maximum, 3 seconds minimum"'),
      size: src(IG_REF, '"File size: 300MB maximum"'),
      container: src(
        IG_REF,
        '"Container: MOV or MP4 (MPEG-4 Part 14), no edit lists, moov atom at the front of the file"',
      ),
      videoCodec: src(
        IG_REF,
        '"Video codec: HEVC or H264, progressive scan, closed GOP, 4:2:0 chroma subsampling"',
      ),
      audioCodec: src(
        IG_REF,
        '"Audio codec: AAC, 48khz sample rate maximum, 1 or 2 channels"; "Audio bitrate: 128kbps"',
      ),
      fps: src(IG_REF, '"Frame rate: 23-60 FPS"'),
      aspect: src(
        IG_REF,
        '"Required aspect ratio is between 0.01:1 and 10:1 but we recommend 9:16 to avoid cropping or blank space"',
      ),
      resolution: src(IG_REF, '"Maximum columns (horizontal pixels): 1920"; no minimum published'),
      bitrate: src(IG_REF, '"Video bitrate: VBR, 25Mbps maximum"'),
    },
  },
  tiktok: {
    platform: 'tiktok',
    label: 'TikTok',
    docsUrl: TT_MEDIA,
    checkedOn: CHECKED,
    // 10 minutes is the ceiling of the initialize-upload endpoint; each creator has their own (often lower) limit, returned
    // by creator_info/query as `max_video_post_duration_sec` (the docs' example shows 300). Callers pass that as an override.
    // No minimum is published.
    durationSec: { min: null, max: 600 },
    maxSizeBytes: 4 * 1000 * 1000 * 1000,
    containers: ['mp4', 'mov', 'webm'],
    videoCodecs: ['h264', 'hevc', 'vp8', 'vp9'],
    audioCodecs: null,
    fps: { min: 23, max: 60 },
    // No aspect limit is published; 9:16 is what the app shows full-screen.
    aspect: { recommended: 9 / 16, tolerance: 0.03, min: null, max: null },
    resolution: { maxWidth: 4096, maxHeight: 4096, minWidth: 360, minHeight: 360 },
    maxVideoBitrateBps: null,
    maxAudioSampleRate: null,
    maxAudioChannels: null,
    requires420Progressive: false,
    sources: {
      duration: src(
        TT_MEDIA,
        '10 minutes through the initialize endpoint; per-creator `max_video_post_duration_sec` (' +
          TT_CREATOR +
          ')',
      ),
      size: src(TT_MEDIA, '"Maximum of 4GB"'),
      container: src(TT_MEDIA, 'Formats: MP4 (recommended), WebM, MOV'),
      videoCodec: src(TT_MEDIA, 'Codecs: H.264 (recommended), H.265, VP8, VP9'),
      fps: src(TT_MEDIA, '"Minimum of 23 FPS", "Maximum of 60 FPS"'),
      aspect: src(TT_MEDIA, 'no aspect rule published'),
      resolution: src(TT_MEDIA, 'height and width each at least 360 and at most 4096 pixels'),
    },
  },
};

/** Container short names for ffprobe's `format_name` (e.g. "mov,mp4,m4a,3gp,3g2,mj2" → mp4 and mov). */
export function containersOf(formatName: string | null | undefined, fileExt?: string): string[] {
  const names = (formatName ?? '').toLowerCase().split(',');
  const out = new Set<string>();
  const ext = (fileExt ?? '').toLowerCase().replace(/^\./, '');
  if (names.includes('mov') || names.includes('mp4')) {
    // ffprobe cannot tell mp4 from mov; the file extension decides (m4v/mp4 → mp4, mov/qt → mov); unknown → both
    if (ext === 'mov' || ext === 'qt') out.add('mov');
    else if (ext === 'mp4' || ext === 'm4v') out.add('mp4');
    else {
      out.add('mp4');
      out.add('mov');
    }
  }
  if (names.includes('matroska') || names.includes('webm')) {
    out.add(ext === 'mkv' ? 'mkv' : 'webm');
  }
  for (const n of names)
    if (n && !['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2', 'matroska', 'webm'].includes(n))
      out.add(n);
  return [...out];
}

/** width / height of the picture. */
export const aspectOf = (width: number, height: number): number =>
  height > 0 ? width / height : 0;

/** True when `ratio` (w/h) is within the spec's tolerance of its recommended shape. */
export function isRecommendedAspect(spec: PlatformSpec, ratio: number): boolean {
  const r = spec.aspect.recommended;
  return Math.abs(ratio - r) / r <= spec.aspect.tolerance;
}

/** 252 → "4:12"; 3723 → "1:02:03"; 3 → "0:03". */
export function formatClock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Short duration for summaries: 3 → "3 s", 90 → "90 s", 180 → "3 min", 900 → "15 min", 150+ non-round → "2:30". */
export function formatDurationShort(sec: number): string {
  if (sec < 120) return `${Math.round(sec)} s`;
  return sec % 60 === 0 ? `${sec / 60} min` : formatClock(sec);
}

/** Decimal sizes: 300e6 → "300 MB", 4e9 → "4 GB", 256·1024³ → "275 GB". */
export function formatBytes(n: number): string {
  if (n >= 1e9) return `${+(n / 1e9).toFixed(n >= 1e11 ? 0 : 1)} GB`;
  if (n >= 1e6) return `${+(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${n} B`;
}

/** The one-line summary the UI shows under a platform: "3 s – 15 min · up to 300 MB · 9:16 recommended". */
export function specSummary(spec: PlatformSpec): string {
  const parts: string[] = [];
  const { min, max } = spec.durationSec;
  if (min !== null && max !== null)
    parts.push(`${formatDurationShort(min)} – ${formatDurationShort(max)}`);
  else if (max !== null) parts.push(`up to ${formatDurationShort(max)}`);
  else if (min !== null) parts.push(`at least ${formatDurationShort(min)}`);
  if (spec.maxSizeBytes !== null) parts.push(`up to ${formatBytes(spec.maxSizeBytes)}`);
  if (spec.aspect.max !== null && spec.aspect.max <= 1)
    parts.push('vertical or square, 9:16 recommended');
  else parts.push('9:16 recommended');
  return parts.join(' · ');
}

export const SPEC_SUMMARY: Record<Platform, string> = {
  shorts: specSummary(PLATFORM_SPECS.shorts),
  reels: specSummary(PLATFORM_SPECS.reels),
  tiktok: specSummary(PLATFORM_SPECS.tiktok),
};
