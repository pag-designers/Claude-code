/**
 * Thumbnail frame scoring (BRIEF §4.12): pure functions turning the sidecar's per-image measurements
 * (Laplacian variance, brightness, faces) into 0..1 scores.
 *
 *   sharpness   — Laplacian variance, log-normalised, half absolute / half relative to the sharpest candidate
 *   face        — a face is present (0.35) + size (8-35% of the frame height is ideal) + horizontally
 *                 centred + detector confidence. NOT scored: eyes open / expression. The face model
 *                 (BlazeFace) gives six keypoints but no eye-openness or expression signal, and
 *                 guessing it from keypoint geometry would be dishonest, so the score says nothing about it.
 *   composition — the face sits in the upper-middle (centre at 20-50% of the height), is not cut off by the
 *                 frame edge, and the exposure is sane (mean 0.25-0.75, enough contrast)
 *   total       — 0.35 sharpness + 0.40 face + 0.25 composition
 */
import type { FrameScore } from '../../pipeline/contracts2';

export const WEIGHTS = { sharpness: 0.35, face: 0.4, composition: 0.25 } as const;
/** Laplacian variance (640 px wide gray) that maps to 0 / 1 on the absolute scale. */
const SHARP_LO = 20;
const SHARP_HI = 900;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 0..1 from the raw Laplacian variance (log scale). */
export function sharpnessAbsolute(variance: number): number {
  const v = Math.max(0, variance);
  return clamp01(
    (Math.log(1 + v) - Math.log(1 + SHARP_LO)) / (Math.log(1 + SHARP_HI) - Math.log(1 + SHARP_LO)),
  );
}

/** Absolute and relative (to the best candidate) sharpness, 50/50. */
export function sharpnessScores(variances: number[]): number[] {
  const best = Math.max(1e-9, ...variances);
  return variances.map((v) => 0.5 * sharpnessAbsolute(v) + 0.5 * clamp01(v / best));
}

type Face = FrameScore['faces'][number];

/** The face that matters: biggest weighted by confidence. */
export function mainFace(faces: Face[]): Face | null {
  let best: Face | null = null;
  let bestV = -1;
  for (const f of faces) {
    const v = f.w * f.h * f.score;
    if (v > bestV) {
      bestV = v;
      best = f;
    }
  }
  return best;
}

/** 1 for a face 8-35% of the frame height; falls off below 8% and above 35% (0 at 60%). */
export function faceSizeScore(h: number): number {
  if (h < 0.08) return clamp01(h / 0.08);
  if (h <= 0.35) return 1;
  return clamp01(1 - (h - 0.35) / 0.25);
}

export function faceScore(faces: Face[]): number {
  const f = mainFace(faces);
  if (!f) return 0;
  const cx = f.x + f.w / 2;
  const centred = clamp01(1 - Math.abs(cx - 0.5) / 0.35);
  return clamp01(0.35 + 0.3 * faceSizeScore(f.h) + 0.2 * centred + 0.15 * clamp01(f.score));
}

export function exposureScore(brightness: number, contrast: number | undefined): number {
  const b = brightness < 0.25 ? brightness / 0.25 : brightness > 0.75 ? (1 - brightness) / 0.25 : 1;
  const c = contrast === undefined ? 1 : clamp01(contrast / 0.12);
  return clamp01(b) * (0.6 + 0.4 * c);
}

export function compositionScore(
  s: Pick<FrameScore, 'brightness' | 'faces'> & { contrast?: number },
): number {
  const exposure = exposureScore(s.brightness, s.contrast);
  const f = mainFace(s.faces);
  if (!f) return 0.3 * exposure;
  const cy = f.y + f.h / 2;
  const vertical =
    cy >= 0.2 && cy <= 0.5 ? 1 : cy < 0.2 ? clamp01(cy / 0.2) : clamp01(1 - (cy - 0.5) / 0.3);
  const margin = 0.01;
  const uncut =
    f.x > margin && f.y > margin && f.x + f.w < 1 - margin && f.y + f.h < 1 - margin ? 1 : 0.3;
  return clamp01(0.5 * vertical + 0.25 * uncut + 0.25 * exposure);
}

export interface ScoredFrame {
  sharpness: number;
  face: number;
  composition: number;
  total: number;
}

/** Scores a batch of measurements (sharpness is relative inside the batch). */
export function scoreMeasurements(m: (FrameScore & { contrast?: number })[]): ScoredFrame[] {
  const sharp = sharpnessScores(m.map((x) => x.sharpness));
  return m.map((x, i) => {
    const sharpness = sharp[i] ?? 0;
    const face = faceScore(x.faces);
    const composition = compositionScore(x);
    const total = clamp01(
      WEIGHTS.sharpness * sharpness + WEIGHTS.face * face + WEIGHTS.composition * composition,
    );
    const r = (v: number): number => Math.round(v * 1000) / 1000;
    return { sharpness: r(sharpness), face: r(face), composition: r(composition), total: r(total) };
  });
}

/* ------------------------------------------- candidate times -------------------------------------------- */

/** Parses `ametadata=print` output: `pts_time:1.25 ... lavfi.astats.Overall.RMS_level=-23.1` pairs. */
export function parseRmsSeries(text: string): { t: number; db: number }[] {
  const out: { t: number; db: number }[] = [];
  let t: number | null = null;
  for (const line of text.split(/\r?\n/)) {
    const mt = /pts_time:([\d.]+)/.exec(line);
    if (mt?.[1]) t = Number(mt[1]);
    const mr = /lavfi\.astats\.Overall\.RMS_level=(-?[\d.]+|-inf)/.exec(line);
    if (mr?.[1] && t !== null) {
      out.push({ t, db: mr[1] === '-inf' ? -90 : Number(mr[1]) });
      t = null;
    }
  }
  return out;
}

/**
 * ~`count` candidate times spread evenly over [from, to], each nudged (within +-40% of the slot) to the
 * loudest moment so frames come from speech rather than pauses. Deterministic; strictly increasing, at
 * least `minGap` apart.
 */
export function candidateTimes(
  from: number,
  to: number,
  count: number,
  rms: { t: number; db: number }[],
  minGap = 0.35,
): number[] {
  const n = Math.max(1, Math.floor(count));
  const span = Math.max(0, to - from);
  if (span <= 0) return [Math.max(0, from)];
  const slot = span / n;
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const centre = from + slot * (i + 0.5);
    const lo = centre - 0.4 * slot;
    const hi = centre + 0.4 * slot;
    let best = centre;
    let bestDb = -Infinity;
    for (const r of rms) {
      if (r.t < lo || r.t > hi) continue;
      // prefer loud, but gently pull toward the slot centre so the spread stays even
      const v = r.db - 6 * (Math.abs(r.t - centre) / Math.max(1e-6, slot));
      if (v > bestDb) {
        bestDb = v;
        best = r.t;
      }
    }
    times.push(Math.min(to, Math.max(from, best)));
  }
  const out: number[] = [];
  for (const t of times) {
    const last = out[out.length - 1];
    if (last === undefined || t - last >= minGap) out.push(Math.round(t * 1000) / 1000);
  }
  return out;
}
