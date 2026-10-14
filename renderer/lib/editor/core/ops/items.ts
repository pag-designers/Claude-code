/**
 * Item-level operations (pure): add, add-asset, delete (+ripple), delete gaps, duplicate, group, bulk property patch.
 */
import {
  itemSchema,
  type Asset,
  type Item,
  type ItemType,
  type Project,
  type Track,
} from '@shared/editor';
import { itemEnd } from '@shared/editor-eval';
import type { DeepPartial } from '../api';
import {
  PREFERRED_KINDS,
  defaultTrackIndex,
  makeAudioItem,
  makeImageItem,
  makeTrack,
  makeVideoItem,
  newId,
  nextTrackName,
  trackAccepts,
} from '../helpers';
import {
  Draft,
  EPS,
  MIN_DUR,
  expandGroups,
  firstStartingAtOrAfter,
  hasTransition,
  indexItems,
  isItemLocked,
  layoutProblem,
  locate,
  normalizeItems,
  overlapIn,
  overlapOut,
  rippleOtherTracks,
  shiftTailRaw,
  trackIndexOf,
  type RippleScope,
} from './common';
import { splitItemAt } from './split';
import { cleanSingletonGroups } from './tracks';

/* ------------------------------------------------------------------ placing ------------------ */

const isFree = (items: readonly Item[], start: number, end: number): boolean =>
  !items.some((it) => it.startSec < end - EPS && itemEnd(it) > start + EPS);

/** Earliest start ≥ `start` where [s, s+dur) is free on a (sorted) track. O(log n + blockers). */
export function findFreeStart(items: readonly Item[], start: number, dur: number): number {
  // item ends are non-decreasing on a valid track → binary-search the first item that ends after `start`
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (itemEnd(items[mid] as Item) <= start + EPS) lo = mid + 1;
    else hi = mid;
  }
  let s = start;
  for (let k = lo; k < items.length; k++) {
    const it = items[k] as Item;
    if (itemEnd(it) <= s + EPS) continue;
    if (it.startSec >= s + dur - EPS) break;
    s = itemEnd(it);
  }
  return s;
}

export interface AddResult {
  project: Project;
  itemId: string | null;
  trackId: string | null;
}

/** Track indices that may hold `type`, best first (the preferred kinds, in order; unlocked only). */
function candidateTracks(p: Project, type: ItemType): number[] {
  const out: number[] = [];
  for (const kind of PREFERRED_KINDS[type])
    p.tracks.forEach((t, ti) => {
      if (t.kind === kind && !t.locked && !out.includes(ti)) out.push(ti);
    });
  return out;
}

/**
 * Add an item. Track choice: the given (unlocked, compatible) track, else the first compatible track where the item
 * fits at its time, else a NEW track of the preferred kind. On an explicit track that is occupied the item is placed
 * at the next free spot. With a ripple `scope` the item is INSERTED: a straddling item is split, later items shift.
 * Transitions are never created here. Returns null ids when refused (locked target track).
 */
export function addItemOp(
  p: Project,
  item: Item,
  opts: { trackId?: string | null; scope?: RippleScope; newTrackId?: string } = {},
): AddResult {
  const fail: AddResult = { project: p, itemId: null, trackId: null };
  const scope = opts.scope ?? 'none';
  const id = locate(p, item.id) ? newId('it') : item.id;
  const start = Math.max(0, item.startSec);
  const dur = Math.max(MIN_DUR, item.durationSec);

  let ti = -1;
  let explicit = false;
  if (opts.trackId) {
    const t = trackIndexOf(p, opts.trackId);
    if (t >= 0) {
      const tr = p.tracks[t] as Track;
      if (tr.locked) return fail;
      if (trackAccepts(tr, item.type)) {
        ti = t;
        explicit = true;
      }
    }
  }
  if (ti < 0) {
    const order = candidateTracks(p, item.type);
    ti =
      scope !== 'none'
        ? (order[0] ?? -1)
        : (order.find((t) => isFree((p.tracks[t] as Track).items, start, start + dur)) ?? -1);
  }
  let base = p;
  if (ti < 0) {
    const kind = (PREFERRED_KINDS[item.type][0] ?? 'overlay') as Track['kind'];
    const track = makeTrack(kind, nextTrackName(p.tracks, kind), { id: opts.newTrackId });
    const tracks = p.tracks.slice();
    ti = defaultTrackIndex(tracks, kind);
    tracks.splice(ti, 0, track);
    base = { ...p, tracks };
  }

  const d = new Draft(base);
  const w = d.items(ti);
  let at = start;
  if (scope !== 'none') {
    const sIdx = w.findIndex((it) => it.startSec < at - EPS && itemEnd(it) > at + EPS);
    let from: number;
    let shift = dur;
    if (sIdx >= 0) {
      const st = w[sIdx] as Item;
      const ok =
        at >= st.startSec + MIN_DUR + overlapIn(w, sIdx) - 1e-9 &&
        at <= itemEnd(st) - MIN_DUR - overlapOut(w, sIdx) + 1e-9;
      const halves = ok ? splitItemAt(st, at, newId('it')) : null;
      if (halves) {
        w[sIdx] = halves[0];
        w.splice(sIdx + 1, 0, halves[1]);
        from = sIdx + 1;
      } else {
        shift = dur + overlapOut(w, sIdx);
        at = itemEnd(st);
        from = sIdx + 1;
      }
    } else from = firstStartingAtOrAfter(w, at);
    shiftTailRaw(w, from, shift);
    if (scope === 'all') rippleOtherTracks(d, ti, at - 1e-9, dur);
  } else if (explicit && !isFree(w, at, at + dur)) {
    at = findFreeStart(w, at, dur);
  }
  const placed: Item = { ...item, id, startSec: at, durationSec: dur };
  w.push(hasTransition(placed) ? { ...placed, transitionIn: null } : placed);
  const out = d.result();
  return { project: out, itemId: id, trackId: (out.tracks[ti] as Track).id };
}

/** Build the right item for an asset (video → VideoItem with audioEnabled = asset.hasAudio, audio, image 5 s). */
export function itemForAsset(asset: Asset, startSec: number): Item | null {
  if (asset.kind === 'video') return makeVideoItem(asset, startSec);
  if (asset.kind === 'audio') return makeAudioItem(asset, startSec);
  if (asset.kind === 'image') return makeImageItem(asset, startSec);
  return null;
}

export function addAssetOp(
  p: Project,
  assetId: string,
  opts: { trackId?: string | null; startSec: number; scope?: RippleScope },
): AddResult {
  const asset = p.assets.find((a) => a.id === assetId);
  if (!asset) return { project: p, itemId: null, trackId: null };
  const item = itemForAsset(asset, opts.startSec);
  if (!item) return { project: p, itemId: null, trackId: null };
  return addItemOp(p, item, { trackId: opts.trackId, scope: opts.scope });
}

/* ------------------------------------------------------------------ delete ------------------- */

/**
 * Delete items (whole groups; locked items / tracks are skipped). With a ripple scope the time they occupied
 * (net of any overlap a KEPT neighbour has with them) is closed on their own track; scope 'all' additionally
 * closes the same time on every other unlocked track where that is collision-free.
 */
export function deleteItemsOp(p: Project, ids: readonly string[], scope: RippleScope = 'none'): Project {
  const idx = indexItems(p);
  const removed = new Set<string>();
  let hadGroup = false;
  for (const id of expandGroups(p, ids)) {
    const l = idx.get(id) as { track: Track; item: Item };
    if (isItemLocked(l.track, l.item)) continue;
    removed.add(id);
    if (l.item.groupId) hadGroup = true;
  }
  if (!removed.size) return p;

  const d = new Draft(p);
  const events: { a: number; b: number; span: number }[] = [];
  const touched = new Set<number>();
  p.tracks.forEach((tr, ti) => {
    if (!tr.items.some((it) => removed.has(it.id))) return;
    touched.add(ti);
    const w = d.items(ti);
    const src = tr.items;
    w.length = 0;
    if (scope === 'none') {
      for (const it of src) if (!removed.has(it.id)) w.push(it);
      return;
    }
    let acc = 0;
    let k = 0;
    while (k < src.length) {
      const it = src[k] as Item;
      if (!removed.has(it.id)) {
        w.push(acc > 0 ? { ...it, startSec: Math.max(0, it.startSec - acc) } : it);
        k++;
        continue;
      }
      const a = it.startSec;
      let b = itemEnd(it);
      let j = k + 1;
      while (j < src.length && removed.has((src[j] as Item).id) && (src[j] as Item).startSec <= b + EPS) {
        b = Math.max(b, itemEnd(src[j] as Item));
        j++;
      }
      let a2 = a;
      let b2 = b;
      const left = src[k - 1];
      if (left && !removed.has(left.id)) a2 = Math.max(a, itemEnd(left));
      const right = src[j];
      if (right && !removed.has(right.id)) b2 = Math.min(b, right.startSec);
      const span = Math.max(0, b2 - a2);
      events.push({ a: a2, b: b2, span });
      acc += span;
      k = j;
    }
  });

  if (scope === 'all' && events.length) {
    p.tracks.forEach((tr, ti) => {
      if (touched.has(ti) || tr.locked) return;
      const w = d.items(ti);
      const next = w.map((it) => {
        let shift = 0;
        for (const e of events) {
          if (it.startSec >= e.b - EPS) shift += e.span;
          else if (it.startSec > e.a + EPS) shift += it.startSec - e.a;
        }
        return shift > 0 ? { ...it, startSec: Math.max(0, it.startSec - shift) } : it;
      });
      normalizeItems(next);
      if (!layoutProblem(next)) {
        w.length = 0;
        for (const it of next) w.push(it);
      }
    });
  }
  const out = d.result();
  return hadGroup ? cleanSingletonGroups(out) : out;
}

/**
 * Close the empty space between items by shifting later items left, on one track or on every unlocked track.
 * The first item keeps its position; transition overlaps are preserved.
 */
export function deleteGapsOp(p: Project, trackId?: string): Project {
  const d = new Draft(p);
  p.tracks.forEach((tr, ti) => {
    if (tr.locked || (trackId !== undefined && tr.id !== trackId)) return;
    const w = d.items(ti);
    let acc = 0;
    let maxEnd = -Infinity;
    for (let k = 0; k < w.length; k++) {
      const it = w[k] as Item;
      if (k > 0) {
        const gap = it.startSec - maxEnd;
        if (gap > EPS) acc += gap;
      }
      maxEnd = Math.max(maxEnd, itemEnd(it));
      if (acc > 0) w[k] = { ...it, startSec: Math.max(0, it.startSec - acc) };
    }
  });
  return d.result();
}

/* ------------------------------------------------------------------ duplicate / group --------- */

/** Fresh ids (and fresh group ids, one per old group) for copies of items. */
export function cloneItems(items: readonly Item[]): { copies: Item[]; idMap: Map<string, string> } {
  const idMap = new Map<string, string>();
  const groups = new Map<string, string>();
  const copies = items.map((it) => {
    const id = newId('it');
    idMap.set(it.id, id);
    let groupId = it.groupId;
    if (groupId) {
      let g = groups.get(groupId);
      if (!g) {
        g = newId('gr');
        groups.set(groupId, g);
      }
      groupId = g;
    }
    return { ...it, id, groupId } as Item;
  });
  return { copies, idMap };
}

/**
 * Duplicate items (whole groups) right after the originals: the copies keep their relative offsets and are shifted
 * by the span of the selection, further right if that would collide. Locked items are not duplicated. New ids and
 * new group ids. A copy keeps its transition only when its predecessor was copied too.
 */
export function duplicateOp(p: Project, ids: readonly string[]): { project: Project; newIds: string[] } {
  const idx = indexItems(p);
  const src: { ti: number; item: Item }[] = [];
  for (const id of expandGroups(p, ids)) {
    const l = idx.get(id);
    if (l && !isItemLocked(l.track, l.item)) src.push({ ti: l.ti, item: l.item });
  }
  if (!src.length) return { project: p, newIds: [] };
  src.sort((a, b) => a.ti - b.ti || a.item.startSec - b.item.startSec);
  const picked = new Set(src.map((s) => s.item.id));
  let minStart = Infinity;
  let maxEnd = -Infinity;
  for (const s of src) {
    minStart = Math.min(minStart, s.item.startSec);
    maxEnd = Math.max(maxEnd, itemEnd(s.item));
  }
  let off = maxEnd - minStart;
  for (let iter = 0; iter < 50; iter++) {
    let next = off;
    for (const s of src) {
      const items = (p.tracks[s.ti] as Track).items;
      const free = findFreeStart(items, s.item.startSec + off, s.item.durationSec) - s.item.startSec;
      next = Math.max(next, free);
    }
    if (next <= off + EPS) break;
    off = next;
  }
  const { copies, idMap } = cloneItems(src.map((s) => s.item));
  const d = new Draft(p);
  const newIds: string[] = [];
  copies.forEach((c, k) => {
    const s = src[k] as { ti: number; item: Item };
    const prev = (p.tracks[s.ti] as Track).items[
      (p.tracks[s.ti] as Track).items.findIndex((i) => i.id === s.item.id) - 1
    ];
    let copy: Item = { ...c, startSec: s.item.startSec + off };
    if (hasTransition(copy) && copy.transitionIn && !(prev && picked.has(prev.id)))
      copy = { ...copy, transitionIn: null };
    d.items(s.ti).push(copy);
    newIds.push(idMap.get(s.item.id) as string);
  });
  const out = d.result();
  for (const tr of out.tracks) if (layoutProblem(tr.items)) return { project: p, newIds: [] };
  return { project: out, newIds };
}

/** Put the items (existing groups merge into it) in one new group. Needs ≥ 2 unlocked items. */
export function groupOp(p: Project, ids: readonly string[]): Project {
  const idx = indexItems(p);
  const members = expandGroups(p, ids).filter((id) => {
    const l = idx.get(id) as { track: Track; item: Item };
    return !isItemLocked(l.track, l.item);
  });
  if (members.length < 2) return p;
  return setGroup(p, new Set(members), newId('gr'));
}

export function ungroupOp(p: Project, ids: readonly string[]): Project {
  const idx = indexItems(p);
  const members = expandGroups(p, ids).filter((id) => {
    const l = idx.get(id) as { track: Track; item: Item };
    return l.item.groupId !== null && !isItemLocked(l.track, l.item);
  });
  if (!members.length) return p;
  return setGroup(p, new Set(members), null);
}

function setGroup(p: Project, members: Set<string>, groupId: string | null): Project {
  const tracks = p.tracks.map((tr) =>
    tr.items.some((it) => members.has(it.id))
      ? { ...tr, items: tr.items.map((it) => (members.has(it.id) ? ({ ...it, groupId } as Item) : it)) }
      : tr,
  );
  return cleanSingletonGroups({ ...p, tracks });
}

/* ------------------------------------------------------------------ property patches --------- */

/** Recursive object merge (arrays and primitives replace; `undefined` leaves the base value). */
export function deepMerge(base: unknown, patch: unknown): unknown {
  if (patch === undefined) return base;
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  if (!base || typeof base !== 'object' || Array.isArray(base)) return patch;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) out[k] = deepMerge(out[k], v);
  return out;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** True when merging `patch` into `base` would change nothing. */
function patchIsNoop(base: unknown, patch: unknown): boolean {
  if (patch === undefined) return true;
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return deepEqual(base, patch);
  if (!base || typeof base !== 'object' || Array.isArray(base)) return false;
  return Object.entries(patch as Record<string, unknown>).every(([k, v]) =>
    patchIsNoop((base as Record<string, unknown>)[k], v),
  );
}

/** The item with `patch` merged in (id / type can't change), or null when the result is not a valid item. */
export function mergeItemPatch(item: Item, patch: DeepPartial<Item>): Item | null {
  const rest: Record<string, unknown> = { ...(patch as Record<string, unknown>) };
  delete rest.id;
  delete rest.type;
  if (patchIsNoop(item, rest)) return item;
  const merged = deepMerge(item, rest) as Item;
  if (merged.durationSec !== item.durationSec && !(merged.durationSec >= MIN_DUR)) return null;
  return itemSchema.safeParse(merged).success ? merged : null;
}

/**
 * Merge `patch` into many items at once (no group expansion). Skips locked items (a patch that only toggles
 * `locked` is allowed on a locked item). If the patch changes startSec / durationSec and that would break the
 * overlap invariant the whole call is refused.
 */
export function updateItemsOp(p: Project, ids: readonly string[], patch: DeepPartial<Item>): Project {
  const want = new Set(ids);
  const onlyLock = Object.keys(patch).every((k) => k === 'locked');
  const geometry = 'startSec' in patch || 'durationSec' in patch;
  const d = new Draft(p);
  let any = false;
  p.tracks.forEach((tr, ti) => {
    if (tr.locked || !tr.items.some((it) => want.has(it.id))) return;
    const w = d.items(ti);
    for (let k = 0; k < w.length; k++) {
      const it = w[k] as Item;
      if (!want.has(it.id) || (it.locked && !onlyLock)) continue;
      const next = mergeItemPatch(it, patch);
      if (next && next !== it) {
        w[k] = next;
        any = true;
      }
    }
  });
  if (!any) return p;
  const out = d.result();
  if (geometry) {
    for (const tr of out.tracks) if (layoutProblem(tr.items)) return p;
  }
  return out;
}
