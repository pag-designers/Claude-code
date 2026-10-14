/** Copy / paste (pure). The clipboard keeps each item's source track KIND (and a source-track slot) so a paste can
 * land on the same kind of track and keep different source tracks on different destination tracks. */
import type { Item, Project, Track, TrackKind } from '@shared/editor';
import { itemEnd } from '@shared/editor-eval';
import {
  defaultTrackIndex,
  makeTrack,
  nextTrackName,
  trackAccepts,
} from '../helpers';
import { Draft, EPS, expandGroups, hasTransition, indexItems, layoutProblem } from './common';
import { cloneItems } from './items';

export interface ClipboardData {
  items: Item[];
  trackKinds: TrackKind[];
  /** Source-track slot per item (same slot = same source track). Optional for externally-built clipboards. */
  slots?: number[];
}

/** Snapshot the (group-expanded) items for pasting. Null when nothing copyable. */
export function copyOp(p: Project, ids: readonly string[]): ClipboardData | null {
  const idx = indexItems(p);
  const rows: { ti: number; item: Item; kind: TrackKind }[] = [];
  for (const id of expandGroups(p, ids)) {
    const l = idx.get(id);
    if (l) rows.push({ ti: l.ti, item: l.item, kind: l.track.kind });
  }
  if (!rows.length) return null;
  rows.sort((a, b) => a.ti - b.ti || a.item.startSec - b.item.startSec);
  return {
    items: rows.map((r) => r.item),
    trackKinds: rows.map((r) => r.kind),
    slots: rows.map((r) => r.ti),
  };
}

const fits = (items: readonly Item[], list: readonly Item[]): boolean =>
  list.every(
    (c) => !items.some((o) => o.startSec < itemEnd(c) - EPS && itemEnd(o) > c.startSec + EPS),
  );

/**
 * Paste at `at`: relative offsets preserved. Each source track goes to (in order) the selected track, then other
 * tracks of the same kind, then any compatible unlocked track — the first where the pasted block fits — else a new
 * track. New item ids and group ids. Returns the pasted ids.
 */
export function pasteOp(
  p: Project,
  clip: ClipboardData,
  at: number,
  selectedTrackId: string | null,
): { project: Project; newIds: string[] } {
  if (!clip.items.length) return { project: p, newIds: [] };
  const base = Math.min(...clip.items.map((i) => i.startSec));
  const offset = Math.max(0, at) - base;
  const { copies, idMap } = cloneItems(clip.items);
  const slotOf = (k: number): number => clip.slots?.[k] ?? kindIndex(clip.trackKinds[k]);
  const order: number[] = [];
  const bySlot = new Map<number, number[]>();
  clip.items.forEach((_, k) => {
    const s = slotOf(k);
    if (!bySlot.has(s)) {
      bySlot.set(s, []);
      order.push(s);
    }
    (bySlot.get(s) as number[]).push(k);
  });

  let cur = p;
  const usedTrackIds = new Set<string>();
  const newIds: string[] = [];
  for (const slot of order) {
    const ks = bySlot.get(slot) as number[];
    const kind = clip.trackKinds[ks[0] as number] as TrackKind;
    const placed: Item[] = ks.map((k) => {
      const orig = clip.items[k] as Item;
      let it: Item = { ...(copies[k] as Item), startSec: orig.startSec + offset };
      if (hasTransition(it) && it.transitionIn) {
        const prevK = ks[ks.indexOf(k) - 1];
        const prev = prevK === undefined ? undefined : (clip.items[prevK] as Item);
        const ok = !!prev && Math.abs(itemEnd(prev) - orig.startSec - it.transitionIn.durationSec) <= 1e-5;
        if (!ok) it = { ...it, transitionIn: null };
      }
      return it;
    });
    const types = placed.map((i) => i.type);
    const accepts = (t: Track) => !t.locked && !usedTrackIds.has(t.id) && types.every((ty) => trackAccepts(t, ty));
    const candidates: Track[] = [];
    const sel = selectedTrackId ? cur.tracks.find((t) => t.id === selectedTrackId) : undefined;
    if (sel && accepts(sel) && usedTrackIds.size === 0) candidates.push(sel);
    for (const t of cur.tracks) if (t.kind === kind && accepts(t) && !candidates.includes(t)) candidates.push(t);
    for (const t of cur.tracks) if (accepts(t) && !candidates.includes(t)) candidates.push(t);
    let target = candidates.find((t) => fits(t.items, placed));
    if (!target) {
      const track = makeTrack(kind, nextTrackName(cur.tracks, kind));
      const tracks = cur.tracks.slice();
      tracks.splice(defaultTrackIndex(tracks, kind), 0, track);
      cur = { ...cur, tracks };
      target = track;
    }
    const ti = cur.tracks.findIndex((t) => t.id === (target as Track).id);
    const d = new Draft(cur);
    d.items(ti).push(...placed);
    cur = d.result();
    usedTrackIds.add((target as Track).id);
    for (const k of ks) newIds.push(idMap.get((clip.items[k] as Item).id) as string);
  }
  for (const tr of cur.tracks) if (layoutProblem(tr.items)) return { project: p, newIds: [] };
  return { project: cur, newIds };
}

function kindIndex(kind: TrackKind | undefined): number {
  return ['video', 'overlay', 'image', 'text', 'subtitle', 'audio', 'sfx'].indexOf(kind ?? 'video');
}
