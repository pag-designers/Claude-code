'use client';

/**
 * Pointer gesture controller for the timeline. One instance per mounted timeline; the scroller delegates `pointerdown`
 * to it and it listens on `window` for the rest of the gesture. Every gesture previews locally (ui store) and commits
 * ONCE on release, so a drag is exactly one undo step. The document is only ever changed through `useEditorStore`.
 */
import type { Asset, Item, Track } from '@shared/editor';
import { useEditorStore, type AnimatedPath, type MovePreview } from '@/lib/editor/core';
import { getEngine } from '@/lib/editor/playback';
import {
  HEADER_W,
  RULER_H,
  SNAP_PX,
  clampTrim,
  collectSnapPoints,
  edgeScrollSpeed,
  endOf,
  formatTimecode,
  layoutTracks,
  marqueeHits,
  normRect,
  sectionOf,
  snapToFrame,
  snapValue,
  trackAtY,
  type KfPath,
  type SnapPoint,
  type TracksLayout,
} from './geometry';
import { useTimelineUi } from './timeline-ui';

const S = () => useEditorStore.getState();
const UI = () => useTimelineUi.getState();

const layoutCache = new WeakMap<readonly Track[], TracksLayout>();
/** Track layout for the current tracks array (memoised by identity). */
export function layoutFor(tracks: readonly Track[]): TracksLayout {
  let l = layoutCache.get(tracks);
  if (!l) {
    l = layoutTracks(tracks);
    layoutCache.set(tracks, l);
  }
  return l;
}

interface Mods {
  shift: boolean;
  alt: boolean;
  mod: boolean;
}
const modsOf = (e: {
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}): Mods => ({
  shift: e.shiftKey,
  alt: e.altKey,
  mod: e.ctrlKey || e.metaKey,
});

interface Base {
  startCX: number;
  startCY: number;
  startScrollL: number;
  startScrollT: number;
  moved: boolean;
  /** Does this gesture auto-scroll vertically too? */
  vertical: boolean;
  /** Auto-scroll only once the gesture has really started. */
  autoscroll: boolean;
}

type Gesture = Base &
  (
    | { kind: 'scrub'; pts: SnapPoint[] }
    | {
        kind: 'move';
        itemId: string;
        ids: string[];
        meta: Map<string, { type: Item['type']; durationSec: number }>;
        collapseOnClick: boolean;
        preview: MovePreview | null;
        enabled: boolean;
      }
    | {
        kind: 'trim';
        itemId: string;
        edge: 'start' | 'end';
        item: Item;
        asset: Asset | undefined;
        /** Pointer offset from the edge at grab time, so the edge does not jump under the cursor. */
        grab: number;
        result: { startSec: number; durationSec: number } | null;
        mods: Mods;
      }
    | { kind: 'marker'; id: string; orig: number; grab: number; pts: SnapPoint[]; at: number }
    | {
        kind: 'kf';
        itemId: string;
        path: KfPath;
        index: number;
        value: number;
        startT: number;
        t: number;
        item: Item;
      }
    | { kind: 'marquee'; base: string[]; additive: boolean; last: string }
    | { kind: 'reorder'; trackId: string; section: 'visual' | 'audio' }
  );

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type GestureRest = DistributiveOmit<Gesture, keyof Base>;

export interface GestureController {
  pointerDown(e: PointerEvent, target: Element): void;
  hover(e: PointerEvent, target: Element): void;
  cancel(): void;
  active(): boolean;
  dispose(): void;
}

export function createGestures(getScroller: () => HTMLDivElement | null): GestureController {
  let g: Gesture | null = null;
  let last = { cx: 0, cy: 0, mods: { shift: false, alt: false, mod: false } as Mods };
  let raf = 0;
  let lastTs = 0;

  const geom = () => {
    const el = getScroller();
    if (!el) return null;
    return { el, r: el.getBoundingClientRect() };
  };
  const contentPt = (cx: number, cy: number) => {
    const gm = geom();
    if (!gm) return { x: 0, y: 0 };
    return {
      x: cx - gm.r.left - HEADER_W + gm.el.scrollLeft,
      y: cy - gm.r.top + gm.el.scrollTop - RULER_H,
    };
  };
  const secAt = (cx: number) => Math.max(0, contentPt(cx, 0).x / S().pxPerSec);

  /* ---------------------------------------------------------------- lifecycle ---------- */
  function begin(
    init: { e: PointerEvent; vertical: boolean; autoscroll: boolean },
    rest: GestureRest,
  ) {
    const gm = geom();
    g = {
      startCX: init.e.clientX,
      startCY: init.e.clientY,
      startScrollL: gm?.el.scrollLeft ?? 0,
      startScrollT: gm?.el.scrollTop ?? 0,
      moved: false,
      vertical: init.vertical,
      autoscroll: init.autoscroll,
      ...rest,
    } as Gesture;
    last = { cx: init.e.clientX, cy: init.e.clientY, mods: modsOf(init.e) };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
    lastTs = performance.now();
    raf = requestAnimationFrame(tick);
  }

  function end() {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('keydown', onKey, true);
    cancelAnimationFrame(raf);
    raf = 0;
    g = null;
    UI().clearInteraction();
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && g) {
      e.preventDefault();
      e.stopPropagation();
      end();
    } else if (g) {
      // modifier changes mid-drag update the preview (snap bypass, ripple, roll)
      last = { ...last, mods: modsOf(e) };
      apply();
    }
  };
  const onCancel = () => end();

  function tick(ts: number) {
    if (!g) return;
    const dt = Math.min(0.05, (ts - lastTs) / 1000);
    lastTs = ts;
    const gm = geom();
    if (gm && g.autoscroll && g.moved) {
      const vx = edgeScrollSpeed(last.cx, gm.r.left + HEADER_W, gm.r.right);
      const vy = g.vertical ? edgeScrollSpeed(last.cy, gm.r.top + RULER_H, gm.r.bottom) : 0;
      if (vx !== 0 || vy !== 0) {
        gm.el.scrollLeft += vx * dt;
        gm.el.scrollTop += vy * dt;
        apply();
      }
    }
    raf = requestAnimationFrame(tick);
  }

  function onMove(e: PointerEvent) {
    if (!g) return;
    last = { cx: e.clientX, cy: e.clientY, mods: modsOf(e) };
    apply();
  }

  /* ---------------------------------------------------------------- apply (move) ------- */
  function apply() {
    if (!g) return;
    const { cx, cy, mods } = last;
    const gm = geom();
    if (!g.moved) {
      const dx = cx - g.startCX + ((gm?.el.scrollLeft ?? 0) - g.startScrollL);
      const dy = cy - g.startCY;
      if (g.kind !== 'scrub' && Math.hypot(dx, dy) < 3) return;
      g.moved = true;
    }
    const s = S();
    const px = s.pxPerSec;
    const fps = s.project.canvas.fps;
    switch (g.kind) {
      case 'scrub': {
        scrubTo(g, cx, mods, s.snapEnabled);
        break;
      }
      case 'move': {
        if (!g.enabled) return;
        const dxPx = cx - g.startCX + ((gm?.el.scrollLeft ?? 0) - g.startScrollL);
        const deltaSec = Math.round((dxPx / px) * fps) / fps;
        const pt = contentPt(cx, cy);
        const layout = layoutFor(s.project.tracks);
        const row = pt.y >= 0 ? trackAtY(layout, pt.y) : null;
        const preview = s.previewMove(g.ids, deltaSec, row ? row.trackId : null, {
          pxPerSec: px,
          snap: mods.mod ? false : undefined,
        });
        g.preview = preview;
        const mv = g;
        const ghosts = preview.moves.map((m) => {
          const meta = mv.meta.get(m.itemId);
          return {
            itemId: m.itemId,
            trackId: m.trackId,
            startSec: m.startSec,
            durationSec: meta?.durationSec ?? 1,
            type: meta?.type ?? ('video' as const),
          };
        });
        const primary = preview.moves.find((m) => m.itemId === mv.itemId) ?? preview.moves[0];
        UI().set({
          ghosts,
          ghostValid: preview.valid,
          guide:
            preview.snappedTo !== null ? { t: preview.snappedTo, kind: preview.snapKind } : null,
          dragLabel: primary ? { x: cx, y: cy, text: formatTimecode(primary.startSec, fps) } : null,
        });
        break;
      }
      case 'trim': {
        const raw = snapToFrame(secAt(cx) - g.grab, fps);
        // the store owns the snapping rules (items, playhead, markers, beats, grid): ask it where this edge would land
        const pv = s.previewTrim(g.itemId, g.edge, raw, {
          snap: mods.mod ? false : undefined,
          pxPerSec: px,
          roll: mods.alt,
        });
        const res = clampTrim(g.item, g.asset, g.edge, pv.sec, fps);
        g.result = res;
        g.mods = mods;
        const ripple = s.rippleEnabled !== mods.shift;
        const edgeT = g.edge === 'start' ? res.startSec : endOf(res);
        UI().set({
          trim: {
            itemId: g.itemId,
            edge: g.edge,
            startSec: res.startSec,
            durationSec: res.durationSec,
          },
          guide:
            pv.snappedTo !== null && Math.abs(pv.snappedTo - edgeT) < 1e-6
              ? { t: pv.snappedTo, kind: pv.snapKind }
              : null,
          dragLabel: {
            x: cx,
            y: cy,
            text: `${formatTimecode(edgeT, fps)}${mods.alt ? '  ·  Roll' : ripple ? '  ·  Ripple' : ''}`,
          },
        });
        break;
      }
      case 'marker': {
        let t = snapToFrame(secAt(cx) - g.grab, fps);
        let guide: { t: number; kind: SnapPoint['kind'] } | null = null;
        if (s.snapEnabled && !mods.mod) {
          const sn = snapValue(t, g.pts, SNAP_PX / px);
          if (sn) {
            t = sn.t;
            guide = { t: sn.t, kind: sn.kind };
          }
        }
        g.at = t;
        UI().set({
          markerDrag: { id: g.id, atSec: t },
          guide,
          dragLabel: { x: cx, y: cy, text: formatTimecode(t, fps) },
        });
        break;
      }
      case 'kf': {
        const local = Math.max(
          0,
          Math.min(g.item.durationSec, snapToFrame(secAt(cx) - g.item.startSec, fps)),
        );
        g.t = local;
        UI().set({
          kfDrag: { itemId: g.itemId, path: g.path, index: g.index, t: local },
          dragLabel: { x: cx, y: cy, text: `${local.toFixed(2)} s` },
        });
        break;
      }
      case 'marquee': {
        const a = {
          x: g.startCX - (gm?.r.left ?? 0) - HEADER_W + g.startScrollL,
          y: g.startCY - (gm?.r.top ?? 0) + g.startScrollT - RULER_H,
        };
        const b = contentPt(cx, cy);
        const rect = normRect(a, { x: Math.max(0, b.x), y: Math.max(0, b.y) });
        const layout = layoutFor(s.project.tracks);
        const hits = marqueeHits(rect, layout, s.project.tracks, px);
        const ids = g.additive ? Array.from(new Set([...g.base, ...hits])) : hits;
        const key = ids.join('|');
        if (key !== g.last) {
          g.last = key;
          s.select(ids, 'replace');
        }
        UI().set({ marquee: rect });
        break;
      }
      case 'reorder': {
        const pt = contentPt(cx, cy);
        const layout = layoutFor(s.project.tracks);
        const row = trackAtY(layout, Math.max(0, pt.y));
        const valid = !!row && row.trackId !== g.trackId && row.section === g.section;
        UI().set({ reorder: { trackId: g.trackId, overTrackId: row?.trackId ?? null, valid } });
        break;
      }
    }
  }

  function scrubTo(gs: Extract<Gesture, { kind: 'scrub' }>, cx: number, mods: Mods, snap: boolean) {
    const s = S();
    const px = s.pxPerSec;
    let t = snapToFrame(secAt(cx), s.project.canvas.fps);
    let guide: { t: number; kind: SnapPoint['kind'] } | null = null;
    if (snap && !mods.mod) {
      const sn = snapValue(t, gs.pts, SNAP_PX / px);
      if (sn) {
        t = sn.t;
        guide = { t: sn.t, kind: sn.kind };
      }
    }
    UI().set({ guide, scrubbing: true });
    if (t !== s.playheadSec) {
      s.setPlayhead(t);
      getEngine()?.scrub(t);
    }
  }

  /* ---------------------------------------------------------------- release ------------ */
  function onUp(e: PointerEvent) {
    if (!g) return;
    last = { cx: e.clientX, cy: e.clientY, mods: modsOf(e) };
    const gs = g;
    const s = S();
    // flush the final pointer position into the preview
    if (gs.moved) apply();
    const mods = last.mods;
    switch (gs.kind) {
      case 'move': {
        if (gs.moved && gs.enabled) {
          const p = gs.preview;
          if (p && p.valid && p.moves.length) s.applyMoves(p.moves, { ripple: s.rippleEnabled });
        } else if (!gs.moved && gs.collapseOnClick) {
          s.select([gs.itemId], 'replace');
        }
        break;
      }
      case 'trim': {
        if (gs.moved && gs.result) {
          const to = gs.edge === 'start' ? gs.result.startSec : endOf(gs.result);
          s.trim(gs.itemId, gs.edge, to, {
            snap: false,
            ripple: s.rippleEnabled !== mods.shift,
            roll: mods.alt,
          });
        }
        break;
      }
      case 'marker': {
        if (gs.moved) {
          if (Math.abs(gs.at - gs.orig) > 1e-6) s.updateMarker(gs.id, { atSec: gs.at });
        } else {
          s.setPlayhead(gs.orig);
        }
        break;
      }
      case 'kf': {
        if (gs.moved && Math.abs(gs.t - gs.startT) > 1e-6)
          s.moveKeyframe(gs.itemId, gs.path as AnimatedPath, gs.index, gs.t, gs.value);
        break;
      }
      case 'marquee': {
        if (!gs.moved && !gs.additive) s.clearSelection();
        break;
      }
      case 'reorder': {
        const r = UI().reorder;
        if (gs.moved && r?.valid && r.overTrackId) {
          const row = layoutFor(s.project.tracks).byId.get(r.overTrackId);
          if (row) s.moveTrack(gs.trackId, row.arrayIndex);
        }
        break;
      }
      case 'scrub':
        break;
    }
    end();
  }

  /* ---------------------------------------------------------------- pointerdown router - */
  function pointerDown(e: PointerEvent, target: Element) {
    if (e.button !== 0 || g) return;
    if (target.closest('input, textarea, select, [data-no-drag], [role=slider]')) return;
    const s = S();
    const ui = UI();
    const mods = modsOf(e);
    const base = { e };

    const markerEl = target.closest<HTMLElement>('[data-marker-id]');
    if (markerEl) {
      const id = markerEl.dataset.markerId ?? '';
      const m = s.project.markers.find((x) => x.id === id);
      if (!m) return;
      begin(
        { ...base, vertical: false, autoscroll: true },
        {
          kind: 'marker',
          id,
          orig: m.atSec,
          grab: secAt(e.clientX) - m.atSec,
          at: m.atSec,
          pts: collectSnapPoints(
            { ...s.project, markers: s.project.markers.filter((x) => x.id !== id) },
            s.playheadSec,
          ),
        },
      );
      return;
    }

    const kfEl = target.closest<HTMLElement>('[data-kf]');
    if (kfEl) {
      const itemId = kfEl.dataset.itemId ?? '';
      const path = (kfEl.dataset.path ?? '') as KfPath;
      const index = Number(kfEl.dataset.index ?? 0);
      const found = findItemById(s.project.tracks, itemId);
      if (!found) return;
      s.selectKeyframe({ itemId, prop: path, index });
      const t0 = Number(kfEl.dataset.t ?? 0);
      const v = keyframeValue(found, path, index);
      begin(
        { ...base, vertical: false, autoscroll: true },
        {
          kind: 'kf',
          itemId,
          path,
          index,
          value: v,
          startT: t0,
          grab: secAt(e.clientX) - found.startSec - t0,
          t: t0,
          item: found,
        },
      );
      return;
    }

    if (target.closest('[data-transition]')) return;

    const trimEl = target.closest<HTMLElement>('[data-trim]');
    if (trimEl) {
      const itemId = trimEl.dataset.itemId ?? '';
      const item = findItemById(s.project.tracks, itemId);
      if (!item) return;
      if (!s.selection.itemIds.includes(itemId)) s.select([itemId], 'replace');
      const asset =
        'assetId' in item ? s.project.assets.find((a) => a.id === item.assetId) : undefined;
      begin(
        { ...base, vertical: false, autoscroll: true },
        {
          kind: 'trim',
          itemId,
          edge: trimEl.dataset.trim === 'end' ? 'end' : 'start',
          item,
          asset,
          grab: secAt(e.clientX) - (trimEl.dataset.trim === 'end' ? item.startSec + item.durationSec : item.startSec),
          result: null,
          mods,
        },
      );
      return;
    }

    const gripEl = target.closest<HTMLElement>('[data-track-grip]');
    if (gripEl) {
      const trackId = gripEl.dataset.trackGrip ?? '';
      const track = s.project.tracks.find((t) => t.id === trackId);
      if (!track) return;
      s.selectTrack(trackId);
      ui.set({ reorder: { trackId, overTrackId: null, valid: false } });
      begin(
        { ...base, vertical: true, autoscroll: true },
        { kind: 'reorder', trackId, section: sectionOf(track.kind) },
      );
      return;
    }

    const itemEl = target.closest<HTMLElement>('[data-item-id][role=option]');
    if (itemEl) {
      const itemId = itemEl.dataset.itemId ?? '';
      const trackId = itemEl.dataset.trackId ?? '';
      if (ui.tool === 'razor') {
        const sec = razorTime(e.clientX, itemId);
        s.selectTrack(trackId);
        s.split(itemId, sec);
        return;
      }
      const item = findItemById(s.project.tracks, itemId);
      const track = s.project.tracks.find((t) => t.id === trackId);
      s.selectTrack(trackId);
      const selected = s.selection.itemIds.includes(itemId);
      if (mods.shift || mods.mod) {
        s.select([itemId], 'toggle');
        // a toggled-off item must not start a drag
        if (selected) return;
      } else if (!selected) {
        s.select([itemId], 'replace');
      }
      const after = S().selection.itemIds;
      if (!after.includes(itemId)) return;
      const ids = [itemId, ...after.filter((x) => x !== itemId)];
      const meta = new Map<string, { type: Item['type']; durationSec: number }>();
      for (const t of S().project.tracks)
        for (const it of t.items)
          if (ids.includes(it.id)) meta.set(it.id, { type: it.type, durationSec: it.durationSec });
      const enabled = !(item?.locked || track?.locked);
      begin(
        { ...base, vertical: true, autoscroll: true },
        {
          kind: 'move',
          itemId,
          ids,
          meta,
          collapseOnClick: selected && !mods.shift && !mods.mod && after.length > 1,
          preview: null,
          enabled,
        },
      );
      return;
    }

    if (target.closest('[data-ruler]')) {
      if (s.playing) s.pause();
      ui.set({ scrubbing: true });
      const pts = collectSnapPoints(s.project, s.playheadSec).filter((p) => p.kind !== 'playhead');
      begin({ ...base, vertical: false, autoscroll: true }, { kind: 'scrub', pts });
      // act on the press itself, not only on movement
      const gs = g as Gesture | null;
      if (gs && gs.kind === 'scrub') scrubTo(gs, e.clientX, mods, s.snapEnabled);
      return;
    }

    const laneEl = target.closest<HTMLElement>('[data-lane]');
    if (laneEl) {
      const trackId = laneEl.dataset.trackId ?? null;
      const additive = mods.shift || mods.mod;
      s.selectTrack(trackId);
      if (!additive) s.select([], 'replace');
      begin(
        { ...base, vertical: true, autoscroll: true },
        { kind: 'marquee', base: additive ? [...s.selection.itemIds] : [], additive, last: '' },
      );
    }
  }

  /** Razor time under the pointer: frame-quantised and snapped to the playhead / clip edges. */
  function razorTime(cx: number, itemId: string): number {
    const s = S();
    const px = s.pxPerSec;
    let t = snapToFrame(secAt(cx), s.project.canvas.fps);
    if (s.snapEnabled) {
      const sn = snapValue(
        t,
        collectSnapPoints(s.project, s.playheadSec, { exclude: new Set([itemId]) }),
        SNAP_PX / px,
      );
      if (sn) t = sn.t;
    }
    return t;
  }

  function hover(e: PointerEvent, target: Element) {
    if (g) return;
    const ui = UI();
    if (ui.tool !== 'razor') {
      if (ui.razor) ui.set({ razor: null });
      return;
    }
    const itemEl = target.closest<HTMLElement>('[data-item-id][role=option]');
    if (!itemEl) {
      if (ui.razor) ui.set({ razor: null });
      return;
    }
    const sec = razorTime(e.clientX, itemEl.dataset.itemId ?? '');
    ui.set({ razor: { trackId: itemEl.dataset.trackId ?? '', sec } });
  }

  return {
    pointerDown,
    hover,
    cancel: () => {
      if (g) end();
    },
    active: () => g !== null,
    dispose: () => {
      if (g) end();
    },
  };
}

/* ------------------------------------------------------------------ small lookups ----------- */
function findItemById(tracks: readonly Track[], id: string): Item | null {
  for (const t of tracks) for (const it of t.items) if (it.id === id) return it;
  return null;
}

function keyframeValue(item: Item, path: KfPath, index: number): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dotted-path read over the discriminated union
  const o = item as any;
  const [a, b] = path.split('.') as [string, string | undefined];
  const node = b ? o[a]?.[b] : o[a];
  return (node?.kf?.[index]?.v as number | undefined) ?? 0;
}
