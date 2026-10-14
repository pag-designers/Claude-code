import { z } from 'zod';
import { captionStyleSchema } from './cp2';

/* ------------------------------------------------------------------------------------------------
 * CP3 — the editor's serialisable PROJECT format (BRIEF §5).
 *
 * One JSON document describes a whole edit. Two independent implementations render it and must agree:
 *   - the PREVIEW compositor (renderer, WebGL/Canvas at proxy resolution), and
 *   - the EXPORT compiler (main process, project → FFmpeg filtergraph + ASS).
 * Everything both need to agree on lives in `shared/editor-eval.ts` as PURE functions over this format
 * (easing, keyframe interpolation, source-time mapping, transitions, fades, ducking, colour maths).
 * Neither side may re-implement those; if a rule is missing, add it there and tell the lead.
 *
 * CONVENTIONS (the parity contract — read all of it):
 *  - Time is SECONDS (float). Item `startSec` is on the TIMELINE. Keyframe `t` is LOCAL to the item
 *    (0 = item start), so moving an item moves its keyframes.
 *  - Space is CANVAS PIXELS at the project's export size (`canvas.width` × `canvas.height`), origin top-left.
 *    The preview scales everything by previewWidth / canvas.width. Transform `x`,`y` are offsets of the item's
 *    centre from the canvas centre.
 *  - Z-order = track order in `project.tracks` (index 0 = bottom). Inside a track, later items paint over
 *    earlier ones only during a transition overlap.
 *  - A TRANSITION is an OVERLAP: the later item of two adjacent items on one track starts `duration` before
 *    the earlier one ends and carries `transitionIn`. During the overlap, progress p = (t − later.start) / duration.
 *    (This is exactly FFmpeg's xfade/acrossfade model.) Editing ops must keep that invariant.
 *  - Visual items have a NATURAL RECT: the media region selected by `crop` is fitted into the canvas per `fit`
 *    ('cover' fills and crops, 'contain' letterboxes, 'native' = source pixels 1:1), centred. `transform`
 *    then translates / scales (uniformly, about the centre) / rotates (degrees, clockwise, about the centre)
 *    that rect and sets opacity. `crop` is normalised (0..1) to the SOURCE frame and is animatable — a
 *    reframe (face-tracking) path is just a `crop` keyframe track.
 *  - Audio gain is LINEAR (1 = unity). dB only appears in labels.
 * ---------------------------------------------------------------------------------------------- */

export const EDITOR_PROJECT_VERSION = 1;

/* ------------------------------------------------------------------ animation ---------------- */

export const easingSchema = z.union([
  z.enum(['linear', 'ease-in', 'ease-out', 'ease-in-out', 'hold']),
  z.object({
    type: z.literal('bezier'),
    x1: z.number().min(0).max(1),
    y1: z.number(),
    x2: z.number().min(0).max(1),
    y2: z.number(),
  }),
]);
export type Easing = z.infer<typeof easingSchema>;
/** CSS cubic-bezier equivalents: ease-in (.42,0,1,1), ease-out (0,0,.58,1), ease-in-out (.42,0,.58,1); 'hold' = step (value of the left keyframe until the next). */

export const keyframeSchema = z.object({
  /** Seconds LOCAL to the item (0 = item start). */
  t: z.number().min(0),
  v: z.number(),
  /** Easing used from this keyframe to the next one. Ignored on the last keyframe. */
  ease: easingSchema.default('linear'),
});
export type Keyframe = z.infer<typeof keyframeSchema>;

/** A number that may be animated. With no keyframes the value is `v`; otherwise `v` is ignored. */
export const animatedSchema = z.object({
  v: z.number(),
  kf: z.array(keyframeSchema).default([]),
});
export type Animated = z.infer<typeof animatedSchema>;
const anim = (v: number) => animatedSchema.default({ v, kf: [] });

/* ------------------------------------------------------------------ shared item parts -------- */

export const transformSchema = z.object({
  x: anim(0),
  y: anim(0),
  /** Uniform scale about the centre of the natural rect. */
  scale: anim(1),
  /** Degrees, clockwise. */
  rotation: anim(0),
  opacity: anim(1),
});
export type Transform = z.infer<typeof transformSchema>;

export const cropSchema = z.object({
  x: anim(0),
  y: anim(0),
  w: anim(1),
  h: anim(1),
});
export type Crop = z.infer<typeof cropSchema>;

export const blendModeSchema = z.enum([
  'normal',
  'multiply',
  'screen',
  'overlay',
  'add',
  'darken',
  'lighten',
]);
export type BlendMode = z.infer<typeof blendModeSchema>;

/** Colour adjustments. All −1..1, 0 = unchanged. Exact maths: `colorMatrix()` in editor-eval.ts. */
export const colorSchema = z.object({
  exposure: anim(0),
  contrast: anim(0),
  saturation: anim(0),
  /** −1 cool … +1 warm */
  temperature: anim(0),
  /** Named look (see FILTER_PRESETS in editor-eval.ts) applied on top of the values above; null = none. */
  filter: z.string().nullable().default(null),
  /** Imported .cube LUT asset (applied last), or null. */
  lutAssetId: z.string().nullable().default(null),
  lutAmount: z.number().min(0).max(1).default(1),
});
export type ColorAdjust = z.infer<typeof colorSchema>;

export const transitionTypeSchema = z.enum([
  'cut',
  'crossfade',
  'dip-black',
  'dip-white',
  'slide-left',
  'slide-right',
  'slide-up',
  'slide-down',
  'zoom',
  'blur',
  'whip-pan',
  'glitch',
]);
export type TransitionType = z.infer<typeof transitionTypeSchema>;

export const transitionSchema = z.object({
  type: transitionTypeSchema,
  /** Equals the overlap with the previous item on the track. */
  durationSec: z.number().min(0.05).max(5),
});
export type ItemTransition = z.infer<typeof transitionSchema>;

const itemBase = {
  id: z.string(),
  startSec: z.number().min(0),
  durationSec: z.number().min(0.04),
  name: z.string().optional(),
  /** Items sharing a groupId move / select / delete together. */
  groupId: z.string().nullable().default(null),
  locked: z.boolean().default(false),
};

/* ------------------------------------------------------------------ items -------------------- */

const mediaCommon = {
  assetId: z.string(),
  /** Source time (s) the item's first frame comes from. */
  inSec: z.number().min(0).default(0),
  /**
   * Constant speed 0.1–10 (when `speedCurve` is empty) — OR a speed ramp: keyframes (local item time) of the
   * instantaneous speed; source time is its integral (`sourceTimeAt`). Duration on the timeline is fixed
   * (`durationSec`); speed decides how much source it consumes.
   */
  speed: z.number().min(0.1).max(10).default(1),
  speedCurve: z.array(keyframeSchema).default([]),
  reverse: z.boolean().default(false),
  /** Freeze frame: when set, every frame shows the source at this time (item shows a still). */
  freezeAtSec: z.number().min(0).nullable().default(null),
  /** Keep pitch when speed ≠ 1 (audio). */
  preservePitch: z.boolean().default(true),
  /** Gate out low-level noise (export: ffmpeg agate, threshold −45 dB, 10 ms attack, 120 ms release; preview: not applied). */
  noiseGate: z.boolean().default(false),
  volume: anim(1),
  fadeInSec: z.number().min(0).default(0),
  fadeOutSec: z.number().min(0).default(0),
};

const visualCommon = {
  transform: transformSchema.default(() => transformSchema.parse({})),
  crop: cropSchema.default(() => cropSchema.parse({})),
  fit: z.enum(['cover', 'contain', 'native']).default('cover'),
  /** With fit 'contain': fill the empty canvas with a blurred cover copy of the item. */
  backgroundBlur: z.boolean().default(false),
  blend: blendModeSchema.default('normal'),
  mirror: z.boolean().default(false),
  /** Gaussian blur radius, canvas px. */
  blur: anim(0),
  color: colorSchema.default(() => colorSchema.parse({})),
  transitionIn: transitionSchema.nullable().default(null),
  /** Visual fade (alpha) at the item's ends, seconds. */
  fadeInSec: z.number().min(0).default(0),
  fadeOutSec: z.number().min(0).default(0),
};

export const videoItemSchema = z.object({
  type: z.literal('video'),
  ...itemBase,
  ...mediaCommon,
  ...visualCommon,
  /** Audio of the video follows the same gain rules; false = picture only. */
  audioEnabled: z.boolean().default(true),
});
export type VideoItem = z.infer<typeof videoItemSchema>;

export const imageItemSchema = z.object({
  type: z.literal('image'),
  ...itemBase,
  assetId: z.string(),
  ...visualCommon,
});
export type ImageItem = z.infer<typeof imageItemSchema>;

export const audioItemSchema = z.object({
  type: z.literal('audio'),
  ...itemBase,
  ...mediaCommon,
});
export type AudioItem = z.infer<typeof audioItemSchema>;

export const textAnimationSchema = z.object({
  type: z.enum(['none', 'pop', 'typewriter', 'slide', 'bounce', 'fade', 'scale']).default('none'),
  durationSec: z.number().min(0).max(3).default(0.4),
});
export type TextAnimation = z.infer<typeof textAnimationSchema>;

export const textStyleSchema = z.object({
  fontFamily: z.string().default('Montserrat'),
  weight: z.number().int().min(100).max(900).default(800),
  italic: z.boolean().default(false),
  /** Canvas px. */
  size: z.number().min(8).max(600).default(72),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#FFFFFF'),
  align: z.enum(['left', 'center', 'right']).default('center'),
  letterSpacing: z.number().min(-20).max(80).default(0),
  /** Multiple of the font size. */
  lineHeight: z.number().min(0.6).max(3).default(1.15),
  stroke: z
    .object({ color: z.string().regex(/^#[0-9a-fA-F]{6}$/), width: z.number().min(0).max(40) })
    .nullable()
    .default(null),
  shadow: z
    .object({
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      opacity: z.number().min(0).max(1),
      blur: z.number().min(0).max(60),
      offsetX: z.number().min(-60).max(60),
      offsetY: z.number().min(-60).max(60),
    })
    .nullable()
    .default(null),
  box: z
    .object({
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      opacity: z.number().min(0).max(1),
      padding: z.number().min(0).max(120),
      radius: z.number().min(0).max(120),
    })
    .nullable()
    .default(null),
  /** Wrap width in canvas px; null = canvas width minus 10 % margins. */
  maxWidth: z.number().min(40).nullable().default(null),
});
export type TextStyle = z.infer<typeof textStyleSchema>;

export const textItemSchema = z.object({
  type: z.literal('text'),
  ...itemBase,
  /** Plain text with \n line breaks; emoji allowed. */
  text: z.string(),
  style: textStyleSchema.default(() => textStyleSchema.parse({})),
  /** Brand Kit text style this was created from (CP4); informational. */
  styleRef: z.string().nullable().default(null),
  transform: transformSchema.default(() => transformSchema.parse({})),
  blend: blendModeSchema.default('normal'),
  animIn: textAnimationSchema.default(() => textAnimationSchema.parse({})),
  animOut: textAnimationSchema.default(() => textAnimationSchema.parse({})),
});
export type TextItem = z.infer<typeof textItemSchema>;

export const subtitleWordSchema = z.object({
  w: z.string(),
  /** Seconds LOCAL to the cue item. */
  s: z.number().min(0),
  e: z.number().min(0),
  /** Per-word emphasis colour override (#RRGGBB) or null. */
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .default(null),
});
export type SubtitleWord = z.infer<typeof subtitleWordSchema>;

/** One caption line (cue). The subtitle track is separate from text layers (BRIEF §5). */
export const subtitleItemSchema = z.object({
  type: z.literal('subtitle'),
  ...itemBase,
  words: z.array(subtitleWordSchema),
  /** Built-in or custom caption preset id (shared/cp2 `captionStyleSchema`). */
  styleId: z.string().default('clean-pop'),
  /** Optional full per-line style override (takes precedence over styleId). */
  styleOverride: captionStyleSchema.nullable().default(null),
});
export type SubtitleItem = z.infer<typeof subtitleItemSchema>;

export const shapeKindSchema = z.enum(['rect', 'ellipse', 'line', 'arrow', 'progress-bar']);
export type ShapeKind = z.infer<typeof shapeKindSchema>;

export const shapeItemSchema = z.object({
  type: z.literal('shape'),
  ...itemBase,
  shape: shapeKindSchema,
  /** Canvas px size of the natural rect. For 'progress-bar' the width fills left→right over the item's duration. */
  width: z.number().min(1).default(400),
  height: z.number().min(1).default(40),
  fill: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#FFFFFF'),
  fillOpacity: z.number().min(0).max(1).default(1),
  stroke: z
    .object({ color: z.string().regex(/^#[0-9a-fA-F]{6}$/), width: z.number().min(0).max(60) })
    .nullable()
    .default(null),
  radius: z.number().min(0).default(0),
  transform: transformSchema.default(() => transformSchema.parse({})),
  blend: blendModeSchema.default('normal'),
});
export type ShapeItem = z.infer<typeof shapeItemSchema>;

export const itemSchema = z.discriminatedUnion('type', [
  videoItemSchema,
  imageItemSchema,
  audioItemSchema,
  textItemSchema,
  subtitleItemSchema,
  shapeItemSchema,
]);
export type Item = z.infer<typeof itemSchema>;
export type ItemType = Item['type'];

/* ------------------------------------------------------------------ tracks ------------------- */

export const trackKindSchema = z.enum([
  'video',
  'overlay',
  'image',
  'text',
  'subtitle',
  'audio',
  'sfx',
]);
export type TrackKind = z.infer<typeof trackKindSchema>;

/** Which item types a track kind may hold. */
export const TRACK_ACCEPTS: Record<TrackKind, ItemType[]> = {
  video: ['video', 'image'],
  overlay: ['video', 'image', 'shape', 'text'],
  image: ['image', 'shape'],
  text: ['text'],
  subtitle: ['subtitle'],
  audio: ['audio', 'video'],
  sfx: ['audio'],
};

export const duckingSchema = z.object({
  enabled: z.boolean().default(false),
  /** Gain reduction while speech plays, dB (positive number, e.g. 12 = −12 dB). */
  reductionDb: z.number().min(0).max(40).default(12),
  attackSec: z.number().min(0).max(2).default(0.15),
  releaseSec: z.number().min(0).max(5).default(0.5),
});
export type Ducking = z.infer<typeof duckingSchema>;

export const trackSchema = z.object({
  id: z.string(),
  kind: trackKindSchema,
  name: z.string(),
  locked: z.boolean().default(false),
  muted: z.boolean().default(false),
  hidden: z.boolean().default(false),
  /** Track gain (linear), applied to audio of its items. */
  gain: z.number().min(0).max(4).default(1),
  /** Audio tracks only: duck this track under speech (speech = audible, non-muted video/audio items on tracks with `speech: true`). */
  ducking: duckingSchema.default(() => duckingSchema.parse({})),
  /** Marks a track as carrying speech (drives ducking of music/SFX). Video tracks default to true. */
  speech: z.boolean().default(false),
  /** Items sorted by startSec; non-overlapping except transition overlaps. */
  items: z.array(itemSchema),
});
export type Track = z.infer<typeof trackSchema>;

/* ------------------------------------------------------------------ assets ------------------- */

export const assetSourceSchema = z.discriminatedUnion('kind', [
  /** A library source video (preview = its 480p proxy, export = full-res source, re-downloaded on demand). */
  z.object({ kind: z.literal('video'), videoId: z.string() }),
  /** A rendered Library clip (1080×1920 mp4 in storage). */
  z.object({ kind: z.literal('clip'), clipId: z.string() }),
  /** A file the user imported into the project (storage key under editor/<projectId>/assets/). */
  z.object({ kind: z.literal('upload'), key: z.string(), fileName: z.string() }),
]);
export type AssetSource = z.infer<typeof assetSourceSchema>;

export const assetSchema = z.object({
  id: z.string(),
  kind: z.enum(['video', 'audio', 'image', 'lut']),
  name: z.string(),
  source: assetSourceSchema,
  durationSec: z.number().nullable().default(null),
  width: z.number().nullable().default(null),
  height: z.number().nullable().default(null),
  fps: z.number().nullable().default(null),
  hasAudio: z.boolean().default(false),
  /** Beat times (s, in ASSET time) once detected; audio assets only. */
  beats: z.array(z.number()).nullable().default(null),
});
export type Asset = z.infer<typeof assetSchema>;

/* ------------------------------------------------------------------ project ------------------ */

export const aspectIdSchema = z.enum(['9:16', '1:1', '16:9', '4:5', 'custom']);
export type AspectId = z.infer<typeof aspectIdSchema>;

export const canvasSchema = z.object({
  aspect: aspectIdSchema.default('9:16'),
  width: z.number().int().min(64).max(4096).default(1080),
  height: z.number().int().min(64).max(4096).default(1920),
  fps: z
    .union([z.literal(24), z.literal(25), z.literal(30), z.literal(50), z.literal(60)])
    .default(30),
  background: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#000000'),
});
export type Canvas = z.infer<typeof canvasSchema>;

export const projectMarkerSchema = z.object({
  id: z.string(),
  atSec: z.number().min(0),
  label: z.string(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#F5A524'),
});
export type ProjectMarker = z.infer<typeof projectMarkerSchema>;

export const projectSchema = z.object({
  version: z.literal(EDITOR_PROJECT_VERSION).default(EDITOR_PROJECT_VERSION),
  canvas: canvasSchema.default(() => canvasSchema.parse({})),
  tracks: z.array(trackSchema),
  assets: z.array(assetSchema),
  markers: z.array(projectMarkerSchema).default([]),
  /** Where it came from (informational): the library clip / video opened in the editor. */
  origin: z
    .object({ clipId: z.string().nullable(), videoId: z.string().nullable() })
    .default({ clipId: null, videoId: null }),
});
export type Project = z.infer<typeof projectSchema>;

/* ------------------------------------------------------------------ platform guides ---------- */

/** Safe-area guides per platform: fractions of the canvas to keep clear (top, bottom, left, right). */
export const SAFE_AREAS: Record<
  string,
  { label: string; top: number; bottom: number; left: number; right: number }
> = {
  tiktok: { label: 'TikTok', top: 0.1, bottom: 0.2, left: 0.05, right: 0.14 },
  reels: { label: 'Instagram Reels', top: 0.1, bottom: 0.2, left: 0.05, right: 0.12 },
  shorts: { label: 'YouTube Shorts', top: 0.08, bottom: 0.2, left: 0.05, right: 0.14 },
};

export const ASPECT_SIZES: Record<
  Exclude<AspectId, 'custom'>,
  { width: number; height: number }
> = {
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
  '16:9': { width: 1920, height: 1080 },
  '4:5': { width: 1080, height: 1350 },
};

/* ------------------------------------------------------------------ export ------------------- */

export const exportPresetIdSchema = z.enum([
  'tiktok',
  'reels',
  'shorts',
  'youtube-1080p',
  'square-1080',
  'draft-720p',
  'custom',
]);
export type ExportPresetId = z.infer<typeof exportPresetIdSchema>;

export const exportSettingsSchema = z.object({
  preset: exportPresetIdSchema.default('tiktok'),
  width: z.number().int().min(64).max(4096),
  height: z.number().int().min(64).max(4096),
  fps: z.number().min(10).max(60).default(30),
  /** 'quality' = CRF-style (lower is better), 'bitrate' = target kbps. */
  rateMode: z.enum(['quality', 'bitrate']).default('quality'),
  /** 0..100 slider mapped to CRF 30..16 (libx264) / equivalent for hardware encoders. */
  quality: z.number().min(0).max(100).default(70),
  videoKbps: z.number().int().min(500).max(80000).default(10000),
  audioKbps: z.number().int().min(64).max(384).default(192),
  /** Burn captions (subtitle track + text layers always render; this controls the subtitle track only). */
  burnCaptions: z.boolean().default(true),
  /** Also write .srt / .vtt next to the video (from the subtitle track). */
  sidecarSrt: z.boolean().default(false),
  sidecarVtt: z.boolean().default(false),
  /** Loudness target (LUFS) or null for no normalisation. */
  loudnessLufs: z.number().min(-30).max(-5).nullable().default(-14),
  /** Filename without extension; tokens: {title} {preset} {date} {n}. */
  filenameTemplate: z.string().min(1).max(120).default('{title}-{preset}'),
});
export type ExportSettings = z.infer<typeof exportSettingsSchema>;
export type ExportSettingsInput = z.input<typeof exportSettingsSchema>;

export const EXPORT_PRESETS: Record<
  Exclude<ExportPresetId, 'custom'>,
  {
    label: string;
    width: number;
    height: number;
    fps: number;
    videoKbps: number;
    maxSec: number | null;
  }
> = {
  tiktok: { label: 'TikTok', width: 1080, height: 1920, fps: 30, videoKbps: 10000, maxSec: 600 },
  reels: {
    label: 'Instagram Reels',
    width: 1080,
    height: 1920,
    fps: 30,
    videoKbps: 10000,
    maxSec: 180,
  },
  shorts: {
    label: 'YouTube Shorts',
    width: 1080,
    height: 1920,
    fps: 30,
    videoKbps: 12000,
    maxSec: 180,
  },
  'youtube-1080p': {
    label: 'YouTube 1080p',
    width: 1920,
    height: 1080,
    fps: 30,
    videoKbps: 12000,
    maxSec: null,
  },
  'square-1080': {
    label: 'Square 1080',
    width: 1080,
    height: 1080,
    fps: 30,
    videoKbps: 10000,
    maxSec: null,
  },
  'draft-720p': {
    label: 'Draft 720p',
    width: 720,
    height: 1280,
    fps: 30,
    videoKbps: 4000,
    maxSec: null,
  },
};

/* ------------------------------------------------------------------ persisted views ---------- */

export const editorProjectSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  rev: z.number().int(),
  clipId: z.string().nullable(),
  videoId: z.string().nullable(),
  durationSec: z.number(),
  aspect: aspectIdSchema,
  /** Presigned thumbnail URL or null. */
  thumbUrl: z.string().nullable(),
  updatedAt: z.number(),
  createdAt: z.number(),
});
export type EditorProjectSummary = z.infer<typeof editorProjectSummarySchema>;

export const editorProjectDocSchema = z.object({
  id: z.string(),
  name: z.string(),
  rev: z.number().int(),
  project: projectSchema,
  updatedAt: z.number(),
});
export type EditorProjectDoc = z.infer<typeof editorProjectDocSchema>;

export const projectVersionSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  rev: z.number().int(),
  label: z.string().nullable(),
  /** 'auto' (periodic snapshot), 'manual' (user pressed Save version), 'restore' (taken before a restore). */
  kind: z.enum(['auto', 'manual', 'restore']),
  createdAt: z.number(),
});
export type ProjectVersion = z.infer<typeof projectVersionSchema>;

export const exportJobSchema = z.object({
  id: z.string(),
  projectId: z.string().nullable(),
  name: z.string(),
  status: z.enum(['queued', 'rendering', 'done', 'failed', 'canceled']),
  progress: z.number().nullable(),
  message: z.string().nullable(),
  error: z.string().nullable(),
  settings: exportSettingsSchema,
  durationSec: z.number().nullable(),
  sizeBytes: z.number().nullable(),
  hasFile: z.boolean(),
  hasThumb: z.boolean(),
  createdAt: z.number(),
  finishedAt: z.number().nullable(),
});
export type ExportJob = z.infer<typeof exportJobSchema>;

/** Waveform peaks for an audio-bearing asset: `peaks[i]` = max |sample| (0..1) of window i. */
export const waveformSchema = z.object({
  /** Windows per second. */
  rate: z.number(),
  durationSec: z.number(),
  peaks: z.array(z.number()),
});
export type Waveform = z.infer<typeof waveformSchema>;

/* ------------------------------------------------------------------ storage keys -------------- */

export const keysEditor = {
  projectBackup: (projectId: string) => `projects/${projectId}/project.json`,
  versionBackup: (projectId: string, rev: number) => `projects/${projectId}/versions/${rev}.json`,
  asset: (projectId: string, assetId: string, ext: string) =>
    `editor/${projectId}/assets/${assetId}.${ext}`,
  projectThumb: (projectId: string) => `projects/${projectId}/thumb.jpg`,
  waveform: (assetKey: string) => `${assetKey}.waveform.json`,
  exportFile: (exportId: string) => `exports/${exportId}/video.mp4`,
  exportThumb: (exportId: string) => `exports/${exportId}/thumb.jpg`,
  exportSrt: (exportId: string) => `exports/${exportId}/captions.srt`,
  exportVtt: (exportId: string) => `exports/${exportId}/captions.vtt`,
} as const;

/**
 * Fills a partial export request from its preset (or the project canvas for 'custom'). The ONE place that
 * decides export defaults — main, the Export panel and tests all call it.
 */
export function resolveExportSettings(
  req: Partial<ExportSettings>,
  canvas: { width: number; height: number; fps: number },
): ExportSettings {
  const preset = req.preset ?? 'tiktok';
  const base =
    preset === 'custom'
      ? { width: canvas.width, height: canvas.height, fps: canvas.fps, videoKbps: 10000 }
      : EXPORT_PRESETS[preset];
  return exportSettingsSchema.parse({
    ...req,
    preset,
    width: req.width ?? base.width,
    height: req.height ?? base.height,
    fps: req.fps ?? base.fps,
    videoKbps: req.videoKbps ?? base.videoKbps,
  });
}
