/**
 * Pure logic of the editor's Brand Kit surfaces (media bin sections, text styles, Apply dialog). No React, no store:
 * ids are injected so the unit tests are deterministic. The numbers come from `shared/brand-apply.ts`, so a text item
 * made here and one restyled by "Apply Brand Kit" look identical.
 */
import {
  imageItemSchema,
  textItemSchema,
  type Asset,
  type ImageItem,
  type SubtitleItem,
  type Project,
  type TextItem,
} from '@shared/editor';
import {
  BRAND_PARTS,
  type BrandAsset,
  type BrandAssetView,
  type BrandKit,
  type BrandPart,
  type BrandTextStyle,
} from '@shared/brand';
import {
  applyBrandToProject,
  brandAssetToProjectAsset,
  brandProjectAssetId,
  brandStyleRef,
  brandTextPatch,
  type ApplyBrandResult,
} from '@shared/brand-apply';

/* ------------------------------------------------------------------------------ asset groups -- */

export interface BrandAssetGroups {
  images: BrandAssetView[];
  videos: BrandAssetView[];
  audio: BrandAssetView[];
  fonts: BrandAssetView[];
}

/** Kit assets by what the editor does with them (logos and images are both "images"; newest last as uploaded). */
export function groupBrandAssets(assets: readonly BrandAssetView[]): BrandAssetGroups {
  const by = (pred: (a: BrandAssetView) => boolean) =>
    assets.filter(pred).sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name));
  return {
    images: by((a) => a.kind === 'logo' || a.kind === 'image'),
    videos: by((a) => a.kind === 'video'),
    audio: by((a) => a.kind === 'audio'),
    fonts: by((a) => a.kind === 'font'),
  };
}

/** Which job a kit video has in the kit (shown as a badge). */
export function videoRole(kit: BrandKit, assetId: string): 'intro' | 'outro' | null {
  if (kit.spec.introAssetId === assetId) return 'intro';
  if (kit.spec.outroAssetId === assetId) return 'outro';
  return null;
}

/** Which job a kit image has (watermark logo). */
export function imageRole(kit: BrandKit, assetId: string): 'watermark' | null {
  return kit.spec.watermark.assetId === assetId ? 'watermark' : null;
}

/** The project asset for a kit asset, plus whether the project already has it. */
export function projectAssetFor(
  project: Pick<Project, 'assets'>,
  brandAsset: BrandAsset,
): { asset: Asset; exists: boolean } {
  const id = brandProjectAssetId(brandAsset.id);
  const cur = project.assets.find((a) => a.id === id);
  return cur
    ? { asset: cur, exists: true }
    : { asset: brandAssetToProjectAsset(brandAsset), exists: false };
}

/* ------------------------------------------------------------------------------ sticker item -- */

/** Share of the canvas width a sticker takes when added by click. */
export const STICKER_WIDTH_FRACTION = 0.42;

/**
 * An image item for a kit logo / sticker: shown at its own proportions (fit 'native' + scale), about 42 % of the canvas
 * width, 4 s long (a still defaults to 5 s on drop; a sticker is shorter). Without a known pixel size the picture is
 * contained in the canvas and halved.
 */
export function brandStickerItem(
  asset: Asset,
  canvas: { width: number; height: number },
  startSec: number,
  id: string,
): ImageItem {
  const known = asset.width && asset.height;
  const scale = known
    ? Math.round(((canvas.width * STICKER_WIDTH_FRACTION) / (asset.width as number)) * 1e5) / 1e5
    : 0.5;
  return imageItemSchema.parse({
    type: 'image',
    id,
    name: asset.name,
    startSec: Math.max(0, startSec),
    durationSec: 4,
    assetId: asset.id,
    fit: known ? 'native' : 'contain',
    transform: { scale: { v: scale, kf: [] } },
  });
}

/* ------------------------------------------------------------------------------ text styles --- */

const SAMPLE: Record<BrandTextStyle['kind'], string> = {
  title: 'Your title',
  hook: 'Wait for it',
  cta: 'Follow for more',
  'lower-third': 'Name Surname\nRole or topic',
};

export const brandStyleSample = (kind: BrandTextStyle['kind']): string => SAMPLE[kind];

/**
 * A new text item in the look of a kit text style. Hook styles name the item "Hook" so "Apply Brand Kit" finds it again,
 * whichever kit it was made from; `styleRef` is `brand:<kitId>:<styleId>`.
 */
export function brandTextItem(
  kit: Pick<BrandKit, 'id'>,
  ts: BrandTextStyle,
  canvas: { width: number; height: number },
  startSec: number,
  id: string,
  text?: string,
): TextItem {
  const patch = brandTextPatch(ts, canvas);
  return textItemSchema.parse({
    type: 'text',
    id,
    name: ts.kind === 'hook' ? 'Hook' : ts.name,
    startSec: Math.max(0, startSec),
    durationSec: 3,
    text: text ?? brandStyleSample(ts.kind),
    style: patch.style,
    styleRef: brandStyleRef(kit.id, ts.id),
    animIn: patch.animIn,
    animOut: patch.animOut,
    transform: { y: { v: patch.y, kf: [] } },
  });
}

/** The patch that restyles existing text items with a kit text style (text and timing are kept). */
export function brandRestylePatch(
  kit: Pick<BrandKit, 'id'>,
  ts: BrandTextStyle,
  canvas: { width: number; height: number },
) {
  const patch = brandTextPatch(ts, canvas);
  return {
    style: patch.style,
    animIn: patch.animIn,
    animOut: patch.animOut,
    styleRef: brandStyleRef(kit.id, ts.id),
    transform: { y: { v: patch.y, kf: [] as never[] } },
  };
}

/** Kit text styles grouped for the pickers, in the kit's order. */
export function textStylesByKind(kit: Pick<BrandKit, 'spec'>) {
  const out = new Map<BrandTextStyle['kind'], BrandTextStyle[]>();
  for (const t of kit.spec.textStyles) out.set(t.kind, [...(out.get(t.kind) ?? []), t]);
  return out;
}

/** Name of the kit text style a `styleRef` points at, when it is one of this kit's. */
export function brandStyleName(
  kit: Pick<BrandKit, 'id' | 'spec'>,
  ref: string | null,
): string | null {
  const m = ref ? /^brand:([^:]+):(.+)$/.exec(ref) : null;
  if (!m || m[1] !== kit.id) return null;
  return kit.spec.textStyles.find((t) => t.id === m[2])?.name ?? null;
}

/* ------------------------------------------------------------------------------ apply dialog -- */

export const PART_LABEL: Record<BrandPart, { label: string; hint: string }> = {
  watermark: { label: 'Watermark', hint: 'Logo over the whole programme' },
  intro: { label: 'Intro', hint: 'Plays first; everything moves later' },
  outro: { label: 'Outro', hint: 'Plays after the last clip' },
  subtitles: { label: 'Caption style', hint: 'Every caption line gets the kit style' },
  hook: { label: 'Hook text', hint: 'Restyles the hook text layer' },
  music: { label: 'Music bed', hint: 'Looped under the programme, ducks under speech' },
};

export const PART_ORDER: readonly BrandPart[] = BRAND_PARTS;

/** What each part needs from the kit, for the disabled state of a checkbox ("Add one in the Brand Kit"). */
export function partAvailability(kit: BrandKit): Record<BrandPart, string | null> {
  const s = kit.spec;
  return {
    watermark: s.watermark.assetId ? null : 'This kit has no watermark logo yet.',
    intro: s.introAssetId ? null : 'This kit has no intro video yet.',
    outro: s.outroAssetId ? null : 'This kit has no outro video yet.',
    subtitles: null,
    // without a hook text style the kit's hook card is used
    hook: null,
    music: s.musicBed.assetId ? null : 'This kit has no music bed yet.',
  };
}

export interface BrandPreviewLine {
  part: BrandPart;
  status: 'applied' | 'skipped';
  text: string;
}

/** Runs the pure apply on a copy and describes the outcome per part, in the dialog's order. */
export function previewBrandApply(args: {
  project: Project;
  kit: BrandKit;
  assets: readonly BrandAsset[];
  parts: readonly BrandPart[];
  previousKit?: BrandKit | null;
  newId: (prefix: string) => string;
}): { result: ApplyBrandResult; lines: BrandPreviewLine[] } {
  const result = applyBrandToProject(args);
  const lines: BrandPreviewLine[] = [];
  for (const part of PART_ORDER) {
    const sk = result.skipped.find((s) => s.part === part);
    if (sk) lines.push({ part, status: 'skipped', text: sk.reason });
    else if (result.applied.includes(part))
      lines.push({ part, status: 'applied', text: result.details[part] ?? PART_LABEL[part].hint });
  }
  return { result, lines };
}

/* ------------------------------------------------------------------------------ B-roll ------- */

/** Longest passage `broll:suggest` accepts. */
export const SUGGEST_MAX_CHARS = 2000;

/**
 * The words spoken in the selection, for "Suggest B-roll": the selected caption lines, or — when clips are selected
 * instead — the caption lines that overlap them. Empty when there is nothing to read.
 */
export function selectionTranscript(
  project: Pick<Project, 'tracks'>,
  ids: readonly string[],
): string {
  if (ids.length === 0) return '';
  const want = new Set(ids);
  const cues = project.tracks
    .flatMap((t) => t.items)
    .filter((i): i is SubtitleItem => i.type === 'subtitle')
    .sort((a, b) => a.startSec - b.startSec);
  const chosen = project.tracks.flatMap((t) => t.items).filter((i) => want.has(i.id));
  const picked = chosen.filter((i) => i.type === 'subtitle');
  let lines: SubtitleItem[];
  if (picked.length) lines = cues.filter((c) => want.has(c.id));
  else {
    const ranges = chosen
      .filter((i) => i.type === 'video' || i.type === 'audio' || i.type === 'image')
      .map((i) => ({ s: i.startSec, e: i.startSec + i.durationSec }));
    lines = cues.filter((c) =>
      ranges.some((r) => c.startSec < r.e - 1e-6 && c.startSec + c.durationSec > r.s + 1e-6),
    );
  }
  const text = lines
    .map((c) => c.words.map((w) => w.w).join(' '))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > SUGGEST_MAX_CHARS ? text.slice(0, SUGGEST_MAX_CHARS) : text;
}
