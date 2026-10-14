import type { Animated, Item, Keyframe } from '@shared/editor';
import { animatedAt } from '@shared/editor-eval';
import type { AnimatedPath } from '../../../../lib/editor/core/api';

/* ------------------------------------------------------------------------------------------------
 * Pure helpers for animated properties (no React, no store): reading the value at the playhead, deciding what the
 * keyframe diamond does, and describing each property (label, unit, range) once for every panel.
 * ---------------------------------------------------------------------------------------------- */

export type { AnimatedPath };

export interface PathMeta {
  label: string;
  /** Stored-unit bounds of the property. */
  min: number;
  max: number;
  /** Display value = stored × mul (e.g. opacity 0..1 shown as 0..100 %). */
  mul: number;
  unit: string;
  decimals: number;
  /** Step in DISPLAY units for arrow keys / one pixel of scrubbing. */
  step: number;
  /** Value the Reset button restores (stored units). */
  neutral: number;
}

export const PATH_META: Record<AnimatedPath, PathMeta> = {
  'transform.x': {
    label: 'Position X',
    min: -8192,
    max: 8192,
    mul: 1,
    unit: 'px',
    decimals: 1,
    step: 1,
    neutral: 0,
  },
  'transform.y': {
    label: 'Position Y',
    min: -8192,
    max: 8192,
    mul: 1,
    unit: 'px',
    decimals: 1,
    step: 1,
    neutral: 0,
  },
  'transform.scale': {
    label: 'Scale',
    min: 0,
    max: 10,
    mul: 100,
    unit: '%',
    decimals: 1,
    step: 1,
    neutral: 1,
  },
  'transform.rotation': {
    label: 'Rotation',
    min: -3600,
    max: 3600,
    mul: 1,
    unit: '°',
    decimals: 1,
    step: 1,
    neutral: 0,
  },
  'transform.opacity': {
    label: 'Opacity',
    min: 0,
    max: 1,
    mul: 100,
    unit: '%',
    decimals: 0,
    step: 1,
    neutral: 1,
  },
  'crop.x': {
    label: 'Crop X',
    min: 0,
    max: 1,
    mul: 100,
    unit: '%',
    decimals: 1,
    step: 0.5,
    neutral: 0,
  },
  'crop.y': {
    label: 'Crop Y',
    min: 0,
    max: 1,
    mul: 100,
    unit: '%',
    decimals: 1,
    step: 0.5,
    neutral: 0,
  },
  'crop.w': {
    label: 'Crop width',
    min: 0.01,
    max: 1,
    mul: 100,
    unit: '%',
    decimals: 1,
    step: 0.5,
    neutral: 1,
  },
  'crop.h': {
    label: 'Crop height',
    min: 0.01,
    max: 1,
    mul: 100,
    unit: '%',
    decimals: 1,
    step: 0.5,
    neutral: 1,
  },
  volume: {
    label: 'Volume',
    min: 0,
    max: 4,
    mul: 100,
    unit: '%',
    decimals: 0,
    step: 1,
    neutral: 1,
  },
  blur: { label: 'Blur', min: 0, max: 200, mul: 1, unit: 'px', decimals: 1, step: 0.5, neutral: 0 },
  'color.exposure': {
    label: 'Exposure',
    min: -1,
    max: 1,
    mul: 100,
    unit: '',
    decimals: 0,
    step: 1,
    neutral: 0,
  },
  'color.contrast': {
    label: 'Contrast',
    min: -1,
    max: 1,
    mul: 100,
    unit: '',
    decimals: 0,
    step: 1,
    neutral: 0,
  },
  'color.saturation': {
    label: 'Saturation',
    min: -1,
    max: 1,
    mul: 100,
    unit: '',
    decimals: 0,
    step: 1,
    neutral: 0,
  },
  'color.temperature': {
    label: 'Temperature',
    min: -1,
    max: 1,
    mul: 100,
    unit: '',
    decimals: 0,
    step: 1,
    neutral: 0,
  },
};

/** Reads an animated property by its dotted path; null when the item type does not have it. */
export function getAnimated(item: Item, path: AnimatedPath): Animated | null {
  const parts = path.split('.');
  let cur: unknown = item;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[p];
  }
  if (cur && typeof cur === 'object' && 'v' in cur && 'kf' in cur) return cur as Animated;
  return null;
}

/** `{ 'transform.x', v }` → `{ transform: { x: v } }` — the nested patch `updateItem(s)` deep-merges. */
export function nestPatch(path: string, value: unknown): Record<string, unknown> {
  const parts = path.split('.');
  let out: unknown = value;
  for (let i = parts.length - 1; i >= 0; i--) out = { [parts[i] as string]: out };
  return out as Record<string, unknown>;
}

export interface LocalTime {
  /** Item-local time of the playhead, clamped to [0, durationSec]. */
  t: number;
  /** True when the playhead really is over the item (keyframes can only be set there). */
  inside: boolean;
}

export function localTime(
  item: Pick<Item, 'startSec' | 'durationSec'>,
  playheadSec: number,
): LocalTime {
  const raw = playheadSec - item.startSec;
  return {
    t: Math.min(item.durationSec, Math.max(0, raw)),
    inside: raw >= -1e-6 && raw <= item.durationSec + 1e-6,
  };
}

/** The value the playhead sees (animated value when keyframed, else the base value). */
export function valueAtPlayhead(
  item: Item,
  path: AnimatedPath,
  playheadSec: number,
): number | null {
  const a = getAnimated(item, path);
  if (!a) return null;
  return animatedAt(a, localTime(item, playheadSec).t);
}

/** Index of the keyframe within `tol` seconds of local time `t`, else −1. */
export function keyframeIndexAt(kf: readonly Keyframe[], t: number, tol: number): number {
  let best = -1;
  let bd = tol;
  kf.forEach((k, i) => {
    const d = Math.abs(k.t - t);
    if (d <= bd) {
      best = i;
      bd = d;
    }
  });
  return best;
}

export type KeyframeToggle =
  | { type: 'add'; t: number; v: number }
  | { type: 'remove'; index: number }
  | { type: 'none'; reason: string };

/** Tolerance for "a keyframe sits at the playhead": half a frame. */
export const frameTol = (fps: number): number => 0.5 / Math.max(1, fps);

/** What the keyframe diamond does at the playhead: add one (capturing the current value) or remove the one under it. */
export function keyframeToggle(
  item: Item,
  path: AnimatedPath,
  playheadSec: number,
  fps: number,
): KeyframeToggle {
  const a = getAnimated(item, path);
  if (!a) return { type: 'none', reason: 'Not animatable on this clip' };
  const lt = localTime(item, playheadSec);
  if (!lt.inside)
    return { type: 'none', reason: 'Move the playhead over the clip to set a keyframe' };
  const idx = keyframeIndexAt(a.kf, lt.t, frameTol(fps));
  if (idx >= 0) return { type: 'remove', index: idx };
  return { type: 'add', t: lt.t, v: animatedAt(a, lt.t) };
}

/** 'none' = never animated, 'animated' = has keyframes elsewhere, 'on' = a keyframe sits at the playhead. */
export type DiamondState = 'none' | 'animated' | 'on';

export function diamondState(
  item: Item,
  path: AnimatedPath,
  playheadSec: number,
  fps: number,
): DiamondState {
  const a = getAnimated(item, path);
  if (!a || a.kf.length === 0) return 'none';
  const lt = localTime(item, playheadSec);
  return keyframeIndexAt(a.kf, lt.t, frameTol(fps)) >= 0 && lt.inside ? 'on' : 'animated';
}

/** Local times of the keyframes just before / after local time `t` (strictly, beyond half a frame). */
export function neighbourKeyframes(
  kf: readonly Keyframe[],
  t: number,
  tol: number,
): { prev: number | null; next: number | null } {
  let prev: number | null = null;
  let next: number | null = null;
  for (const k of kf) {
    if (k.t < t - tol) prev = k.t;
    else if (k.t > t + tol && next === null) next = k.t;
  }
  return { prev, next };
}

/* ------------------------------------------------------------------ display maths ---------------- */

export const toDisplay = (path: AnimatedPath, stored: number): number =>
  stored * PATH_META[path].mul;
export const fromDisplay = (path: AnimatedPath, shown: number): number =>
  shown / PATH_META[path].mul;

/** Linear gain → dB (−∞ for silence). */
export const gainToDb = (g: number): number => (g <= 1e-6 ? -Infinity : 20 * Math.log10(g));
export const dbToGain = (db: number): number => (db <= -60 ? 0 : Math.pow(10, db / 20));

export function formatDb(g: number): string {
  const db = gainToDb(g);
  if (!Number.isFinite(db)) return '−∞ dB';
  const r = Math.round(db * 10) / 10;
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toFixed(1)} dB`;
}

/** How the keyframe graph frames each property: hard bounds (drag clamps to them) and the smallest vertical span. */
export const GRAPH_BOUNDS: Record<
  AnimatedPath,
  { floor?: number; ceil?: number; minSpan?: number }
> = {
  'transform.x': { minSpan: 200 },
  'transform.y': { minSpan: 200 },
  'transform.scale': { floor: 0, minSpan: 1 },
  'transform.rotation': { minSpan: 90 },
  'transform.opacity': { floor: 0, ceil: 1 },
  'crop.x': { floor: 0, ceil: 1 },
  'crop.y': { floor: 0, ceil: 1 },
  'crop.w': { floor: 0.01, ceil: 1 },
  'crop.h': { floor: 0.01, ceil: 1 },
  volume: { floor: 0, minSpan: 1 },
  blur: { floor: 0, minSpan: 20 },
  'color.exposure': { floor: -1, ceil: 1 },
  'color.contrast': { floor: -1, ceil: 1 },
  'color.saturation': { floor: -1, ceil: 1 },
  'color.temperature': { floor: -1, ceil: 1 },
};
