/**
 * Keyframe / animated-property helpers (pure). Item-local keyframe times: 0 = item start.
 */
import type { Animated, Easing, Item, Keyframe } from '@shared/editor';
import { animatedAt, interpolate } from '@shared/editor-eval';
import type { AnimatedPath } from '../api';
import { EPS, clamp, isMedia } from './common';

type Rec = Record<string, unknown>;

export const ANIMATED_PATHS: readonly AnimatedPath[] = [
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

/** Keyframes closer than this (s) are the same keyframe when adding / moving. */
export const KF_MERGE_EPS = 0.005;

function isAnimated(x: unknown): x is Animated {
  return (
    !!x && typeof x === 'object' && typeof (x as Rec).v === 'number' && Array.isArray((x as Rec).kf)
  );
}

/** The Animated at `path` or null when this item type has no such property. */
export function getAnimated(item: Item, path: AnimatedPath): Animated | null {
  let cur: unknown = item;
  for (const k of path.split('.')) {
    if (!cur || typeof cur !== 'object') return null;
    cur = (cur as Rec)[k]; // structural walk over a schema-validated item
  }
  return isAnimated(cur) ? cur : null;
}

/** Immutable set of the Animated at `path` (copies only the path spine). */
export function setAnimated<T extends Item>(item: T, path: AnimatedPath, a: Animated): T {
  const parts = path.split('.');
  const rec = (node: Rec, i: number): Rec => {
    const key = parts[i] as string;
    return { ...node, [key]: i === parts.length - 1 ? a : rec(node[key] as Rec, i + 1) };
  };
  return rec(item as unknown as Rec, 0) as unknown as T; // spine copy of a validated item keeps its shape
}

/** Value limits per property (what the schema leaves open but the renderers expect). */
export function clampPropValue(path: AnimatedPath, v: number): number {
  if (!Number.isFinite(v)) return 0;
  switch (path) {
    case 'transform.opacity':
    case 'crop.x':
    case 'crop.y':
      return clamp(v, 0, 1);
    case 'crop.w':
    case 'crop.h':
      return clamp(v, 0.01, 1);
    case 'transform.scale':
    case 'volume':
    case 'blur':
      return Math.max(0, v);
    case 'color.exposure':
    case 'color.contrast':
    case 'color.saturation':
    case 'color.temperature':
      return clamp(v, -1, 1);
    default:
      return v;
  }
}

/* ------------------------------------------------------------------ keyframe arrays ---------- */

/**
 * The keyframes of an animation after its item's first `cut` seconds are removed (start-trim / right half of a
 * split): times shift left by `cut`; keyframes that fall before 0 are dropped but an interpolated keyframe is
 * inserted at 0 so the animation continues unchanged (exact for linear/hold easing; the easing of the segment
 * being cut into is re-used for the remainder). A negative `cut` (extending the head) shifts everything right.
 */
export function keyframesAfterCut(
  kf: readonly Keyframe[],
  cut: number,
  fallback: number,
): Keyframe[] {
  if (kf.length === 0) return [];
  if (Math.abs(cut) < EPS) return kf as Keyframe[];
  if (cut < 0) return kf.map((k) => ({ ...k, t: k.t - cut }));
  const kept: Keyframe[] = [];
  let lastDropped: Keyframe | null = null;
  for (const k of kf) {
    if (k.t < cut - EPS) lastDropped = k;
    else kept.push({ ...k, t: Math.max(0, k.t - cut) });
  }
  if (!lastDropped) return kept;
  if (kept.length === 0 || (kept[0] as Keyframe).t > EPS)
    kept.unshift({ t: 0, v: interpolate(kf, cut, fallback), ease: lastDropped.ease });
  return kept;
}

/**
 * The keyframes of an animation for the part of the item that ends at local time `at` (left half of a split):
 * keyframes after `at` are dropped and an interpolated one is added at `at` when needed.
 */
export function keyframesUpTo(kf: readonly Keyframe[], at: number, fallback: number): Keyframe[] {
  if (kf.length === 0) return [];
  const kept = kf.filter((k) => k.t <= at + EPS);
  if (kept.length === kf.length) return kf as Keyframe[];
  const last = kept[kept.length - 1];
  if (!last || last.t < at - EPS)
    kept.push({ t: at, v: interpolate(kf, at, fallback), ease: 'linear' });
  return kept;
}

/** Apply `fn` to the keyframes of every animated property of the item (and its speed ramp). */
export function mapKeyframes<T extends Item>(
  item: T,
  fn: (kf: readonly Keyframe[], fallback: number) => Keyframe[],
): T {
  let out: Item = item;
  for (const path of ANIMATED_PATHS) {
    const a = getAnimated(out, path);
    if (a && a.kf.length) out = setAnimated(out, path, { v: a.v, kf: fn(a.kf, a.v) });
  }
  if (isMedia(out) && out.speedCurve.length)
    out = { ...out, speedCurve: fn(out.speedCurve, out.speed) };
  return out as T;
}

/** Insert / update a keyframe (sorted). An existing keyframe within KF_MERGE_EPS is updated in place. */
export function upsertKeyframe(
  a: Animated,
  t: number,
  v: number,
  ease?: Easing,
): { animated: Animated; index: number } {
  const kf = a.kf.slice();
  const existing = kf.findIndex((k) => Math.abs(k.t - t) <= KF_MERGE_EPS);
  if (existing >= 0) {
    const cur = kf[existing] as Keyframe;
    kf[existing] = { t: cur.t, v, ease: ease ?? cur.ease };
    return { animated: { v: a.v, kf }, index: existing };
  }
  let at = kf.findIndex((k) => k.t > t);
  if (at < 0) at = kf.length;
  kf.splice(at, 0, { t, v, ease: ease ?? 'linear' });
  return { animated: { v: a.v, kf }, index: at };
}

/** Value of an animated property at item-local time (convenience re-export). */
export const valueAt = animatedAt;
