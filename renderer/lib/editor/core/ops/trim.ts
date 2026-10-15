/**
 * Trim (start / end, ripple, roll) and constant-speed changes (pure).
 *
 * Edge rules:
 *  - START trim keeps the content where it is on the timeline: startSec + inSec (+ keyframes, shifted left with an
 *    interpolated keyframe at 0) + durationSec change together. END trim only changes the duration (keyframes past
 *    the end are kept). Media can't extend past the asset's available source (makeSourceOffset / sourceSpan aware).
 *  - Without ripple an edge can't cross a neighbour. A transition overlap is "elastic": trimming the earlier item's
 *    end into / out of the following item resizes that transition (dropping it when the overlap vanishes).
 *  - Ripple (scope 'track' / 'all') keeps the item's START fixed for head trims (the removed head disappears and later
 *    items close up), moves later items with the tail for end trims.
 *  - Roll moves the shared boundary of two adjacent items (or the shared overlap of a transition pair).
 */
import type { Item, Project } from '@shared/editor';
import { itemEnd, sourceSpan } from '@shared/editor-eval';
import { keyframesAfterCut, mapKeyframes } from './animate';
import {
  ADJ,
  Draft,
  EPS,
  MAX_TRANSITION,
  MIN_DUR,
  MIN_TRANSITION,
  assetOf,
  clamp,
  hasTransition,
  isItemLocked,
  isMedia,
  locate,
  maxEndBefore,
  overlapIn,
  overlapOut,
  rippleOtherTracks,
  shiftTailRaw,
  type Located,
  type MediaItem,
  type RippleScope,
} from './common';
import { clipCueWords, cutStartCue, cutStartMedia, maxExtension, resizeEndMedia } from './media';

export interface TrimOpts {
  ripple?: RippleScope;
  roll?: boolean;
}

/** The item with `cut` seconds removed from its head (negative = extended), new start and duration. */
export function withStartCut(item: Item, cut: number, newStart: number, newDur: number): Item {
  let next: Item;
  if (isMedia(item)) next = cutStartMedia(item, cut, newDur);
  else if (item.type === 'subtitle') next = cutStartCue(item, cut, newDur);
  else
    next = mapKeyframes({ ...item, durationSec: newDur }, (kf, fb) =>
      keyframesAfterCut(kf, cut, fb),
    );
  return { ...next, startSec: Math.max(0, newStart) };
}

/** The item with its duration set at the end edge (media: source mapping kept consistent). */
export function withEndSet(item: Item, newDur: number): Item {
  if (isMedia(item)) return resizeEndMedia(item, newDur);
  if (item.type === 'subtitle') return clipCueWords({ ...item, durationSec: newDur });
  return { ...item, durationSec: newDur };
}

/** Room for the END edge of items[i] against its neighbours (ignores the asset limit). */
function endBounds(
  items: readonly Item[],
  i: number,
  scope: RippleScope,
): { lower: number; upper: number } {
  const item = items[i] as Item;
  const dIn = overlapIn(items, i);
  const dOut = overlapOut(items, i);
  if (scope !== 'none') return { lower: item.startSec + MIN_DUR + dIn + dOut, upper: Infinity };
  const next = items[i + 1];
  const after = items[i + 2];
  let upper = Infinity;
  if (next) {
    upper =
      hasTransition(next) && next.transitionIn && dOut > EPS
        ? next.startSec + Math.min(MAX_TRANSITION, next.durationSec - MIN_DUR)
        : next.startSec;
  }
  if (after) upper = Math.min(upper, after.startSec);
  return { lower: item.startSec + MIN_DUR + dIn, upper };
}

/** Round an end position that leaves a sub-minimum transition overlap to the neighbour's start. */
function collapseTinyOverlap(items: readonly Item[], i: number, end: number): number {
  const next = items[i + 1];
  if (
    next &&
    hasTransition(next) &&
    next.transitionIn &&
    next.startSec < itemEnd(items[i] as Item) - EPS
  ) {
    const o = end - next.startSec;
    if (o > EPS && o < MIN_TRANSITION) return next.startSec;
  }
  return end;
}

function trimStart(p: Project, loc: Located, toSec: number, scope: RippleScope): Project {
  const { ti, i, item } = loc;
  const items = loc.track.items;
  const asset = isMedia(item) ? assetOf(p, item.assetId) : null;
  const dIn = overlapIn(items, i);
  const dOut = overlapOut(items, i);
  const end = itemEnd(item);
  const eMax = maxExtension(item, 'start', asset);
  const d = new Draft(p);
  const w = d.items(ti);

  if (scope === 'none') {
    const prev = items[i - 1];
    const linked = !!(prev && hasTransition(item) && item.transitionIn && dIn > EPS);
    const upper = end - dOut - MIN_DUR;
    let lower = linked
      ? Math.max(
          maxEndBefore(items, i - 1),
          (prev as Item).startSec + MIN_DUR,
          itemEnd(prev as Item) - MAX_TRANSITION,
        )
      : maxEndBefore(items, i);
    lower = Math.max(0, lower, item.startSec - eMax);
    if (lower > upper + EPS) return p;
    let s = clamp(toSec, lower, upper);
    if (linked) {
      const o = itemEnd(prev as Item) - s;
      if (o > EPS && o < MIN_TRANSITION) s = itemEnd(prev as Item);
      if (s > upper + EPS) return p;
    }
    const cut = s - item.startSec;
    if (Math.abs(cut) < 1e-9) return p;
    w[i] = withStartCut(item, cut, s, end - s);
    return d.result();
  }

  const maxCut = item.durationSec - (MIN_DUR + dIn + dOut);
  if (-eMax > maxCut) return p;
  const cut = clamp(toSec - item.startSec, -eMax, maxCut);
  if (Math.abs(cut) < 1e-9) return p;
  w[i] = withStartCut(item, cut, item.startSec, item.durationSec - cut);
  shiftTailRaw(w, i + 1, -cut);
  if (scope === 'all') rippleOtherTracks(d, ti, end, -cut);
  return d.result();
}

function trimEnd(p: Project, loc: Located, toSec: number, scope: RippleScope): Project {
  const { ti, i, item } = loc;
  const items = loc.track.items;
  const asset = isMedia(item) ? assetOf(p, item.assetId) : null;
  const end = itemEnd(item);
  const eMax = maxExtension(item, 'end', asset);
  const b = endBounds(items, i, scope);
  const upper = Math.min(b.upper, end + eMax);
  if (b.lower > upper + EPS) return p;
  let e = clamp(toSec, b.lower, upper);
  if (scope === 'none') {
    e = collapseTinyOverlap(items, i, e);
    if (e < b.lower - EPS) return p;
  }
  if (Math.abs(e - end) < 1e-9) return p;
  const d = new Draft(p);
  const w = d.items(ti);
  w[i] = withEndSet(item, e - item.startSec);
  if (scope !== 'none') {
    shiftTailRaw(w, i + 1, e - end);
    if (scope === 'all') rippleOtherTracks(d, ti, end, e - end);
  }
  return d.result();
}

/** Roll the boundary shared with a neighbour; null when there is no adjacent neighbour (caller falls back). */
function roll(p: Project, loc: Located, edge: 'start' | 'end', toSec: number): Project | null {
  const items = loc.track.items;
  const aIdx = edge === 'end' ? loc.i : loc.i - 1;
  const A = items[aIdx];
  const B = items[aIdx + 1];
  if (!A || !B) return null;
  const o = Math.max(0, itemEnd(A) - B.startSec);
  if (o <= EPS && Math.abs(B.startSec - itemEnd(A)) > ADJ) return null;
  if (isItemLocked(loc.track, A) || isItemLocked(loc.track, B)) return p;
  const cur = edge === 'end' ? itemEnd(A) : B.startSec;
  const minA = MIN_DUR + overlapIn(items, aIdx) + o;
  const minB = MIN_DUR + o + overlapOut(items, aIdx + 1);
  const eEndA = maxExtension(A, 'end', isMedia(A) ? assetOf(p, A.assetId) : null);
  const eStartB = maxExtension(B, 'start', isMedia(B) ? assetOf(p, B.assetId) : null);
  const lo = Math.max(minA - A.durationSec, -eStartB);
  const hi = Math.min(B.durationSec - minB, eEndA);
  if (lo > hi + EPS) return p;
  const delta = clamp(toSec - cur, lo, hi);
  if (Math.abs(delta) < 1e-9) return p;
  const d = new Draft(p);
  const w = d.items(loc.ti);
  w[aIdx] = withEndSet(A, A.durationSec + delta);
  w[aIdx + 1] = withStartCut(B, delta, B.startSec + delta, B.durationSec - delta);
  return d.result();
}

/** Trim one edge of an item to timeline time `toSec` (already snapped by the caller). */
export function trimOp(
  p: Project,
  itemId: string,
  edge: 'start' | 'end',
  toSec: number,
  opts: TrimOpts = {},
): Project {
  const loc = locate(p, itemId);
  if (!loc || !Number.isFinite(toSec)) return p;
  if (isItemLocked(loc.track, loc.item)) return p;
  if (opts.roll) {
    const r = roll(p, loc, edge, toSec);
    if (r) return r;
  }
  const scope = opts.ripple ?? 'none';
  return edge === 'start' ? trimStart(p, loc, toSec, scope) : trimEnd(p, loc, toSec, scope);
}

/**
 * Constant speed (0.1–10). The source span is kept (so the duration changes to span / speed) unless
 * `keepDuration` (then more / less source is consumed, shortened to fit the asset). A speed ramp is replaced by the
 * constant speed. The new end is limited by neighbours exactly like an end trim (a shortened result consumes
 * less source); with ripple the later items follow the new end.
 */
export function setSpeedOp(
  p: Project,
  itemId: string,
  speed: number,
  opts: { keepDuration?: boolean; ripple?: RippleScope } = {},
): Project {
  const loc = locate(p, itemId);
  if (!loc || !isMedia(loc.item) || loc.item.freezeAtSec !== null) return p;
  if (isItemLocked(loc.track, loc.item)) return p;
  const item: MediaItem = loc.item;
  const scope = opts.ripple ?? 'none';
  const span = sourceSpan(item);
  const asset = assetOf(p, item.assetId);
  let s2 = clamp(speed, 0.1, 10);
  if (!Number.isFinite(s2)) return p;

  let b1: MediaItem;
  if (!opts.keepDuration) {
    s2 = Math.min(s2, span / MIN_DUR);
    if (s2 < 0.1) return p;
    b1 = { ...item, speed: s2, speedCurve: [], durationSec: span / s2 };
  } else {
    let inSec = item.inSec;
    let dur = item.durationSec;
    if (item.reverse) {
      const top = item.inSec + span;
      inSec = top - s2 * dur;
      if (inSec < 0) {
        inSec = 0;
        dur = top / s2;
      }
    } else if (
      asset?.durationSec !== null &&
      asset?.durationSec !== undefined &&
      item.inSec + s2 * dur > asset.durationSec + 1e-9
    ) {
      dur = (asset.durationSec - item.inSec) / s2;
    }
    if (dur < MIN_DUR) return p;
    b1 = { ...item, speed: s2, speedCurve: [], inSec, durationSec: dur };
  }

  const items = loc.track.items;
  const b = endBounds(items, loc.i, scope);
  const wantEnd = item.startSec + b1.durationSec;
  let e = Math.min(wantEnd, b.upper);
  if (e < b.lower - EPS) return p;
  if (scope === 'none') e = collapseTinyOverlap(items, loc.i, e);
  if (e < wantEnd - 1e-9) b1 = resizeEndMedia(b1, e - item.startSec);

  const oldEnd = itemEnd(item);
  const newEnd = item.startSec + b1.durationSec;
  const d = new Draft(p);
  const w = d.items(loc.ti);
  w[loc.i] = b1;
  if (scope !== 'none') {
    shiftTailRaw(w, loc.i + 1, newEnd - oldEnd);
    if (scope === 'all') rippleOtherTracks(d, loc.ti, oldEnd, newEnd - oldEnd);
  }
  return d.result();
}
