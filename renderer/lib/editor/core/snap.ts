/**
 * Magnetic snapping. Candidates: item edges (every track), playhead, markers, beat times of audio assets mapped
 * to timeline time through the item's inSec / speed / ramp / reverse, project start (0) and — when zoomed in far
 * enough that a frame is several pixels wide — the 1-frame grid. Threshold: 8 px / pxPerSec.
 *
 * The expensive part (all edges + beats, sorted) is cached per Project reference, so a drag preview on a
 * 3,000-item project is a handful of binary searches.
 */
import type { Item, Project } from '@shared/editor';
import { itemEnd, makeSourceOffset, snapTo } from '@shared/editor-eval';
import type { MovePreview } from './api';
import { EPS, isMedia, type MediaItem } from './ops/common';

export type SnapKind = NonNullable<MovePreview['snapKind']>;

export interface SnapPoint {
  t: number;
  kind: SnapKind;
  /** The item that owns an 'item' / 'beat' point (so a drag can ignore its own edges). */
  owner: string | null;
}

export const SNAP_PX = 8;
/** The frame grid only snaps once a frame is at least this many pixels wide. */
export const GRID_MIN_FRAME_PX = 3;

const cache = new WeakMap<Project, SnapPoint[]>();

/** Beat times of `item`'s asset mapped to the timeline (only beats inside the item's source window). */
export function beatTimesOnTimeline(item: MediaItem, beats: readonly number[]): number[] {
  if (item.freezeAtSec !== null) return [];
  const off = makeSourceOffset(item);
  const span = off(item.durationSec);
  const constant = item.speedCurve.length === 0;
  const out: number[] = [];
  for (const b of beats) {
    const rel = b - item.inSec;
    if (rel < -EPS || rel > span + EPS) continue;
    const consumed = item.reverse ? span - rel : rel;
    let tl: number;
    if (constant) tl = consumed / item.speed;
    else {
      let lo = 0;
      let hi = item.durationSec;
      for (let k = 0; k < 32; k++) {
        const mid = (lo + hi) / 2;
        if (off(mid) < consumed) lo = mid;
        else hi = mid;
      }
      tl = (lo + hi) / 2;
    }
    out.push(item.startSec + tl);
  }
  return out;
}

/** Item edges + markers + beats + 0, sorted by time (cached per project reference). */
export function baseSnapPoints(p: Project): SnapPoint[] {
  const hit = cache.get(p);
  if (hit) return hit;
  const pts: SnapPoint[] = [{ t: 0, kind: 'start', owner: null }];
  for (const tr of p.tracks)
    for (const it of tr.items) {
      pts.push({ t: it.startSec, kind: 'item', owner: it.id });
      pts.push({ t: itemEnd(it), kind: 'item', owner: it.id });
      if (isMedia(it)) {
        const asset = p.assets.find((a) => a.id === it.assetId);
        if (asset?.beats?.length)
          for (const t of beatTimesOnTimeline(it, asset.beats)) pts.push({ t, kind: 'beat', owner: it.id });
      }
    }
  for (const m of p.markers) pts.push({ t: m.atSec, kind: 'marker', owner: null });
  pts.sort((a, b) => a.t - b.t);
  cache.set(p, pts);
  return pts;
}

export interface SnapCandidateOpts {
  /** Item ids whose own edges / beats are not candidates (the items being dragged). */
  exclude?: ReadonlySet<string>;
}

/** Every snap candidate, sorted by time. */
export function snapCandidates(
  project: Project,
  playhead: number | null,
  opts: SnapCandidateOpts = {},
): SnapPoint[] {
  const base = baseSnapPoints(project);
  const ex = opts.exclude;
  const out = ex && ex.size ? base.filter((s) => !s.owner || !ex.has(s.owner)) : base.slice();
  if (playhead !== null && Number.isFinite(playhead)) {
    out.push({ t: playhead, kind: 'playhead', owner: null });
    out.sort((a, b) => a.t - b.t);
  }
  return out;
}

export interface SnapQuery {
  playhead: number | null;
  pxPerSec: number;
  fps: number;
  exclude?: ReadonlySet<string>;
  /** Also try the 1-frame grid (only effective when zoomed in). */
  grid?: boolean;
}

export const snapThreshold = (pxPerSec: number): number => SNAP_PX / Math.max(1e-6, pxPerSec);

function lowerBound(pts: readonly SnapPoint[], v: number): number {
  let lo = 0;
  let hi = pts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((pts[mid] as SnapPoint).t < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Nearest non-grid candidate within threshold of `value`, or null. */
export function nearestPoint(
  project: Project,
  value: number,
  q: Pick<SnapQuery, 'playhead' | 'pxPerSec' | 'exclude'>,
): SnapPoint | null {
  const thr = snapThreshold(q.pxPerSec);
  const pts = baseSnapPoints(project);
  const ex = q.exclude;
  let best: SnapPoint | null = null;
  let bd = thr + 1e-12;
  const i0 = lowerBound(pts, value);
  for (let i = i0; i < pts.length; i++) {
    const s = pts[i] as SnapPoint;
    const d = s.t - value;
    if (d > bd) break;
    if (ex && s.owner && ex.has(s.owner)) continue;
    if (d <= bd) {
      best = s;
      bd = d;
    }
  }
  for (let i = i0 - 1; i >= 0; i--) {
    const s = pts[i] as SnapPoint;
    const d = value - s.t;
    if (d > bd) break;
    if (ex && s.owner && ex.has(s.owner)) continue;
    if (d < bd || (d <= bd && !best)) {
      best = s;
      bd = d;
    }
  }
  if (q.playhead !== null && Math.abs(q.playhead - value) <= bd) {
    best = { t: q.playhead, kind: 'playhead', owner: null };
  }
  return best;
}

/** Snap a single time (trim edges, markers…): nearest candidate, else the frame grid, else null. */
export function snapTime(
  project: Project,
  value: number,
  q: SnapQuery,
): { t: number; kind: SnapKind } | null {
  const hit = nearestPoint(project, value, q);
  if (hit) return { t: hit.t, kind: hit.kind };
  if (q.grid !== false && q.pxPerSec / q.fps >= GRID_MIN_FRAME_PX) {
    const g = Math.round(value * q.fps) / q.fps;
    if (snapTo(value, [g], snapThreshold(q.pxPerSec)) !== null) return { t: g, kind: 'grid' };
  }
  return null;
}

/**
 * Snap a rigid move: `edges` are the timeline times of the moving block's edges (primary item start first).
 * Returns the corrected delta plus what it snapped to. Candidate hits beat the frame grid; the grid aligns
 * `edges[0]` only.
 */
export function snapDelta(
  project: Project,
  edges: readonly number[],
  delta: number,
  q: SnapQuery,
): { delta: number; to: number | null; kind: SnapKind | null } {
  let best: { adj: number; hit: SnapPoint } | null = null;
  for (const e of edges) {
    const hit = nearestPoint(project, e + delta, q);
    if (!hit) continue;
    const adj = hit.t - (e + delta);
    if (!best || Math.abs(adj) < Math.abs(best.adj)) best = { adj, hit };
  }
  if (best) return { delta: delta + best.adj, to: best.hit.t, kind: best.hit.kind };
  if (q.grid !== false && edges.length && q.pxPerSec / q.fps >= GRID_MIN_FRAME_PX) {
    const e0 = (edges[0] as number) + delta;
    const g = Math.round(e0 * q.fps) / q.fps;
    if (Math.abs(g - e0) <= snapThreshold(q.pxPerSec)) return { delta: delta + (g - e0), to: g, kind: 'grid' };
  }
  return { delta, to: null, kind: null };
}

export type { Item };
