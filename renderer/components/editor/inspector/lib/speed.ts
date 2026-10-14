import type { AudioItem, Keyframe, VideoItem } from '@shared/editor';
import { sourceSpan } from '@shared/editor-eval';

/* Speed-ramp helpers: presets, constant ↔ ramp conversion and the source-consumption read-out. */

type MediaItem = VideoItem | AudioItem;

export const SPEED_MIN = 0.1;
export const SPEED_MAX = 10;
export const clampSpeed = (v: number): number => Math.min(SPEED_MAX, Math.max(SPEED_MIN, v));

/** Constant speed shown as "1.5×" / "0.25×". */
export function formatSpeed(v: number): string {
  const r = v >= 10 ? v.toFixed(1) : v >= 1 ? v.toFixed(2) : v.toFixed(2);
  return `${r.replace(/\.?0+$/, '')}×`;
}

/** Average speed over the whole item = source consumed ÷ timeline duration. */
export function averageSpeed(item: MediaItem): number {
  return sourceSpan(item) / Math.max(item.durationSec, 1e-6);
}

/** Start editing a ramp from a constant speed: two keyframes holding the same speed at both ends. */
export function rampFromConstant(speed: number, durationSec: number): Keyframe[] {
  return [
    { t: 0, v: clampSpeed(speed), ease: 'linear' },
    { t: durationSec, v: clampSpeed(speed), ease: 'linear' },
  ];
}

/** Collapse a ramp back to a constant speed that consumes the SAME source (so the clip's content does not change). */
export function constantFromRamp(item: MediaItem): number {
  return clampSpeed(averageSpeed(item));
}

export interface RampPreset {
  id: string;
  label: string;
  hint: string;
  /** Builds the keyframes for an item of `durationSec` at `base` speed (kept as the 1× reference). */
  build(durationSec: number, base: number): Keyframe[];
}

const k = (t: number, v: number, ease: Keyframe['ease'] = 'ease-in-out'): Keyframe => ({
  t,
  v: clampSpeed(v),
  ease,
});

export const RAMP_PRESETS: RampPreset[] = [
  {
    id: 'speed-up',
    label: 'Speed up',
    hint: 'Slow start, fast finish',
    build: (d, b) => [k(0, b * 0.5), k(d, b * 3, 'linear')],
  },
  {
    id: 'slow-down',
    label: 'Slow down',
    hint: 'Fast start, slow finish',
    build: (d, b) => [k(0, b * 3), k(d, b * 0.5, 'linear')],
  },
  {
    id: 'bullet',
    label: 'Bullet time',
    hint: 'Fast, slow-motion in the middle, fast',
    build: (d, b) => [k(0, b * 2), k(d * 0.35, b * 2), k(d * 0.5, b * 0.2), k(d * 0.65, b * 2), k(d, b * 2, 'linear')],
  },
  {
    id: 'pulse',
    label: 'Pulse',
    hint: 'A quick slow-down on the beat',
    build: (d, b) => [k(0, b), k(d * 0.4, b), k(d * 0.5, b * 0.3), k(d * 0.6, b), k(d, b, 'linear')],
  },
];

/** True when two keyframe lists describe the same ramp (used to highlight the active preset). */
export function sameRamp(a: readonly Keyframe[], b: readonly Keyframe[]): boolean {
  return (
    a.length === b.length &&
    a.every((x, i) => {
      const y = b[i] as Keyframe;
      return Math.abs(x.t - y.t) < 1e-3 && Math.abs(x.v - y.v) < 1e-3;
    })
  );
}

/**
 * Scales every ramp keyframe's speed so the whole ramp consumes `targetSpan` source seconds (keeps what the clip
 * SHOWS while reshaping the timing). Returns the original keyframes when nothing can be solved.
 */
export function fitRampToSpan(item: MediaItem, kf: readonly Keyframe[], targetSpan: number): Keyframe[] {
  const cur = sourceSpan({ ...item, speedCurve: [...kf] });
  if (cur <= 1e-6 || targetSpan <= 0) return [...kf];
  const f = targetSpan / cur;
  return kf.map((x) => ({ ...x, v: clampSpeed(x.v * f) }));
}
