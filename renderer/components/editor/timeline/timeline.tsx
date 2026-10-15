'use client';

import './timeline.css';
import * as React from 'react';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { TRACK_ACCEPTS, type ItemType, type Track } from '@shared/editor';
import { projectDuration } from '@shared/editor-eval';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tip } from '@/components/ui/tooltip';
import { useEditorStore } from '@/lib/editor/core';
import {
  ASSET_MIME,
  TRANSITION_MIME,
  parseAssetDrag,
  parseTransitionDrag,
} from '@/lib/editor-panels/drag';
import { cn } from '@/lib/utils';
import { ContextMenu, type MenuEntry, type MenuState } from './context-menu';
import { syncEngineBinding, unbindEngine } from './engine-cache';
import {
  HEADER_W,
  NEW_TRACK_ZONE_H,
  RULER_H,
  SNAP_PX,
  TRACK_KIND_LABEL,
  collectSnapPoints,
  renderWindow,
  resolveDropTarget,
  resolveTransitionTarget,
  snapToFrame,
  snapValue,
  newTrackKindForAsset,
  wheelZoomFactor,
} from './geometry';
import { createGestures, layoutFor, type GestureController } from './gestures';
import { handleItemKey, setKeyboardModality } from './keyboard-nav';
import { ADD_TRACK_KINDS, itemMenu, laneMenu, markerMenu, trackMenu } from './menus';
import {
  DragLabel,
  DropHint,
  Ghosts,
  TransitionDropTarget,
  MarqueeBox,
  RazorLine,
  ReorderLine,
  SnapGuide,
  TrimGhost,
} from './overlays';
import { PlayheadLine, Ruler } from './ruler';
import { TimelineToolbar, zoomTo } from './toolbar';
import { TrackHeader, TRACK_ICON } from './track-header';
import { TrackLane } from './track-lane';
import { useTimelineUi } from './timeline-ui';

export const ASSET_DRAG_MIME = ASSET_MIME;

const S = () => useEditorStore.getState();

/** Which item type does an asset become on the timeline? */
const itemTypeForAsset = (kind: 'video' | 'audio' | 'image' | 'lut'): ItemType | null =>
  kind === 'video' ? 'video' : kind === 'audio' ? 'audio' : kind === 'image' ? 'image' : null;

function AddTrackButton() {
  return (
    <DropdownMenu>
      <Tip content="Add a track">
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="xs"
            className="h-6 gap-1 px-1.5 text-xs"
            aria-label="Add track"
            data-testid="add-track"
          >
            <Plus className="size-3.5" /> Track
          </Button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="start" className="min-w-48" data-testid="add-track-menu">
        {ADD_TRACK_KINDS.map((k) => {
          const Icon = TRACK_ICON[k];
          return (
            <DropdownMenuItem key={k} onSelect={() => S().addTrack(k)}>
              <Icon /> {TRACK_KIND_LABEL[k]} track
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The multi-track timeline. Layout: one native scroller (so trackpad inertia, scrollbars and wheel behave) holding a
 * sticky ruler row and one row per track (sticky header + lane). Only the items inside the render window are mounted.
 */
export function Timeline({ className }: { className?: string }) {
  const scrollerRef = React.useRef<HTMLDivElement>(null);
  const gesturesRef = React.useRef<GestureController | null>(null);
  React.useEffect(() => {
    const g = createGestures(() => scrollerRef.current);
    gesturesRef.current = g;
    return () => {
      g.dispose();
      gesturesRef.current = null;
    };
  }, []);

  const tracks = useEditorStore((s) => s.project.tracks);
  const assets = useEditorStore((s) => s.project.assets);
  const pxPerSec = useEditorStore((s) => s.pxPerSec);
  const selectedArr = useEditorStore((s) => s.selection.itemIds);
  const selTrackId = useEditorStore((s) => s.selection.trackId);
  const viewportPx = useTimelineUi((s) => s.viewportPx);
  const tool = useTimelineUi((s) => s.tool);
  const moving = useTimelineUi((s) => s.ghosts !== null);
  const ghostEnd = useTimelineUi((s) =>
    s.ghosts ? Math.ceil(Math.max(...s.ghosts.map((g) => g.startSec + g.durationSec)) / 5) * 5 : 0,
  );
  const reorder = useTimelineUi((s) => s.reorder);
  const drop = useTimelineUi((s) => s.drop);
  const setUi = useTimelineUi((s) => s.set);

  const viewportSec = Math.max(viewportPx, 100) / pxPerSec;
  const chunk = viewportSec * 0.5;
  const chunkIdx = useEditorStore((s) => Math.floor(s.scrollSec / chunk));
  const win = React.useMemo(
    () => renderWindow(chunkIdx * chunk, viewportSec),
    [chunkIdx, chunk, viewportSec],
  );

  const layout = React.useMemo(() => layoutFor(tracks), [tracks]);
  const assetMap = React.useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);
  const selected = React.useMemo(() => new Set(selectedArr), [selectedArr]);
  const duration = React.useMemo(() => projectDuration({ tracks }), [tracks]);
  const contentSec = Math.max(duration, ghostEnd) + Math.max(viewportSec * 0.6, 8);
  const contentW = Math.ceil(Math.max(contentSec, viewportSec) * pxPerSec);
  const totalH = RULER_H + layout.height + NEW_TRACK_ZONE_H;
  const itemCount = React.useMemo(() => tracks.reduce((n, t) => n + t.items.length, 0), [tracks]);

  const [menu, setMenu] = React.useState<MenuState | null>(null);
  const closeMenu = React.useCallback(() => setMenu(null), []);
  const openMenu = React.useCallback(
    (e: { clientX: number; clientY: number }, label: string, entries: MenuEntry[]) => {
      setMenu({ x: e.clientX, y: e.clientY, label, entries });
    },
    [],
  );

  /* ---- keyboard modality (Tab = keyboard reached the clips) ---------------------------- */
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab') setKeyboardModality(true);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  /* ---- fit the whole project into view when it is opened ------------------------------- */
  const projectId = useEditorStore((s) => s.projectId);
  React.useEffect(() => {
    if (!projectId) return;
    const s = S();
    if (projectDuration(s.project) > 0) s.zoomToFit(useTimelineUi.getState().viewportPx);
  }, [projectId]);

  /* ---- viewport size ------------------------------------------------------------------ */
  React.useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const measure = () => {
      const w = Math.max(100, el.clientWidth - HEADER_W);
      setUi({ viewportPx: w, viewportH: el.clientHeight });
      S().setViewportPx(w);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [setUi]);

  /* ---- playback engine caches (waveforms / thumbnails) -------------------------------- */
  React.useEffect(() => {
    syncEngineBinding();
    const id = window.setInterval(syncEngineBinding, 500);
    return () => {
      window.clearInterval(id);
      unbindEngine();
    };
  }, []);

  /* ---- scroll: DOM <-> store ---------------------------------------------------------- */
  const programmatic = React.useRef<number | null>(null);
  const lastUserScroll = React.useRef(0);
  const applyScroll = React.useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const s = S();
    const target = Math.max(0, s.scrollSec * s.pxPerSec);
    if (Math.abs(el.scrollLeft - target) > 0.75) {
      programmatic.current = target;
      el.scrollLeft = target;
      requestAnimationFrame(() => {
        programmatic.current = null;
      });
    }
  }, []);
  React.useLayoutEffect(() => {
    applyScroll();
  }, [pxPerSec, contentW, applyScroll]);
  React.useEffect(
    () =>
      useEditorStore.subscribe((s, p) => {
        if (s.scrollSec !== p.scrollSec && s.pxPerSec === p.pxPerSec) applyScroll();
      }),
    [applyScroll],
  );
  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (programmatic.current !== null && Math.abs(el.scrollLeft - programmatic.current) < 1.5)
      return;
    const s = S();
    if (!gesturesRef.current?.active()) lastUserScroll.current = performance.now();
    const sec = el.scrollLeft / s.pxPerSec;
    if (Math.abs(sec - s.scrollSec) * s.pxPerSec > 0.5) s.setScroll(sec);
  };

  /* ---- follow / reveal the playhead --------------------------------------------------- */
  React.useEffect(
    () =>
      useEditorStore.subscribe((s, p) => {
        if (s.playheadSec === p.playheadSec) return;
        const ui = useTimelineUi.getState();
        if (ui.scrubbing || gesturesRef.current?.active()) return;
        const vs = ui.viewportPx / s.pxPerSec;
        const t = s.playheadSec;
        if (s.playing) {
          if (performance.now() - lastUserScroll.current < 1500) return;
          if (t > s.scrollSec + vs * 0.92 || t < s.scrollSec)
            s.setScroll(Math.max(0, t - vs * 0.08));
        } else if (t < s.scrollSec || t > s.scrollSec + vs) {
          s.setScroll(Math.max(0, t - vs / 2));
        }
      }),
    [],
  );

  /* ---- zoom ----------------------------------------------------------------------------- */
  const anchorForButtons = React.useCallback(() => {
    const s = S();
    const vs = useTimelineUi.getState().viewportPx / s.pxPerSec;
    return s.playheadSec >= s.scrollSec && s.playheadSec <= s.scrollSec + vs
      ? s.playheadSec
      : s.scrollSec + vs / 2;
  }, []);
  const zoomBy = React.useCallback(
    (factor: number) => zoomTo(S().pxPerSec * factor, anchorForButtons()),
    [anchorForButtons],
  );
  const fit = React.useCallback(() => {
    S().zoomToFit(useTimelineUi.getState().viewportPx);
  }, []);

  React.useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const s = S();
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const r = el.getBoundingClientRect();
        const inLane = e.clientX - r.left >= HEADER_W;
        const anchor = inLane
          ? s.scrollSec + (e.clientX - r.left - HEADER_W) / s.pxPerSec
          : anchorForButtons();
        zoomTo(s.pxPerSec * wheelZoomFactor(e.deltaY), anchor);
        return;
      }
      lastUserScroll.current = performance.now();
      // nothing to scroll vertically: let the wheel pan the timeline horizontally
      if (el.scrollHeight <= el.clientHeight + 1 && Math.abs(e.deltaX) < Math.abs(e.deltaY)) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [anchorForButtons]);

  /* ---- pointer / keyboard / menus ------------------------------------------------------ */
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    setKeyboardModality(false);
    if (menu) setMenu(null);
    gesturesRef.current?.pointerDown(e.nativeEvent, e.target as Element);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) =>
    gesturesRef.current?.hover(e.nativeEvent, e.target as Element);

  const secFromClient = (clientX: number) => {
    const el = scrollerRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return Math.max(0, (clientX - r.left - HEADER_W + el.scrollLeft) / S().pxPerSec);
  };

  const onContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as Element;
    if (target.closest('input, textarea')) return;
    e.preventDefault();
    const s = S();
    const itemEl = target.closest<HTMLElement>('[data-item-id][role=option]');
    if (itemEl) {
      const id = itemEl.dataset.itemId ?? '';
      if (!s.selection.itemIds.includes(id)) s.select([id], 'replace');
      s.selectTrack(itemEl.dataset.trackId ?? null);
      openMenu(e, 'Clip actions', itemMenu());
      return;
    }
    if (target.closest('[data-ruler]')) {
      openMenu(e, 'Ruler actions', [
        {
          kind: 'item',
          id: 'marker',
          label: 'Add marker here',
          keys: ['M'],
          onSelect: () =>
            void S().addMarker(snapToFrame(secFromClient(e.clientX), S().project.canvas.fps)),
        },
      ]);
      return;
    }
    const laneEl = target.closest<HTMLElement>('[data-lane]');
    if (laneEl) {
      const trackId = laneEl.dataset.trackId ?? null;
      s.selectTrack(trackId);
      openMenu(
        e,
        'Track actions',
        laneMenu(trackId, snapToFrame(secFromClient(e.clientX), s.project.canvas.fps)),
      );
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      const el = (e.target as Element).closest<HTMLElement>('[data-item-id][role=option]');
      if (el) {
        e.preventDefault();
        const r = el.getBoundingClientRect();
        const id = el.dataset.itemId ?? '';
        if (!S().selection.itemIds.includes(id)) S().select([id], 'replace');
        setMenu({ x: r.left + 12, y: r.bottom - 6, label: 'Clip actions', entries: itemMenu() });
        return;
      }
    }
    handleItemKey(e, scrollerRef.current);
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = (e.target as Element).closest<HTMLElement>('[data-type=subtitle][data-item-id]');
    if (el && !(e.target as Element).closest('input'))
      setUi({ editingCueId: el.dataset.itemId ?? null });
  };

  /* ---- drag & drop from the media bin / OS -------------------------------------------- */
  const dropAt = (e: React.DragEvent) => {
    const el = scrollerRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const s = S();
    const px = s.pxPerSec;
    let sec = snapToFrame(
      Math.max(0, (e.clientX - r.left - HEADER_W + el.scrollLeft) / px),
      s.project.canvas.fps,
    );
    if (s.snapEnabled) {
      const sn = snapValue(sec, collectSnapPoints(s.project, s.playheadSec), SNAP_PX / px);
      if (sn) sec = sn.t;
    }
    const y = e.clientY - r.top + el.scrollTop - RULER_H;
    return { sec, target: resolveDropTarget(layoutFor(s.project.tracks), y) };
  };
  const hasType = (e: React.DragEvent, mime: string) =>
    Array.from(e.dataTransfer.types).includes(mime);
  const hasAssetPayload = (e: React.DragEvent) => hasType(e, ASSET_MIME);
  const hasTransitionPayload = (e: React.DragEvent) => hasType(e, TRANSITION_MIME);
  const hasFiles = (e: React.DragEvent) => hasType(e, 'Files');
  const transitionTargetAt = (e: React.DragEvent) => {
    const el = scrollerRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const s = S();
    const sec = (e.clientX - r.left - HEADER_W + el.scrollLeft) / s.pxPerSec;
    const y = e.clientY - r.top + el.scrollTop - RULER_H;
    const layout = layoutFor(s.project.tracks);
    const t = resolveDropTarget(layout, y);
    if (t.kind !== 'track') return null;
    const track = s.project.tracks[t.row.arrayIndex];
    if (!track || track.locked) return null;
    const found = resolveTransitionTarget(track, sec, s.pxPerSec);
    return found ? { ...found, trackId: track.id } : null;
  };
  const onDragOver = (e: React.DragEvent) => {
    if (hasTransitionPayload(e)) {
      e.preventDefault();
      const found = transitionTargetAt(e);
      e.dataTransfer.dropEffect = found ? 'copy' : 'none';
      const cur = useTimelineUi.getState().dropTransition;
      const next = found
        ? {
            itemId: found.target.id,
            trackId: found.trackId,
            startSec: found.target.startSec,
            durationSec: found.target.durationSec,
          }
        : null;
      if (cur?.itemId !== next?.itemId) setUi({ dropTransition: next, drop: null });
      return;
    }
    if (!hasAssetPayload(e) && !hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = hasAssetPayload(e) ? 'copy' : 'none';
    const at = dropAt(e);
    if (!at) return;
    const trackId = at.target.kind === 'track' ? at.target.row.trackId : null;
    const newTrack = at.target.kind === 'new-track';
    const cur = useTimelineUi.getState().drop;
    if (!cur || cur.sec !== at.sec || cur.trackId !== trackId || cur.newTrack !== newTrack)
      setUi({ drop: { sec: at.sec, trackId, newTrack } });
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (!scrollerRef.current?.contains(e.relatedTarget as Node | null))
      setUi({ drop: null, dropTransition: null });
  };
  const onDrop = (e: React.DragEvent) => {
    if (hasTransitionPayload(e)) {
      e.preventDefault();
      setUi({ drop: null, dropTransition: null });
      const payload = parseTransitionDrag(e.dataTransfer.getData(TRANSITION_MIME));
      const found = transitionTargetAt(e);
      if (!payload) return;
      if (!found) {
        toast.info('A transition needs two neighbouring clips on the same track.');
        return;
      }
      const dur = Math.max(
        0.05,
        Math.min(0.5, found.target.durationSec / 2, found.previous.durationSec / 2),
      );
      S().setTransition(found.target.id, {
        type: payload.type,
        durationSec: Math.round(dur * 100) / 100,
      });
      S().select([found.target.id], 'replace');
      return;
    }
    const hasAsset = hasAssetPayload(e);
    if (!hasAsset && !hasFiles(e)) return;
    e.preventDefault();
    setUi({ drop: null });
    if (!hasAsset) {
      toast.info('Import files with the Media bin, then drag them onto a track.');
      return;
    }
    const parsed = parseAssetDrag(e.dataTransfer.getData(ASSET_MIME));
    const assetId = parsed?.assetId ?? null;
    const s = S();
    const asset = assetId ? s.project.assets.find((a) => a.id === assetId) : undefined;
    const at = dropAt(e);
    if (!asset || !at || !assetId) {
      toast.error('That media is not part of this project.');
      return;
    }
    const type = itemTypeForAsset(asset.kind);
    if (!type) {
      toast.error('This kind of file cannot be placed on the timeline.');
      return;
    }
    let trackId: string | null = null;
    if (at.target.kind === 'track') {
      const tr = s.project.tracks[at.target.row.arrayIndex];
      if (tr?.locked) {
        toast.warning(`${tr.name} is locked.`);
        return;
      }
      if (tr && TRACK_ACCEPTS[tr.kind].includes(type)) trackId = tr.id;
    } else if (at.target.kind === 'new-track') {
      trackId = s.addTrack(newTrackKindForAsset(asset.kind));
    }
    const id = s.addAsset(assetId, { trackId, startSec: at.sec });
    if (id) S().select([id], 'replace');
  };

  /* ---- render ------------------------------------------------------------------------- */
  const onTrackMenu = React.useCallback(
    (e: React.MouseEvent, track: Track) => {
      e.preventDefault();
      S().selectTrack(track.id);
      openMenu(e, `${track.name} track actions`, trackMenu(track));
    },
    [openMenu],
  );
  const onMarkerMenu = React.useCallback(
    (e: React.MouseEvent, m: Parameters<typeof markerMenu>[0]) => {
      e.preventDefault();
      e.stopPropagation();
      openMenu(e, 'Marker actions', markerMenu(m));
    },
    [openMenu],
  );

  return (
    <div
      className={cn('tl-root flex min-h-0 flex-col bg-background', className)}
      data-testid="timeline"
      data-tool={tool}
      data-moving={moving || undefined}
    >
      <TimelineToolbar zoomBy={zoomBy} fit={fit} />
      <div
        ref={scrollerRef}
        role="region"
        aria-label="Timeline"
        data-testid="timeline-scroller"
        className="scrollbar-thin relative min-h-0 flex-1 overflow-auto"
        onScroll={onScroll}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerLeave={() => useTimelineUi.getState().razor && setUi({ razor: null })}
        onContextMenu={onContextMenu}
        onKeyDown={onKeyDown}
        onDoubleClick={onDoubleClick}
        onDragOver={onDragOver}
        onDragEnter={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <div
          className="relative"
          style={{ width: HEADER_W + contentW, height: totalH, minHeight: '100%' }}
          data-testid="timeline-content"
        >
          <Ruler
            contentW={contentW}
            win={win}
            corner={<AddTrackButton />}
            onMarkerContextMenu={onMarkerMenu}
          />
          {layout.rows.map((row, i) => {
            const track = tracks[row.arrayIndex];
            if (!track) return null;
            const reorderState =
              reorder?.trackId === track.id
                ? 'dragging'
                : reorder?.overTrackId === track.id
                  ? reorder.valid
                    ? 'over-ok'
                    : 'over-bad'
                  : null;
            return (
              <div
                key={track.id}
                className="absolute left-0 flex"
                style={{ top: RULER_H + row.top, width: HEADER_W + contentW, height: row.height }}
                data-testid="track-row"
                data-track-id={track.id}
                data-kind={track.kind}
              >
                <TrackHeader
                  track={track}
                  row={row}
                  selected={selTrackId === track.id}
                  reorderState={reorderState}
                  onContextMenu={onTrackMenu}
                />
                <TrackLane
                  track={track}
                  row={row}
                  alt={i % 2 === 1}
                  contentW={contentW}
                  pxPerSec={pxPerSec}
                  win={win}
                  assets={assetMap}
                  selectedIds={selected}
                  selectionCount={selectedArr.length}
                  dropTarget={drop?.trackId === track.id}
                />
              </div>
            );
          })}
          {itemCount === 0 ? (
            <div
              className="pointer-events-none absolute z-[5] flex items-center justify-center text-center text-sm text-subtle"
              style={{
                left: HEADER_W,
                top: RULER_H,
                width: viewportPx,
                height: Math.max(layout.height, 120),
              }}
            >
              <p className="max-w-sm rounded-lg border border-dashed border-border-strong bg-background/70 px-4 py-3">
                Drag media from the Media bin onto a track to start cutting.
              </p>
            </div>
          ) : null}
          <PlayheadLine height={RULER_H + layout.height + NEW_TRACK_ZONE_H} />
          <SnapGuide height={layout.height + NEW_TRACK_ZONE_H} />
          <Ghosts layout={layout} />
          <TrimGhost layout={layout} />
          <TransitionDropTarget layout={layout} />
          <MarqueeBox />
          <DropHint layout={layout} bottom={layout.height + NEW_TRACK_ZONE_H} />
          <RazorLine layout={layout} />
          <ReorderLine layout={layout} />
        </div>
      </div>
      <DragLabel />
      <ContextMenu menu={menu} onClose={closeMenu} />
    </div>
  );
}
