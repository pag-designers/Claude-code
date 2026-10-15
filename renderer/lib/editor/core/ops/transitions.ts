/**
 * Transitions are OVERLAPS (shared/editor.ts): the later item of an adjacent pair carries `transitionIn` and starts
 * `durationSec` before the earlier item ends. Setting one moves the later item earlier by the duration (and its
 * followers too when rippling); removing it restores adjacency. When there is no room the duration is clamped.
 */
import type { ItemTransition, Item, Project } from '@shared/editor';
import { itemEnd } from '@shared/editor-eval';
import {
  Draft,
  EPS,
  MAX_TRANSITION,
  MIN_DUR,
  MIN_TRANSITION,
  clamp,
  hasTransition,
  isItemLocked,
  locate,
  maxEndBefore,
  overlapOut,
  shiftTailRaw,
} from './common';

/** After the item before `from` moved right by `shift`: close up (ripple) or push only what now collides. */
function pushFollowers(w: Item[], from: number, shift: number, ripple: boolean): void {
  if (ripple) {
    shiftTailRaw(w, from, shift);
    return;
  }
  for (let k = from; k < w.length; k++) {
    const pred = w[k - 1] as Item;
    const it = w[k] as Item;
    const dk = hasTransition(it) && it.transitionIn ? it.transitionIn.durationSec : 0;
    const need = itemEnd(pred) - dk;
    if (it.startSec >= need - EPS) break;
    w[k] = { ...it, startSec: need };
  }
}

export function setTransitionOp(
  p: Project,
  itemId: string,
  tr: ItemTransition | null,
  ripple: boolean,
): Project {
  const loc = locate(p, itemId);
  if (!loc) return p;
  const { ti, i, item, track } = loc;
  const items = track.items;
  if (!hasTransition(item)) return p;
  const prev = items[i - 1];
  if (!prev) return p;
  if (isItemLocked(track, item) || isItemLocked(track, prev)) return p;
  const cur = item.transitionIn;
  const oCur = Math.max(0, itemEnd(prev) - item.startSec);
  const d = new Draft(p);
  const w = d.items(ti);

  if (tr === null || tr.type === 'cut') {
    if (!cur) return p;
    w[i] = { ...item, startSec: item.startSec + oCur, transitionIn: null };
    if (oCur > EPS) pushFollowers(w, i + 1, oCur, ripple);
    return d.result();
  }

  const dOutX = overlapOut(items, i);
  const dMax = Math.min(
    MAX_TRANSITION,
    itemEnd(prev) - Math.max(maxEndBefore(items, i - 1), prev.startSec + MIN_DUR),
    item.durationSec - dOutX - MIN_DUR,
  );
  if (dMax < MIN_TRANSITION - 1e-9) return p;
  let dur = Math.min(clamp(tr.durationSec, MIN_TRANSITION, MAX_TRANSITION), dMax);
  let newStart = itemEnd(prev) - dur;
  let delta = newStart - item.startSec;

  if (!ripple && delta > 0) {
    // The item would grow into whatever follows it: limit the shift to the free room.
    const next = items[i + 1];
    const room = next ? Math.max(0, next.startSec - itemEnd(item)) : Infinity;
    if (delta > room + EPS) {
      delta = room;
      newStart = item.startSec + delta;
      dur = itemEnd(prev) - newStart;
      if (dur < MIN_TRANSITION - 1e-9 || dur > dMax + 1e-9) return p;
    }
  }
  w[i] = { ...item, startSec: newStart, transitionIn: { type: tr.type, durationSec: dur } };
  if (Math.abs(delta) > 1e-12 && (ripple || dOutX > EPS)) shiftTailRaw(w, i + 1, delta);
  return d.result();
}
