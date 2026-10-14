/** Frame grid + per-track frame bookkeeping (which item is drawn when, transition ops) on top of editor-eval. */
import type { Item, Track } from '@shared/editor';
import {
  activeOnTrack,
  isActive,
  itemEnd,
  transitionOps,
  type LayerOps,
  type TransitionOps,
} from '@shared/editor-eval';

export interface Grid {
  fps: number;
  /** Timeline time of output frame 0. */
  r0: number;
  /** Number of output frames. */
  n: number;
  /** Timeline time of frame j (what the evaluator is asked). */
  time(j: number): number;
  /** Output (stream) time of frame j. */
  out(j: number): number;
}

export function makeGrid(fps: number, r0: number, durationSec: number): Grid {
  const n = Math.max(1, Math.round(durationSec * fps));
  return { fps, r0, n, time: (j) => r0 + j / fps, out: (j) => j / fps };
}

/** Frames [ja, jb) on which the item is active (same half-open rule as the evaluator). */
export function itemFrames(
  grid: Grid,
  item: Pick<Item, 'startSec' | 'durationSec'>,
): { ja: number; jb: number } | null {
  const { fps, r0, n } = grid;
  const end = itemEnd(item);
  let ja = Math.max(0, Math.floor((item.startSec - r0) * fps) - 1);
  while (ja < n && !isActive(item, grid.time(ja)) && grid.time(ja) < end) ja++;
  if (ja >= n) return null;
  let jb = ja;
  while (jb < n && isActive(item, grid.time(jb))) jb++;
  if (jb <= ja) return null;
  return { ja, jb };
}

export interface ItemFrameInfo {
  ja: number;
  jb: number;
  /** Per frame (index j - ja): transition ops applying to this item, or null. */
  ops: (LayerOps | null)[];
  /** Per frame: active but not drawn (outgoing item of a 'cut' overlap). */
  hidden: boolean[];
}

export interface TrackFrames {
  items: Map<string, ItemFrameInfo>;
  /** Dip veil per frame index j (absolute), only inside transitions. */
  veils: Map<number, NonNullable<TransitionOps['veil']>>;
}

/** Runs the evaluator's `activeOnTrack` over every frame the track's items span. */
export function trackFrames(track: Pick<Track, 'items'>, grid: Grid): TrackFrames {
  const items = new Map<string, ItemFrameInfo>();
  const veils = new Map<number, NonNullable<TransitionOps['veil']>>();
  for (const it of track.items) {
    const fr = itemFrames(grid, it);
    if (!fr) continue;
    const m = fr.jb - fr.ja;
    items.set(it.id, {
      ja: fr.ja,
      jb: fr.jb,
      ops: new Array<LayerOps | null>(m).fill(null),
      hidden: new Array<boolean>(m).fill(false),
    });
  }
  if (items.size === 0) return { items, veils };
  let lo = Infinity;
  let hi = -Infinity;
  for (const f of items.values()) {
    lo = Math.min(lo, f.ja);
    hi = Math.max(hi, f.jb);
  }
  for (let j = lo; j < hi; j++) {
    const act = activeOnTrack(track, grid.time(j));
    const shown = new Set(act.items.map((i) => i.id));
    const ops = act.transition ? transitionOps(act.transition.type, act.transition.progress) : null;
    for (const [id, info] of items) {
      if (j < info.ja || j >= info.jb) continue;
      const k = j - info.ja;
      if (!shown.has(id)) {
        info.hidden[k] = true;
        continue;
      }
      if (act.transition && ops) {
        if (id === act.transition.from.id) info.ops[k] = ops.from;
        else if (id === act.transition.to.id) info.ops[k] = ops.to;
      }
    }
    if (ops?.veil) veils.set(j, ops.veil);
  }
  return { items, veils };
}
