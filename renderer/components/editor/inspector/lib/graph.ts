import type { Keyframe } from '@shared/editor';
import { interpolate } from '@shared/editor-eval';

/* Pure maths of the keyframe graph (value over item-local time). */

export interface GraphBox {
  width: number;
  height: number;
  padX: number;
  padY: number;
}

export interface GraphDomain {
  duration: number;
  vMin: number;
  vMax: number;
  /** 'log' plots log2(v) (used for speed: 0.5× and 2× are symmetric about 1×). */
  scale?: 'linear' | 'log';
}

const axis = (d: GraphDomain, v: number) => (d.scale === 'log' ? Math.log2(Math.max(v, 1e-6)) : v);
const unaxis = (d: GraphDomain, a: number) => (d.scale === 'log' ? Math.pow(2, a) : a);

export function graphMapper(box: GraphBox, d: GraphDomain) {
  const w = box.width - box.padX * 2;
  const h = box.height - box.padY * 2;
  const lo = axis(d, d.vMin);
  const hi = axis(d, d.vMax);
  const span = hi - lo || 1;
  const dur = d.duration || 1;
  return {
    tToX: (t: number) => box.padX + (t / dur) * w,
    xToT: (x: number) => Math.min(d.duration, Math.max(0, ((x - box.padX) / w) * dur)),
    vToY: (v: number) => box.padY + (1 - (axis(d, v) - lo) / span) * h,
    yToV: (y: number) =>
      Math.min(d.vMax, Math.max(d.vMin, unaxis(d, lo + (1 - (y - box.padY) / h) * span))),
  };
}

/** A value range that frames every keyframe (and the base value) with a margin, never narrower than `minSpan`. */
export function autoDomain(
  values: readonly number[],
  opts: { floor?: number; ceil?: number; minSpan?: number; scale?: 'linear' | 'log' } = {},
): { vMin: number; vMax: number } {
  const vs = values.length ? values : [0];
  const f = (v: number) => (opts.scale === 'log' ? Math.log2(Math.max(v, 1e-6)) : v);
  const g = (a: number) => (opts.scale === 'log' ? Math.pow(2, a) : a);
  let lo = Math.min(...vs.map(f));
  let hi = Math.max(...vs.map(f));
  const minSpan = opts.minSpan ?? (opts.scale === 'log' ? 2 : 1);
  if (hi - lo < minSpan) {
    const mid = (hi + lo) / 2;
    lo = mid - minSpan / 2;
    hi = mid + minSpan / 2;
  }
  const m = (hi - lo) * 0.12;
  let vMin = g(lo - m);
  let vMax = g(hi + m);
  if (opts.floor !== undefined) vMin = Math.max(opts.floor, vMin);
  if (opts.ceil !== undefined) vMax = Math.min(opts.ceil, vMax);
  return { vMin, vMax };
}

/** The curve as a polyline: `n` samples between local time 0 and `duration`, honouring every segment's easing. */
export function sampleCurve(
  kf: readonly Keyframe[],
  base: number,
  duration: number,
  n = 96,
): { t: number; v: number }[] {
  const out: { t: number; v: number }[] = [];
  for (let i = 0; i <= n; i++) {
    const t = (duration * i) / n;
    out.push({ t, v: interpolate(kf, t, base) });
  }
  // a 'hold' segment is a step: add the exact corner so the polyline does not slope across it
  for (let i = 0; i < kf.length - 1; i++) {
    const a = kf[i] as Keyframe;
    const b = kf[i + 1] as Keyframe;
    if (a.ease === 'hold') {
      out.push({ t: b.t - 1e-4, v: a.v });
      out.push({ t: b.t, v: b.v });
    }
  }
  return out.sort((p, q) => p.t - q.t);
}

/**
 * Keeps a dragged keyframe between its neighbours so indices stay stable during a drag (the store re-sorts on commit).
 * `minGap` keeps two keyframes from sharing a time.
 */
export function clampKeyframeTime(
  kf: readonly Keyframe[],
  index: number,
  t: number,
  duration: number,
  minGap = 1 / 120,
): number {
  const lo = index > 0 ? (kf[index - 1] as Keyframe).t + minGap : 0;
  const hi = index < kf.length - 1 ? (kf[index + 1] as Keyframe).t - minGap : duration;
  return Math.min(Math.max(t, lo), Math.max(lo, hi));
}

/** Index of the keyframe nearest (in px) to a point, if within `radius`. */
export function hitKeyframe(
  pts: readonly { x: number; y: number }[],
  px: number,
  py: number,
  radius: number,
): number {
  let best = -1;
  let bd = radius * radius;
  pts.forEach((p, i) => {
    const d = (p.x - px) ** 2 + (p.y - py) ** 2;
    if (d <= bd) {
      best = i;
      bd = d;
    }
  });
  return best;
}

/** Which segment (between keyframe i and i+1) a local time falls in; −1 before the first / after the last. */
export function segmentAt(kf: readonly Keyframe[], t: number): number {
  for (let i = 0; i < kf.length - 1; i++) {
    if (t >= (kf[i] as Keyframe).t && t < (kf[i + 1] as Keyframe).t) return i;
  }
  return -1;
}
