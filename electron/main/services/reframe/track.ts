/**
 * Dominant-face tracking with hysteresis. Works in SOURCE pixels, per shot (a scene cut resets
 * everything). Faces are associated across samples into tracks; each track accumulates decayed
 * "evidence" (area x confidence). The camera follows one track and only switches to another when that
 * track is clearly stronger for a sustained time, or when the followed one has been gone for a while.
 */
import type { FaceSample } from '../../pipeline/contracts';

export interface Obs {
  /** Time relative to the clip start (seconds). */
  t: number;
  /** Face centre and size in source pixels. */
  cx: number;
  cy: number;
  w: number;
  h: number;
  /** Detector confidence 0..1 (absent in hand-made observations). */
  score?: number;
}

export interface TrackerConfig {
  minScore: number;
  /** Faces smaller than this fraction of the frame height are ignored (background faces/false hits). */
  minFaceHeightFrac: number;
  /** Evidence time constant (seconds). */
  tau: number;
  /** A challenger needs this multiple of the followed track's evidence to take over. */
  switchRatio: number;
  /** The followed track is considered lost after this many seconds without a detection. */
  lostSec: number;
  /** Max seconds between two detections to be the same track. */
  maxGapSec: number;
}

/** Look-ahead window for choosing the face to follow at the start of a shot. */
const EARLY_SEC = 3.0;

export const DEFAULT_TRACKER: TrackerConfig = {
  minScore: 0.45,
  minFaceHeightFrac: 0.035,
  tau: 3.0,
  switchRatio: 2.0,
  lostSec: 1.0,
  maxGapSec: 1.5,
};

interface Track {
  id: number;
  last: Obs;
  evidence: number;
  lastT: number;
}

interface SampleFace extends Obs {
  sal: number;
  track: number;
}

/** Faces of one sample, filtered and converted to source pixels. Exported for diagnostics/tests. */
export function usableFaces(
  sample: FaceSample,
  t: number,
  srcW: number,
  srcH: number,
  cfg: TrackerConfig = DEFAULT_TRACKER,
): (Obs & { sal: number })[] {
  const out: (Obs & { sal: number })[] = [];
  for (const b of sample.boxes) {
    if (!(b.score >= cfg.minScore)) continue;
    if (!(b.w > 0 && b.h > 0)) continue;
    if (b.h < cfg.minFaceHeightFrac) continue;
    out.push({
      t,
      cx: (b.x + b.w / 2) * srcW,
      cy: (b.y + b.h / 2) * srcH,
      w: b.w * srcW,
      h: b.h * srcH,
      sal: b.w * b.h * b.score * b.score,
      score: b.score,
    });
  }
  return out;
}

/**
 * Returns, per sample, the dominant face (or null when the followed face is not detected in it).
 * `samples` must be sorted by time and lie in one shot.
 */
export function trackDominant(
  samples: { t: number; sample: FaceSample }[],
  srcW: number,
  srcH: number,
  cfg: TrackerConfig = DEFAULT_TRACKER,
): { obs: (Obs | null)[]; switches: number } {
  const n = samples.length;
  const perSample: SampleFace[][] = [];
  const evidenceAt: Map<number, number>[] = [];
  const tracks: Track[] = [];
  let nextId = 0;
  let prevT = samples[0]?.t ?? 0;

  // pass 1: association + evidence timeline
  for (let k = 0; k < n; k++) {
    const sm = samples[k];
    if (!sm) continue;
    const decay = Math.exp(-Math.max(0, sm.t - prevT) / cfg.tau);
    prevT = sm.t;
    for (const tr of tracks) tr.evidence *= decay;
    const faces = usableFaces(sm.sample, sm.t, srcW, srcH, cfg).sort((a, b) => b.sal - a.sal);
    const claimed = new Set<number>();
    const here: SampleFace[] = [];
    for (const f of faces) {
      let best: Track | null = null;
      let bestD = Infinity;
      for (const tr of tracks) {
        if (claimed.has(tr.id) || sm.t - tr.lastT > cfg.maxGapSec) continue;
        const d = Math.hypot(f.cx - tr.last.cx, f.cy - tr.last.cy);
        const thr = Math.max(0.15 * srcW, 1.6 * Math.max(f.w, tr.last.w));
        if (d <= thr && d < bestD) {
          best = tr;
          bestD = d;
        }
      }
      if (!best) {
        best = { id: nextId++, last: f, evidence: 0, lastT: sm.t };
        tracks.push(best);
      }
      claimed.add(best.id);
      best.last = f;
      best.lastT = sm.t;
      best.evidence += f.sal;
      here.push({ ...f, track: best.id });
    }
    perSample.push(here);
    evidenceAt.push(new Map(tracks.map((tr) => [tr.id, tr.evidence])));
  }

  // initial dominant: strongest total evidence over the first EARLY_SEC of the shot (look-ahead: a one-off
  // false detection in the first frames must not win)
  const t0 = samples[0]?.t ?? 0;
  const early = new Map<number, number>();
  for (let k = 0; k < n; k++) {
    if ((samples[k]?.t ?? 0) - t0 > EARLY_SEC) break;
    for (const f of perSample[k] ?? []) early.set(f.track, (early.get(f.track) ?? 0) + f.sal);
  }
  let current = -1;
  let bestE = -1;
  for (const [id, e] of early) {
    if (e > bestE) {
      bestE = e;
      current = id;
    }
  }

  // pass 2: follow with hysteresis
  const out: (Obs | null)[] = [];
  let switches = 0;
  let lastSeenT = t0;
  for (let k = 0; k < n; k++) {
    const t = samples[k]?.t ?? 0;
    const here = perSample[k] ?? [];
    const ev = evidenceAt[k];
    let mine = here.find((f) => f.track === current);
    if (current === -1 || (!mine && t - lastSeenT > cfg.lostSec)) {
      // nothing followed yet / followed face lost: take the strongest present
      const cand = [...here].sort((a, b) => (ev?.get(b.track) ?? 0) - (ev?.get(a.track) ?? 0))[0];
      if (cand) {
        if (current !== -1 && cand.track !== current) switches++;
        current = cand.track;
        mine = cand;
      }
    } else if (mine) {
      const curE = ev?.get(current) ?? 0;
      let challenger: SampleFace | undefined;
      let chE = 0;
      for (const f of here) {
        if (f.track === current) continue;
        const e = ev?.get(f.track) ?? 0;
        if (e > chE) {
          chE = e;
          challenger = f;
        }
      }
      if (challenger && chE > cfg.switchRatio * curE) {
        switches++;
        current = challenger.track;
        mine = challenger;
      }
    }
    if (mine) {
      lastSeenT = t;
      out.push({ t, cx: mine.cx, cy: mine.cy, w: mine.w, h: mine.h });
    } else {
      out.push(null);
    }
  }
  return { obs: out, switches };
}

/** 3-point median over consecutive detections (rejects single-sample outliers, keeps real motion). */
export function medianFilter(obs: Obs[], maxGapSec = 0.6): Obs[] {
  if (obs.length < 3) return obs;
  const med3 = (a: number, b: number, c: number): number =>
    Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
  return obs.map((o, i) => {
    const p = obs[i - 1];
    const q = obs[i + 1];
    if (!p || !q || o.t - p.t > maxGapSec || q.t - o.t > maxGapSec) return o;
    return { ...o, cx: med3(p.cx, o.cx, q.cx), cy: med3(p.cy, o.cy, q.cy) };
  });
}
