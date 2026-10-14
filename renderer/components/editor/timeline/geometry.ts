/**
 * Pure timeline geometry: time <-> pixel maths, virtual-window culling, track layout, drop-target and marquee
 * hit-testing, ruler ticks, snapping, trim clamping and keyframe collection. No React, no DOM, no store — everything
 * here is unit-tested (test/unit/editor-timeline-geometry.test.ts) and shared by the timeline components.
 *
 * Coordinates: "content x" = seconds * pxPerSec (origin at time 0, independent of scrolling and of the sticky track
 * header column); "content y" = distance from the top of the first track row.
 */
import type { Asset, Item, Project, Track, TrackKind } from '@shared/editor';

/* ------------------------------------------------------------------ constants ---------------- */

export const MIN_PX_PER_SEC = 1;
export const MAX_PX_PER_SEC = 600;
export const RULER_H = 32;
export const HEADER_W = 200;
export const SECTION_GAP = 10;
/** Empty drop area under the last track ("drop here to create a new track"). */
export const NEW_TRACK_ZONE_H = 52;
export const SNAP_PX = 8;
export const MIN_ITEM_PX = 2;

export const TRACK_HEIGHT: Record<TrackKind, number> = {
  video: 64,
  overlay: 54,
  image: 46,
  text: 40,
  subtitle: 40,
  audio: 54,
  sfx: 42,
};

export type Section = 'visual' | 'audio';
export const sectionOf = (kind: TrackKind): Section =>
  kind === 'audio' || kind === 'sfx' ? 'audio' : 'visual';

/* ------------------------------------------------------------------ time <-> px -------------- */

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Content x (px from time 0) of a time. */
export const secToPx = (sec: number, pxPerSec: number): number => sec * pxPerSec;
export const pxToSec = (px: number, pxPerSec: number): number => px / pxPerSec;

/** Viewport-relative x (px from the left edge of the lane viewport) of a time. */
export const secToViewportPx = (sec: number, pxPerSec: number, scrollSec: number): number =>
  (sec - scrollSec) * pxPerSec;
export const viewportPxToSec = (px: number, pxPerSec: number, scrollSec: number): number =>
  scrollSec + px / pxPerSec;

export const snapToFrame = (sec: number, fps: number): number =>
  Math.max(0, Math.round(sec * fps) / fps);

export const clampZoom = (px: number): number => clamp(px, MIN_PX_PER_SEC, MAX_PX_PER_SEC);

/** New zoom/scroll that keeps `anchorSec` under the same screen pixel. */
export function zoomAround(
  cur: { pxPerSec: number; scrollSec: number },
  nextPxPerSec: number,
  anchorSec: number,
): { pxPerSec: number; scrollSec: number } {
  const px = clampZoom(nextPxPerSec);
  const offsetPx = (anchorSec - cur.scrollSec) * cur.pxPerSec;
  return { pxPerSec: px, scrollSec: Math.max(0, anchorSec - offsetPx / px) };
}

/** Zoom that makes `durationSec` fill the viewport (with a little air). */
export function fitZoom(durationSec: number, viewportPx: number, padFrac = 0.04): number {
  if (!(durationSec > 0) || !(viewportPx > 0)) return 60;
  return clampZoom((viewportPx * (1 - padFrac * 2)) / durationSec);
}

/** Logarithmic slider <-> zoom mapping (0..1). */
export const zoomToSlider = (px: number): number =>
  Math.log(clampZoom(px) / MIN_PX_PER_SEC) / Math.log(MAX_PX_PER_SEC / MIN_PX_PER_SEC);
export const sliderToZoom = (v: number): number =>
  clampZoom(MIN_PX_PER_SEC * Math.pow(MAX_PX_PER_SEC / MIN_PX_PER_SEC, clamp(v, 0, 1)));

/** Multiplicative zoom factor for a wheel/pinch delta (positive deltaY = zoom out). */
export const wheelZoomFactor = (deltaY: number): number =>
  Math.exp(-clamp(deltaY, -240, 240) * 0.0022);

/** Signed auto-scroll speed (px/s) when a drag is within `edge` px of the viewport's edges; 0 elsewhere. */
export function edgeScrollSpeed(
  pos: number,
  min: number,
  max: number,
  edge = 56,
  maxSpeed = 1500,
): number {
  if (pos < min + edge) return -maxSpeed * Math.min(1, (min + edge - pos) / edge) ** 2;
  if (pos > max - edge) return maxSpeed * Math.min(1, (pos - (max - edge)) / edge) ** 2;
  return 0;
}

/* ------------------------------------------------------------------ timecode ----------------- */

const pad2 = (n: number) => String(n).padStart(2, '0');

/** `MM:SS:FF` (`H:MM:SS:FF` from one hour). */
export function formatTimecode(sec: number, fps: number): string {
  const f = Math.max(1, Math.round(fps));
  const total = Math.max(0, Math.round((Number.isFinite(sec) ? sec : 0) * f));
  const frames = total % f;
  const s = Math.floor(total / f);
  const ss = s % 60;
  const m = Math.floor(s / 60);
  if (m >= 60) return `${Math.floor(m / 60)}:${pad2(m % 60)}:${pad2(ss)}:${pad2(frames)}`;
  return `${pad2(m)}:${pad2(ss)}:${pad2(frames)}`;
}

/** Parses what a person types into the timecode field. 1 part = seconds, 2 = m:ss, 3 = mm:ss:ff, 4 = h:mm:ss:ff. */
export function parseTimecode(input: string, fps: number): number | null {
  const parts = input.trim().split(':');
  if (parts.length < 1 || parts.length > 4 || parts.some((p) => p.trim() === '')) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
  const f = Math.max(1, Math.round(fps));
  const [a = 0, b = 0, c = 0, d = 0] = nums;
  switch (nums.length) {
    case 1:
      return a;
    case 2:
      return a * 60 + b;
    case 3:
      return a * 60 + b + c / f;
    default:
      return a * 3600 + b * 60 + c + d / f;
  }
}

/** Compact duration for labels: 0:03.2 / 1:02. */
export function formatSpanShort(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`;
}

/* ------------------------------------------------------------------ ruler ticks -------------- */

export interface RulerTick {
  t: number;
  kind: 'major' | 'minor';
  label?: string;
}

const SECOND_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
const FRAME_STEPS = [1, 2, 3, 5, 10, 15];

export function rulerLabel(t: number, stepSec: number, fps: number): string {
  if (stepSec < 1 - 1e-9) return formatTimecode(t, fps).replace(/^00:/, '0:');
  const total = Math.round(t);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}

/** Picks the major step (seconds) so labels are at least `minLabelPx` apart. */
export function majorStep(pxPerSec: number, fps: number, minLabelPx = 84): number {
  const f = Math.max(1, Math.round(fps));
  for (const n of FRAME_STEPS) {
    const step = n / f;
    if (step < 1 - 1e-9 && step * pxPerSec >= minLabelPx) return step;
  }
  for (const s of SECOND_STEPS) if (s * pxPerSec >= minLabelPx) return s;
  return SECOND_STEPS[SECOND_STEPS.length - 1] ?? 7200;
}

/** Adaptive ruler ticks for [startSec, endSec]: frame ticks at high zoom, seconds, minutes, hours when zoomed out. */
export function rulerTicks(
  pxPerSec: number,
  startSec: number,
  endSec: number,
  fps: number,
): RulerTick[] {
  const f = Math.max(1, Math.round(fps));
  const step = majorStep(pxPerSec, f);
  const out: RulerTick[] = [];
  // minor subdivisions
  let minorStep = 0;
  if (step < 1 - 1e-9) {
    // frame steps: a minor tick on every frame when frames are >= 5px apart
    if (pxPerSec / f >= 5) minorStep = 1 / f;
  } else {
    for (const d of [10, 5, 4, 2]) {
      const cand = step / d;
      if (cand * pxPerSec >= 9 && Math.abs(cand * 1000 - Math.round(cand * 1000)) < 1e-6) {
        minorStep = cand;
        break;
      }
    }
  }
  const lo = Math.max(0, startSec);
  if (minorStep > 0) {
    const i0 = Math.ceil(lo / minorStep - 1e-9);
    const i1 = Math.floor(endSec / minorStep + 1e-9);
    const cap = Math.min(i1, i0 + 4000);
    for (let i = i0; i <= cap; i++) {
      const t = i * minorStep;
      const ratio = t / step;
      const isMajor = Math.abs(ratio - Math.round(ratio)) < 1e-6;
      if (!isMajor) out.push({ t, kind: 'minor' });
    }
  }
  const j0 = Math.ceil(lo / step - 1e-9);
  const j1 = Math.floor(endSec / step + 1e-9);
  for (let j = j0; j <= Math.min(j1, j0 + 2000); j++) {
    const t = j * step;
    out.push({ t, kind: 'major', label: rulerLabel(t, step, f) });
  }
  return out.sort((a, b) => a.t - b.t);
}

/* ------------------------------------------------------------------ virtual window ----------- */

export interface TimeWindow {
  start: number;
  end: number;
}

/**
 * The time window to render: the visible span plus an overscan margin, quantised to `chunkSec` so the rendered set
 * only changes when the viewport crosses a chunk boundary (not on every scroll event).
 */
export function renderWindow(
  scrollSec: number,
  viewportSec: number,
  overscanFrac = 0.5,
): TimeWindow {
  const vs = Math.max(viewportSec, 0.001);
  const chunk = vs * 0.5;
  const start = Math.max(0, Math.floor((scrollSec - vs * overscanFrac) / chunk) * chunk);
  const end = Math.ceil((scrollSec + vs * (1 + overscanFrac)) / chunk) * chunk;
  return { start, end };
}

const maxDurCache = new WeakMap<readonly Item[], number>();
/** Longest item on a track (cached per items array) — bounds the backwards scan of the culling search. */
export function maxItemDuration(items: readonly Item[]): number {
  const cached = maxDurCache.get(items);
  if (cached !== undefined) return cached;
  let m = 0;
  for (const it of items) if (it.durationSec > m) m = it.durationSec;
  maxDurCache.set(items, m);
  return m;
}

/** Index of the first item with startSec >= t (items sorted by startSec). */
export function lowerBoundByStart(items: readonly Item[], t: number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((items[mid]?.startSec ?? 0) < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Items of a track that intersect [start, end] — O(log n + k). */
export function cullItems(items: readonly Item[], start: number, end: number): Item[] {
  if (items.length === 0) return [];
  const from = lowerBoundByStart(items, start - maxItemDuration(items));
  const out: Item[] = [];
  for (let i = from; i < items.length; i++) {
    const it = items[i];
    if (!it) continue;
    if (it.startSec > end) break;
    if (it.startSec + it.durationSec >= start) out.push(it);
  }
  return out;
}

/** Visible slice of an item in LOCAL item seconds, clamped to the render window (null when fully outside). */
export function visibleSpan(
  item: Pick<Item, 'startSec' | 'durationSec'>,
  win: TimeWindow,
): { from: number; to: number } | null {
  const from = Math.max(0, win.start - item.startSec);
  const to = Math.min(item.durationSec, win.end - item.startSec);
  return to > from ? { from, to } : null;
}

/* ------------------------------------------------------------------ track layout ------------- */

export interface RowLayout {
  trackId: string;
  /** Index in `project.tracks` (z-order, 0 = bottom). */
  arrayIndex: number;
  kind: TrackKind;
  top: number;
  height: number;
  section: Section;
}

export interface TracksLayout {
  rows: RowLayout[];
  byId: Map<string, RowLayout>;
  /** Height of all rows incl. the gap between the visual and audio sections. */
  height: number;
}

/** Display order: visual tracks top-most = highest z (reverse array order), audio/sfx tracks below in array order. */
export function displayOrder(tracks: readonly Track[]): { track: Track; arrayIndex: number }[] {
  const visual: { track: Track; arrayIndex: number }[] = [];
  const audio: { track: Track; arrayIndex: number }[] = [];
  tracks.forEach((track, arrayIndex) => {
    (sectionOf(track.kind) === 'visual' ? visual : audio).push({ track, arrayIndex });
  });
  return [...visual.reverse(), ...audio];
}

export function layoutTracks(
  tracks: readonly Track[],
  heightOf: (t: Track) => number = (t) => TRACK_HEIGHT[t.kind],
): TracksLayout {
  const rows: RowLayout[] = [];
  const byId = new Map<string, RowLayout>();
  let y = 0;
  let prev: Section | null = null;
  for (const { track, arrayIndex } of displayOrder(tracks)) {
    const section = sectionOf(track.kind);
    if (prev && prev !== section) y += SECTION_GAP;
    const row: RowLayout = {
      trackId: track.id,
      arrayIndex,
      kind: track.kind,
      top: y,
      height: heightOf(track),
      section,
    };
    rows.push(row);
    byId.set(track.id, row);
    y += row.height;
    prev = section;
  }
  return { rows, byId, height: y };
}

export function trackAtY(layout: TracksLayout, y: number): RowLayout | null {
  const rows = layout.rows;
  let lo = 0;
  let hi = rows.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = rows[mid];
    if (!r) return null;
    if (y < r.top) hi = mid - 1;
    else if (y >= r.top + r.height) lo = mid + 1;
    else return r;
  }
  return null;
}

export type DropTarget =
  | { kind: 'track'; row: RowLayout }
  /** Below the last row (or in an empty timeline): drop creates a new track. */
  | { kind: 'new-track' }
  | { kind: 'none' };

/**
 * Where does a drop at content-y land? Over a row → that track; in the gap between sections → the nearest row;
 * below the last row (the "new track" zone) → a new track; above the first row → nothing.
 */
export function resolveDropTarget(layout: TracksLayout, y: number): DropTarget {
  if (layout.rows.length === 0) return y >= 0 ? { kind: 'new-track' } : { kind: 'none' };
  if (y < 0) return { kind: 'none' };
  if (y >= layout.height) return { kind: 'new-track' };
  const hit = trackAtY(layout, y);
  if (hit) return { kind: 'track', row: hit };
  // inside a section gap: nearest row
  let best: RowLayout | null = null;
  let bd = Infinity;
  for (const r of layout.rows) {
    const d = y < r.top ? r.top - y : y - (r.top + r.height);
    if (d >= 0 && d < bd) {
      bd = d;
      best = r;
    }
  }
  return best ? { kind: 'track', row: best } : { kind: 'none' };
}

/** Which track kind a dropped asset should create / be accepted by. */
export function newTrackKindForAsset(assetKind: Asset['kind']): TrackKind {
  switch (assetKind) {
    case 'audio':
      return 'audio';
    case 'image':
      return 'image';
    default:
      return 'overlay';
  }
}

/* ------------------------------------------------------------------ hit-testing -------------- */

export interface ContentRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const normRect = (a: { x: number; y: number }, b: { x: number; y: number }): ContentRect => ({
  x0: Math.min(a.x, b.x),
  y0: Math.min(a.y, b.y),
  x1: Math.max(a.x, b.x),
  y1: Math.max(a.y, b.y),
});

/** Ids of the items touched by a content-space rectangle (locked tracks and hidden tracks are skipped). */
export function marqueeHits(
  rect: ContentRect,
  layout: TracksLayout,
  tracks: readonly Track[],
  pxPerSec: number,
): string[] {
  const t0 = rect.x0 / pxPerSec;
  const t1 = rect.x1 / pxPerSec;
  const out: string[] = [];
  for (const row of layout.rows) {
    if (row.top + row.height <= rect.y0 || row.top >= rect.y1) continue;
    const track = tracks[row.arrayIndex];
    if (!track || track.locked) continue;
    for (const it of cullItems(track.items, t0, t1)) {
      const s = it.startSec;
      const e = it.startSec + it.durationSec;
      if (e >= t0 && s <= t1) out.push(it.id);
    }
  }
  return out;
}

/** Item under a content point (topmost = last in the track), or null. */
export function itemAtPoint(
  track: Pick<Track, 'items'>,
  sec: number,
  pxPerSec: number,
  tolPx = 0,
): Item | null {
  const tol = tolPx / pxPerSec;
  const cands = cullItems(track.items, sec - tol, sec + tol);
  for (let i = cands.length - 1; i >= 0; i--) {
    const it = cands[i];
    if (it && sec >= it.startSec - tol && sec <= it.startSec + it.durationSec + tol) return it;
  }
  return null;
}

/* ------------------------------------------------------------------ snapping ----------------- */

export type SnapKind = 'item' | 'playhead' | 'marker' | 'beat' | 'start';
export interface SnapPoint {
  t: number;
  kind: SnapKind;
}

/** Snap candidates for an edit that does NOT go through the store's previewMove (trim previews, drops, scrubbing). */
export function collectSnapPoints(
  project: Pick<Project, 'tracks' | 'markers' | 'assets'>,
  playheadSec: number,
  opts: { exclude?: ReadonlySet<string>; from?: number; to?: number } = {},
): SnapPoint[] {
  const pts: SnapPoint[] = [{ t: 0, kind: 'start' }];
  const inWin = (t: number) =>
    (opts.from === undefined || t >= opts.from) && (opts.to === undefined || t <= opts.to);
  if (inWin(playheadSec)) pts.push({ t: playheadSec, kind: 'playhead' });
  for (const m of project.markers) if (inWin(m.atSec)) pts.push({ t: m.atSec, kind: 'marker' });
  const assets = new Map(project.assets.map((a) => [a.id, a]));
  for (const tr of project.tracks) {
    if (tr.hidden) continue;
    for (const it of tr.items) {
      if (opts.exclude?.has(it.id)) continue;
      const e = it.startSec + it.durationSec;
      if (inWin(it.startSec)) pts.push({ t: it.startSec, kind: 'item' });
      if (inWin(e)) pts.push({ t: e, kind: 'item' });
      if (it.type === 'audio') {
        const beats = assets.get(it.assetId)?.beats;
        if (beats) {
          const speed = it.speed || 1;
          for (const b of beats) {
            const t = it.startSec + (b - it.inSec) / speed;
            if (t >= it.startSec && t <= e && inWin(t)) pts.push({ t, kind: 'beat' });
          }
        }
      }
    }
  }
  return pts;
}

/** Nearest snap point within `thresholdSec` (ties resolve to the earlier kind priority), or null. */
export function snapValue(
  t: number,
  points: readonly SnapPoint[],
  thresholdSec: number,
): SnapPoint | null {
  const PRIORITY: Record<SnapKind, number> = { playhead: 0, marker: 1, item: 2, start: 3, beat: 4 };
  let best: SnapPoint | null = null;
  let bd = thresholdSec;
  for (const p of points) {
    const d = Math.abs(p.t - t);
    if (d < bd - 1e-9 || (best && Math.abs(d - bd) <= 1e-9 && PRIORITY[p.kind] < PRIORITY[best.kind])) {
      best = p;
      bd = d;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ trim clamping ------------ */

type MediaLike = Extract<Item, { type: 'video' | 'audio' }>;
const isMedia = (it: Item): it is MediaLike => it.type === 'video' || it.type === 'audio';

/**
 * Result of dragging one edge of `item` to `toSec` WITHOUT applying it: start edges keep the content in place (so they
 * can only grow left while source remains before `inSec`), end edges cannot pass the end of the source asset.
 */
export function clampTrim(
  item: Item,
  asset: Pick<Asset, 'durationSec'> | null | undefined,
  edge: 'start' | 'end',
  toSec: number,
  fps: number,
): { startSec: number; durationSec: number } {
  const minDur = Math.max(1 / Math.max(fps, 1), 0.04);
  const end = item.startSec + item.durationSec;
  if (edge === 'start') {
    let lo = 0;
    if (isMedia(item) && item.freezeAtSec === null) {
      const speed = item.speed || 1;
      lo = Math.max(0, item.startSec - item.inSec / speed);
    }
    const s = clamp(toSec, lo, end - minDur);
    return { startSec: s, durationSec: end - s };
  }
  let hi = Infinity;
  if (isMedia(item) && item.freezeAtSec === null && asset?.durationSec) {
    const speed = item.speed || 1;
    hi = item.startSec + (asset.durationSec - item.inSec) / speed;
  }
  const e = clamp(toSec, item.startSec + minDur, Math.max(hi, item.startSec + minDur));
  return { startSec: item.startSec, durationSec: e - item.startSec };
}

/* ------------------------------------------------------------------ keyframes ---------------- */

export type KfPath =
  | 'transform.x'
  | 'transform.y'
  | 'transform.scale'
  | 'transform.rotation'
  | 'transform.opacity'
  | 'crop.x'
  | 'crop.y'
  | 'crop.w'
  | 'crop.h'
  | 'volume'
  | 'blur'
  | 'color.exposure'
  | 'color.contrast'
  | 'color.saturation'
  | 'color.temperature';

export interface KfEntry {
  path: KfPath;
  index: number;
  /** Seconds local to the item. */
  t: number;
  v: number;
}

interface AnimLike {
  v: number;
  kf: readonly { t: number; v: number }[];
}
const animOf = (item: Item, path: KfPath): AnimLike | undefined => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dotted-path read over the discriminated union
  const o = item as any;
  const [a, b] = path.split('.') as [string, string | undefined];
  const node = b ? o[a]?.[b] : o[a];
  return node && Array.isArray(node.kf) ? (node as AnimLike) : undefined;
};

const ALL_PATHS: KfPath[] = [
  'transform.x',
  'transform.y',
  'transform.scale',
  'transform.rotation',
  'transform.opacity',
  'crop.x',
  'crop.y',
  'crop.w',
  'crop.h',
  'volume',
  'blur',
  'color.exposure',
  'color.contrast',
  'color.saturation',
  'color.temperature',
];

/** Every keyframe of an item, sorted by time (then path). */
export function collectKeyframes(item: Item): KfEntry[] {
  const out: KfEntry[] = [];
  for (const path of ALL_PATHS) {
    const a = animOf(item, path);
    if (!a) continue;
    a.kf.forEach((k, index) => {
      if (k.t <= item.durationSec + 1e-6) out.push({ path, index, t: k.t, v: k.v });
    });
  }
  return out.sort((x, y) => x.t - y.t || x.path.localeCompare(y.path));
}

/** Groups keyframes that share (almost) the same time into one diamond. */
export function groupKeyframes(entries: readonly KfEntry[], epsSec = 1e-3): KfEntry[][] {
  const groups: KfEntry[][] = [];
  for (const e of entries) {
    const last = groups[groups.length - 1];
    if (last && Math.abs((last[0]?.t ?? 0) - e.t) <= epsSec) last.push(e);
    else groups.push([e]);
  }
  return groups;
}

/* ------------------------------------------------------------------ labels ------------------- */

export const ITEM_TYPE_LABEL: Record<Item['type'], string> = {
  video: 'Video',
  audio: 'Audio',
  image: 'Image',
  text: 'Text',
  subtitle: 'Subtitle',
  shape: 'Shape',
};

export const TRACK_KIND_LABEL: Record<TrackKind, string> = {
  video: 'Video',
  overlay: 'Overlay',
  image: 'Image',
  text: 'Text',
  subtitle: 'Subtitles',
  audio: 'Music',
  sfx: 'Sound effects',
};

export const cueText = (it: Extract<Item, { type: 'subtitle' }>): string =>
  it.words.map((w) => w.w).join(' ');

export function itemLabel(item: Item, asset?: Pick<Asset, 'name'> | null): string {
  switch (item.type) {
    case 'text':
      return item.text.replace(/\s+/g, ' ').trim() || 'Text';
    case 'subtitle':
      return cueText(item) || 'Empty caption';
    case 'shape':
      return item.name ?? `${item.shape[0]?.toUpperCase()}${item.shape.slice(1)}`;
    default:
      return item.name ?? asset?.name ?? ITEM_TYPE_LABEL[item.type];
  }
}

/** Screen-reader description, e.g. "Interview, video, 0:03.0 to 0:12.4, selected". */
export function itemAriaLabel(
  item: Item,
  asset: Pick<Asset, 'name'> | null | undefined,
  selected: boolean,
): string {
  const a = formatSpanShort(item.startSec);
  const b = formatSpanShort(item.startSec + item.durationSec);
  const bits = [itemLabel(item, asset), ITEM_TYPE_LABEL[item.type].toLowerCase(), `${a} to ${b}`];
  if (item.locked) bits.push('locked');
  if (item.groupId) bits.push('grouped');
  if (selected) bits.push('selected');
  return bits.join(', ');
}

/** Index 0..5 into the group colour tokens, stable per group id. */
export function groupColorIndex(groupId: string): number {
  let h = 2166136261;
  for (let i = 0; i < groupId.length; i++) {
    h ^= groupId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 6;
}

/** Convenience: item end. */
export const endOf = (it: Pick<Item, 'startSec' | 'durationSec'>): number => it.startSec + it.durationSec;
