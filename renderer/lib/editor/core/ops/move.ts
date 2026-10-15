/**
 * Moving items (drag): the preview (snap + validity, no mutation) and the apply.
 *
 * A move set is expanded to whole groups. After a move every `transitionIn` is re-validated STRICTLY: it survives
 * only if its previous neighbour is the same item as before and the overlap still equals its duration (i.e. the
 * pair moved together); otherwise it is dropped. Overlaps are then illegal — the drop is invalid (preview) or
 * refused (apply) — unless `insert` mode pushes the items that were already there to the right.
 */
import type { Item, Project, Track } from '@shared/editor';
import { itemEnd } from '@shared/editor-eval';
import type { MovePreview } from '../api';
import { trackAccepts } from '../helpers';
import { snapDelta, type SnapKind } from '../snap';
import {
  EPS,
  expandGroups,
  hasTransition,
  indexItems,
  isItemLocked,
  layoutProblem,
  trackIndexOf,
  type Located,
} from './common';

export interface MoveSpec {
  itemId: string;
  trackId: string;
  startSec: number;
}

export interface MovePlan {
  project: Project;
  ok: boolean;
}

/**
 * Compute the project after `moves` (no history, no selection). `ok` is false when something is locked,
 * incompatible, missing, or the result would violate the overlap invariant (then `project` is the input).
 */
export function planMoves(
  p: Project,
  moves: readonly MoveSpec[],
  opts: { insert?: boolean } = {},
): MovePlan {
  const fail: MovePlan = { project: p, ok: false };
  if (!moves.length) return fail;
  const byId = new Map<string, MoveSpec>();
  for (const m of moves) byId.set(m.itemId, m);
  const idx = indexItems(p);
  const touched = new Set<number>();
  const movedHere = new Map<number, Item[]>();
  const origPred = new Map<string, string | null>();

  for (const m of byId.values()) {
    const loc = idx.get(m.itemId);
    if (!loc) return fail;
    if (isItemLocked(loc.track, loc.item)) return fail;
    const dti = trackIndexOf(p, m.trackId);
    if (dti < 0) return fail;
    const dest = p.tracks[dti] as Track;
    if (dest.locked || !trackAccepts(dest, loc.item.type)) return fail;
    if (!Number.isFinite(m.startSec) || m.startSec < -EPS) return fail;
    touched.add(loc.ti);
    touched.add(dti);
    const arr = movedHere.get(dti) ?? [];
    arr.push({ ...loc.item, startSec: Math.max(0, m.startSec) });
    movedHere.set(dti, arr);
  }
  for (const ti of touched) {
    const items = (p.tracks[ti] as Track).items;
    for (let i = 0; i < items.length; i++) {
      const it = items[i] as Item;
      if (hasTransition(it) && it.transitionIn) origPred.set(it.id, items[i - 1]?.id ?? null);
    }
  }

  const newItems = new Map<number, Item[]>();
  for (const ti of touched) {
    const tr = p.tracks[ti] as Track;
    const kept = tr.items.filter((it) => !byId.has(it.id));
    const arrived = movedHere.get(ti) ?? [];
    const movedIds = new Set(arrived.map((a) => a.id));
    // Drop transitions whose relation can't have survived; they are re-checked after ordering below.
    const list = kept.concat(arrived).sort((a, b) => {
      const d = a.startSec - b.startSec;
      if (Math.abs(d) > 1e-12) return d;
      return (movedIds.has(a.id) ? 0 : 1) - (movedIds.has(b.id) ? 0 : 1);
    });
    if (opts.insert) {
      // Insert mode: items that were already there are pushed right (rigidly) instead of refusing the overlap.
      let cursor = -Infinity;
      for (let k = 0; k < list.length; k++) {
        const it = list[k] as Item;
        const link = hasTransition(it) && it.transitionIn ? it.transitionIn.durationSec : 0;
        if (!movedIds.has(it.id) && it.startSec < cursor - link - EPS) {
          const shift = cursor - link - it.startSec;
          for (let j = k; j < list.length; j++) {
            const nx = list[j] as Item;
            if (!movedIds.has(nx.id)) list[j] = { ...nx, startSec: nx.startSec + shift };
          }
        }
        cursor = Math.max(cursor, itemEnd(list[k] as Item));
      }
    }
    for (let k = 0; k < list.length; k++) {
      const it = list[k] as Item;
      if (!hasTransition(it) || !it.transitionIn) continue;
      const pred = list[k - 1];
      const keep =
        !!pred &&
        origPred.get(it.id) === pred.id &&
        Math.abs(itemEnd(pred) - it.startSec - it.transitionIn.durationSec) <= 1e-5;
      if (!keep) list[k] = { ...it, transitionIn: null };
    }
    if (layoutProblem(list)) return fail;
    newItems.set(ti, list);
  }

  const tracks = p.tracks.map((tr, ti) => {
    const items = newItems.get(ti);
    return items ? { ...tr, items } : tr;
  });
  return { project: { ...p, tracks }, ok: true };
}

export interface MoveContext {
  enabled: boolean;
  playhead: number;
  pxPerSec: number;
  fps: number;
}

/**
 * What dragging `itemIds` by `deltaSec` (primary item = first id) would do, without applying it: group expansion,
 * clamp at 0, magnetic snapping (item edges, playhead, markers, beats, 0, frame grid), track retargeting
 * (`targetTrackId` is where the PRIMARY item goes; items from its source track follow, others stay), validity.
 */
export function previewMoveOp(
  p: Project,
  itemIds: readonly string[],
  deltaSec: number,
  targetTrackId: string | null,
  ctx: MoveContext,
): MovePreview {
  const ids = expandGroups(p, itemIds);
  const empty: MovePreview = { moves: [], snappedTo: null, snapKind: null, valid: false };
  if (!ids.length) return empty;
  const idx = indexItems(p);
  const located: Located[] = [];
  for (const id of ids) located.push(idx.get(id) as Located);
  const primary = idx.get(itemIds.find((i) => idx.has(i)) ?? (ids[0] as string)) as Located;

  let minStart = Infinity;
  let maxEnd = -Infinity;
  for (const l of located) {
    minStart = Math.min(minStart, l.item.startSec);
    maxEnd = Math.max(maxEnd, itemEnd(l.item));
  }
  let delta = Number.isFinite(deltaSec) ? deltaSec : 0;
  delta = Math.max(delta, -minStart);

  let snappedTo: number | null = null;
  let snapKind: SnapKind | null = null;
  if (ctx.enabled) {
    const edges = [primary.item.startSec, itemEnd(primary.item), minStart, maxEnd];
    const s = snapDelta(p, edges, delta, {
      playhead: ctx.playhead,
      pxPerSec: ctx.pxPerSec,
      fps: ctx.fps,
      exclude: new Set(ids),
    });
    delta = Math.max(s.delta, -minStart);
    if (s.to !== null && Math.abs(s.delta - delta) < 1e-9) {
      snappedTo = s.to;
      snapKind = s.kind;
    }
  }

  const target = targetTrackId ? p.tracks.find((t) => t.id === targetTrackId) : undefined;
  const moves: MoveSpec[] = located.map((l) => ({
    itemId: l.item.id,
    trackId: target && l.ti === primary.ti ? target.id : l.track.id,
    startSec: l.item.startSec + delta,
  }));
  const plan = planMoves(p, moves);
  return { moves, snappedTo, snapKind, valid: plan.ok && (!targetTrackId || !!target) };
}

/**
 * Apply moves (typically a MovePreview's). Groups are completed: a missing group member follows the first move's
 * time shift on its own track. `insert` pushes already-present items right instead of refusing an overlap.
 * Returns the input project when refused.
 */
export function applyMovesOp(
  p: Project,
  moves: readonly MoveSpec[],
  opts: { insert?: boolean } = {},
): Project {
  if (!moves.length) return p;
  const idx = indexItems(p);
  const have = new Set(moves.map((m) => m.itemId));
  const first = moves.find((m) => idx.has(m.itemId));
  if (!first) return p;
  const shift = first.startSec - (idx.get(first.itemId) as Located).item.startSec;
  const full: MoveSpec[] = moves.slice();
  for (const id of expandGroups(
    p,
    moves.map((m) => m.itemId),
  )) {
    if (have.has(id)) continue;
    const l = idx.get(id) as Located;
    full.push({ itemId: id, trackId: l.track.id, startSec: Math.max(0, l.item.startSec + shift) });
  }
  const plan = planMoves(p, full, opts);
  return plan.ok ? plan.project : p;
}
