/**
 * Multi-face / split-screen planner (BRIEF §4.7): two persistent, well separated faces (two speakers
 * side by side, or in video-call tiles) get one panel each, stacked in the output (side by side for
 * 16:9). Every panel has its own crop path built with the same dead-zone / smoothing / cut-aware logic
 * as the single-face planner.
 *
 *  - stable assignment: panel A is the leftmost face of the shot (topmost when the two are stacked);
 *    assignment is decided per shot, so it can only change at a scene cut;
 *  - the crop window of a panel never reaches the other person: it is limited to the face's tile (when
 *    the layout analysis found video-call tiles) and to its side of the midpoint between the two faces;
 *  - window sizes are constant per panel for the whole clip (no breathing zoom): the face fills
 *    ~1/3 of the panel height unless the tile / separation limits force it tighter.
 */
import type { ReframePlan } from '@shared/pipeline';
import type { ReframeService } from '../../pipeline/contracts';
import { outputSize, splitPanels, type Aspect, type Rect } from './geometry';
import { toPx, type Rect01 } from './hint';
import {
  buildShots,
  clamp,
  emitShotPath,
  evenFloor,
  evenRound,
  HOLD_SEC,
  keyframeCollector,
  round2,
  targetFromObs,
  type PathBounds,
  type Pt,
  type Shot,
} from './path';
import { buildTracks, pickPair, type FacePair, type FaceTrack } from './tracks';
import type { FaceSample } from '../../pipeline/contracts';

type PlanArgs = Parameters<ReframeService['plan']>[0];

/** Face centre sits this far from the top of a split panel. */
export const SPLIT_FACE_Y = 0.42;
/** Target face height as a share of the panel height. */
const FACE_FRAC = 0.36;
/** Never let the face fill more than this much of the panel (floor on the window size). */
const FACE_FRAC_MAX = 0.75;
/** Auto mode splits only when this share of the clip duration is covered by shots with two faces. */
export const AUTO_MIN_PAIR_FRACTION = 0.75;

export interface MultiOptions {
  region: Rect;
  tiles: Rect01[];
  /** Minimum share of the clip (by duration) with two faces in view. */
  minPairFraction: number;
}

interface ShotInfo {
  shot: Shot;
  tracks: FaceTrack[];
  pair: FacePair | null;
}

/** Smallest tile (px) that contains the point, or null. */
function tileAround(tiles: Rect[], p: { cx: number; cy: number }): Rect | null {
  let best: Rect | null = null;
  for (const t of tiles) {
    if (p.cx < t.x || p.cx > t.x + t.w || p.cy < t.y || p.cy > t.y + t.h) continue;
    if (!best || t.w * t.h < best.w * best.h) best = t;
  }
  return best;
}

const median = (a: number[]): number => {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1] ?? 0;
};

/** Per-shot persistent tracks and the pair among them (exported for tests and diagnostics). */
export function analyzeShots(
  args: PlanArgs,
  dur: number,
): { shots: ShotInfo[]; pairFraction: number } {
  const { startSec, srcW, srcH } = args;
  const cutsRel = args.sceneCuts.map((c) => c - startSec).filter((c) => c > 0 && c < dur);
  const inClip = args.faces
    .filter((f: FaceSample) => f.t >= startSec - 0.5 && f.t < args.endSec + 0.5)
    .map((f) => ({ t: f.t - startSec, sample: f }))
    .sort((a, b) => a.t - b.t);
  const shots = buildShots(dur, cutsRel).map((shot) => {
    const samples = inClip.filter((s) => s.t >= shot.t0 - 1e-9 && s.t < shot.t1 - 1e-9);
    const tracks = samples.length >= 2 ? buildTracks(samples, srcW, srcH) : [];
    return { shot, tracks, pair: pickPair(tracks) };
  });
  // Time with BOTH faces in view: the overlap of the two tracks' life spans (a detection gap of a
  // second or two does not end a track; a person who leaves does).
  const paired = shots.reduce((sum, x) => {
    if (!x.pair) return sum;
    const span = (t: FaceTrack): [number, number] => [
      Math.max(x.shot.t0, (t.obs[0]?.t ?? x.shot.t0) - 0.5),
      Math.min(x.shot.t1, (t.obs[t.obs.length - 1]?.t ?? x.shot.t1) + HOLD_SEC),
    ];
    const [a0, a1] = span(x.pair.a);
    const [b0, b1] = span(x.pair.b);
    return sum + Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  }, 0);
  return { shots, pairFraction: dur > 0 ? Math.min(1, paired / dur) : 0 };
}

/**
 * Builds the split plan, or null when the footage does not have two faces for long enough
 * (`opts.minPairFraction`) or the output aspect cannot be split.
 */
export function planMulti(args: PlanArgs, opts: MultiOptions): ReframePlan | null {
  const { startSec, endSec, srcW, srcH } = args;
  const aspect = args.aspect as Aspect;
  const dur = Math.max(0.1, endSec - startSec);
  const { shots, pairFraction } = analyzeShots(args, dur);
  if (!shots.some((s) => s.pair) || pairFraction < opts.minPairFraction) return null;

  const region = opts.region;
  const panels = splitPanels(aspect);
  const pa = panels.a.w / panels.a.h;
  // tile edges are estimated to a few px and often carry a dark/blended seam: stay a little inside
  const inset = Math.max(3, Math.round(0.008 * srcH));
  const tilesPx = opts.tiles.map((t) => {
    const r = toPx(t, srcW, srcH);
    return { x: r.x + inset, y: r.y + inset, w: r.w - 2 * inset, h: r.h - 2 * inset };
  });

  // ---- constant window size -------------------------------------------------------------------
  const picked: { track: FaceTrack; side: 'a' | 'b'; pair: FacePair | null }[] = [];
  for (const s of shots) {
    if (s.pair) {
      picked.push(
        { track: s.pair.a, side: 'a', pair: s.pair },
        { track: s.pair.b, side: 'b', pair: s.pair },
      );
    } else if (s.tracks[0]) {
      picked.push(
        { track: s.tracks[0], side: 'a', pair: null },
        { track: s.tracks[0], side: 'b', pair: null },
      );
    }
  }
  const medH = median(picked.map((p) => p.track.h));
  let ch = medH / FACE_FRAC;
  let cw = ch * pa;
  const fit = (maxW: number, maxH: number): void => {
    const s = Math.min(1, maxW / cw, maxH / ch);
    cw *= s;
    ch *= s;
  };
  fit(region.w, region.h);
  const floorH = medH / FACE_FRAC_MAX;
  // tile limit: the window stays inside the tile of each face
  let tileLimited = false;
  for (const p of picked) {
    const tile = tileAround(tilesPx, { cx: p.track.cx, cy: p.track.cy });
    if (tile && (cw > tile.w || ch > tile.h)) {
      fit(tile.w, tile.h);
      tileLimited = true;
    }
  }
  // separation limit (no tile info): the window must not reach the other person
  if (!tileLimited) {
    for (const s of shots) {
      if (!s.pair) continue;
      const { a, b, horizontal } = s.pair;
      if (horizontal) fit(Math.abs(a.cx - b.cx), Infinity);
      else fit(Infinity, Math.abs(a.cy - b.cy));
    }
  }
  if (ch < floorH) {
    ch = floorH;
    cw = ch * pa;
    fit(region.w, region.h);
  }
  const cropH = evenFloor(ch);
  const cropW = Math.min(evenFloor(region.w), evenRound(cropH * pa));

  // ---- paths ----------------------------------------------------------------------------------
  const kfA = keyframeCollector(cropW, cropH);
  const kfB = keyframeCollector(cropW, cropH);
  const regionBounds: PathBounds = {
    minX: region.x,
    maxX: region.x + region.w - cropW,
    minY: region.y,
    maxY: region.y + region.h - cropH,
  };
  const homeAll = (side: 'a' | 'b'): Pt => {
    const ps = picked.filter((p) => p.side === side);
    const cx = median(ps.map((p) => p.track.cx));
    const cy = median(ps.map((p) => p.track.cy));
    return {
      x: clamp(cx - cropW / 2, regionBounds.minX, regionBounds.maxX),
      y: clamp(cy - SPLIT_FACE_Y * cropH, regionBounds.minY, regionBounds.maxY),
    };
  };

  shots.forEach((s, si) => {
    const isLast = si === shots.length - 1;
    for (const side of ['a', 'b'] as const) {
      const track = s.pair ? s.pair[side] : (s.tracks[0] ?? null);
      const other = s.pair ? s.pair[side === 'a' ? 'b' : 'a'] : null;
      const bounds: PathBounds = { ...regionBounds };
      if (track) {
        const tile = tileAround(tilesPx, { cx: track.cx, cy: track.cy });
        if (tile) {
          bounds.minX = Math.max(bounds.minX, tile.x);
          bounds.maxX = Math.min(bounds.maxX, tile.x + tile.w - cropW);
          bounds.minY = Math.max(bounds.minY, tile.y);
          bounds.maxY = Math.min(bounds.maxY, tile.y + tile.h - cropH);
          // window larger than the tile (floor on the size): centre it on the tile
          if (bounds.maxX < bounds.minX) bounds.minX = bounds.maxX = tile.x + (tile.w - cropW) / 2;
          if (bounds.maxY < bounds.minY) bounds.minY = bounds.maxY = tile.y + (tile.h - cropH) / 2;
        }
        if (other && s.pair) {
          // stay on this face's side of the midpoint between the two faces
          if (s.pair.horizontal) {
            const mid = (track.cx + other.cx) / 2;
            if (track.cx < other.cx)
              bounds.maxX = Math.min(bounds.maxX, Math.max(bounds.minX, mid - cropW));
            else bounds.minX = Math.max(bounds.minX, Math.min(bounds.maxX, mid));
          } else {
            const mid = (track.cy + other.cy) / 2;
            if (track.cy < other.cy)
              bounds.maxY = Math.min(bounds.maxY, Math.max(bounds.minY, mid - cropH));
            else bounds.minY = Math.max(bounds.minY, Math.min(bounds.maxY, mid));
          }
        }
      }
      const toCrop = (p: { cx: number; cy: number }): Pt => ({
        x: clamp(p.cx - cropW / 2, bounds.minX, bounds.maxX),
        y: clamp(p.cy - SPLIT_FACE_Y * cropH, bounds.minY, bounds.maxY),
      });
      const home = track ? toCrop(track) : homeAll(side);
      const fixed: Pt = {
        x: clamp(home.x, bounds.minX, bounds.maxX),
        y: clamp(home.y, bounds.minY, bounds.maxY),
      };
      const targetAt = targetFromObs(track?.obs ?? [], toCrop, home);
      emitShotPath(s.shot, isLast, dur, targetAt, {
        cropW,
        cropH,
        bounds,
        fixed,
        emit: (side === 'a' ? kfA : kfB).emit,
      });
    }
  });

  const withFace = shots.reduce((n, s) => n + (s.tracks.length > 0 ? s.shot.t1 - s.shot.t0 : 0), 0);
  const { outW, outH } = outputSize(aspect);
  const cutsUsed = shots.slice(1).map((s) => round2(s.shot.t0 * 1000) / 1000);
  return {
    mode: 'multi-face',
    aspect,
    srcW,
    srcH,
    outW,
    outH,
    keyframes: kfA.keyframes,
    cuts: cutsUsed,
    faceCoverage: Math.round((withFace / dur) * 1000) / 1000,
    layout: 'split',
    panels: [
      { out: panels.a, keyframes: kfA.keyframes, role: 'face-a' },
      { out: panels.b, keyframes: kfB.keyframes, role: 'face-b' },
    ],
  };
}
