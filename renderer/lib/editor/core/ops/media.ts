/**
 * Source-time bookkeeping for trimming / splitting media items (video + audio): which part of the asset an item
 * shows, how that changes when an edge moves, and how far an edge may be dragged outward before running off the
 * asset. Everything goes through `makeSourceOffset` / `sourceSpan` from shared/editor-eval (speed, ramps, reverse).
 */
import type { Asset, Item, SubtitleItem } from '@shared/editor';
import { makeSourceOffset, sourceSpan, speedAt } from '@shared/editor-eval';
import { keyframesAfterCut, mapKeyframes } from './animate';
import { EPS, MIN_DUR, isMedia, type MediaItem } from './common';

/** Source seconds consumed by local time `tl`, extrapolating with the boundary speed outside [0, duration]. */
export function offsetExt(item: MediaItem, tl: number): number {
  const off = makeSourceOffset(item);
  if (tl < 0) return tl * speedAt(item, 0);
  if (tl > item.durationSec) return off(item.durationSec) + (tl - item.durationSec) * speedAt(item, item.durationSec);
  return off(tl);
}

/**
 * The media item after `cut` seconds are removed from its head (cut < 0 = the head is extended), with the new
 * duration `newDur`. Content stays where it is on the timeline: forward items advance `inSec`; reverse items keep
 * `inSec` (the head of a reversed item is the top of its source window); keyframes / speed ramp shift left.
 * Does NOT touch startSec.
 */
export function cutStartMedia<T extends MediaItem>(item: T, cut: number, newDur: number): T {
  const off0 = offsetExt(item, cut);
  const span = sourceSpan(item);
  const shifted = mapKeyframes({ ...item, durationSec: newDur }, (kf, fb) => keyframesAfterCut(kf, cut, fb));
  if (item.freezeAtSec !== null) return shifted;
  if (!item.reverse) return { ...shifted, inSec: Math.max(0, item.inSec + off0) };
  const span2 = sourceSpan(shifted);
  return { ...shifted, inSec: Math.max(0, item.inSec + span - off0 - span2) };
}

/**
 * The media item with its duration changed at the END (keyframes untouched). Forward items keep `inSec`;
 * reverse items keep their first (top-of-window) frame, so `inSec` moves.
 */
export function resizeEndMedia<T extends MediaItem>(item: T, newDur: number): T {
  const next = { ...item, durationSec: newDur };
  if (item.freezeAtSec !== null || !item.reverse) return next;
  const span = sourceSpan(item);
  const span2 = sourceSpan(next);
  return { ...next, inSec: Math.max(0, item.inSec + span - span2) };
}

/** Does the item's source window lie inside the asset? (Freeze frames and unknown durations always fit.) */
export function windowFits(item: MediaItem, asset: Asset | null): boolean {
  if (item.freezeAtSec !== null || !asset || asset.durationSec === null) return true;
  return item.inSec >= -1e-6 && item.inSec + sourceSpan(item) <= asset.durationSec + 1e-6;
}

/**
 * How many timeline seconds the START / END edge may move outward before the item would show footage that does
 * not exist (≥ 0). Closed form for constant speed; bisection for speed ramps. Non-media / unknown → Infinity.
 */
export function maxExtension(item: Item, edge: 'start' | 'end', asset: Asset | null): number {
  if (!isMedia(item) || item.freezeAtSec !== null || !asset || asset.durationSec === null) return Infinity;
  const A = asset.durationSec;
  if (!item.speedCurve.length) {
    const s = item.speed;
    const forwardEnd = (A - item.inSec) / s - item.durationSec;
    const backwardStart = item.inSec / s;
    const fwd = !item.reverse;
    const e = edge === 'start' ? (fwd ? backwardStart : forwardEnd) : fwd ? forwardEnd : backwardStart;
    return Math.max(0, e);
  }
  const fits = (e: number): boolean =>
    windowFits(
      edge === 'start'
        ? cutStartMedia(item, -e, item.durationSec + e)
        : resizeEndMedia(item, item.durationSec + e),
      asset,
    );
  let lo = 0;
  let hi = Math.max(A, 1);
  if (fits(hi)) return hi;
  for (let k = 0; k < 28; k++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/* ------------------------------------------------------------------ subtitle cue timing ------- */

/** A cue after its head is cut by `cut` seconds (negative = extended) and its new duration `newDur`. */
export function cutStartCue(cue: SubtitleItem, cut: number, newDur: number): SubtitleItem {
  return clipCueWords({
    ...cue,
    durationSec: newDur,
    words: cue.words.map((w) => ({ ...w, s: w.s - cut, e: w.e - cut })),
  });
}

/** Clamp a cue's words into [0, duration]; words entirely outside are dropped. */
export function clipCueWords(cue: SubtitleItem): SubtitleItem {
  const dur = cue.durationSec;
  const words: SubtitleItem['words'] = [];
  for (const w of cue.words) {
    if (w.e < -EPS || w.s > dur + EPS) continue;
    const s = Math.min(dur, Math.max(0, w.s));
    words.push({ ...w, s, e: Math.min(dur, Math.max(s, w.e)) });
  }
  return { ...cue, words };
}

export const minDurWith = (dIn: number, dOut: number): number => MIN_DUR + dIn + dOut;
