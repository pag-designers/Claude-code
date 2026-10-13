/**
 * Persistent multi-face tracks for one shot (split-screen / screen + face planners).
 *
 * Unlike `trackDominant` (which follows ONE face with hysteresis) this keeps every face that is
 * present often enough, so two people side by side or in video-call tiles can each get their own
 * crop path. Association is by proximity (tiles and seated people hardly move); the order of the
 * returned pair is stable: leftmost first (or topmost first when the two are stacked).
 */
import type { FaceSample } from '../../pipeline/contracts';
import { medianFilter, usableFaces, type Obs, type TrackerConfig } from './track';

/** Detection thresholds for multi-face work: tile faces are small and score low (0.3-0.5). */
export const MULTI_TRACKER: TrackerConfig = {
  minScore: 0.3,
  minFaceHeightFrac: 0.05,
  tau: 3.0,
  switchRatio: 2.0,
  lostSec: 1.0,
  maxGapSec: 1.5,
};

export interface FaceTrack {
  id: number;
  /** Detections (clip-relative time), median-filtered, time-sorted. */
  obs: Obs[];
  /** Fraction of the shot's samples in which the face was detected. */
  presence: number;
  /** Medians in source pixels. */
  cx: number;
  cy: number;
  w: number;
  h: number;
  /** Sum of area x score^2 over detections (saliency mass). */
  evidence: number;
  /** Mean detector confidence. */
  score: number;
}

export interface TrackOptions {
  /** A track must be present in at least this share of the shot's samples. */
  minPresence: number;
  cfg: TrackerConfig;
}

export const DEFAULT_TRACK_OPTS: TrackOptions = { minPresence: 0.25, cfg: MULTI_TRACKER };

const median = (a: number[]): number => {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] ?? 0) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
};

interface RawTrack {
  id: number;
  obs: Obs[];
  last: Obs;
  lastT: number;
  evidence: number;
}

/**
 * Builds the persistent tracks of one shot. `samples` must be sorted by time (clip-relative `t`) and lie
 * in the shot. Tracks seen in fewer than `minPresence` of the samples are dropped.
 */
export function buildTracks(
  samples: { t: number; sample: FaceSample }[],
  srcW: number,
  srcH: number,
  opts: TrackOptions = DEFAULT_TRACK_OPTS,
): FaceTrack[] {
  const tracks: RawTrack[] = [];
  let nextId = 0;
  for (const sm of samples) {
    const faces = usableFaces(sm.sample, sm.t, srcW, srcH, opts.cfg).sort((a, b) => b.sal - a.sal);
    const claimed = new Set<number>();
    for (const f of faces) {
      let best: RawTrack | null = null;
      let bestD = Infinity;
      for (const tr of tracks) {
        if (claimed.has(tr.id) || sm.t - tr.lastT > opts.cfg.maxGapSec * 2) continue;
        const d = Math.hypot(f.cx - tr.last.cx, f.cy - tr.last.cy);
        const thr = Math.max(0.08 * srcW, 0.9 * Math.max(f.w, tr.last.w));
        if (d <= thr && d < bestD) {
          best = tr;
          bestD = d;
        }
      }
      if (!best) {
        best = { id: nextId++, obs: [], last: f, lastT: sm.t, evidence: 0 };
        tracks.push(best);
      }
      claimed.add(best.id);
      best.last = f;
      best.lastT = sm.t;
      best.evidence += f.sal;
      best.obs.push({ t: f.t, cx: f.cx, cy: f.cy, w: f.w, h: f.h, score: f.score });
    }
  }
  const n = Math.max(1, samples.length);
  return tracks
    .filter((t) => t.obs.length / n >= opts.minPresence && t.obs.length >= 2)
    .map((t) => {
      const obs = medianFilter(t.obs);
      return {
        id: t.id,
        obs,
        presence: t.obs.length / n,
        cx: median(obs.map((o) => o.cx)),
        cy: median(obs.map((o) => o.cy)),
        w: median(obs.map((o) => o.w)),
        h: median(obs.map((o) => o.h)),
        evidence: t.evidence,
        score: t.obs.reduce((s, o) => s + (o.score ?? 0), 0) / Math.max(1, t.obs.length),
      };
    })
    .sort((a, b) => b.evidence - a.evidence);
}

/** Two faces are "well separated" when they are clearly different people, not one face detected twice. */
export function wellSeparated(a: FaceTrack, b: FaceTrack): boolean {
  const dx = Math.abs(a.cx - b.cx);
  const dy = Math.abs(a.cy - b.cy);
  return dx >= 1.6 * Math.max(a.w, b.w) || dy >= 1.4 * Math.max(a.h, b.h);
}

export interface FacePair {
  /** First panel: leftmost (or topmost when stacked). */
  a: FaceTrack;
  b: FaceTrack;
  /** The two faces are side by side (true) or stacked (false). */
  horizontal: boolean;
}

/**
 * The two strongest persistent, well separated, similarly sized faces; null when the shot does not
 * have two. Ordered leftmost first (stacked tiles: topmost first).
 */
export function pickPair(tracks: FaceTrack[]): FacePair | null {
  const first = tracks[0];
  if (!first) return null;
  for (const other of tracks.slice(1)) {
    if (!wellSeparated(first, other)) continue;
    const ratio = other.h / first.h;
    if (ratio < 0.5 || ratio > 2) continue;
    if (other.evidence < 0.3 * first.evidence) continue;
    const horizontal = Math.abs(first.cx - other.cx) >= Math.abs(first.cy - other.cy);
    const firstIsA = horizontal ? first.cx <= other.cx : first.cy <= other.cy;
    return firstIsA ? { a: first, b: other, horizontal } : { a: other, b: first, horizontal };
  }
  return null;
}
