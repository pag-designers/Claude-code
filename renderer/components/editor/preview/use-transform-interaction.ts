'use client';

import * as React from 'react';
import type { AnimatedPath } from '@/lib/editor/core/api';
import type { Compositor, HandleKind, Point, TransformHandles } from '@/lib/editor/compositor/api';
import { computeDrag, useEditorStore } from '@/lib/editor/playback/link';
import { findItem, resolveTransform } from '@shared/editor-eval';
import { cursorFor, hitHandle, naturalSize, toBufferPx, type FitResult } from './layout';

/**
 * Pointer interaction of the preview: click-to-select (compositor.hitTest), transform handles (move / scale / rotate via
 * compositor.handlesFor + computeDrag) and live edits through `store.setProp` with ONE shared `coalesceKey` per drag so the
 * whole gesture is a single undo step. A click without movement never edits anything (a 3 px dead zone).
 */
export interface InteractionOptions {
  compositor: Compositor | null;
  layout: FitResult | null;
  canvasW: number;
  canvasH: number;
  /** Element whose bounding box maps 1:1 onto the drawing buffer. */
  surface: React.RefObject<HTMLElement | null>;
  onEditText(itemId: string): void;
}

interface Drag {
  pointerId: number;
  kind: HandleKind;
  itemId: string;
  start: Point;
  initial: { x: number; y: number; scale: number; rotation: number };
  rectW: number;
  rectH: number;
  key: string;
  last: { x: number; y: number; scale: number; rotation: number } | null;
  started: boolean;
  keepalive: number | null;
}

const DEAD_ZONE_CSS = 3;
const KEEPALIVE_MS = 280;
let dragSeq = 0;

export function useTransformInteraction(o: InteractionOptions) {
  const dragRef = React.useRef<Drag | null>(null);
  const [guides, setGuides] = React.useState<{ x?: number; y?: number }[]>([]);
  const [cursor, setCursor] = React.useState('default');
  const [dragKind, setDragKind] = React.useState<HandleKind | null>(null);
  const opts = React.useRef(o);
  React.useEffect(() => {
    opts.current = o;
  });

  const pointerOf = React.useCallback((e: { clientX: number; clientY: number }): Point | null => {
    const { surface, layout } = opts.current;
    const el = surface.current;
    if (!el || !layout) return null;
    return toBufferPx(e.clientX, e.clientY, el.getBoundingClientRect(), layout.bufW, layout.bufH);
  }, []);

  const apply = React.useCallback(
    (d: Drag, current: Point, mods: { shift: boolean; alt: boolean }) => {
      const { layout, canvasW, canvasH } = opts.current;
      if (!layout) return;
      const res = computeDrag({
        kind: d.kind,
        start: d.start,
        current,
        initial: d.initial,
        previewScale: layout.previewScale,
        rectW: d.rectW,
        rectH: d.rectH,
        canvasW,
        canvasH,
        shift: mods.shift,
        alt: mods.alt,
        snapPx: 8 * layout.k,
      });
      const store = useEditorStore.getState();
      const next = { x: res.x, y: res.y, scale: res.scale, rotation: res.rotation };
      const props: [keyof typeof next, AnimatedPath][] = [
        ['x', 'transform.x'],
        ['y', 'transform.y'],
        ['scale', 'transform.scale'],
        ['rotation', 'transform.rotation'],
      ];
      for (const [p, path] of props) {
        const before = d.last ? d.last[p] : d.initial[p];
        if (Math.abs(before - next[p]) > 1e-9)
          store.setProp(d.itemId, path, next[p], { coalesceKey: d.key });
      }
      d.last = next;
      setGuides(
        res.guides.map((g) =>
          g.x !== undefined
            ? { x: g.x * layout.previewScale }
            : { y: (g.y as number) * layout.previewScale },
        ),
      );
    },
    [],
  );

  const endDrag = React.useCallback(() => {
    const d = dragRef.current;
    if (d?.keepalive) window.clearInterval(d.keepalive);
    dragRef.current = null;
    setDragKind(null);
    setGuides([]);
  }, []);

  React.useEffect(() => endDrag, [endDrag]);

  const onPointerDown = React.useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const { compositor, layout } = opts.current;
      if (e.button !== 0 || !compositor || !layout) return;
      const p = pointerOf(e);
      if (!p) return;
      const store = useEditorStore.getState();
      const t = store.playheadSec;
      const sel = store.selection.itemIds;
      let kind: HandleKind | null = null;
      let itemId: string | null = null;
      if (sel.length === 1) {
        const h = compositor.handlesFor(t, sel[0] as string);
        const hk = h ? hitHandle(h, p, layout.k) : null;
        if (hk) {
          kind = hk;
          itemId = sel[0] as string;
        }
      }
      if (!itemId) {
        const hit = compositor.hitTest(t, p.x, p.y);
        if (!hit) {
          if (!e.shiftKey) store.clearSelection();
          return;
        }
        if (e.shiftKey || e.metaKey || e.ctrlKey) store.select([hit], 'toggle');
        else if (!sel.includes(hit)) store.select([hit], 'replace');
        if (!useEditorStore.getState().selection.itemIds.includes(hit)) return;
        itemId = hit;
        kind = 'move';
      }
      const found = findItem(store.project, itemId);
      if (!found || found.item.locked || found.track.locked) return;
      const item = found.item;
      if (!('transform' in item)) return;
      const h: TransformHandles | null = compositor.handlesFor(t, itemId);
      if (!h) return;
      const tr = resolveTransform(item, Math.max(0, t - item.startSec), false);
      const size = naturalSize(h, layout.previewScale, tr.scale);
      const d: Drag = {
        pointerId: e.pointerId,
        kind: kind as HandleKind,
        itemId,
        start: p,
        initial: { x: tr.x, y: tr.y, scale: tr.scale, rotation: tr.rotation },
        rectW: size.rectW,
        rectH: size.rectH,
        key: `preview-drag:${itemId}:${++dragSeq}`,
        last: null,
        started: false,
        keepalive: null,
      };
      dragRef.current = d;
      e.currentTarget.setPointerCapture(e.pointerId);
      setDragKind(kind);
      e.preventDefault();
    },
    [pointerOf],
  );

  const onPointerMove = React.useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const p = pointerOf(e);
      const { compositor, layout } = opts.current;
      if (!p || !compositor || !layout) return;
      const d = dragRef.current;
      if (d && d.pointerId === e.pointerId) {
        if (!d.started) {
          if (Math.hypot(p.x - d.start.x, p.y - d.start.y) < DEAD_ZONE_CSS * layout.k) return;
          d.started = true;
          // Re-send the latest values while the pointer rests so a long pause doesn't split the undo step.
          d.keepalive = window.setInterval(() => {
            const cur = dragRef.current;
            if (!cur?.last) return;
            const s = useEditorStore.getState();
            s.setProp(cur.itemId, 'transform.x', cur.last.x, { coalesceKey: cur.key });
          }, KEEPALIVE_MS);
        }
        apply(d, p, { shift: e.shiftKey, alt: e.altKey });
        return;
      }
      // hover feedback
      const store = useEditorStore.getState();
      const sel = store.selection.itemIds;
      let next = 'default';
      if (sel.length === 1) {
        const h = compositor.handlesFor(store.playheadSec, sel[0] as string);
        if (h) next = cursorFor(hitHandle(h, p, layout.k), h.rotation);
      }
      if (next === 'default' && compositor.hitTest(store.playheadSec, p.x, p.y)) next = 'pointer';
      setCursor((c) => (c === next ? c : next));
    },
    [apply, pointerOf],
  );

  const onPointerUp = React.useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const d = dragRef.current;
      if (!d || d.pointerId !== e.pointerId) return;
      if (e.currentTarget.hasPointerCapture(e.pointerId))
        e.currentTarget.releasePointerCapture(e.pointerId);
      endDrag();
    },
    [endDrag],
  );

  const onDoubleClick = React.useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      const { compositor, onEditText } = opts.current;
      const p = pointerOf(e);
      if (!compositor || !p) return;
      const store = useEditorStore.getState();
      const hit = compositor.hitTest(store.playheadSec, p.x, p.y);
      if (!hit) return;
      const f = findItem(store.project, hit);
      if (
        f &&
        !f.item.locked &&
        !f.track.locked &&
        (f.item.type === 'text' || f.item.type === 'subtitle')
      ) {
        store.select([hit], 'replace');
        onEditText(hit);
      }
    },
    [pointerOf],
  );

  return {
    guides,
    cursor: dragKind ? cursorFor(dragKind) : cursor,
    dragging: dragKind !== null,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      onDoubleClick,
    },
  };
}
