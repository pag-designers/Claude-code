import type { Easing } from '@shared/editor';

/* Bezier editor maths: a cubic-bezier(x1,y1,x2,y2) easing ↔ two draggable handles on a square viewport. */

export type BezierTuple = [number, number, number, number];

const NAMED: Record<'ease-in' | 'ease-out' | 'ease-in-out', BezierTuple> = {
  'ease-in': [0.42, 0, 1, 1],
  'ease-out': [0, 0, 0.58, 1],
  'ease-in-out': [0.42, 0, 0.58, 1],
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** The four numbers of an easing; 'hold' (a step) has none. 'linear' is the identity curve. */
export function easingToBezier(e: Easing): BezierTuple | null {
  if (e === 'hold') return null;
  if (e === 'linear') return [0, 0, 1, 1];
  if (typeof e === 'string') return [...NAMED[e]];
  return [e.x1, e.y1, e.x2, e.y2];
}

/** Handles → the stored easing. x is clamped to 0..1 (the schema), y is free (overshoot) within ±`yLimit`. */
export function bezierToEasing(b: readonly number[], yLimit = 2): Easing {
  const [x1 = 0, y1 = 0, x2 = 1, y2 = 1] = b;
  return {
    type: 'bezier',
    x1: round3(clamp(x1, 0, 1)),
    y1: round3(clamp(y1, -yLimit, yLimit)),
    x2: round3(clamp(x2, 0, 1)),
    y2: round3(clamp(y2, -yLimit, yLimit)),
  };
}

export const sameBezier = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === 4 && b.length === 4 && a.every((v, i) => Math.abs(v - (b[i] as number)) < 5e-4);

export type EasingChoice = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'hold' | 'bezier';

/** Which button of the per-segment picker an easing lights up. A bezier equal to a named curve still reads as 'bezier'. */
export function easingChoice(e: Easing): EasingChoice {
  return typeof e === 'string' ? e : 'bezier';
}

export interface BezierPreset {
  id: string;
  label: string;
  b: BezierTuple;
}

export const BEZIER_PRESETS: BezierPreset[] = [
  { id: 'ease', label: 'Ease', b: [0.25, 0.1, 0.25, 1] },
  { id: 'in-sine', label: 'In sine', b: [0.12, 0, 0.39, 0] },
  { id: 'out-sine', label: 'Out sine', b: [0.61, 1, 0.88, 1] },
  { id: 'in-out-cubic', label: 'In-out cubic', b: [0.65, 0, 0.35, 1] },
  { id: 'out-expo', label: 'Out expo', b: [0.16, 1, 0.3, 1] },
  { id: 'in-expo', label: 'In expo', b: [0.7, 0, 0.84, 0] },
  { id: 'out-back', label: 'Out back', b: [0.34, 1.56, 0.64, 1] },
  { id: 'in-back', label: 'In back', b: [0.36, 0, 0.66, -0.56] },
];

export function matchPreset(b: readonly number[]): BezierPreset | null {
  return BEZIER_PRESETS.find((p) => sameBezier(p.b, b)) ?? null;
}

/* ------------------------------------------------------------------ viewport mapping -------------- */

export interface BezierViewport {
  /** Square plot size in px (the unit square 0..1 occupies this). */
  size: number;
  /** Space around the plot so overshooting handles stay visible. */
  pad: number;
  /** y range shown, e.g. [-0.6, 1.6]. */
  yMin: number;
  yMax: number;
}

export function bezierMapper(vp: BezierViewport) {
  const w = vp.size;
  const ySpan = vp.yMax - vp.yMin;
  return {
    width: w + vp.pad * 2,
    height: w * ySpan + vp.pad * 2,
    toPx: (x: number, y: number) => ({
      px: vp.pad + x * w,
      py: vp.pad + (vp.yMax - y) * w,
    }),
    fromPx: (px: number, py: number) => ({
      x: clamp((px - vp.pad) / w, 0, 1),
      y: clamp(vp.yMax - (py - vp.pad) / w, vp.yMin, vp.yMax),
    }),
  };
}

/** Which handle (1 or 2) a drag moves: the one whose control point is nearer the pointer. */
export function nearestHandle(b: readonly number[], x: number, y: number): 1 | 2 {
  const d1 = (b[0]! - x) ** 2 + (b[1]! - y) ** 2;
  const d2 = (b[2]! - x) ** 2 + (b[3]! - y) ** 2;
  return d1 <= d2 ? 1 : 2;
}

/** New tuple with handle `which` moved to (x,y); x/y are rounded + clamped by `bezierToEasing`. */
export function moveHandle(b: readonly number[], which: 1 | 2, x: number, y: number): BezierTuple {
  const next: BezierTuple = [b[0]!, b[1]!, b[2]!, b[3]!];
  if (which === 1) {
    next[0] = x;
    next[1] = y;
  } else {
    next[2] = x;
    next[3] = y;
  }
  return next;
}
