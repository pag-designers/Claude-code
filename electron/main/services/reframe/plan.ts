/**
 * Reframe planner (BRIEF §4.7): face samples -> smooth crop path.
 *
 *  - per shot (scene cuts split the clip): follow the dominant face, hold through short detection gaps
 *    (< HOLD_SEC), ease to the centre for longer ones;
 *  - target -> trailing dead-zone (a still speaker => a still camera) -> critically-damped smoothing
 *    with a pan-speed limit; the filter state is reset at every cut (the crop JUMPS at a cut);
 *  - keyframes at 10 Hz + at every cut; x/y are top-left of the crop window in source pixels.
 */
import type { CropKeyframe, ReframePlan } from '@shared/pipeline';
import type { ReframeService } from '../../pipeline/contracts';
import { cropGeometry, type Aspect } from './geometry';
import { DEFAULT_TRACKER, medianFilter, trackDominant, usableFaces, type Obs } from './track';

export const KEYFRAME_HZ = 10;
/** Face centre sits this far from the top of the crop window (eyes in the upper third). */
export const FACE_Y_FRACTION = 0.4;
/** No detection for less than this: hold the last position; longer: ease toward the centre. */
export const HOLD_SEC = 1.0;
/** Two detections further apart than this are not interpolated across. */
const INTERP_GAP_SEC = 1.0;
/** At a shot start, a face appearing within this time is assumed to be there already. */
const LEAD_HOLD_SEC = 1.5;
/** Smoothing time (seconds to ~95% of a step) and pan limits. */
export const SMOOTH_TIME = 0.55;
/** Max pan speed in crop-widths per second. */
export const MAX_PAN_CROPS_PER_SEC = 0.45;
/** Dead-zone half-width as a fraction of the crop size. */
export const DEAD_ZONE_FRAC = 0.03;
/** Below this fraction of samples with a face we do not trust tracking: static centre crop. */
const MIN_COVERAGE = 0.2;
/** Scene cuts closer than this to the clip edges / each other are ignored. */
const MIN_SHOT_SEC = 0.25;
/** Shot reliability: fewer detections than this share of samples, or this many face switches. */
const FLAKY_COVERAGE = 0.4;
const FLAKY_SWITCHES = 2;
/** Flaky shot: park on the median face position only if the detections agree within this fraction of the width. */
const FLAKY_SPREAD = 0.2;

const round2 = (v: number): number => Math.round(v * 100) / 100;
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

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

interface Shot {
  t0: number;
  t1: number;
}

function buildShots(dur: number, cutsRel: number[]): Shot[] {
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

/** Pan target (crop top-left, source px) for an observation. */
function cropTarget(
  o: { cx: number; cy: number },
  g: { cropW: number; cropH: number },
  srcW: number,
  srcH: number,
): { x: number; y: number } {
  return {
    x: clamp(o.cx - g.cropW / 2, 0, srcW - g.cropW),
    y: clamp(o.cy - FACE_Y_FRACTION * g.cropH, 0, srcH - g.cropH),
  };
}

export function planReframe(args: Parameters<ReframeService['plan']>[0]): ReframePlan {
  const { startSec, endSec, srcW, srcH, aspect } = args;
  const dur = Math.max(0.1, endSec - startSec);
  const g = cropGeometry(aspect as Aspect, srcW, srcH);
  const centre = { x: (srcW - g.cropW) / 2, y: (srcH - g.cropH) / 2 };
  const canPanX = srcW - g.cropW > 0.5;
  const canPanY = srcH - g.cropH > 0.5;

  // face samples that matter (a little margin so the first/last shot has data at its edges)
  const inClip = args.faces
    .filter((f) => f.t >= startSec - 0.5 && f.t < endSec + 0.5)
    .map((f) => ({ t: f.t - startSec, sample: f }))
    .sort((a, b) => a.t - b.t);
  const strictSamples = inClip.filter((s) => s.t >= 0 && s.t < dur);
  const withFace = strictSamples.filter(
    (s) => usableFaces(s.sample, s.t, srcW, srcH, DEFAULT_TRACKER).length > 0,
  ).length;
  const faceCoverage = strictSamples.length > 0 ? withFace / strictSamples.length : 0;

  const base = {
    aspect: aspect as Aspect,
    srcW,
    srcH,
    outW: g.outW,
    outH: g.outH,
    faceCoverage: Math.round(faceCoverage * 1000) / 1000,
  };
  const cutsRel = args.sceneCuts.map((c) => c - startSec).filter((c) => c > 0 && c < dur);
  const staticPlan = (cuts: number[]): ReframePlan => ({
    mode: 'center',
    ...base,
    keyframes: [
      { t: 0, x: round2(centre.x), y: round2(centre.y), w: g.cropW, h: g.cropH },
      { t: round2(dur), x: round2(centre.x), y: round2(centre.y), w: g.cropW, h: g.cropH },
    ],
    cuts,
  });

  if ((!canPanX && !canPanY) || faceCoverage < MIN_COVERAGE) {
    return staticPlan(cutsRel);
  }

  const shots = buildShots(dur, cutsRel);
  const keyframes: CropKeyframe[] = [];
  const dt = 1 / KEYFRAME_HZ;
  const dzX = DEAD_ZONE_FRAC * g.cropW;
  const dzY = DEAD_ZONE_FRAC * g.cropH;
  const maxSpeedX = MAX_PAN_CROPS_PER_SEC * g.cropW;
  const maxSpeedY = MAX_PAN_CROPS_PER_SEC * g.cropH;
  const emit = (t: number, x: number, y: number): void => {
    keyframes.push({
      t: round2(t * 1000) / 1000,
      x: round2(x),
      y: round2(y),
      w: g.cropW,
      h: g.cropH,
    });
  };

  let anyTracked = false;
  for (let si = 0; si < shots.length; si++) {
    const shot = shots[si];
    if (!shot) continue;
    const isLast = si === shots.length - 1;
    // samples in this shot (a sample belongs to the shot that contains its time)
    const shotSamples = inClip.filter((s) => s.t >= shot.t0 - 1e-9 && s.t < shot.t1 - 1e-9);
    const tracked = trackDominant(shotSamples, srcW, srcH, DEFAULT_TRACKER);
    const obs: Obs[] = medianFilter(tracked.obs.filter((o): o is Obs => o !== null));
    if (obs.length > 0) anyTracked = true;
    // A shot where the detector is flaky (rare detections, or the followed face keeps changing: tiled
    // video-call layouts, crowds) must not make the camera wander: park it on the typical face position.
    const flaky =
      obs.length > 0 &&
      shotSamples.length >= 4 &&
      (obs.length / shotSamples.length < FLAKY_COVERAGE || tracked.switches >= FLAKY_SWITCHES);
    let fixed: { x: number; y: number } | null = null;
    if (flaky) {
      const cxs = obs.map((o) => o.cx).sort((a, b) => a - b);
      const cys = obs.map((o) => o.cy).sort((a, b) => a - b);
      const q = (a: number[], f: number): number =>
        a[Math.min(a.length - 1, Math.floor(f * a.length))] ?? 0;
      const spread = q(cxs, 0.9) - q(cxs, 0.1);
      fixed =
        spread <= FLAKY_SPREAD * srcW
          ? cropTarget({ cx: q(cxs, 0.5), cy: q(cys, 0.5) }, g, srcW, srcH)
          : centre;
    }

    const targetAt = (t: number): { x: number; y: number } => {
      if (fixed) return fixed;
      if (obs.length === 0) return centre;
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
        return cropTarget(
          { cx: prev.cx + (next.cx - prev.cx) * f, cy: prev.cy + (next.cy - prev.cy) * f },
          g,
          srcW,
          srcH,
        );
      }
      if (prev) {
        // short gap: hold; long gap: head for the centre (the smoother makes it an ease)
        return t - prev.t <= HOLD_SEC ? cropTarget(prev, g, srcW, srcH) : centre;
      }
      // before the first detection of the shot
      if (next && next.t - t <= LEAD_HOLD_SEC) return cropTarget(next, g, srcW, srcH);
      return centre;
    };

    // filter state, reset per shot (no smoothing across cuts)
    const start = targetAt(shot.t0);
    let px = start.x;
    let py = start.y;
    let vx = 0;
    let vy = 0;
    let cx = start.x; // dead-zone camera targets
    let cy = start.y;
    const steps = Math.max(1, Math.ceil((shot.t1 - shot.t0) / dt - 1e-9));
    emit(shot.t0, px, py);
    for (let k = 1; k < steps; k++) {
      const t = shot.t0 + k * dt;
      const tg = targetAt(t);
      // trailing dead-zone: the camera target only moves when the face pushes at the zone's edge
      if (canPanX) {
        if (tg.x - cx > dzX) cx = tg.x - dzX;
        else if (cx - tg.x > dzX) cx = tg.x + dzX;
        const r = smoothDamp(px, clamp(cx, 0, srcW - g.cropW), vx, SMOOTH_TIME, maxSpeedX, dt);
        px = r.value;
        vx = r.vel;
      }
      if (canPanY) {
        if (tg.y - cy > dzY) cy = tg.y - dzY;
        else if (cy - tg.y > dzY) cy = tg.y + dzY;
        const r = smoothDamp(py, clamp(cy, 0, srcH - g.cropH), vy, SMOOTH_TIME, maxSpeedY, dt);
        py = r.value;
        vy = r.vel;
      }
      px = canPanX ? clamp(px, 0, srcW - g.cropW) : centre.x;
      py = canPanY ? clamp(py, 0, srcH - g.cropH) : centre.y;
      emit(t, px, py);
    }
    if (!isLast) {
      // hold the last position right up to the cut; consumers that interpolate linearly see a step
      emit(shot.t1 - 0.001, px, py);
    } else {
      emit(dur, px, py);
    }
  }

  if (!anyTracked) return staticPlan(cutsRel);
  // The cut list reported in the plan is the one actually used for the jumps.
  const usedCuts = shots.slice(1).map((s) => round2(s.t0 * 1000) / 1000);
  return { mode: 'single-face', ...base, keyframes, cuts: usedCuts };
}
