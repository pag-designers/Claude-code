import { z } from 'zod';
import { platformSchema } from './cp2';
import { SAFE_AREAS, textAnimationSchema, textStyleSchema } from './editor';

/* ------------------------------------------------------------------------------------------------
 * CP4 domain types: Brand Kits (BRIEF §7). A kit is a small JSON document (`BrandKitSpec`) plus a set of
 * uploaded assets (`BrandAsset`, files live in object storage and are referenced by id).
 * Pure helpers shared by main, preload and renderer live at the bottom (watermark geometry, hook style,
 * storage keys, upload formats) so the finisher, the editor and the Brand Kit page agree on every number.
 * ---------------------------------------------------------------------------------------------- */

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'use #RRGGBB');

/* ------------------------------------------------------------------------------------ assets ----- */

export const BRAND_ASSET_KINDS = ['logo', 'image', 'video', 'audio', 'font'] as const;
export const brandAssetKindSchema = z.enum(BRAND_ASSET_KINDS);
export type BrandAssetKind = z.infer<typeof brandAssetKindSchema>;

/** Accepted extensions per section (BRIEF §7) and the text shown under every upload panel. */
export const BRAND_FORMATS: Record<
  BrandAssetKind,
  { extensions: readonly string[]; label: string; maxBytes: number }
> = {
  logo: { extensions: ['png', 'svg', 'webp'], label: 'PNG, SVG, WEBP', maxBytes: 25 * 2 ** 20 },
  image: {
    extensions: ['png', 'jpg', 'jpeg', 'webp', 'svg', 'gif'],
    label: 'PNG, JPG, WEBP, SVG, GIF',
    maxBytes: 50 * 2 ** 20,
  },
  video: { extensions: ['mp4', 'mov', 'webm'], label: 'MP4, MOV, WEBM', maxBytes: 2 * 2 ** 30 },
  audio: {
    extensions: ['mp3', 'wav', 'aac', 'm4a'],
    label: 'MP3, WAV, AAC, M4A',
    maxBytes: 300 * 2 ** 20,
  },
  font: {
    extensions: ['ttf', 'otf', 'woff', 'woff2'],
    label: 'TTF, OTF, WOFF, WOFF2',
    maxBytes: 20 * 2 ** 20,
  },
};

/** Which section(s) accept a file with this extension (an .svg can be a logo or an image). */
export function brandKindsForExt(ext: string): BrandAssetKind[] {
  const e = ext.replace(/^\./, '').toLowerCase();
  return BRAND_ASSET_KINDS.filter((k) => BRAND_FORMATS[k].extensions.includes(e));
}

export const brandFontInfoSchema = z.object({
  /** Typographic family ("Poppins"). */
  family: z.string(),
  /** Name libass / fontconfig match (nameID 1, e.g. "Poppins ExtraBold"). */
  assName: z.string(),
  weight: z.number().int().min(100).max(900),
  italic: z.boolean(),
  /** File name inside the merged fonts directory that libass reads (always a TTF/OTF after conversion). */
  file: z.string(),
});
export type BrandFontInfo = z.infer<typeof brandFontInfoSchema>;

export const brandAssetCreditSchema = z.object({
  /** 'pexels' | 'pixabay' for stock B-roll, otherwise free text. */
  source: z.string(),
  author: z.string().nullable().default(null),
  url: z.string().nullable().default(null),
});
export type BrandAssetCredit = z.infer<typeof brandAssetCreditSchema>;

export const brandAssetSchema = z.object({
  id: z.string(),
  kitId: z.string(),
  kind: brandAssetKindSchema,
  name: z.string(),
  /** Original file extension, lower case, no dot. */
  ext: z.string(),
  bytes: z.number().int().nonnegative(),
  /** Storage key of the original upload. */
  storageKey: z.string(),
  /**
   * What compositing uses when the original cannot be used directly: SVG → PNG raster (≤ 2048 px), WOFF/WOFF2 → TTF/OTF,
   * animated GIF → its first frame as PNG. null = use `storageKey`.
   */
  usableKey: z.string().nullable().default(null),
  /** 480p H.264 (video) or loudness-normalised −14 LUFS audition copy (audio). */
  previewKey: z.string().nullable().default(null),
  thumbKey: z.string().nullable().default(null),
  width: z.number().int().nullable().default(null),
  height: z.number().int().nullable().default(null),
  durationSec: z.number().nullable().default(null),
  hasAudio: z.boolean().default(false),
  fps: z.number().nullable().default(null),
  /** Integrated loudness of the ORIGINAL audio (LUFS), audio and video assets with sound. */
  loudnessLufs: z.number().nullable().default(null),
  font: brandFontInfoSchema.nullable().default(null),
  credit: brandAssetCreditSchema.nullable().default(null),
  createdAt: z.number(),
});
export type BrandAsset = z.infer<typeof brandAssetSchema>;

/** A BrandAsset with short-lived URLs the renderer can load (never stored). */
export const brandAssetViewSchema = brandAssetSchema.extend({
  url: z.string().nullable(),
  previewUrl: z.string().nullable(),
  thumbUrl: z.string().nullable(),
});
export type BrandAssetView = z.infer<typeof brandAssetViewSchema>;

/* ------------------------------------------------------------------------------------ kit spec ---- */

export const brandColorSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(40),
  hex,
  /** Palette group ("Primary", "Accent", …). */
  group: z.string().max(30).default('Primary'),
});
export type BrandColor = z.infer<typeof brandColorSchema>;

export const WATERMARK_POSITIONS = [
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
  'center',
] as const;
export const watermarkPositionSchema = z.enum(WATERMARK_POSITIONS);
export type WatermarkPosition = z.infer<typeof watermarkPositionSchema>;

export const watermarkSchema = z.object({
  /** A `logo` (or `image`) asset of the kit; null = none chosen. */
  assetId: z.string().nullable().default(null),
  position: watermarkPositionSchema.default('top-right'),
  /** Logo width as % of the canvas width. */
  sizePct: z.number().min(3).max(60).default(16),
  opacity: z.number().min(0.05).max(1).default(0.85),
  /** Distance from the edge, % of the canvas short side. */
  marginPct: z.number().min(0).max(15).default(4),
  /** Keep clear of platform UI: 'all' = union of TikTok/Reels/Shorts safe areas; 'none' = just the margin. */
  safeArea: z.enum(['none', 'all', 'tiktok', 'reels', 'shorts']).default('all'),
});
export type Watermark = z.infer<typeof watermarkSchema>;

export const musicBedSchema = z.object({
  /** An `audio` asset of the kit; null = none. */
  assetId: z.string().nullable().default(null),
  /** Level of the bed before ducking (dB). */
  gainDb: z.number().min(-40).max(0).default(-18),
  duckEnabled: z.boolean().default(true),
  /** How far the bed drops while someone speaks (dB, positive). */
  duckAmountDb: z.number().min(0).max(30).default(12),
  fadeInSec: z.number().min(0).max(5).default(0.8),
  fadeOutSec: z.number().min(0).max(8).default(1.5),
});
export type MusicBed = z.infer<typeof musicBedSchema>;

/**
 * Hook title card look (the card burned in for the first ~3 s). Defaults reproduce the CP1/CP2 card exactly
 * (white card, near-black Montserrat, 18 % from the top) so a clip rendered without a kit is unchanged.
 */
export const hookStyleSchema = z.object({
  fontFamily: z.string().default('Montserrat'),
  weight: z.number().int().min(100).max(900).default(800),
  textColor: hex.default('#101114'),
  cardColor: hex.default('#FFFFFF'),
  cardOpacity: z.number().min(0).max(1).default(1),
  textCase: z.enum(['none', 'upper', 'lower']).default('none'),
  /** Centre of the card, % of frame height. */
  yPct: z.number().min(5).max(90).default(18),
  /** Font size, % of the frame's short side. */
  sizePct: z.number().min(3).max(12).default(7.4),
});
export type HookStyle = z.infer<typeof hookStyleSchema>;
export const DEFAULT_HOOK_STYLE: HookStyle = hookStyleSchema.parse({});

export const TEXT_STYLE_KINDS = ['title', 'hook', 'cta', 'lower-third'] as const;
export const brandTextStyleSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(40),
  kind: z.enum(TEXT_STYLE_KINDS).default('title'),
  /** Same look/animation model as editor text items (canvas px at 1080 wide; scaled to other canvases). */
  style: textStyleSchema,
  animIn: textAnimationSchema.default(() => textAnimationSchema.parse({})),
  animOut: textAnimationSchema.default(() => textAnimationSchema.parse({})),
  /** Vertical centre, % of canvas height. */
  yPct: z.number().min(0).max(100).default(30),
});
export type BrandTextStyle = z.infer<typeof brandTextStyleSchema>;

export const hashtagSetSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(40),
  /** Without the leading #. */
  tags: z.array(z.string().min(1).max(60)).max(60),
});
export type HashtagSet = z.infer<typeof hashtagSetSchema>;

export const postingWindowSchema = z.object({
  id: z.string(),
  /** null = every platform. */
  platform: platformSchema.nullable().default(null),
  /** 0 = Sunday … 6 = Saturday. */
  days: z.array(z.number().int().min(0).max(6)).min(1).default([0, 1, 2, 3, 4, 5, 6]),
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
});
export type PostingWindow = z.infer<typeof postingWindowSchema>;

export const brandDefaultsSchema = z.object({
  aspect: z.enum(['9:16', '1:1', '16:9', '4:5']).default('9:16'),
  /** Caption preset (built-in or a kit subtitle style id). */
  captionStyleId: z.string().default('clean-pop'),
  /** Editor: the kit text style (kind 'hook') used for the hook text item of new projects; the burned-in clip card uses `BrandKitSpec.hook`. */
  hookTextStyleId: z.string().nullable().default(null),
  watermarkOn: z.boolean().default(true),
  introOn: z.boolean().default(false),
  outroOn: z.boolean().default(false),
  musicOn: z.boolean().default(false),
  platforms: z.array(platformSchema).default(['tiktok', 'reels', 'shorts']),
  hashtagSets: z.array(hashtagSetSchema).default([]),
  postingWindows: z.array(postingWindowSchema).default([]),
});
export type BrandDefaults = z.infer<typeof brandDefaultsSchema>;

export const brandKitSpecSchema = z.object({
  colors: z.array(brandColorSchema).max(60).default([]),
  watermark: watermarkSchema.default(() => watermarkSchema.parse({})),
  /** Video assets of the kit played before / after the clip. */
  introAssetId: z.string().nullable().default(null),
  outroAssetId: z.string().nullable().default(null),
  musicBed: musicBedSchema.default(() => musicBedSchema.parse({})),
  hook: hookStyleSchema.default(() => hookStyleSchema.parse({})),
  textStyles: z.array(brandTextStyleSchema).max(40).default([]),
  defaults: brandDefaultsSchema.default(() => brandDefaultsSchema.parse({})),
});
export type BrandKitSpec = z.infer<typeof brandKitSpecSchema>;

export const brandKitSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(60),
  isDefault: z.boolean(),
  spec: brandKitSpecSchema,
  /** Optimistic-concurrency counter (bumped on every update). */
  rev: z.number().int(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type BrandKit = z.infer<typeof brandKitSchema>;

export const brandKitSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  isDefault: z.boolean(),
  updatedAt: z.number(),
  counts: z.record(brandAssetKindSchema, z.number().int()),
  /** Up to 5 swatches for the card. */
  swatches: z.array(z.string()),
  /** Short-lived URL of the watermark/logo thumbnail, when the kit has one. */
  logoThumbUrl: z.string().nullable(),
});
export type BrandKitSummary = z.infer<typeof brandKitSummarySchema>;

/** Partial update of a kit: top-level spec keys are REPLACED whole (send the full `colors` array, etc.). */
export const brandKitPatchSchema = z
  .object({
    name: z.string().min(1).max(60).optional(),
    spec: z
      .object(
        Object.fromEntries(
          Object.entries(brandKitSpecSchema.shape).map(([k, f]) => [
            k,
            // strip the default so an omitted key stays omitted (see pipelineOptionsPatchSchema)
            f instanceof z.ZodDefault ? f.removeDefault().optional() : (f as z.ZodType).optional(),
          ]),
        ),
      )
      .strict()
      .optional(),
  })
  .strict() as unknown as z.ZodType<{ name?: string; spec?: Partial<BrandKitSpec> }>;
export type BrandKitPatch = { name?: string; spec?: Partial<BrandKitSpec> };

/* --------------------------------------------------------------------------- apply to clips ------ */

/** What "Apply a Brand Kit" changes on a rendered clip (all re-render the clip through the pipeline). */
export const brandApplyResultSchema = z.object({
  queued: z.number().int(),
  skipped: z.number().int(),
});
export type BrandApplyResult = z.infer<typeof brandApplyResultSchema>;

/** Parts of a kit a project can take over (editor "Apply Brand Kit"). */
export const BRAND_PARTS = ['watermark', 'intro', 'outro', 'subtitles', 'hook', 'music'] as const;
export const brandPartSchema = z.enum(BRAND_PARTS);
export type BrandPart = z.infer<typeof brandPartSchema>;

/* --------------------------------------------------------------------------- stock B-roll -------- */

export const brollProviderSchema = z.enum(['pexels', 'pixabay']);
export type BrollProvider = z.infer<typeof brollProviderSchema>;

export const brollItemSchema = z.object({
  /** `${provider}:${providerId}` */
  id: z.string(),
  provider: brollProviderSchema,
  title: z.string(),
  author: z.string().nullable(),
  /** Page of the clip on the provider (credit link). */
  pageUrl: z.string().nullable(),
  thumbUrl: z.string(),
  /** Short muted preview (mp4) from the provider's CDN, for hover play. */
  previewUrl: z.string().nullable(),
  width: z.number().int(),
  height: z.number().int(),
  durationSec: z.number(),
});
export type BrollItem = z.infer<typeof brollItemSchema>;

export const brollSearchResultSchema = z.object({
  items: z.array(brollItemSchema),
  page: z.number().int(),
  /** null = no more pages. */
  nextPage: z.number().int().nullable(),
});
export type BrollSearchResult = z.infer<typeof brollSearchResultSchema>;

/* ----------------------------------------------------------------------------- storage keys ------ */

export const keysBrand = {
  original: (kitId: string, assetId: string, ext: string) => `brand/${kitId}/${assetId}.${ext}`,
  /** Derived files hang off the original's key (so the editor's `${key}.preview.mp4` convention holds for brand videos). */
  usable: (originalKey: string, ext: string) => `${originalKey}.usable.${ext}`,
  preview: (originalKey: string, ext: string) => `${originalKey}.preview.${ext}`,
  thumb: (kitId: string, assetId: string) => `brand/${kitId}/${assetId}.thumb.jpg`,
  /** Editor convention: a video upload at `key` has its 480p copy at `${key}.preview.mp4`. */
  editorPreview: (key: string) => `${key}.preview.mp4`,
  prefix: (kitId: string) => `brand/${kitId}/`,
} as const;

/* ------------------------------------------------------------------- pure helpers (shared) ------- */

/** Fractions of the canvas kept clear for platform UI (max over the chosen platforms). */
export function safeInsets(
  safeArea: Watermark['safeArea'],
  /** true when the canvas is portrait/square-ish vertical video; platform UI only matters there. */
  vertical = true,
): { top: number; bottom: number; left: number; right: number } {
  if (safeArea === 'none' || !vertical) return { top: 0, bottom: 0, left: 0, right: 0 };
  const ids = safeArea === 'all' ? Object.keys(SAFE_AREAS) : [safeArea];
  const out = { top: 0, bottom: 0, left: 0, right: 0 };
  for (const id of ids) {
    const s = SAFE_AREAS[id];
    if (!s) continue;
    out.top = Math.max(out.top, s.top);
    out.bottom = Math.max(out.bottom, s.bottom);
    out.left = Math.max(out.left, s.left);
    out.right = Math.max(out.right, s.right);
  }
  return out;
}

export interface WatermarkRect {
  /** Top-left, canvas px. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Centre, canvas px (the editor's image items are positioned by centre). */
  cx: number;
  cy: number;
}

/**
 * Where the watermark sits on a canvas. ONE function for the finisher (FFmpeg overlay), the editor (image item
 * transform) and the Brand Kit page preview. `aspect` = logo width / height.
 * Corner positions hug the inner edge of (margin ∪ safe area); 'center' ignores both.
 */
export function watermarkRect(
  canvas: { width: number; height: number },
  wm: Pick<Watermark, 'position' | 'sizePct' | 'marginPct' | 'safeArea'>,
  aspect: number,
): WatermarkRect {
  const { width: W, height: H } = canvas;
  const w = Math.max(8, Math.round((W * wm.sizePct) / 100));
  const h = Math.max(8, Math.round(w / (aspect > 0 ? aspect : 1)));
  const margin = Math.round((Math.min(W, H) * wm.marginPct) / 100);
  const ins = safeInsets(wm.safeArea, H >= W * 0.9);
  const left = Math.max(margin, Math.round(W * ins.left));
  const right = Math.max(margin, Math.round(W * ins.right));
  const top = Math.max(margin, Math.round(H * ins.top));
  const bottom = Math.max(margin, Math.round(H * ins.bottom));
  let x = Math.round((W - w) / 2);
  let y = Math.round((H - h) / 2);
  if (wm.position.endsWith('left')) x = left;
  if (wm.position.endsWith('right')) x = W - right - w;
  if (wm.position.startsWith('top')) y = top;
  if (wm.position.startsWith('bottom')) y = H - bottom - h;
  x = Math.min(Math.max(0, x), Math.max(0, W - w));
  y = Math.min(Math.max(0, y), Math.max(0, H - h));
  return { x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
}

/** A fresh kit spec (all defaults). */
export function defaultBrandSpec(): BrandKitSpec {
  return brandKitSpecSchema.parse({});
}

/** The kit text style to use for the hook card, when the kit's defaults point at one. */
export function hookTextStyleOf(spec: BrandKitSpec): BrandTextStyle | null {
  const id = spec.defaults.hookTextStyleId;
  return id ? (spec.textStyles.find((t) => t.id === id && t.kind === 'hook') ?? null) : null;
}

/**
 * Which kit a clip renders with. `clipValue` = `Clip.brandKitId` (null = inherit), `optionsValue` =
 * `PipelineOptions.brandKitId` of its video. 'none' → no kit; 'default' → the default kit (null when there is none).
 * A kit id that no longer exists must be treated as 'none' by the caller (resolution here is purely textual).
 */
export function resolveBrandKitId(
  clipValue: string | null | undefined,
  optionsValue: string | null | undefined,
  defaultKitId: string | null,
): string | null {
  const v = clipValue ?? optionsValue ?? 'default';
  if (v === 'none') return null;
  if (v === 'default') return defaultKitId;
  return v;
}
