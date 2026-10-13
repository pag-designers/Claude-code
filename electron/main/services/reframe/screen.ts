/**
 * Screen + face planner (BRIEF §4.7): a screen share with a small webcam. Output = the shared screen on
 * top (scaled to FIT the width, never stretched; the renderer fills the letter/pillar boxes with a blurred
 * copy of the picture) and the webcam face as a close-up strip below.
 *
 * Plan conventions (consumed by services/render):
 *  - panels[0] role 'screen': ONE static keyframe pair describing the screen REGION of the source (its
 *    aspect usually differs from the panel: the renderer contain-fits it and blurs the rest);
 *  - panels[1] role 'face': an ordinary animated crop path whose windows have the panel's aspect.
 */
import type { ReframePlan } from '@shared/pipeline';
import type { ReframeService } from '../../pipeline/contracts';
import { outputSize, screenFacePanels, type Aspect, type Rect } from './geometry';
import { toPx } from './hint';
import type { LayoutHint } from '../../pipeline/contracts';
import {
  buildShots,
  clamp,
  emitShotPath,
  evenFloor,
  evenRound,
  keyframeCollector,
  round2,
  targetFromObs,
  type Pt,
} from './path';
import { buildTracks } from './tracks';
import { medianFilter, type Obs } from './track';

type PlanArgs = Parameters<ReframeService['plan']>[0];

/** The face is centred this far from the top of the webcam strip. */
export const WEBCAM_FACE_Y = 0.46;
/** Target face height as a share of the strip height (bounded by the webcam rectangle). */
const WEBCAM_FACE_FRAC = 0.55;


/** Webcam rectangle (px) around a face box: wide enough for head + shoulders, clamped to the frame. */
export function webcamRectFromFace(
  face: { cx: number; cy: number; w: number; h: number },
  srcW: number,
  srcH: number,
): Rect {
  const w = Math.min(srcW, face.w * 2.4);
  const h = Math.min(srcH, face.h * 2.0);
  return {
    x: clamp(face.cx - w / 2, 0, srcW - w),
    y: clamp(face.cy - h * 0.46, 0, srcH - h),
    w,
    h,
  };
}

/**
 * Builds the screen + face plan, or null when no webcam face can be located (no hint region and no
 * face detections in the clip).
 */
export function planScreenFace(
  args: PlanArgs,
  hint: LayoutHint | null,
  region: Rect,
): ReframePlan | null {
  const { startSec, endSec, srcW, srcH } = args;
  const aspect = args.aspect as Aspect;
  const dur = Math.max(0.1, endSec - startSec);
  const panels = screenFacePanels(aspect);
  const pa = panels.face.w / panels.face.h;
  const cutsRel = args.sceneCuts.map((c) => c - startSec).filter((c) => c > 0 && c < dur);

  const inClip = args.faces
    .filter((f) => f.t >= startSec - 0.5 && f.t < endSec + 0.5)
    .map((f) => ({ t: f.t - startSec, sample: f }))
    .sort((a, b) => a.t - b.t);
  const tracks = buildTracks(inClip, srcW, srcH);
  // the webcam face = the track nearest to the hinted region, else the strongest one
  const hintRect = hint?.faceRegion ? toPx(hint.faceRegion, srcW, srcH) : null;
  let track = tracks[0] ?? null;
  if (hintRect) {
    const hc = { x: hintRect.x + hintRect.w / 2, y: hintRect.y + hintRect.h / 2 };
    track =
      [...tracks].sort(
        (a, b) => Math.hypot(a.cx - hc.x, a.cy - hc.y) - Math.hypot(b.cx - hc.x, b.cy - hc.y),
      )[0] ?? null;
    if (track && Math.hypot(track.cx - hc.x, track.cy - hc.y) > Math.max(hintRect.w, hintRect.h)) {
      track = null;
    }
  }
  if (!track && !hintRect) return null;

  const cam: Rect =
    hintRect ??
    webcamRectFromFace(track ?? { cx: srcW / 2, cy: srcH / 2, w: srcW / 8, h: srcW / 8 }, srcW, srcH);
  // window: the face fills ~55% of the strip, never larger than the webcam rectangle (so no screen
  // content bleeds into the strip), never smaller than the face itself
  const faceH = track?.h ?? cam.h / 1.8;
  let ch = faceH / WEBCAM_FACE_FRAC;
  let cw = ch * pa;
  const s = Math.min(1, cam.w / cw, cam.h / ch);
  cw *= s;
  ch *= s;
  ch = Math.max(ch, Math.min(faceH * 1.25, cam.h));
  cw = ch * pa;
  const cropH = evenFloor(Math.min(ch, srcH));
  const cropW = Math.min(evenFloor(srcW), evenRound(cropH * pa));

  const bounds = {
    minX: clamp(cam.x, 0, srcW - cropW),
    maxX: clamp(cam.x + cam.w - cropW, 0, srcW - cropW),
    minY: clamp(cam.y, 0, srcH - cropH),
    maxY: clamp(cam.y + cam.h - cropH, 0, srcH - cropH),
  };
  if (bounds.maxX < bounds.minX) bounds.minX = bounds.maxX = clamp(cam.x + (cam.w - cropW) / 2, 0, srcW - cropW);
  if (bounds.maxY < bounds.minY) bounds.minY = bounds.maxY = clamp(cam.y + (cam.h - cropH) / 2, 0, srcH - cropH);
  const toCrop = (p: { cx: number; cy: number }): Pt => ({
    x: clamp(p.cx - cropW / 2, bounds.minX, bounds.maxX),
    y: clamp(p.cy - WEBCAM_FACE_Y * cropH, bounds.minY, bounds.maxY),
  });
  const home = toCrop(track ?? { cx: cam.x + cam.w / 2, cy: cam.y + cam.h * 0.46 });

  const shots = buildShots(dur, cutsRel);
  const kf = keyframeCollector(cropW, cropH);
  const obs: Obs[] = track ? medianFilter(track.obs) : [];
  shots.forEach((shot, si) => {
    const inShot = obs.filter((o) => o.t >= shot.t0 - 1e-9 && o.t < shot.t1 - 1e-9);
    emitShotPath(shot, si === shots.length - 1, dur, targetFromObs(inShot, toCrop, home), {
      cropW,
      cropH,
      bounds,
      fixed: home,
      emit: kf.emit,
    });
  });

  // screen panel: static region (default: the whole picture area)
  const scr: Rect = hint?.screenRegion ? toPx(hint.screenRegion, srcW, srcH) : region;
  const sx = 2 * Math.round(clamp(scr.x, 0, srcW - 2) / 2);
  const sy = 2 * Math.round(clamp(scr.y, 0, srcH - 2) / 2);
  const sw = Math.min(srcW - sx, evenRound(scr.w));
  const sh = Math.min(srcH - sy, evenRound(scr.h));
  const screenKfs = [
    { t: 0, x: sx, y: sy, w: sw, h: sh },
    { t: round2(dur), x: sx, y: sy, w: sw, h: sh },
  ];
  const withFace = inClip.length > 0 ? obs.length / inClip.length : 0;
  const { outW, outH } = outputSize(aspect);
  return {
    mode: 'screen-face',
    aspect,
    srcW,
    srcH,
    outW,
    outH,
    keyframes: kf.keyframes,
    cuts: shots.slice(1).map((s) => round2(s.t0 * 1000) / 1000),
    faceCoverage: Math.round(Math.min(1, withFace) * 1000) / 1000,
    layout: 'screen-face',
    panels: [
      { out: panels.screen, keyframes: screenKfs, role: 'screen' },
      { out: panels.face, keyframes: kf.keyframes, role: 'face' },
    ],
  };
}

