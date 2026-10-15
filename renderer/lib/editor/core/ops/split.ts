/**
 * Split and freeze-frame (pure).
 *
 * Split rules (see the task brief): the RIGHT half gets the new id and an `inSec` advanced by the source consumed
 * (speed / ramp / reverse aware; for reversed items the right half in time is the EARLIER source window);
 * keyframes are redistributed (right half shifted with an interpolated keyframe at its start, left half gets
 * one at its end); fadeIn / transitionIn stay left, fadeOut goes right; text animIn stays left, animOut goes
 * right; subtitle cues split their words at the time. Group ids are preserved on both halves.
 */
import type { Item, Project, SubtitleItem, SubtitleWord, VideoItem } from '@shared/editor';
import { animatedAt, makeSourceOffset, makeSourceTime } from '@shared/editor-eval';
import { newId } from '../helpers';
import {
  ANIMATED_PATHS,
  getAnimated,
  keyframesAfterCut,
  keyframesUpTo,
  mapKeyframes,
  setAnimated,
} from './animate';
import {
  Draft,
  EPS,
  MIN_DUR,
  clamp,
  hasTransition,
  isItemLocked,
  indexItems,
  isMedia,
  locate,
  overlapIn,
  overlapOut,
  rippleOtherTracks,
  shiftTailRaw,
  type RippleScope,
} from './common';

function splitWords(
  words: readonly SubtitleWord[],
  a: number,
  total: number,
): [SubtitleWord[], SubtitleWord[]] {
  const left: SubtitleWord[] = [];
  const right: SubtitleWord[] = [];
  for (const w of words) {
    if (w.e <= a + EPS) left.push({ ...w, s: Math.min(w.s, a), e: Math.min(w.e, a) });
    else if (w.s >= a - EPS)
      right.push({ ...w, s: Math.max(0, w.s - a), e: Math.min(total - a, w.e - a) });
    else if (a - w.s >= w.e - a) left.push({ ...w, e: a });
    else right.push({ ...w, s: 0, e: Math.min(total - a, w.e - a) });
  }
  return [left, right];
}

/**
 * Split one item at timeline time `at` into [left (keeps the id), right (gets `rightId`)], or null when a half
 * would be shorter than MIN_DUR (or a subtitle half would end up without words). Pure geometry: transition
 * overlap constraints are checked by the caller.
 */
export function splitItemAt(item: Item, at: number, rightId: string): [Item, Item] | null {
  const a = at - item.startSec;
  const b = item.durationSec - a;
  if (a < MIN_DUR - 1e-9 || b < MIN_DUR - 1e-9) return null;

  if (item.type === 'subtitle') {
    const [lw, rw] = splitWords(item.words, a, item.durationSec);
    if (!lw.length || !rw.length) return null;
    const left: SubtitleItem = { ...item, durationSec: a, words: lw };
    const right: SubtitleItem = { ...item, id: rightId, startSec: at, durationSec: b, words: rw };
    return [left, right];
  }

  let left: Item = mapKeyframes({ ...item, durationSec: a }, (kf, fb) => keyframesUpTo(kf, a, fb));
  let right: Item = mapKeyframes({ ...item, id: rightId, startSec: at, durationSec: b }, (kf, fb) =>
    keyframesAfterCut(kf, a, fb),
  );

  if (isMedia(item) && item.freezeAtSec === null) {
    const off = makeSourceOffset(item);
    const span = off(item.durationSec);
    const used = off(a);
    if (!item.reverse) right = { ...right, inSec: item.inSec + used } as Item;
    else left = { ...left, inSec: item.inSec + span - used } as Item;
  }
  if ('fadeInSec' in left) {
    left = { ...left, fadeInSec: Math.min(left.fadeInSec, a), fadeOutSec: 0 } as Item;
    right = {
      ...right,
      fadeInSec: 0,
      fadeOutSec: Math.min((right as { fadeOutSec: number }).fadeOutSec, b),
    } as Item;
  }
  if (hasTransition(right)) right = { ...right, transitionIn: null };
  if (left.type === 'text' && right.type === 'text') {
    left = { ...left, animOut: { ...left.animOut, type: 'none' } };
    right = { ...right, animIn: { ...right.animIn, type: 'none' } };
  }
  return [left, right];
}

/**
 * Split each target (ids; groups must already be expanded by the caller) at `at`. Targets that don't cross `at`,
 * are locked, or can't be split without breaking a transition overlap are skipped. Returns the new (right-half) ids.
 */
export function splitOp(
  p: Project,
  targets: readonly string[],
  at: number,
): { project: Project; newIds: string[] } {
  const d = new Draft(p);
  const idx = indexItems(p);
  const newIds: string[] = [];
  for (const id of targets) {
    const loc = idx.get(id);
    if (!loc) continue;
    const items = d.items(loc.ti);
    const i = items.findIndex((it) => it.id === id);
    const item = items[i] as Item;
    if (isItemLocked(loc.track, item)) continue;
    const dIn = overlapIn(items, i);
    const dOut = overlapOut(items, i);
    if (at < item.startSec + MIN_DUR + dIn - 1e-9) continue;
    if (at > item.startSec + item.durationSec - MIN_DUR - dOut + 1e-9) continue;
    const halves = splitItemAt(item, at, newId('it'));
    if (!halves) continue;
    items[i] = halves[0];
    items.splice(i + 1, 0, halves[1]);
    newIds.push(halves[1].id);
  }
  return { project: d.result(), newIds };
}

/** A still copy of a video item showing the source frame at `srcTime`, with its pose frozen at local time `tl`. */
function makeFreezeItem(
  item: VideoItem,
  startSec: number,
  hold: number,
  srcTime: number,
  tl: number,
): VideoItem {
  let f: VideoItem = {
    ...item,
    id: newId('it'),
    startSec,
    durationSec: hold,
    speed: 1,
    speedCurve: [],
    reverse: false,
    freezeAtSec: srcTime,
    audioEnabled: false,
    transitionIn: null,
    fadeInSec: 0,
    fadeOutSec: 0,
    name: `${item.name ?? 'Clip'} (freeze)`,
  };
  for (const path of ANIMATED_PATHS) {
    const an = getAnimated(item, path);
    if (an && an.kf.length) f = setAnimated(f, path, { v: animatedAt(an, tl), kf: [] });
  }
  return f;
}

/**
 * Freeze frame: split `itemId` at `atSec` and insert a still of `holdSec` between the halves, rippling later
 * items on the track right (and, with scope 'all', on other tracks). At the very start / end of an item the still
 * is inserted before / after it. Only video items; returns the still's id.
 */
export function freezeFrameOp(
  p: Project,
  itemId: string,
  atSec: number,
  holdSec: number,
  scope: RippleScope = 'track',
): { project: Project; freezeId: string | null } {
  const loc = locate(p, itemId);
  if (!loc || loc.item.type !== 'video') return { project: p, freezeId: null };
  if (isItemLocked(loc.track, loc.item)) return { project: p, freezeId: null };
  const item = loc.item;
  const hold = clamp(holdSec, MIN_DUR, 600);
  const d = new Draft(p);
  const items = d.items(loc.ti);
  const i = loc.i;
  const dIn = overlapIn(items, i);
  const dOut = overlapOut(items, i);
  const end = item.startSec + item.durationSec;
  const tlRaw = atSec - item.startSec;
  const srcOf = makeSourceTime(item);

  let at = atSec;
  let freeze: VideoItem;
  if (tlRaw < MIN_DUR) {
    // head: still before the item
    if (dIn > EPS) return { project: p, freezeId: null };
    at = item.startSec;
    freeze = makeFreezeItem(item, at, hold, srcOf(0), 0);
    shiftTailRaw(items, i, hold);
    items.splice(i, 0, freeze);
  } else if (end - atSec < MIN_DUR) {
    if (dOut > EPS) return { project: p, freezeId: null };
    at = end;
    freeze = makeFreezeItem(item, at, hold, srcOf(item.durationSec), item.durationSec);
    shiftTailRaw(items, i + 1, hold);
    items.splice(i + 1, 0, freeze);
  } else {
    if (at < item.startSec + MIN_DUR + dIn - 1e-9 || at > end - MIN_DUR - dOut + 1e-9)
      return { project: p, freezeId: null };
    const halves = splitItemAt(item, at, newId('it'));
    if (!halves) return { project: p, freezeId: null };
    freeze = makeFreezeItem(item, at, hold, srcOf(at - item.startSec), at - item.startSec);
    shiftTailRaw(items, i + 1, hold);
    items[i] = halves[0];
    items.splice(i + 1, 0, freeze, { ...halves[1], startSec: halves[1].startSec + hold });
  }
  if (scope === 'all') rippleOtherTracks(d, loc.ti, at - 1e-9, hold);
  return { project: d.result(), freezeId: freeze.id };
}
