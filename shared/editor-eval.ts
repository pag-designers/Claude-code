import type {
  Animated,
  AudioItem,
  ColorAdjust,
  Crop,
  Ducking,
  Easing,
  Item,
  Keyframe,
  Project,
  SubtitleItem,
  TextAnimation,
  TextItem,
  Track,
  TransitionType,
  VideoItem,
} from './editor';

/* ------------------------------------------------------------------------------------------------
 * Pure evaluation of the editor project format. THE source of truth for visual / audio semantics:
 * the preview compositor and the FFmpeg compiler both call these (or sample them). See the header of
 * shared/editor.ts for the conventions. No DOM, no Node APIs, no randomness — same input, same output.
 * ---------------------------------------------------------------------------------------------- */

export const EPS = 1e-6;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const lerp = (a: number, b: number, p: number) => a + (b - a) * p;

/* ------------------------------------------------------------------ easing / keyframes ------- */

const BEZIER_PRESETS: Record<
  'ease-in' | 'ease-out' | 'ease-in-out',
  [number, number, number, number]
> = {
  'ease-in': [0.42, 0, 1, 1],
  'ease-out': [0, 0, 0.58, 1],
  'ease-in-out': [0.42, 0, 0.58, 1],
};

/** CSS-style cubic-bezier(x1,y1,x2,y2) as a function of progress (solves x(t)=p by Newton + bisection). */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (p: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sy = (t: number) => ((ay * t + by) * t + cy) * t;
  const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (p: number) => {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    let t = p;
    for (let i = 0; i < 8; i++) {
      const err = sx(t) - p;
      if (Math.abs(err) < 1e-7) return sy(t);
      const d = dx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    let lo = 0;
    let hi = 1;
    t = p;
    for (let i = 0; i < 40; i++) {
      const err = sx(t) - p;
      if (Math.abs(err) < 1e-7) break;
      if (err > 0) hi = t;
      else lo = t;
      t = (lo + hi) / 2;
    }
    return sy(t);
  };
}

const bezierCache = new Map<string, (p: number) => number>();
/** Eased progress for p ∈ [0,1]. 'hold' returns 0 until p reaches 1 (step). */
export function ease(e: Easing, p: number): number {
  const q = clamp(p, 0, 1);
  if (e === 'linear') return q;
  if (e === 'hold') return q >= 1 ? 1 : 0;
  const [x1, y1, x2, y2] =
    typeof e === 'string'
      ? BEZIER_PRESETS[e]
      : ([e.x1, e.y1, e.x2, e.y2] as [number, number, number, number]);
  const key = `${x1},${y1},${x2},${y2}`;
  let f = bezierCache.get(key);
  if (!f) {
    f = cubicBezier(x1, y1, x2, y2);
    bezierCache.set(key, f);
  }
  return f(q);
}

/** Value of a keyframe track at local time `t` (keyframes sorted by t). Clamps before the first / after the last. */
export function interpolate(kf: readonly Keyframe[], t: number, fallback: number): number {
  const n = kf.length;
  if (n === 0) return fallback;
  const first = kf[0] as Keyframe;
  if (t <= first.t) return first.v;
  const last = kf[n - 1] as Keyframe;
  if (t >= last.t) return last.v;
  for (let i = 0; i < n - 1; i++) {
    const a = kf[i] as Keyframe;
    const b = kf[i + 1] as Keyframe;
    if (t >= a.t && t < b.t) {
      const span = b.t - a.t;
      if (span <= EPS) return b.v;
      return lerp(a.v, b.v, ease(a.ease, (t - a.t) / span));
    }
  }
  return last.v;
}

export const animatedAt = (a: Animated, t: number): number =>
  a.kf.length ? interpolate(a.kf, t, a.v) : a.v;

/* ------------------------------------------------------------------ timeline helpers --------- */

export const itemEnd = (item: Pick<Item, 'startSec' | 'durationSec'>): number =>
  item.startSec + item.durationSec;

/** Half-open: an item is active on [start, end). */
export const isActive = (item: Pick<Item, 'startSec' | 'durationSec'>, t: number): boolean =>
  t >= item.startSec - EPS && t < itemEnd(item) - EPS;

export function projectDuration(project: Pick<Project, 'tracks'>): number {
  let end = 0;
  for (const tr of project.tracks) for (const it of tr.items) end = Math.max(end, itemEnd(it));
  return end;
}

export function findItem(
  project: Pick<Project, 'tracks'>,
  itemId: string,
): { track: Track; item: Item; index: number } | null {
  for (const track of project.tracks) {
    const index = track.items.findIndex((i) => i.id === itemId);
    if (index >= 0) return { track, item: track.items[index] as Item, index };
  }
  return null;
}

/* ------------------------------------------------------------------ source time (speed) ----- */

type MediaItem = VideoItem | AudioItem;

/** Instantaneous speed at local time `tl` (constant `speed`, or the ramp). */
export function speedAt(item: MediaItem, tl: number): number {
  return item.speedCurve.length
    ? clamp(interpolate(item.speedCurve, tl, item.speed), 0.1, 10)
    : item.speed;
}

const SPEED_STEP = 1 / 240;

/**
 * Returns f(tl) = source seconds CONSUMED from the item's start up to local time tl (monotonic, 0 at tl = 0).
 * Constant speed: speed·tl. Ramp: integral of speedAt (trapezoid, 1/240 s steps, table-cached).
 */
export function makeSourceOffset(item: MediaItem): (tl: number) => number {
  if (!item.speedCurve.length) return (tl) => item.speed * Math.max(0, tl);
  const steps = Math.ceil(item.durationSec / SPEED_STEP);
  const table = new Float64Array(steps + 1);
  let acc = 0;
  let prev = speedAt(item, 0);
  for (let i = 1; i <= steps; i++) {
    const cur = speedAt(item, Math.min(item.durationSec, i * SPEED_STEP));
    acc += ((prev + cur) / 2) * SPEED_STEP;
    table[i] = acc;
    prev = cur;
  }
  return (tl) => {
    const x = clamp(tl, 0, item.durationSec) / SPEED_STEP;
    const i = Math.min(steps - 1, Math.floor(x));
    if (steps === 0) return 0;
    return lerp(table[i] as number, table[i + 1] as number, x - i);
  };
}

/** Source seconds the whole item spans (how much of the asset it covers). */
export const sourceSpan = (item: MediaItem): number => makeSourceOffset(item)(item.durationSec);

/**
 * Source (asset) time shown/heard at local time `tl`:
 *  - freezeAtSec set → that time, always;
 *  - forward → inSec + consumed(tl);
 *  - reverse → the window [inSec, inSec + span] is played backwards: inSec + span − consumed(tl).
 * Callers clamp to [0, asset.durationSec] (hold the last/first frame).
 */
export function makeSourceTime(item: MediaItem): (tl: number) => number {
  if (item.freezeAtSec !== null) {
    const t = item.freezeAtSec;
    return () => t;
  }
  const off = makeSourceOffset(item);
  if (!item.reverse) return (tl) => item.inSec + off(tl);
  const span = off(item.durationSec);
  return (tl) => Math.max(0, item.inSec + span - off(tl));
}

/* ------------------------------------------------------------------ fades / gain / ducking --- */

/** Linear ramp 0→1 over fadeInSec at the start and 1→0 over fadeOutSec at the end. Used for audio gain AND picture alpha. */
export function fadeFactor(
  item: { durationSec: number; fadeInSec?: number; fadeOutSec?: number },
  tl: number,
): number {
  let f = 1;
  const fi = item.fadeInSec ?? 0;
  const fo = item.fadeOutSec ?? 0;
  if (fi > EPS) f = Math.min(f, clamp(tl / fi, 0, 1));
  if (fo > EPS) f = Math.min(f, clamp((item.durationSec - tl) / fo, 0, 1));
  return f;
}

/** Linear gain of a media item at local time tl: volume keyframes × fades (track gain / mute / ducking are applied by the caller). */
export function itemGainAt(item: MediaItem, tl: number): number {
  return Math.max(0, animatedAt(item.volume, tl)) * fadeFactor(item, tl);
}

export interface TimeRange {
  s: number;
  e: number;
}

function mergeRanges(ranges: TimeRange[], gap: number): TimeRange[] {
  const sorted = [...ranges].sort((a, b) => a.s - b.s);
  const out: TimeRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.s <= last.e + gap) last.e = Math.max(last.e, r.e);
    else out.push({ s: r.s, e: r.e });
  }
  return out;
}

/**
 * Timeline ranges where speech is present (drives ducking). If the project has subtitle cues, speech =
 * the (merged, gaps < 0.35 s) word spans of those cues; otherwise the audible spans of items on `speech` tracks.
 */
export function speechRanges(project: Pick<Project, 'tracks'>): TimeRange[] {
  const words: TimeRange[] = [];
  for (const tr of project.tracks) {
    if (tr.kind !== 'subtitle' || tr.muted) continue;
    for (const it of tr.items) {
      if (it.type !== 'subtitle') continue;
      for (const w of (it as SubtitleItem).words)
        words.push({ s: it.startSec + w.s, e: it.startSec + w.e });
    }
  }
  if (words.length) return mergeRanges(words, 0.35);
  const spans: TimeRange[] = [];
  for (const tr of project.tracks) {
    if (!tr.speech || tr.muted || tr.hidden) continue;
    for (const it of tr.items)
      if (it.type === 'video' || it.type === 'audio')
        spans.push({ s: it.startSec, e: itemEnd(it) });
  }
  return mergeRanges(spans, 0.35);
}

/**
 * Linear gain multiplier (≤ 1) from ducking at timeline time t. Look-ahead ramp: gain falls to
 * 10^(−reductionDb/20) over `attackSec` ENDING at each speech range's start, holds inside it, and
 * recovers linearly over `releaseSec` after it ends. Several ranges: the deepest amount wins.
 */
export function duckGainAt(
  ranges: readonly TimeRange[],
  d: Pick<Ducking, 'enabled' | 'reductionDb' | 'attackSec' | 'releaseSec'>,
  t: number,
): number {
  if (!d.enabled || ranges.length === 0 || d.reductionDb <= 0) return 1;
  let amount = 0;
  for (const r of ranges) {
    let a = 0;
    if (t >= r.s && t <= r.e) a = 1;
    else if (t < r.s) a = d.attackSec > EPS ? clamp(1 - (r.s - t) / d.attackSec, 0, 1) : 0;
    else a = d.releaseSec > EPS ? clamp(1 - (t - r.e) / d.releaseSec, 0, 1) : 0;
    if (a > amount) amount = a;
    if (amount >= 1) break;
  }
  return lerp(1, Math.pow(10, -d.reductionDb / 20), amount);
}

/** The times at which duckGainAt changes slope (for emitting piecewise-linear gain automation). */
export function duckBreakpoints(
  ranges: readonly TimeRange[],
  d: Pick<Ducking, 'attackSec' | 'releaseSec'>,
  duration: number,
): number[] {
  const pts = new Set<number>([0, duration]);
  for (const r of ranges) {
    for (const t of [r.s - d.attackSec, r.s, r.e, r.e + d.releaseSec])
      if (t > 0 && t < duration) pts.add(Math.round(t * 1000) / 1000);
  }
  return [...pts].sort((a, b) => a - b);
}

/* ------------------------------------------------------------------ colour ------------------- */

/** Named looks = deltas added to the item's own colour values (then clamped to −1..1). */
export const FILTER_PRESETS: Record<
  string,
  { label: string; exposure: number; contrast: number; saturation: number; temperature: number }
> = {
  vivid: { label: 'Vivid', exposure: 0.05, contrast: 0.15, saturation: 0.35, temperature: 0 },
  warm: { label: 'Warm', exposure: 0.05, contrast: 0.05, saturation: 0.1, temperature: 0.35 },
  cool: { label: 'Cool', exposure: 0, contrast: 0.05, saturation: 0.05, temperature: -0.35 },
  mono: { label: 'Mono', exposure: 0, contrast: 0.1, saturation: -1, temperature: 0 },
  fade: { label: 'Faded', exposure: 0.1, contrast: -0.25, saturation: -0.2, temperature: 0.05 },
  punch: { label: 'Punch', exposure: -0.05, contrast: 0.35, saturation: 0.2, temperature: 0 },
  noir: { label: 'Noir', exposure: -0.1, contrast: 0.45, saturation: -1, temperature: 0 },
};

export interface EffectiveColor {
  /** Exposure in stops: gain = 2^ev applied to the 0..1 sRGB values. */
  ev: number;
  /** Contrast factor f (0..2) around 0.5. */
  contrast: number;
  /** Saturation factor s (0..2): out = L + (in − L)·s, L = Rec.709 luma of the RGB triple. */
  saturation: number;
  /** r gain = 1 + 0.25·t, b gain = 1 − 0.25·t, g unchanged. */
  temperature: number;
  lutAssetId: string | null;
  lutAmount: number;
}

export function resolveColor(c: ColorAdjust, tl: number): EffectiveColor {
  const p = c.filter ? FILTER_PRESETS[c.filter] : undefined;
  const g = (a: Animated, add: number) => clamp(animatedAt(a, tl) + add, -1, 1);
  const exposure = g(c.exposure, p?.exposure ?? 0);
  const contrast = g(c.contrast, p?.contrast ?? 0);
  const saturation = g(c.saturation, p?.saturation ?? 0);
  const temperature = g(c.temperature, p?.temperature ?? 0);
  return {
    ev: exposure * 1.5,
    contrast: 1 + contrast,
    saturation: 1 + saturation,
    temperature,
    lutAssetId: c.lutAssetId,
    lutAmount: c.lutAmount,
  };
}

export const isNeutralColor = (e: EffectiveColor): boolean =>
  Math.abs(e.ev) < 1e-6 &&
  Math.abs(e.contrast - 1) < 1e-6 &&
  Math.abs(e.saturation - 1) < 1e-6 &&
  Math.abs(e.temperature) < 1e-6 &&
  !e.lutAssetId;

/**
 * Reference per-pixel maths on 0..1 sRGB (NOT linear light). Order: exposure → contrast → saturation → temperature.
 * Shader and FFmpeg graph (lutrgb + colorchannelmixer) must reproduce this.
 */
export function applyColor(
  rgb: readonly [number, number, number],
  e: EffectiveColor,
): [number, number, number] {
  const gain = Math.pow(2, e.ev);
  let [r, g, b] = rgb.map((v) => clamp((clamp(v * gain, 0, 1) - 0.5) * e.contrast + 0.5, 0, 1)) as [
    number,
    number,
    number,
  ];
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  r = clamp(l + (r - l) * e.saturation, 0, 1);
  g = clamp(l + (g - l) * e.saturation, 0, 1);
  b = clamp(l + (b - l) * e.saturation, 0, 1);
  return [
    clamp(r * (1 + 0.25 * e.temperature), 0, 1),
    g,
    clamp(b * (1 - 0.25 * e.temperature), 0, 1),
  ];
}

/* ------------------------------------------------------------------ layout / transform ------- */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ResolvedCrop extends Rect {}

export function resolveCrop(c: Crop, tl: number): ResolvedCrop {
  const x = clamp(animatedAt(c.x, tl), 0, 1);
  const y = clamp(animatedAt(c.y, tl), 0, 1);
  const w = clamp(animatedAt(c.w, tl), 0.01, 1 - x);
  const h = clamp(animatedAt(c.h, tl), 0.01, 1 - y);
  return { x, y, w, h };
}

/**
 * Natural layout of visual media: which SOURCE pixels are sampled (`src`) and the rect they fill on the canvas
 * BEFORE the item transform (`dst`, canvas px). `crop` is normalised to the source frame.
 *  - cover: dst = whole canvas; src = the part of the crop region that fills it (centre-cropped to the canvas aspect);
 *  - contain: dst = crop region fitted inside the canvas, centred; src = whole crop region;
 *  - native: dst = crop region at 1 source px = 1 canvas px, centred (may overflow the canvas); src = whole crop region.
 */
export function naturalLayout(
  fit: 'cover' | 'contain' | 'native',
  crop: ResolvedCrop,
  srcW: number,
  srcH: number,
  canvasW: number,
  canvasH: number,
): { src: Rect; dst: Rect } {
  const rx = crop.x * srcW;
  const ry = crop.y * srcH;
  const rw = crop.w * srcW;
  const rh = crop.h * srcH;
  if (fit === 'cover') {
    const canvasAspect = canvasW / canvasH;
    const regionAspect = rw / rh;
    let sw = rw;
    let sh = rh;
    if (regionAspect > canvasAspect) sw = rh * canvasAspect;
    else sh = rw / canvasAspect;
    return {
      src: { x: rx + (rw - sw) / 2, y: ry + (rh - sh) / 2, w: sw, h: sh },
      dst: { x: 0, y: 0, w: canvasW, h: canvasH },
    };
  }
  const s = fit === 'contain' ? Math.min(canvasW / rw, canvasH / rh) : 1;
  const dw = rw * s;
  const dh = rh * s;
  return {
    src: { x: rx, y: ry, w: rw, h: rh },
    dst: { x: (canvasW - dw) / 2, y: (canvasH - dh) / 2, w: dw, h: dh },
  };
}

export interface ResolvedTransform {
  /** Offset of the rect's centre from the canvas centre, canvas px. */
  x: number;
  y: number;
  scale: number;
  /** Degrees clockwise. */
  rotation: number;
  /** 0..1 (item opacity × fades). */
  opacity: number;
}

type Transformable = {
  transform: { x: Animated; y: Animated; scale: Animated; rotation: Animated; opacity: Animated };
  durationSec: number;
  fadeInSec?: number;
  fadeOutSec?: number;
};

export function resolveTransform(
  item: Transformable,
  tl: number,
  withFades = true,
): ResolvedTransform {
  const t = item.transform;
  return {
    x: animatedAt(t.x, tl),
    y: animatedAt(t.y, tl),
    scale: Math.max(0, animatedAt(t.scale, tl)),
    rotation: animatedAt(t.rotation, tl),
    opacity: clamp(animatedAt(t.opacity, tl), 0, 1) * (withFades ? fadeFactor(item, tl) : 1),
  };
}

/* ------------------------------------------------------------------ transitions -------------- */

export interface LayerOps {
  /** 0..1 */
  opacity: number;
  /** Offset as a fraction of the canvas width / height. */
  dx: number;
  dy: number;
  /** Extra scale about the canvas centre. */
  scale: number;
  /** Gaussian blur radius as a fraction of the canvas SHORT side. */
  blur: number;
}

export interface TransitionOps {
  from: LayerOps;
  to: LayerOps;
  /** Solid colour laid over BOTH layers at this alpha (dip transitions), or null. */
  veil: { color: '#000000' | '#FFFFFF'; alpha: number } | null;
}

const L = (o: Partial<LayerOps> = {}): LayerOps => ({
  opacity: 1,
  dx: 0,
  dy: 0,
  scale: 1,
  blur: 0,
  ...o,
});
const easeInOut = (p: number) => ease('ease-in-out', p);

/**
 * How to draw the outgoing (`from`) and incoming (`to`) layers at transition progress p ∈ [0,1]. The `from` layer
 * is drawn first (opaque), then `to` on top at its opacity, then the veil. This reproduces FFmpeg's xfade for
 * fade / fadeblack / fadewhite / slide* ; the exporter may use xfade or equivalent overlays but must match this
 * within the parity tolerance.
 */
export function transitionOps(type: TransitionType, pIn: number): TransitionOps {
  const p = clamp(pIn, 0, 1);
  switch (type) {
    case 'cut':
      return { from: L({ opacity: 0 }), to: L(), veil: null };
    case 'crossfade':
      return { from: L(), to: L({ opacity: p }), veil: null };
    case 'dip-black':
    case 'dip-white': {
      const color = type === 'dip-black' ? '#000000' : '#FFFFFF';
      return p < 0.5
        ? { from: L(), to: L({ opacity: 0 }), veil: { color, alpha: p * 2 } }
        : { from: L({ opacity: 0 }), to: L(), veil: { color, alpha: (1 - p) * 2 } };
    }
    case 'slide-left':
      return { from: L({ dx: -p }), to: L({ dx: 1 - p }), veil: null };
    case 'slide-right':
      return { from: L({ dx: p }), to: L({ dx: -(1 - p) }), veil: null };
    case 'slide-up':
      return { from: L({ dy: -p }), to: L({ dy: 1 - p }), veil: null };
    case 'slide-down':
      return { from: L({ dy: p }), to: L({ dy: -(1 - p) }), veil: null };
    case 'zoom':
      return { from: L({ scale: 1 + 0.5 * p }), to: L({ opacity: p }), veil: null };
    case 'blur':
      return {
        from: L({ blur: 0.08 * p }),
        to: L({ opacity: p, blur: 0.08 * (1 - p) }),
        veil: null,
      };
    case 'whip-pan': {
      const e = easeInOut(p);
      const b = 0.06 * Math.sin(Math.PI * p);
      return { from: L({ dx: -e, blur: b }), to: L({ dx: 1 - e, blur: b }), veil: null };
    }
    case 'glitch': {
      const k = Math.floor(p * 10);
      const on = p >= 0.9 || (k % 2 === 1 && ((k * 7 + 3) % 5) % 2 === 1);
      const dx = on && p < 0.9 ? ((k % 3) - 1) * 0.04 : 0;
      return {
        from: on ? L({ opacity: 0, dx }) : L({ dx: -dx }),
        to: on ? L({ dx }) : L({ opacity: 0 }),
        veil: null,
      };
    }
  }
}

export interface ActiveOnTrack {
  /** Items drawn at t, bottom first (earlier item, then later). One item normally; two during a transition overlap. */
  items: Item[];
  transition: {
    from: Item;
    to: Item;
    type: TransitionType;
    durationSec: number;
    progress: number;
  } | null;
}

/** Which items of a track are visible at timeline time t, and the transition between them if overlapping. */
export function activeOnTrack(track: Pick<Track, 'items'>, t: number): ActiveOnTrack {
  const act = track.items.filter((i) => isActive(i, t)).sort((a, b) => a.startSec - b.startSec);
  if (act.length < 2) return { items: act, transition: null };
  const from = act[act.length - 2] as Item;
  const to = act[act.length - 1] as Item;
  const tin = 'transitionIn' in to ? to.transitionIn : null;
  if (!tin || tin.type === 'cut') return { items: [to], transition: null };
  const dur = Math.min(tin.durationSec, itemEnd(from) - to.startSec);
  if (dur <= EPS) return { items: [to], transition: null };
  return {
    items: [from, to],
    transition: {
      from,
      to,
      type: tin.type,
      durationSec: dur,
      progress: clamp((t - to.startSec) / dur, 0, 1),
    },
  };
}

/* ------------------------------------------------------------------ text animation ----------- */

export interface TextAnimState {
  opacity: number;
  scale: number;
  /** Offsets as a fraction of canvas height / width. */
  dy: number;
  dx: number;
  /** Fraction of characters shown (typewriter), 1 = all. */
  visible: number;
}

const bounceOut = (x: number): number => {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (x < 1 / d1) return n1 * x * x;
  if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75;
  if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375;
  return n1 * (x -= 2.625 / d1) * x + 0.984375;
};

/** State of one animation at normalised progress u (0 = hidden/start, 1 = fully shown). */
function animState(type: TextAnimation['type'], u: number): TextAnimState {
  const o = ease('ease-out', u);
  switch (type) {
    case 'none':
      return { opacity: 1, scale: 1, dy: 0, dx: 0, visible: 1 };
    case 'fade':
      return { opacity: u, scale: 1, dy: 0, dx: 0, visible: 1 };
    case 'scale':
      return { opacity: u, scale: 0.6 + 0.4 * o, dy: 0, dx: 0, visible: 1 };
    case 'pop': {
      const s = u < 0.6 ? (u / 0.6) * 1.15 : 1.15 - 0.15 * ((u - 0.6) / 0.4);
      return { opacity: u > 0 ? 1 : 0, scale: s, dy: 0, dx: 0, visible: 1 };
    }
    case 'slide':
      return { opacity: o, scale: 1, dy: 0.08 * (1 - o), dx: 0, visible: 1 };
    case 'bounce':
      return {
        opacity: u > 0 ? 1 : 0,
        scale: 1,
        dy: -0.12 * (1 - bounceOut(u)),
        dx: 0,
        visible: 1,
      };
    case 'typewriter':
      return { opacity: 1, scale: 1, dy: 0, dx: 0, visible: u };
  }
}

/** Combined in/out animation state of a text item at local time tl. */
export function textAnimAt(
  item: Pick<TextItem, 'animIn' | 'animOut' | 'durationSec'>,
  tl: number,
): TextAnimState {
  let s: TextAnimState = { opacity: 1, scale: 1, dy: 0, dx: 0, visible: 1 };
  const din = item.animIn.type === 'none' ? 0 : item.animIn.durationSec;
  const dout = item.animOut.type === 'none' ? 0 : item.animOut.durationSec;
  if (din > EPS && tl < din) s = animState(item.animIn.type, clamp(tl / din, 0, 1));
  if (dout > EPS && tl > item.durationSec - dout) {
    const o = animState(item.animOut.type, clamp((item.durationSec - tl) / dout, 0, 1));
    s = {
      opacity: s.opacity * o.opacity,
      scale: s.scale * o.scale,
      dy: s.dy + o.dy,
      dx: s.dx + o.dx,
      visible: Math.min(s.visible, o.visible),
    };
  }
  return s;
}

/** Number of characters of `text` shown for a typewriter fraction (counts code points). */
export const visibleChars = (text: string, visible: number): number =>
  Math.max(0, Math.ceil(Array.from(text).length * clamp(visible, 0, 1) - 1e-9));

/* ------------------------------------------------------------------ misc --------------------- */

/** Progress-bar shape: fraction of the width filled at local time tl. */
export const progressFraction = (durationSec: number, tl: number): number =>
  clamp(tl / Math.max(durationSec, EPS), 0, 1);

/** Snap helper shared by UI and tests: nearest candidate within `threshold`, or null. */
export function snapTo(
  value: number,
  candidates: readonly number[],
  threshold: number,
): number | null {
  let best: number | null = null;
  let bd = threshold;
  for (const c of candidates) {
    const d = Math.abs(c - value);
    if (d <= bd) {
      best = c;
      bd = d;
    }
  }
  return best;
}
