/**
 * Shared crop-path machinery of the reframe planners (single face, split screen, screen + face):
 * critically damped smoothing with a trailing dead-zone, scene-cut aware shot splitting, and a
 * detection-gap aware "target at time t" function. Pure and deterministic.
 */
import type { CropKeyframe } from '@shared/pipeline';
import type { Obs } from './track';

export const KEYFRAME_HZ = 10;
/** Face centre sits this far from the top of the crop window (eyes in the upper third). */
export const FACE_Y_FRACTION = 0.4;
/** No detection for less than this: hold the last position; longer: ease toward the home position. */
export const HOLD_SEC = 1.0;
/** Two detections further apart than this are not interpolated across. */
export const INTERP_GAP_SEC = 1.0;
/** At a shot start, a face appearing within this time is assumed to be there already. */
export const LEAD_HOLD_SEC = 1.5;
/** Smoothing time (seconds to ~95% of a step) and pan limits. */
export const SMOOTH_TIME = 0.55;
/** Max pan speed in crop-widths per second. */
export const MAX_PAN_CROPS_PER_SEC = 0.45;
/** Dead-zone half-width as a fraction of the crop size. */
export const DEAD_ZONE_FRAC = 0.03;
/** Scene cuts closer than this to the clip edges / each other are ignored. */
export const MIN_SHOT_SEC = 0.25;

export const round2 = (v: number): number => Math.round(v * 100) / 100;
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const evenFloor = (v: number): number => Math.max(2, 2 * Math.floor(v / 2));
export const evenRound = (v: number): number => Math.max(2, 2 * Math.round(v / 2));

/** Critically damped spring step (analytic, stable for any dt). */
export function smoothDamp(
  current: number,
  target: number,
  vel: number,
  smoothTime: number,
  maxSpeed: number,
  dt: number,
): { value: number; vel: number } {
  const st = Math.max(1e-4, smoothTime);
  const omega = 2 / st;
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const maxChange = maxSpeed * st;
  const change = clamp(current - target, -maxChange, maxChange);
  const adjTarget = current - change;
  const temp = (vel + omega * change) * dt;
  let newVel = (vel - omega * temp) * exp;
  let value = adjTarget + (change + temp) * exp;
  // never overshoot the (real) target
  if (target - current > 0 === value > target) {
    value = target;
    newVel = 0;
  }
  return { value, vel: newVel };
}

export interface Shot {
  t0: number;
  t1: number;
}

/** Splits [0,dur) into shots at the scene cuts (cuts too close to an edge or to each other are dropped). */
export function buildShots(dur: number, cutsRel: number[]): Shot[] {
  const cuts = [...cutsRel].sort((a, b) => a - b);
  const kept: number[] = [];
  let prev = 0;
  for (const c of cuts) {
    if (c - prev >= MIN_SHOT_SEC && dur - c >= MIN_SHOT_SEC) {
      kept.push(c);
      prev = c;
    }
  }
  const bounds = [0, ...kept, dur];
  const shots: Shot[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    shots.push({ t0: bounds[i] ?? 0, t1: bounds[i + 1] ?? dur });
  }
  return shots;
}

export interface Pt {
  x: number;
  y: number;
}

/** Where the crop window's top-left may be (source px). */
export interface PathBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/**
 * "Where should the crop be at time t" for a sequence of detections (sorted by time): interpolates
 * between detections that are close in time, holds through short gaps, then heads for `home`.
 * `toCrop` maps a face observation to the crop top-left.
 */
export function targetFromObs(
  obs: Obs[],
  toCrop: (o: { cx: number; cy: number }) => Pt,
  home: Pt,
): (t: number) => Pt {
  return (t: number): Pt => {
    if (obs.length === 0) return home;
    // binary search: last obs with time <= t
    let lo = 0;
    let hi = obs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((obs[mid]?.t ?? 0) <= t) lo = mid + 1;
      else hi = mid;
    }
    const prev = obs[lo - 1];
    const next = obs[lo];
    if (prev && next && next.t - prev.t <= INTERP_GAP_SEC) {
      const f = (t - prev.t) / Math.max(1e-6, next.t - prev.t);
      return toCrop({
        cx: prev.cx + (next.cx - prev.cx) * f,
        cy: prev.cy + (next.cy - prev.cy) * f,
      });
    }
    if (prev) {
      // short gap: hold; long gap: head for home (the smoother makes it an ease)
      return t - prev.t <= HOLD_SEC ? toCrop(prev) : home;
    }
    // before the first detection of the shot
    if (next && next.t - t <= LEAD_HOLD_SEC) return toCrop(next);
    return home;
  };
}

export interface ShotPathOptions {
  cropW: number;
  cropH: number;
  bounds: PathBounds;
  /** Position used on an axis that cannot pan. */
  fixed: Pt;
  /** Appends a keyframe (time relative to the clip, crop top-left in source px). */
  emit: (t: number, x: number, y: number) => void;
}

/**
 * Emits the smoothed keyframes of one shot: trailing dead-zone -> critically damped smoothing with a
 * pan-speed limit. The filter state starts AT the target (no smoothing across a cut). The last shot
 * ends with a keyframe at the clip end; earlier ones hold up to the cut.
 */
export function emitShotPath(
  shot: Shot,
  isLast: boolean,
  clipDur: number,
  targetAt: (t: number) => Pt,
  o: ShotPathOptions,
): void {
  const { cropW, cropH, bounds, fixed } = o;
  const canPanX = bounds.maxX - bounds.minX > 0.5;
  const canPanY = bounds.maxY - bounds.minY > 0.5;
  const dt = 1 / KEYFRAME_HZ;
  const dzX = DEAD_ZONE_FRAC * cropW;
  const dzY = DEAD_ZONE_FRAC * cropH;
  const maxSpeedX = MAX_PAN_CROPS_PER_SEC * cropW;
  const maxSpeedY = MAX_PAN_CROPS_PER_SEC * cropH;

  const start = targetAt(shot.t0);
  let px = canPanX ? clamp(start.x, bounds.minX, bounds.maxX) : fixed.x;
  let py = canPanY ? clamp(start.y, bounds.minY, bounds.maxY) : fixed.y;
  let vx = 0;
  let vy = 0;
  let cx = start.x; // dead-zone camera targets
  let cy = start.y;
  const steps = Math.max(1, Math.ceil((shot.t1 - shot.t0) / dt - 1e-9));
  o.emit(shot.t0, px, py);
  for (let k = 1; k < steps; k++) {
    const t = shot.t0 + k * dt;
    const tg = targetAt(t);
    // trailing dead-zone: the camera target only moves when the face pushes at the zone's edge
    if (canPanX) {
      if (tg.x - cx > dzX) cx = tg.x - dzX;
      else if (cx - tg.x > dzX) cx = tg.x + dzX;
      const r = smoothDamp(px, clamp(cx, bounds.minX, bounds.maxX), vx, SMOOTH_TIME, maxSpeedX, dt);
      px = r.value;
      vx = r.vel;
    }
    if (canPanY) {
      if (tg.y - cy > dzY) cy = tg.y - dzY;
      else if (cy - tg.y > dzY) cy = tg.y + dzY;
      const r = smoothDamp(py, clamp(cy, bounds.minY, bounds.maxY), vy, SMOOTH_TIME, maxSpeedY, dt);
      py = r.value;
      vy = r.vel;
    }
    px = canPanX ? clamp(px, bounds.minX, bounds.maxX) : fixed.x;
    py = canPanY ? clamp(py, bounds.minY, bounds.maxY) : fixed.y;
    o.emit(t, px, py);
  }
  // hold the last position right up to the cut; consumers that interpolate linearly see a step
  if (!isLast) o.emit(shot.t1 - 0.001, px, py);
  else o.emit(clipDur, px, py);
}

/** Collects keyframes with a constant window size; times are rounded like the CP1 planner. */
export function keyframeCollector(
  cropW: number,
  cropH: number,
): { keyframes: CropKeyframe[]; emit: ShotPathOptions['emit'] } {
  const keyframes: CropKeyframe[] = [];
  return {
    keyframes,
    emit: (t, x, y) => {
      keyframes.push({
        t: round2(t * 1000) / 1000,
        x: round2(x),
        y: round2(y),
        w: cropW,
        h: cropH,
      });
    },
  };
}
