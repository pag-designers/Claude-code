/**
 * Which items a bin action applies to. Pure functions over the Project so the rules (selected item, else the item
 * under the playhead; a transition belongs to the LATER item of an adjacent pair) are unit-tested without a store.
 */
import { EPS, itemEnd, isActive } from '@shared/editor-eval';
import type { Item, ItemTransition, Project, Track, TransitionType } from '@shared/editor';

export type VisualItem = Extract<Item, { type: 'video' | 'image' }>;
export const isVisual = (i: Item): i is VisualItem => i.type === 'video' || i.type === 'image';

/** Two clips count as adjacent when the gap is at most this (or they already overlap by a transition). */
export const ADJACENT_GAP_SEC = 0.1;
/** The shortest a transition may be (schema minimum). */
export const MIN_TRANSITION_SEC = 0.05;

const sortedVisual = (t: Track): VisualItem[] =>
  t.items.filter(isVisual).sort((a, b) => a.startSec - b.startSec);

export function selectedVisualItems(project: Project, ids: readonly string[]): VisualItem[] {
  const want = new Set(ids);
  const out: VisualItem[] = [];
  for (const t of project.tracks)
    for (const i of t.items) if (want.has(i.id) && isVisual(i)) out.push(i);
  return out;
}

/** The video / image item under the playhead on the top-most track that has one. */
export function visualUnderPlayhead(project: Project, t: number): VisualItem | null {
  for (let k = project.tracks.length - 1; k >= 0; k--) {
    const tr = project.tracks[k]!;
    if (tr.hidden) continue;
    const hit = sortedVisual(tr).find((i) => isActive(i, t));
    if (hit) return hit;
  }
  return null;
}

export type TransitionTarget =
  | {
      ok: true;
      item: VisualItem;
      previous: VisualItem;
      existing: ItemTransition | null;
      maxSec: number;
    }
  | { ok: false; reason: string };

/**
 * A transition lives on the later item of two adjacent clips on one track. The target is the selected clip (or the
 * clip under the playhead when nothing is selected); if that clip is the first of its pair, the transition goes on
 * the clip after it.
 */
export function resolveTransitionTarget(
  project: Project,
  selectedIds: readonly string[],
  playheadSec: number,
): TransitionTarget {
  const selected = selectedVisualItems(project, selectedIds);
  const candidates = selected.length
    ? selected
    : (() => {
        const hit = visualUnderPlayhead(project, playheadSec);
        return hit ? [hit] : [];
      })();
  if (!candidates.length)
    return {
      ok: false,
      reason: 'Select a clip, or park the playhead on one, to choose where the transition goes.',
    };
  for (const cand of candidates) {
    const track = project.tracks.find((t) => t.items.some((i) => i.id === cand.id));
    if (!track || track.locked) continue;
    const list = sortedVisual(track);
    const idx = list.findIndex((i) => i.id === cand.id);
    const prev = idx > 0 ? list[idx - 1] : undefined;
    const next = list[idx + 1];
    if (prev && cand.startSec - itemEnd(prev) <= ADJACENT_GAP_SEC + EPS) return build(cand, prev);
    if (next && next.startSec - itemEnd(cand) <= ADJACENT_GAP_SEC + EPS) return build(next, cand);
  }
  const lockedOnly = candidates.every((c) =>
    project.tracks.some((t) => t.locked && t.items.some((i) => i.id === c.id)),
  );
  return {
    ok: false,
    reason: lockedOnly
      ? 'That track is locked. Unlock it to add a transition.'
      : 'A transition sits between two clips that touch on the same track. Place another clip right next to this one first.',
  };
}

function build(item: VisualItem, previous: VisualItem): TransitionTarget {
  return {
    ok: true,
    item,
    previous,
    existing: item.transitionIn,
    // a transition is an overlap, so it can never exceed half of either clip
    maxSec: Math.max(MIN_TRANSITION_SEC, Math.min(item.durationSec, previous.durationSec) / 2),
  };
}

/** `null` removes the transition ("Cut"). */
export function transitionFor(
  type: TransitionType,
  durationSec: number,
  maxSec: number,
): ItemTransition | null {
  if (type === 'cut') return null;
  return {
    type,
    durationSec:
      Math.round(Math.max(MIN_TRANSITION_SEC, Math.min(durationSec, maxSec)) * 100) / 100,
  };
}

/** Filter key shared by every item: the key, null (all unfiltered), or 'mixed'. */
export function sharedFilter(items: readonly VisualItem[]): string | null | 'mixed' {
  if (!items.length) return null;
  const first = items[0]!.color.filter;
  return items.every((i) => i.color.filter === first) ? first : 'mixed';
}

/** Same for the imported LUT. */
export function sharedLut(items: readonly VisualItem[]): string | null | 'mixed' {
  if (!items.length) return null;
  const first = items[0]!.color.lutAssetId;
  return items.every((i) => i.color.lutAssetId === first) ? first : 'mixed';
}

/** Tempo from beat times (seconds): median inter-beat interval, folded into 70–180 BPM. Null if too few beats. */
export function estimateBpm(beats: readonly number[] | null | undefined): number | null {
  if (!beats || beats.length < 4) return null;
  const d: number[] = [];
  for (let i = 1; i < beats.length; i++) {
    const g = beats[i]! - beats[i - 1]!;
    if (g > 0.05) d.push(g);
  }
  if (d.length < 3) return null;
  d.sort((a, b) => a - b);
  const mid = d[Math.floor(d.length / 2)]!;
  let bpm = 60 / mid;
  while (bpm < 70) bpm *= 2;
  while (bpm > 180) bpm /= 2;
  return Math.round(bpm);
}

/** Playback length of what is already on the timeline from `fromSec` (min `floor`), for items that span the project. */
export function remainingSec(project: Pick<Project, 'tracks'>, fromSec: number, floor = 5): number {
  let end = 0;
  for (const t of project.tracks) for (const i of t.items) end = Math.max(end, itemEnd(i));
  return Math.max(floor, Math.round((end - fromSec) * 100) / 100);
}
