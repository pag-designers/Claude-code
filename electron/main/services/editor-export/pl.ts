/**
 * Piecewise-linear (PL) series: the bridge from the shared evaluator (arbitrary easing, steps, fades) to
 * FFmpeg expressions. A parameter is SAMPLED at every output frame time (so it equals the evaluator at the
 * instants that are actually rendered), the samples are simplified (Douglas-Peucker, tolerance `tol`) to a
 * short polyline whose knots are real samples, and the polyline is emitted as a balanced binary decision tree
 * over the time variable (`if(lt(t,..),..,..)`), so evaluation per frame is O(log knots).
 *
 * Because knots are exact samples, the expression reproduces the evaluator EXACTLY at every knot frame and
 * within `tol` at the frames in between; jumps (steps, glitch) become a one-frame segment.
 */

export interface Knot {
  t: number;
  v: number;
}

/** Constant, or a polyline over output seconds (strictly increasing t, at least 2 knots). */
export type Series = { kind: 'const'; v: number } | { kind: 'pl'; knots: Knot[] };

/** Compact decimal, no exponent (FFmpeg expressions accept plain decimals only). */
export function num(n: number, digits = 6): string {
  if (!Number.isFinite(n)) return '0';
  const s = n.toFixed(digits);
  const trimmed = s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
  return trimmed === '-0' || trimmed === '' ? '0' : trimmed;
}

/** Perpendicular-in-value distance of sample i from the chord (i0,i1). */
function deviation(t: number[], v: number[], i0: number, i1: number, i: number): number {
  const t0 = t[i0] as number;
  const t1 = t[i1] as number;
  const v0 = v[i0] as number;
  const v1 = v[i1] as number;
  const p = t1 > t0 ? ((t[i] as number) - t0) / (t1 - t0) : 0;
  return Math.abs((v[i] as number) - (v0 + (v1 - v0) * p));
}

/** Indices kept by Douglas-Peucker with value tolerance `tol` (always includes first and last). */
export function simplifyIndices(t: number[], v: number[], tol: number): number[] {
  const n = t.length;
  if (n <= 2) return n === 0 ? [] : n === 1 ? [0] : [0, 1];
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop() as [number, number];
    if (b - a < 2) continue;
    let worst = -1;
    let wd = tol;
    for (let i = a + 1; i < b; i++) {
      const d = deviation(t, v, a, b, i);
      if (d > wd) {
        wd = d;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

/** Samples → Series. `times` strictly increasing output seconds. */
export function toSeries(times: number[], values: number[], tol: number): Series {
  if (values.length === 0) return { kind: 'const', v: 0 };
  let lo = Infinity;
  let hi = -Infinity;
  for (const x of values) {
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  if (hi - lo <= tol || values.length === 1) {
    // a constant: use the first sample so a flat parameter is reproduced exactly
    return { kind: 'const', v: values[0] as number };
  }
  const idx = simplifyIndices(times, values, tol);
  return {
    kind: 'pl',
    knots: idx.map((i) => ({ t: times[i] as number, v: values[i] as number })),
  };
}

/** Value of a series at t (the same function the expression computes; used by tests and sizing). */
export function seriesAt(s: Series, t: number): number {
  if (s.kind === 'const') return s.v;
  const k = s.knots;
  const first = k[0] as Knot;
  const last = k[k.length - 1] as Knot;
  if (t <= first.t) return first.v;
  if (t >= last.t) return last.v;
  let lo = 0;
  let hi = k.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((k[mid] as Knot).t <= t) lo = mid;
    else hi = mid;
  }
  const a = k[lo] as Knot;
  const b = k[hi] as Knot;
  return a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
}

export function seriesRange(s: Series): { min: number; max: number } {
  if (s.kind === 'const') return { min: s.v, max: s.v };
  let min = Infinity;
  let max = -Infinity;
  for (const k of s.knots) {
    if (k.v < min) min = k.v;
    if (k.v > max) max = k.v;
  }
  return { min, max };
}

export const isConst = (s: Series): s is { kind: 'const'; v: number } => s.kind === 'const';

/** Maps every value (affine / monotone transforms keep the knots). */
export function mapSeries(s: Series, f: (v: number) => number): Series {
  return s.kind === 'const'
    ? { kind: 'const', v: f(s.v) }
    : { kind: 'pl', knots: s.knots.map((k) => ({ t: k.t, v: f(k.v) })) };
}

function leaf(a: Knot, b: Knot, tv: string): string {
  const slope = (b.v - a.v) / (b.t - a.t);
  if (Math.abs(slope) < 1e-12) return num(a.v);
  return `(${num(a.v)}+(${tv}-${num(a.t)})*${num(slope, 7)})`;
}

function tree(k: Knot[], lo: number, hi: number, tv: string): string {
  // segments lo..hi-1 (between knots lo..hi)
  if (hi - lo === 1) return leaf(k[lo] as Knot, k[hi] as Knot, tv);
  const mid = (lo + hi) >> 1;
  return `if(lt(${tv},${num((k[mid] as Knot).t)}),${tree(k, lo, mid, tv)},${tree(k, mid, hi, tv)})`;
}

/** FFmpeg expression of a series in the time variable `tv` ('t' for most filters, 'T' in setpts). */
export function seriesExpr(s: Series, tv = 't'): string {
  if (s.kind === 'const') return num(s.v);
  return tree(s.knots, 0, s.knots.length - 1, tv);
}

/** Expression of `a·series + b`. */
export function affineExpr(s: Series, a: number, b: number, tv = 't'): string {
  if (s.kind === 'const') return num(a * s.v + b);
  return seriesExpr(mapSeries(s, (v) => a * v + b), tv);
}
