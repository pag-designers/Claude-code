'use client';

import type * as React from 'react';
import { useEditorStore } from '@/lib/editor/core';
import { endOf } from './geometry';
import { layoutFor } from './gestures';
import { openInspectorRequest } from './menus';
import { useTimelineUi } from './timeline-ui';

const S = () => useEditorStore.getState();

/** Moves DOM focus to an item once it is rendered (it may be outside the virtualised window for a frame or two). */
export function focusItemSoon(scroller: HTMLElement | null, id: string, tries = 6) {
  if (!scroller) return;
  const el = scroller.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(id)}"][role=option]`);
  if (el) {
    el.focus({ preventScroll: true });
    return;
  }
  if (tries > 0) requestAnimationFrame(() => focusItemSoon(scroller, id, tries - 1));
}

function revealItem(id: string) {
  const s = S();
  for (const t of s.project.tracks) {
    const it = t.items.find((i) => i.id === id);
    if (!it) continue;
    const vs = useTimelineUi.getState().viewportPx / s.pxPerSec;
    if (it.startSec < s.scrollSec || endOf(it) > s.scrollSec + vs)
      s.setScroll(Math.max(0, it.startSec - vs * 0.1));
    return;
  }
}

/**
 * Keyboard operation of the clips: arrows move/extend the selection (Left/Right along the track, Up/Down to the nearest clip
 * on the neighbouring track), Home/End jump to the first/last clip, Enter opens the inspector. Only active when the clip has
 * keyboard focus (`:focus-visible`), so after a mouse click the global frame-step arrows keep working.
 */
export function handleItemKey(e: React.KeyboardEvent, scroller: HTMLElement | null): boolean {
  const el = e.target as HTMLElement;
  if (!el.matches?.('[data-item-id][role=option]')) return false;
  const id = el.dataset.itemId ?? '';
  const trackId = el.dataset.trackId ?? '';
  if (e.key === 'Enter') {
    e.preventDefault();
    if (!S().selection.itemIds.includes(id)) S().select([id], 'replace');
    openInspectorRequest();
    return true;
  }
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key))
    return false;
  if (!el.matches(':focus-visible')) return false;
  const s = S();
  const tracks = s.project.tracks;
  const track = tracks.find((t) => t.id === trackId);
  if (!track) return false;
  const idx = track.items.findIndex((i) => i.id === id);
  let target: string | null = null;
  if (e.key === 'ArrowLeft') target = track.items[idx - 1]?.id ?? null;
  else if (e.key === 'ArrowRight') target = track.items[idx + 1]?.id ?? null;
  else if (e.key === 'Home') target = track.items[0]?.id ?? null;
  else if (e.key === 'End') target = track.items[track.items.length - 1]?.id ?? null;
  else {
    const layout = layoutFor(tracks);
    const pos = layout.rows.findIndex((r) => r.trackId === trackId);
    const next = layout.rows[pos + (e.key === 'ArrowDown' ? 1 : -1)];
    const other = next ? tracks[next.arrayIndex] : undefined;
    const cur = track.items[idx];
    if (other && cur) {
      let best: { id: string; d: number } | null = null;
      for (const it of other.items) {
        const d =
          cur.startSec >= it.startSec && cur.startSec <= endOf(it)
            ? -1
            : Math.abs(it.startSec - cur.startSec);
        if (!best || d < best.d) best = { id: it.id, d };
      }
      target = best?.id ?? null;
    }
  }
  e.preventDefault();
  e.stopPropagation();
  if (!target) return true;
  s.selectTrack(trackId);
  const other = tracks.find((t) => t.items.some((i) => i.id === target));
  if (other) s.selectTrack(other.id);
  s.select([target], e.shiftKey ? 'add' : 'replace');
  revealItem(target);
  focusItemSoon(scroller, target);
  return true;
}
