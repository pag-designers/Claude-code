/** Animated-property and keyframe operations (pure). Times are item-local seconds. */
import type { Animated, Easing, Item, Keyframe, Project } from '@shared/editor';
import { animatedAt } from '@shared/editor-eval';
import type { AnimatedPath } from '../api';
import { KF_MERGE_EPS, clampPropValue, getAnimated, setAnimated, upsertKeyframe } from './animate';
import { clamp, isItemLocked, locate, type Located } from './common';

/** Replace one item in a project (copies only that track's item array). */
export function replaceItem(p: Project, loc: Located, item: Item): Project {
  const items = loc.track.items.slice();
  items[loc.i] = item;
  const tracks = p.tracks.slice();
  tracks[loc.ti] = { ...loc.track, items };
  return { ...p, tracks };
}

function edit(
  p: Project,
  itemId: string,
  path: AnimatedPath,
  fn: (a: Animated, item: Item) => Animated | null,
): { project: Project; loc: Located | null; animated: Animated | null } {
  const loc = locate(p, itemId);
  if (!loc || isItemLocked(loc.track, loc.item)) return { project: p, loc: null, animated: null };
  const a = getAnimated(loc.item, path);
  if (!a) return { project: p, loc: null, animated: null };
  const next = fn(a, loc.item);
  if (!next || next === a) return { project: p, loc, animated: a };
  return { project: replaceItem(p, loc, setAnimated(loc.item, path, next)), loc, animated: next };
}

/**
 * Set a property at item-local time `tLocal`: adds / updates a keyframe when the property already has keyframes
 * (or `forceKeyframe`), otherwise sets the base value.
 */
export function setPropOp(
  p: Project,
  itemId: string,
  path: AnimatedPath,
  value: number,
  tLocal: number,
  opts: { forceKeyframe?: boolean; ease?: Easing } = {},
): Project {
  const v = clampPropValue(path, value);
  return edit(p, itemId, path, (a, item) => {
    if (a.kf.length || opts.forceKeyframe) {
      const t = clamp(tLocal, 0, item.durationSec);
      const ex = a.kf.find((k) => Math.abs(k.t - t) <= KF_MERGE_EPS);
      if (ex && ex.v === v && (!opts.ease || ex.ease === opts.ease)) return null;
      return upsertKeyframe(a, ex ? ex.t : t, v, opts.ease).animated;
    }
    return a.v === v ? null : { v, kf: [] };
  }).project;
}

/** Add (or update) a keyframe; the value defaults to the property's current value at that time. */
export function addKeyframeOp(
  p: Project,
  itemId: string,
  path: AnimatedPath,
  tLocal: number,
  value?: number,
  ease?: Easing,
): { project: Project; index: number } {
  let index = -1;
  const r = edit(p, itemId, path, (a, item) => {
    const t = clamp(tLocal, 0, item.durationSec);
    const v = clampPropValue(path, value ?? animatedAt(a, t));
    const res = upsertKeyframe(a, t, v, ease);
    index = res.index;
    return res.animated;
  });
  return { project: r.project, index };
}

/** Move keyframe `index` to (t, v). A keyframe already at t is replaced. Returns the keyframe's new index. */
export function moveKeyframeOp(
  p: Project,
  itemId: string,
  path: AnimatedPath,
  index: number,
  tLocal: number,
  value: number,
): { project: Project; index: number } {
  let newIndex = index;
  const r = edit(p, itemId, path, (a, item) => {
    const cur = a.kf[index];
    if (!cur) return null;
    const t = clamp(tLocal, 0, item.durationSec);
    const v = clampPropValue(path, value);
    if (cur.t === t && cur.v === v) return null;
    const rest = a.kf.filter(
      (_, k) => k !== index && Math.abs((a.kf[k] as Keyframe).t - t) > KF_MERGE_EPS,
    );
    const moved: Keyframe = { t, v, ease: cur.ease };
    let at = rest.findIndex((k) => k.t > t);
    if (at < 0) at = rest.length;
    rest.splice(at, 0, moved);
    newIndex = at;
    return { v: a.v, kf: rest };
  });
  return { project: r.project, index: newIndex };
}

export function setKeyframeEaseOp(
  p: Project,
  itemId: string,
  path: AnimatedPath,
  index: number,
  ease: Easing,
): Project {
  return edit(p, itemId, path, (a) => {
    const cur = a.kf[index];
    if (!cur || JSON.stringify(cur.ease) === JSON.stringify(ease)) return null;
    const kf = a.kf.slice();
    kf[index] = { ...cur, ease };
    return { v: a.v, kf };
  }).project;
}

/** Remove a keyframe; removing the last one leaves its value as the static value. */
export function removeKeyframeOp(
  p: Project,
  itemId: string,
  path: AnimatedPath,
  index: number,
): Project {
  return edit(p, itemId, path, (a) => {
    const cur = a.kf[index];
    if (!cur) return null;
    const kf = a.kf.filter((_, k) => k !== index);
    return { v: kf.length ? a.v : cur.v, kf };
  }).project;
}

/** Remove every keyframe; the value at `tLocal` becomes the static value. */
export function clearKeyframesOp(
  p: Project,
  itemId: string,
  path: AnimatedPath,
  tLocal: number,
): Project {
  return edit(p, itemId, path, (a) => (a.kf.length ? { v: animatedAt(a, tLocal), kf: [] } : null))
    .project;
}
