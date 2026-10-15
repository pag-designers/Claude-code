/**
 * Shared building blocks of the pure operations layer: constants, lookups, group expansion, the copy-on-write
 * `Draft` (touches only the tracks an op edits — everything else is shared by reference, which is what keeps a
 * 200-level snapshot history cheap), track normalisation and the layout invariant checker.
 *
 * Nothing in here touches the DOM, zustand, timers or randomness (ids are minted by callers).
 */
import type { Item, Project, Track, VideoItem, AudioItem, ImageItem } from '@shared/editor';
import { itemEnd } from '@shared/editor-eval';

export const EPS = 1e-6;
/** Shortest legal item (matches the schema's `durationSec.min(0.04)`). */
export const MIN_DUR = 0.04;
export const MIN_TRANSITION = 0.05;
export const MAX_TRANSITION = 5;
/** Two edges closer than this are "the same boundary" for adjacency tests (roll edits, transitions). */
export const ADJ = 1e-3;

export type MediaItem = VideoItem | AudioItem;
export type VisualMediaItem = VideoItem | ImageItem;

export const isMedia = (i: Item): i is MediaItem => i.type === 'video' || i.type === 'audio';
/** Items that can carry `transitionIn`. */
export const hasTransition = (i: Item): i is VisualMediaItem =>
  i.type === 'video' || i.type === 'image';

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** How the ripple of an edit propagates: nothing / the edited track only / every unlocked track. */
export type RippleScope = 'none' | 'track' | 'all';

/* ------------------------------------------------------------------ lookups ------------------ */

export interface Located {
  ti: number;
  track: Track;
  i: number;
  item: Item;
}

export function locate(p: Project, itemId: string): Located | null {
  for (let ti = 0; ti < p.tracks.length; ti++) {
    const track = p.tracks[ti] as Track;
    const items = track.items;
    for (let i = 0; i < items.length; i++) {
      if ((items[i] as Item).id === itemId) return { ti, track, i, item: items[i] as Item };
    }
  }
  return null;
}

/** id → location for many lookups in one pass. */
export function indexItems(p: Project): Map<string, Located> {
  const m = new Map<string, Located>();
  for (let ti = 0; ti < p.tracks.length; ti++) {
    const track = p.tracks[ti] as Track;
    for (let i = 0; i < track.items.length; i++) {
      const item = track.items[i] as Item;
      m.set(item.id, { ti, track, i, item });
    }
  }
  return m;
}

export const trackIndexOf = (p: Project, trackId: string): number =>
  p.tracks.findIndex((t) => t.id === trackId);

export const isItemLocked = (track: Track, item: Item): boolean => track.locked || item.locked;

/**
 * `ids` plus every item sharing a group with one of them (existing items only, original order first, no
 * duplicates). "Moving / selecting / deleting a grouped item acts on the whole group."
 */
export function expandGroups(p: Project, ids: readonly string[]): string[] {
  const want = new Set(ids);
  const groups = new Set<string>();
  const existing = new Set<string>();
  for (const tr of p.tracks)
    for (const it of tr.items) {
      existing.add(it.id);
      if (it.groupId && want.has(it.id)) groups.add(it.groupId);
    }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (existing.has(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  if (groups.size) {
    for (const tr of p.tracks)
      for (const it of tr.items)
        if (it.groupId && groups.has(it.groupId) && !seen.has(it.id)) {
          seen.add(it.id);
          out.push(it.id);
        }
  }
  return out;
}

export function assetOf(p: Project, assetId: string) {
  return p.assets.find((a) => a.id === assetId) ?? null;
}

/** Overlap (> 0) between an item and the end of the previous item on its track, else 0. */
export function overlapIn(items: readonly Item[], i: number): number {
  const prev = items[i - 1];
  const it = items[i];
  if (!prev || !it) return 0;
  return Math.max(0, itemEnd(prev) - it.startSec);
}

/** Overlap (> 0) of the NEXT item with this one (the next item's transition), else 0. */
export function overlapOut(items: readonly Item[], i: number): number {
  const it = items[i];
  const next = items[i + 1];
  if (!it || !next) return 0;
  return Math.max(0, itemEnd(it) - next.startSec);
}

/** Largest end among items[0..upTo) (−Infinity when empty). */
export function maxEndBefore(items: readonly Item[], upTo: number): number {
  let m = -Infinity;
  for (let k = 0; k < upTo && k < items.length; k++) m = Math.max(m, itemEnd(items[k] as Item));
  return m;
}

/* ------------------------------------------------------------------ normalisation ------------ */

/**
 * Canonical form of a track's item list (IN PLACE on the given working array): sorted by startSec (stable) and
 * every `transitionIn` reconciled with the geometry — its duration IS the overlap with the previous item;
 * a transition without a (sufficient) overlap is dropped, as is a `cut`.
 */
export function normalizeItems(items: Item[]): Item[] {
  // Float drift guard: 0.04 − 1e-16 would fail the schema's `min(0.04)`; a start of −1e-13 its `min(0)`.
  for (let i = 0; i < items.length; i++) {
    const it = items[i] as Item;
    const shortDur = it.durationSec < MIN_DUR && it.durationSec > MIN_DUR - 1e-6;
    const negStart = it.startSec < 0 && it.startSec > -1e-6;
    if (shortDur || negStart)
      items[i] = {
        ...it,
        durationSec: shortDur ? MIN_DUR : it.durationSec,
        startSec: negStart ? 0 : it.startSec,
      };
  }
  let sorted = true;
  for (let i = 1; i < items.length; i++) {
    if ((items[i] as Item).startSec < (items[i - 1] as Item).startSec) {
      sorted = false;
      break;
    }
  }
  if (!sorted) items.sort((a, b) => a.startSec - b.startSec);
  for (let i = 0; i < items.length; i++) {
    const it = items[i] as Item;
    if (!hasTransition(it) || !it.transitionIn) continue;
    const prev = items[i - 1];
    const o = prev ? itemEnd(prev) - it.startSec : 0;
    if (!prev || o < MIN_TRANSITION - 1e-9 || it.transitionIn.type === 'cut') {
      items[i] = { ...it, transitionIn: null };
    } else {
      const d = clamp(o, MIN_TRANSITION, MAX_TRANSITION);
      if (Math.abs(d - it.transitionIn.durationSec) > 1e-9)
        items[i] = { ...it, transitionIn: { ...it.transitionIn, durationSec: d } };
    }
  }
  return items;
}

/**
 * The overlap invariant. Returns a description of the first violation or null:
 * items sorted; nothing overlaps EXCEPT the later item of a pair carrying a `transitionIn` whose duration equals
 * the overlap (and leaves both items at least MIN_DUR of their own); no item overlaps anything but its direct
 * predecessor.
 */
export function layoutProblem(items: readonly Item[]): string | null {
  let endsBeforePrev = -Infinity; // max end among items[0 .. i-2]
  for (let i = 0; i < items.length; i++) {
    const it = items[i] as Item;
    const prev = items[i - 1];
    if (prev && it.startSec < prev.startSec - EPS) return `items not sorted at ${it.id}`;
    if (it.startSec < endsBeforePrev - EPS) return `${it.id} overlaps a non-adjacent item`;
    if (prev) {
      const o = itemEnd(prev) - it.startSec;
      if (o > EPS) {
        const tin = hasTransition(it) ? it.transitionIn : null;
        if (!tin) return `${it.id} overlaps ${prev.id} without a transition`;
        if (Math.abs(o - tin.durationSec) > 1e-5)
          return `${it.id} transition ${tin.durationSec} != overlap ${o}`;
        if (o > MAX_TRANSITION + 1e-5) return `${it.id} transition too long`;
        if (o > prev.durationSec - MIN_DUR + 1e-5 || o > it.durationSec - MIN_DUR + 1e-5)
          return `${it.id} transition swallows an item`;
      }
      endsBeforePrev = Math.max(endsBeforePrev, itemEnd(prev));
    }
  }
  return null;
}

/* ------------------------------------------------------------------ Draft -------------------- */

/**
 * Copy-on-write view of a project. `items(ti)` hands out a private working copy of one track's item array
 * (copied on first touch); `result()` normalises the touched tracks, drops "touched" tracks that ended up
 * identical, and returns either a new Project (structurally sharing every untouched track) or the SAME
 * project reference when nothing changed — which is how the store knows an edit was a no-op (no history entry).
 */
export class Draft {
  private tracks: Track[];
  private work = new Map<number, Item[]>();
  extra: Partial<Pick<Project, 'assets' | 'markers' | 'canvas'>> = {};
  tracksReplaced = false;

  constructor(readonly base: Project) {
    this.tracks = base.tracks.slice();
  }

  get trackList(): readonly Track[] {
    return this.tracks;
  }

  /** Mutable working copy of track `ti`'s items. */
  items(ti: number): Item[] {
    let w = this.work.get(ti);
    if (!w) {
      w = (this.tracks[ti] as Track).items.slice();
      this.work.set(ti, w);
    }
    return w;
  }

  /** Replace the whole track list (add / remove / reorder tracks). Working copies are re-keyed by caller. */
  replaceTracks(tracks: Track[]): void {
    this.tracks = tracks;
    this.tracksReplaced = true;
  }

  setTrack(ti: number, track: Track): void {
    this.tracks[ti] = track;
    this.tracksReplaced = true;
  }

  result(opts: { normalize?: boolean } = {}): Project {
    const normalize = opts.normalize ?? true;
    let changed = this.tracksReplaced || Object.keys(this.extra).length > 0;
    const tracks = this.tracks.slice();
    for (const [ti, items] of this.work) {
      const tr = tracks[ti] as Track;
      if (normalize) normalizeItems(items);
      if (items.length === tr.items.length && items.every((it, k) => it === tr.items[k])) continue;
      tracks[ti] = { ...tr, items };
      changed = true;
    }
    if (!changed) return this.base;
    return { ...this.base, ...this.extra, tracks };
  }
}

/* ------------------------------------------------------------------ ripple helpers ----------- */

/** Shift items[from..] by `delta` exactly (no guards). Used for the edited track's own tail. */
export function shiftTailRaw(items: Item[], from: number, delta: number): void {
  if (Math.abs(delta) < 1e-12) return;
  for (let k = from; k < items.length; k++) {
    const it = items[k] as Item;
    items[k] = { ...it, startSec: Math.max(0, it.startSec + delta) };
  }
}

/** Index of the first item starting at or after `point` (items sorted), or items.length. */
export function firstStartingAtOrAfter(items: readonly Item[], point: number): number {
  for (let k = 0; k < items.length; k++) if ((items[k] as Item).startSec >= point - EPS) return k;
  return items.length;
}

/**
 * Best-effort shift of a track that is NOT the one being edited (ripple across tracks): the tail from
 * `from` moves by `delta`; if the result would break the layout invariant the track is left exactly as it was.
 * Returns the new item array, or null when the track should stay untouched.
 */
export function tryShiftTail(items: readonly Item[], from: number, delta: number): Item[] | null {
  if (from >= items.length || Math.abs(delta) < 1e-12) return null;
  const copy = items.slice();
  shiftTailRaw(copy, from, delta);
  normalizeItems(copy);
  return layoutProblem(copy) ? null : copy;
}

/**
 * Cross-track ripple: shift, on every unlocked track except `exceptTi`, the items starting at or after `anchor`
 * by `delta` (best effort per track, see tryShiftTail).
 */
export function rippleOtherTracks(
  d: Draft,
  exceptTi: number | null,
  anchor: number,
  delta: number,
): void {
  for (let ti = 0; ti < d.trackList.length; ti++) {
    if (ti === exceptTi || (d.trackList[ti] as Track).locked) continue;
    const cur = d.items(ti);
    const from = firstStartingAtOrAfter(cur, anchor);
    const next = tryShiftTail(cur, from, delta);
    if (next) {
      cur.length = 0;
      for (const it of next) cur.push(it);
    }
  }
}
