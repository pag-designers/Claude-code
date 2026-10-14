/**
 * Pure helpers of the Brand Kit page (no React, no DOM): file validation for drops, asset references, tags, colours,
 * posting windows, watermark preview geometry. Unit tested in test/unit/renderer-brand-helpers.test.ts.
 */
import {
  BRAND_ASSET_KINDS,
  BRAND_FORMATS,
  brandKindsForExt,
  watermarkRect,
  type BrandAsset,
  type BrandAssetKind,
  type BrandKitSpec,
  type PostingWindow,
  type Watermark,
  type WatermarkRect,
} from '@shared/brand';
import { ASPECT_SIZES } from '@shared/editor';

/* ------------------------------------------------------------------------------------- sections ---- */

/** Singular/plural nouns per asset kind, used in labels and messages. */
export const KIND_NOUN: Record<BrandAssetKind, { one: string; many: string; section: string }> = {
  logo: { one: 'logo', many: 'logos', section: 'Logos / Watermarks' },
  image: { one: 'image', many: 'images', section: 'Images' },
  video: { one: 'video', many: 'videos', section: 'Videos' },
  audio: { one: 'audio file', many: 'audio files', section: 'Audio' },
  font: { one: 'font', many: 'fonts', section: 'Fonts' },
};

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

export function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

export function stripExt(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

const MB = 2 ** 20;
export function humanBytes(n: number): string {
  if (n >= 2 ** 30) return `${(n / 2 ** 30).toFixed(1)} GB`;
  if (n >= MB) return `${(n / MB).toFixed(n >= 10 * MB ? 0 : 1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

export interface DroppedFile {
  name: string;
  size: number;
}
export interface FileProblem {
  name: string;
  message: string;
}

/**
 * Splits dropped files into the ones the section accepts and the ones to reject with a clear message. The main process
 * validates again; this gives instant feedback and keeps wrong files from ever crossing the bridge.
 */
export function validateDrop<T extends DroppedFile>(
  files: readonly T[],
  kind: BrandAssetKind,
): { accepted: T[]; rejected: FileProblem[] } {
  const fmt = BRAND_FORMATS[kind];
  const accepted: T[] = [];
  const rejected: FileProblem[] = [];
  for (const f of files) {
    const ext = extOf(f.name);
    if (!fmt.extensions.includes(ext)) {
      const elsewhere = brandKindsForExt(ext).filter((k) => k !== kind);
      const hint = elsewhere.length
        ? ` It belongs in ${elsewhere.map((k) => KIND_NOUN[k].section).join(' or ')}.`
        : '';
      rejected.push({
        name: f.name,
        message: `${ext ? `.${ext.toUpperCase()}` : 'This file type'} is not supported here. Use ${fmt.label}.${hint}`,
      });
    } else if (f.size > fmt.maxBytes) {
      rejected.push({
        name: f.name,
        message: `Too large (${humanBytes(f.size)}). The limit for ${KIND_NOUN[kind].many} is ${humanBytes(fmt.maxBytes)}.`,
      });
    } else accepted.push(f);
  }
  return { accepted, rejected };
}

/** Friendly wording of the `stage` strings main reports in `brand:progress`. */
export function stageLabel(stage: string): string {
  const s = stage.toLowerCase();
  if (/(upload)/.test(s)) return 'Uploading';
  if (/(probe|read|inspect)/.test(s)) return 'Reading file';
  if (/(loud|lufs|normal)/.test(s)) return 'Measuring loudness';
  if (/(preview|proxy|transcode)/.test(s)) return 'Making preview';
  if (/(thumb|poster|frame)/.test(s)) return 'Making thumbnail';
  if (/(convert|raster|font)/.test(s)) return 'Converting';
  if (/done|complete/.test(s)) return 'Done';
  return stage ? stage.charAt(0).toUpperCase() + stage.slice(1) : 'Working';
}

/* ----------------------------------------------------------------------------------- references ---- */

export type AssetRef = 'Watermark' | 'Intro' | 'Outro' | 'Music bed';

/** Which parts of the kit point at this asset (deleting it clears them). */
export function refsOfAsset(spec: BrandKitSpec, assetId: string): AssetRef[] {
  const out: AssetRef[] = [];
  if (spec.watermark.assetId === assetId) out.push('Watermark');
  if (spec.introAssetId === assetId) out.push('Intro');
  if (spec.outroAssetId === assetId) out.push('Outro');
  if (spec.musicBed.assetId === assetId) out.push('Music bed');
  return out;
}

export function refsOfAssets(spec: BrandKitSpec, ids: readonly string[]): AssetRef[] {
  const set = new Set<AssetRef>();
  for (const id of ids) for (const r of refsOfAsset(spec, id)) set.add(r);
  return [...set];
}

/** The spec keys that would drop their reference to deleted assets (used for the optimistic UI). */
export function clearRefs(spec: BrandKitSpec, ids: readonly string[]): Partial<BrandKitSpec> {
  const gone = new Set(ids);
  const patch: Partial<BrandKitSpec> = {};
  if (spec.watermark.assetId && gone.has(spec.watermark.assetId))
    patch.watermark = { ...spec.watermark, assetId: null };
  if (spec.introAssetId && gone.has(spec.introAssetId)) patch.introAssetId = null;
  if (spec.outroAssetId && gone.has(spec.outroAssetId)) patch.outroAssetId = null;
  if (spec.musicBed.assetId && gone.has(spec.musicBed.assetId))
    patch.musicBed = { ...spec.musicBed, assetId: null };
  return patch;
}

export function groupByKind<T extends Pick<BrandAsset, 'kind'>>(
  assets: readonly T[],
): Record<BrandAssetKind, T[]> {
  const out = Object.fromEntries(BRAND_ASSET_KINDS.map((k) => [k, [] as T[]])) as Record<
    BrandAssetKind,
    T[]
  >;
  for (const a of assets) out[a.kind].push(a);
  return out;
}

/* ---------------------------------------------------------------------------------------- colours ---- */

export const HEX_RE = /^#[0-9a-fA-F]{6}$/;
export const isHex = (v: string) => HEX_RE.test(v);

/** Accepts "abc", "#abc", "A1B2C3", "#a1b2c3" → "#A1B2C3"; null when it is not a colour. */
export function normalizeHex(raw: string): string | null {
  let v = raw.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(v)) v = [...v].map((c) => c + c).join('');
  return /^[0-9a-fA-F]{6}$/.test(v) ? `#${v.toUpperCase()}` : null;
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

/** `rgba()` for CSS from a #RRGGBB and an alpha 0-1. */
export function hexToRgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(isHex(hex) ? hex : '#000000');
  return `rgba(${r}, ${g}, ${b}, ${Math.min(1, Math.max(0, alpha))})`;
}

/** WCAG relative luminance 0-1. */
export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** True when dark text reads better than light text on this colour. */
export const isLightColor = (hex: string) => luminance(isHex(hex) ? hex : '#000000') > 0.4;

/** Names for swatches proposed by "Extract from logo": plain colour families, deterministic. */
export function colorFamilyName(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2 / 255;
  const d = max - min;
  if (d < 18) return l > 0.9 ? 'White' : l < 0.14 ? 'Black' : l > 0.55 ? 'Light grey' : 'Grey';
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  const tone = l > 0.7 ? 'Light ' : l < 0.28 ? 'Dark ' : '';
  const base =
    h < 15 || h >= 345
      ? 'red'
      : h < 40
        ? 'orange'
        : h < 65
          ? 'yellow'
          : h < 160
            ? 'green'
            : h < 200
              ? 'teal'
              : h < 255
                ? 'blue'
                : h < 290
                  ? 'violet'
                  : 'pink';
  return tone ? tone + base : base.charAt(0).toUpperCase() + base.slice(1);
}

/** A unique swatch name: "Blue", then "Blue 2", "Blue 3" … (max 40 chars, the schema limit). */
export function uniqueName(base: string, taken: readonly string[]): string {
  const lower = new Set(taken.map((t) => t.toLowerCase()));
  const clean = base.trim().slice(0, 34) || 'Colour';
  if (!lower.has(clean.toLowerCase())) return clean;
  for (let i = 2; i < 1000; i++) {
    const n = `${clean} ${i}`;
    if (!lower.has(n.toLowerCase())) return n;
  }
  return clean;
}

export function groupColors<T extends { group: string }>(
  colors: readonly T[],
): { group: string; colors: T[] }[] {
  const order: string[] = [];
  const map = new Map<string, T[]>();
  for (const c of colors) {
    if (!map.has(c.group)) {
      map.set(c.group, []);
      order.push(c.group);
    }
    map.get(c.group)!.push(c);
  }
  return order.map((group) => ({ group, colors: map.get(group)! }));
}

/* ---------------------------------------------------------------------------------------- ids ------ */

let counter = 0;
/** Short unique id for kit-owned objects (swatches, text styles, hashtag sets, windows). */
export function newId(prefix: string): string {
  counter = (counter + 1) % 1e6;
  const rnd =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 10)
      : Math.random().toString(36).slice(2, 12);
  return `${prefix}_${rnd}${counter.toString(36)}`;
}

/* ---------------------------------------------------------------------------------------- hashtags -- */

/** "#Growth Hacks!" → "GrowthHacks"; letters, digits, underscore and other Unicode letters survive. */
export function normalizeTag(raw: string): string {
  return raw
    .replace(/^#+/, '')
    .replace(/[^\p{L}\p{N}_]/gu, '')
    .slice(0, 60);
}

/** Splits pasted text ("#a #b, c\nd") into normalised unique tags. */
export function parseTags(input: string, existing: readonly string[] = []): string[] {
  const seen = new Set(existing.map((t) => t.toLowerCase()));
  const out: string[] = [];
  for (const part of input.split(/[\s,;]+/)) {
    const t = normalizeTag(part);
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      out.push(t);
    }
  }
  return out;
}

/* ---------------------------------------------------------------------------- posting windows ------ */

export const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
export const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

const toMinutes = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** Error text for a posting window, null when it is valid. */
export function windowError(w: Pick<PostingWindow, 'start' | 'end' | 'days'>): string | null {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(w.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(w.end))
    return 'Enter times as HH:MM.';
  if (toMinutes(w.end) <= toMinutes(w.start)) return 'The window must end after it starts.';
  if (w.days.length === 0) return 'Pick at least one day.';
  return null;
}

/** "Mon–Fri", "Every day", "Sat, Sun", "Mon, Wed, Fri". */
export function describeDays(days: readonly number[]): string {
  const d = [...new Set(days)].sort((a, b) => a - b);
  if (d.length === 7) return 'Every day';
  if (d.length === 0) return 'No days';
  if (d.length === 5 && d.join() === '1,2,3,4,5') return 'Mon–Fri';
  if (d.length === 2 && d.join() === '0,6') return 'Sat, Sun';
  let consecutive = d.length >= 3;
  for (let i = 1; i < d.length; i++) if (d[i]! !== d[i - 1]! + 1) consecutive = false;
  if (consecutive) return `${DAY_LABELS[d[0]!]}–${DAY_LABELS[d[d.length - 1]!]}`;
  return d.map((x) => DAY_LABELS[x]).join(', ');
}

/* ------------------------------------------------------------------------- watermark preview ------ */

export const PREVIEW_ASPECTS = ['9:16', '4:5', '1:1', '16:9'] as const;
export type PreviewAspect = (typeof PREVIEW_ASPECTS)[number];

export function canvasOf(aspect: PreviewAspect): { width: number; height: number } {
  return ASPECT_SIZES[aspect];
}

/** Logo width/height; 1 when unknown (an SVG without probed dimensions). */
export function assetAspect(a: Pick<BrandAsset, 'width' | 'height'> | null | undefined): number {
  return a?.width && a.height ? a.width / a.height : 1;
}

export interface PreviewBox {
  /** % of the canvas */
  left: number;
  top: number;
  width: number;
  height: number;
  rect: WatermarkRect;
  canvas: { width: number; height: number };
}

/** The watermark's box on the preview as percentages of the frame: the SAME `watermarkRect` the finisher uses. */
export function watermarkPreviewBox(
  aspect: PreviewAspect,
  wm: Pick<Watermark, 'position' | 'sizePct' | 'marginPct' | 'safeArea'>,
  logoAspect: number,
): PreviewBox {
  const canvas = canvasOf(aspect);
  const rect = watermarkRect(canvas, wm, logoAspect);
  return {
    left: (rect.x / canvas.width) * 100,
    top: (rect.y / canvas.height) * 100,
    width: (rect.w / canvas.width) * 100,
    height: (rect.h / canvas.height) * 100,
    rect,
    canvas,
  };
}

/* ------------------------------------------------------------------------------- audio / video ----- */

export function formatLufs(l: number | null | undefined): string | null {
  return l === null || l === undefined || !Number.isFinite(l) ? null : `${l.toFixed(1)} LUFS`;
}

export function formatDur(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '--:--';
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** Weight number → name used in font cards. */
export function weightName(w: number): string {
  const names: Record<number, string> = {
    100: 'Thin',
    200: 'Extra Light',
    300: 'Light',
    400: 'Regular',
    500: 'Medium',
    600: 'Semi Bold',
    700: 'Bold',
    800: 'Extra Bold',
    900: 'Black',
  };
  return names[w] ?? String(w);
}

/* ------------------------------------------------------------------------------ virtual grids ------- */

export interface GridWindow {
  cols: number;
  rows: number;
  /** First/last row to render (inclusive), -1/-1 when empty. */
  startRow: number;
  endRow: number;
  /** Index range of the items in those rows. */
  startIndex: number;
  endIndex: number;
  totalHeight: number;
  offsetTop: number;
}

/** Windowing maths for a fixed-row-height grid: which rows are visible (plus overscan). */
export function gridWindow(p: {
  count: number;
  width: number;
  minItemWidth: number;
  gap: number;
  rowHeight: number;
  scrollTop: number;
  viewport: number;
  overscanRows?: number;
}): GridWindow {
  const cols = Math.max(1, Math.floor((p.width + p.gap) / (p.minItemWidth + p.gap)));
  const rows = Math.ceil(p.count / cols);
  const step = p.rowHeight + p.gap;
  const totalHeight = rows > 0 ? rows * step - p.gap : 0;
  if (rows === 0)
    return {
      cols,
      rows,
      startRow: -1,
      endRow: -1,
      startIndex: 0,
      endIndex: -1,
      totalHeight,
      offsetTop: 0,
    };
  const over = p.overscanRows ?? 2;
  const startRow = Math.max(0, Math.floor(p.scrollTop / step) - over);
  const endRow = Math.min(rows - 1, Math.floor((p.scrollTop + p.viewport) / step) + over);
  return {
    cols,
    rows,
    startRow,
    endRow,
    startIndex: startRow * cols,
    endIndex: Math.min(p.count - 1, (endRow + 1) * cols - 1),
    totalHeight,
    offsetTop: startRow * step,
  };
}

/* ------------------------------------------------------------------------------- music bed curve ---- */

export interface EnvelopePoint {
  t: number;
  /** dB, -40 (silent) … 0 */
  db: number;
}

/**
 * The music bed level over a sample timeline: fade in, steady level, a dip while someone speaks (ducking), fade out.
 * Purely illustrative (the finisher mixes the real audio), but built from the very numbers it will use.
 */
export function bedEnvelope(
  bed: {
    gainDb: number;
    duckEnabled: boolean;
    duckAmountDb: number;
    fadeInSec: number;
    fadeOutSec: number;
  },
  totalSec: number,
  speech: readonly (readonly [number, number])[],
): EnvelopePoint[] {
  const floor = -40;
  const ramp = 0.25;
  const base = Math.max(floor, Math.min(0, bed.gainDb));
  const low = Math.max(floor, base - (bed.duckEnabled ? bed.duckAmountDb : 0));
  const pts: EnvelopePoint[] = [];
  const level = (t: number) => {
    let db = base;
    if (bed.duckEnabled) {
      for (const [a, b] of speech) {
        if (t >= a - ramp && t < a)
          db = Math.min(db, base + ((low - base) * (t - (a - ramp))) / ramp);
        else if (t >= a && t <= b) db = Math.min(db, low);
        else if (t > b && t <= b + ramp) db = Math.min(db, low + ((base - low) * (t - b)) / ramp);
      }
    }
    if (bed.fadeInSec > 0 && t < bed.fadeInSec) db = floor + ((db - floor) * t) / bed.fadeInSec;
    const out = totalSec - bed.fadeOutSec;
    if (bed.fadeOutSec > 0 && t > out)
      db = floor + ((db - floor) * (totalSec - t)) / bed.fadeOutSec;
    return Math.max(floor, db);
  };
  const times = new Set<number>([0, totalSec]);
  for (let t = 0; t <= totalSec; t += 0.25) times.add(Math.round(t * 100) / 100);
  for (const [a, b] of speech)
    for (const t of [a - ramp, a, b, b + ramp]) if (t > 0 && t < totalSec) times.add(t);
  for (const t of [bed.fadeInSec, totalSec - bed.fadeOutSec])
    if (t > 0 && t < totalSec) times.add(t);
  for (const t of [...times].sort((x, y) => x - y)) pts.push({ t, db: level(t) });
  return pts;
}
