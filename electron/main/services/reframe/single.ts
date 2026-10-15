/**
 * Single-face reframe planner (BRIEF §4.7, CP1 + CP2 framing improvements).
 *
 *  - per shot (scene cuts split the clip): follow the dominant face, hold through short detection gaps
 *    (< HOLD_SEC), ease to the centre for longer ones;
 *  - target -> trailing dead-zone (a still speaker => a still camera) -> critically-damped smoothing
 *    with a pan-speed limit; the filter state is reset at every cut (the crop JUMPS at a cut);
 *  - keyframes at 10 Hz + at every cut; x/y are top-left of the crop window in source pixels;
 *  - CP2: a gentle constant zoom-in when the face would otherwise sit below the 40% line (a 16:9 -> 9:16
 *    crop uses the full source height, so there is no vertical freedom without zooming), and a
 *    content region (letterbox bars removed) that bounds the crop window.
 */
import type { ReframePlan } from '@shared/pipeline';
import type { ReframeService } from '../../pipeline/contracts';
import { cropGeometry, outputSize, type Aspect, type CropGeometry, type Rect } from './geometry';
import {
  buildShots,
  clamp,
  emitShotPath,
  evenFloor,
  evenRound,
  FACE_Y_FRACTION,
  keyframeCollector,
  round2,
  targetFromObs,
  type Pt,
} from './path';
import { DEFAULT_TRACKER, medianFilter, trackDominant, usableFaces, type Obs } from './track';

/** Below this fraction of samples with a face we do not trust tracking: static centre crop. */
const MIN_COVERAGE = 0.2;
/** Shot reliability: fewer detections than this share of samples, or this many face switches. */
const FLAKY_COVERAGE = 0.4;
const FLAKY_SWITCHES = 2;
/** Flaky shot: park on the median face position only if the detections agree within this fraction of the width. */
const FLAKY_SPREAD = 0.2;

/** Zoom-in limits: gentle (<= 1.25x) and never so tight that the face fills the frame. */
export const ZOOM_MAX = 1.25;
const ZOOM_MIN_EFFECT = 1.02;
const ZOOM_FACE_H_MAX = 0.36;
const ZOOM_FACE_W_MAX = 0.55;
/** Share of the time the face should be able to reach the target line (the rest clamps at the edge). */
const ZOOM_QUANTILE = 0.8;

type PlanArgs = Parameters<ReframeService['plan']>[0];

export interface SingleOptions {
  /** Picture area (letterbox bars removed), source px. Default: the whole frame. */
  region?: Rect;
  /** Zoom in to bring the face up to the 40% line. Default true. */
  zoom?: boolean;
}

/** Plan for a static centre crop of the picture area. */
export function centerPlan(args: PlanArgs, region?: Rect, faceCoverage = 0): ReframePlan {
  const { startSec, endSec, srcW, srcH, aspect } = args;
  const dur = Math.max(0.1, endSec - startSec);
  const reg = region ?? { x: 0, y: 0, w: srcW, h: srcH };
  const g = cropGeometry(aspect as Aspect, reg.w, reg.h);
  const x = round2(reg.x + (reg.w - g.cropW) / 2);
  const y = round2(reg.y + (reg.h - g.cropH) / 2);
  const cutsRel = args.sceneCuts.map((c) => c - startSec).filter((c) => c > 0 && c < dur);
  return {
    mode: 'center',
    aspect: aspect as Aspect,
    srcW,
    srcH,
    outW: g.outW,
    outH: g.outH,
    faceCoverage: Math.round(faceCoverage * 1000) / 1000,
    keyframes: [
      { t: 0, x, y, w: g.cropW, h: g.cropH },
      { t: round2(dur), x, y, w: g.cropW, h: g.cropH },
    ],
    cuts: cutsRel,
    layout: 'single',
  };
}

/**
 * Constant zoom factor (>= 1) that lets the face reach the 40% line: with the crop spanning the full
 * region height the face can only sit where it is in the source; shrinking the window gives room.
 */
export function chooseZoom(obs: Obs[], g: CropGeometry, region: Rect, aspect: Aspect): number {
  if (obs.length < 3) return 1;
  const sorted = (a: number[]): number[] => [...a].sort((x, y) => x - y);
  const q = (a: number[], f: number): number =>
    a[Math.min(a.length - 1, Math.floor(f * a.length))] ?? 0;
  const cyR = sorted(obs.map((o) => o.cy - region.y));
  const hmax = (region.h - q(cyR, ZOOM_QUANTILE)) / (1 - FACE_Y_FRACTION);
  if (hmax >= g.cropH) return 1;
  let z = g.cropH / Math.max(1, hmax);
  const medH = q(sorted(obs.map((o) => o.h)), 0.5);
  const medW = q(sorted(obs.map((o) => o.w)), 0.5);
  void aspect;
  z = Math.min(z, ZOOM_MAX);
  if (medH > 0) z = Math.min(z, (g.cropH * ZOOM_FACE_H_MAX) / medH);
  if (medW > 0) z = Math.min(z, (g.cropW * ZOOM_FACE_W_MAX) / medW);
  return z < ZOOM_MIN_EFFECT ? 1 : z;
}

export function planSingle(args: PlanArgs, o: SingleOptions = {}): ReframePlan {
  const { startSec, endSec, srcW, srcH, aspect } = args;
  const dur = Math.max(0.1, endSec - startSec);
  const region: Rect = o.region ?? { x: 0, y: 0, w: srcW, h: srcH };
  const g0 = cropGeometry(aspect as Aspect, region.w, region.h);
  const canPan0 = region.w - g0.cropW > 0.5 || region.h - g0.cropH > 0.5;

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
  const cutsRel = args.sceneCuts.map((c) => c - startSec).filter((c) => c > 0 && c < dur);

  if (!canPan0 || faceCoverage < MIN_COVERAGE) {
    return centerPlan(args, region, faceCoverage);
  }

  // ---- pass 1: per-shot tracking --------------------------------------------------------------
  const shots = buildShots(dur, cutsRel);
  interface ShotData {
    shot: (typeof shots)[number];
    obs: Obs[];
    flaky: boolean;
  }
  const data: ShotData[] = shots.map((shot) => {
    const shotSamples = inClip.filter((s) => s.t >= shot.t0 - 1e-9 && s.t < shot.t1 - 1e-9);
    const tracked = trackDominant(shotSamples, srcW, srcH, DEFAULT_TRACKER);
    const obs: Obs[] = medianFilter(tracked.obs.filter((x): x is Obs => x !== null));
    // A shot where the detector is flaky (rare detections, or the followed face keeps changing: tiled
    // video-call layouts, crowds) must not make the camera wander: park it on the typical position.
    const flaky =
      obs.length > 0 &&
      shotSamples.length >= 4 &&
      (obs.length / shotSamples.length < FLAKY_COVERAGE || tracked.switches >= FLAKY_SWITCHES);
    return { shot, obs, flaky };
  });
  if (!data.some((d) => d.obs.length > 0)) return centerPlan(args, region, faceCoverage);

  // ---- zoom (constant per plan), from the reliable shots --------------------------------------
  let g: CropGeometry = g0;
  if (o.zoom !== false) {
    const reliable = data.filter((d) => !d.flaky).flatMap((d) => d.obs);
    const zoom = chooseZoom(reliable, g0, region, aspect as Aspect);
    if (zoom > 1) {
      const cropH = evenFloor(g0.cropH / zoom);
      const ratio = g0.outW / g0.outH;
      const cropW = Math.min(g0.cropW, evenRound(cropH * ratio));
      g = { ...g0, cropW, cropH };
    }
  }
  const bounds = {
    minX: region.x,
    maxX: region.x + region.w - g.cropW,
    minY: region.y,
    maxY: region.y + region.h - g.cropH,
  };
  const centre: Pt = {
    x: region.x + (region.w - g.cropW) / 2,
    y: region.y + (region.h - g.cropH) / 2,
  };
  const toCrop = (p: { cx: number; cy: number }): Pt => ({
    x: clamp(p.cx - g.cropW / 2, bounds.minX, bounds.maxX),
    y: clamp(p.cy - FACE_Y_FRACTION * g.cropH, bounds.minY, bounds.maxY),
  });

  // ---- pass 2: paths --------------------------------------------------------------------------
  const kc = keyframeCollector(g.cropW, g.cropH);
  data.forEach((d, si) => {
    let fixed: Pt | null = null;
    if (d.flaky) {
      const cxs = d.obs.map((x) => x.cx).sort((a, b) => a - b);
      const cys = d.obs.map((x) => x.cy).sort((a, b) => a - b);
      const q = (a: number[], f: number): number =>
        a[Math.min(a.length - 1, Math.floor(f * a.length))] ?? 0;
      const spread = q(cxs, 0.9) - q(cxs, 0.1);
      fixed = spread <= FLAKY_SPREAD * srcW ? toCrop({ cx: q(cxs, 0.5), cy: q(cys, 0.5) }) : centre;
    }
    const targetAt = fixed ? (): Pt => fixed as Pt : targetFromObs(d.obs, toCrop, centre);
    emitShotPath(d.shot, si === data.length - 1, dur, targetAt, {
      cropW: g.cropW,
      cropH: g.cropH,
      bounds,
      fixed: centre,
      emit: kc.emit,
    });
  });

  const { outW, outH } = outputSize(aspect as Aspect);
  // The cut list reported in the plan is the one actually used for the jumps.
  const usedCuts = shots.slice(1).map((s) => round2(s.t0 * 1000) / 1000);
  return {
    mode: 'single-face',
    aspect: aspect as Aspect,
    srcW,
    srcH,
    outW,
    outH,
    faceCoverage: Math.round(faceCoverage * 1000) / 1000,
    keyframes: kc.keyframes,
    cuts: usedCuts,
    layout: 'single',
  };
}
