'use client';

import * as React from 'react';
import { TriangleAlert } from 'lucide-react';
import { SAFE_AREAS } from '@shared/editor';
import { findItem } from '@shared/editor-eval';
import type { Compositor } from '@/lib/editor/compositor/api';
import { cn } from '@/lib/utils';
import { createCompositor, forwardKey, useEditorStore } from '@/lib/editor/playback/link';
import { createPlaybackEngine, getEngine } from '@/lib/editor/playback/registry';
import type { AssetStatus } from '@/lib/editor/playback/pool';
import type { PlaybackEngineExt } from '@/lib/editor/playback/types';
import { relevantAssets, summarizeStatuses } from './assets-status';
import { InlineTextEditor } from './inline-text-editor';
import { fitPreview, formatTimecode, quadBounds, type FitResult } from './layout';
import { PreviewOverlay, type SelectionOverlay } from './overlay';
import { PreviewError, PreviewLoading } from './status-layers';
import { useTransformInteraction } from './use-transform-interaction';

/**
 * The preview panel. Owns the preview <canvas> (a fresh element per mount, so React StrictMode's double effect can't hit a
 * canvas whose GL context was disposed), sizes it to the container with the project's aspect (letterboxed on the panel's
 * token background), keeps the drawing buffer at proxy resolution, and layers the transparent DOM/SVG overlay on top:
 * safe-area guides, grid, transform handles, snap guides, inline text editing, loading / error states, timecode.
 */
const PAD_CSS = 12;
/** Long side of the drawing buffer is capped here: the picture is composited at proxy resolution and CSS-scaled up. */
const MAX_BUFFER_LONG = 960;

export function PreviewPlayer({ className }: { className?: string }) {
  const projectId = useEditorStore((s) => s.projectId);
  const canvasW = useEditorStore((s) => s.project.canvas.width);
  const canvasH = useEditorStore((s) => s.project.canvas.height);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const canvasHostRef = React.useRef<HTMLDivElement>(null);
  const surfaceRef = React.useRef<HTMLDivElement>(null);
  const [box, setBox] = React.useState({ w: 0, h: 0 });
  const [dpr, setDpr] = React.useState(1);
  const [engine, setEngine] = React.useState<PlaybackEngineExt | null>(null);
  const [compositor, setCompositor] = React.useState<Compositor | null>(null);
  const [glError, setGlError] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState<string | null>(null);

  /* ---- container size + devicePixelRatio ---- */
  React.useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const read = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  React.useEffect(() => {
    let mq: MediaQueryList | null = null;
    const onChange = () => {
      setDpr(window.devicePixelRatio || 1);
      listen();
    };
    const listen = () => {
      mq?.removeEventListener('change', onChange);
      mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      mq.addEventListener('change', onChange);
    };
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reading devicePixelRatio is only possible after mount
    setDpr(window.devicePixelRatio || 1);
    listen();
    return () => mq?.removeEventListener('change', onChange);
  }, []);

  const layout: FitResult | null = React.useMemo(
    () =>
      box.w > 0 && box.h > 0
        ? fitPreview({
            containerW: box.w,
            containerH: box.h,
            canvasW,
            canvasH,
            pad: PAD_CSS,
            dpr,
            maxBufferLong: MAX_BUFFER_LONG,
          })
        : null,
    [box, canvasW, canvasH, dpr],
  );

  /* ---- engine: reuse the shell's, or own one for the lifetime of this panel ---- */
  React.useEffect(() => {
    if (!projectId) return;
    let eng = getEngine();
    let owned = false;
    if (!eng || eng.projectId !== projectId) {
      eng = createPlaybackEngine({ projectId });
      owned = true;
    }
    const detach = eng.attach();
    eng.warmup();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the engine is an external, effect-created resource
    setEngine(eng);
    return () => {
      detach();
      setEngine(null);
      if (owned) eng.dispose();
    };
  }, [projectId]);

  /* ---- compositor on a private canvas ---- */
  React.useEffect(() => {
    const host = canvasHostRef.current;
    if (!engine || !host || !layout) return;
    const canvas = document.createElement('canvas');
    canvas.dataset.testid = 'preview-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.className = 'absolute inset-0 block size-full';
    canvas.width = layout.bufW;
    canvas.height = layout.bufH;
    host.appendChild(canvas);
    let comp: Compositor;
    try {
      comp = createCompositor(canvas, { project: useEditorStore.getState().project });
    } catch (e) {
      canvas.remove();
      // eslint-disable-next-line react-hooks/set-state-in-effect -- surfaces a failure of the external GL context
      setGlError(e instanceof Error ? e.message : 'the compositor could not start');
      return;
    }
    setGlError(null);
    comp.resize(layout.bufW, layout.bufH);
    engine.bindCompositor(comp);
    setCompositor(comp);
    return () => {
      engine.bindCompositor(null);
      setCompositor(null);
      comp.dispose();
      canvas.remove();
    };
    // The compositor lives as long as the engine/host; size changes go through the resize effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, layout !== null]);

  React.useLayoutEffect(() => {
    if (!compositor || !layout || !engine) return;
    const canvas = canvasHostRef.current?.querySelector('canvas');
    if (canvas && (canvas.width !== layout.bufW || canvas.height !== layout.bufH)) {
      canvas.width = layout.bufW;
      canvas.height = layout.bufH;
    }
    compositor.resize(layout.bufW, layout.bufH);
    engine.requestRender();
  }, [compositor, engine, layout]);

  /* ---- asset status ---- */
  const assetKey = useEditorStore((s) => s.project.assets.map((a) => a.id).join(','));
  const [statuses, setStatuses] = React.useState<Record<string, AssetStatus>>({});
  React.useEffect(() => {
    if (!engine) return;
    const upd = () => setStatuses(engine.assetStatuses());
    upd();
    return engine.onStatusChange(upd);
  }, [engine, assetKey]);
  const relKey = useEditorStore((s) => {
    const r = relevantAssets(s.project, s.playheadSec);
    return `${r.visual.join(',')}|${r.audio.join(',')}`;
  });
  const summary = React.useMemo(() => {
    const [v = '', a = ''] = relKey.split('|');
    return summarizeStatuses(
      { visual: v ? v.split(',') : [], audio: a ? a.split(',') : [] },
      statuses,
    );
  }, [relKey, statuses]);

  /* ---- keyboard ---- */
  const onKeyDown = React.useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented) return;
    if (forwardKey(e.nativeEvent)) {
      e.preventDefault();
      // The shell's global listener must not run the same shortcut a second time.
      e.stopPropagation();
    }
  }, []);

  /* ---- pointer ---- */
  const interaction = useTransformInteraction({
    compositor,
    layout,
    canvasW,
    canvasH,
    surface: surfaceRef,
    onEditText: setEditing,
  });

  const showError = summary.error;
  return (
    <div
      ref={rootRef}
      data-testid="preview-root"
      role="group"
      aria-label="Video preview"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) rootRef.current?.focus({ preventScroll: true });
      }}
      className={cn(
        'relative flex size-full min-h-0 min-w-0 items-center justify-center overflow-hidden bg-sidebar outline-none',
        className,
      )}
    >
      {layout ? (
        <div
          data-testid="preview-stage"
          className="relative shrink-0 overflow-hidden rounded-xs bg-muted shadow-md ring-1 ring-border"
          style={{ width: layout.cssW, height: layout.cssH }}
        >
          <div ref={canvasHostRef} className="absolute inset-0" />
          <PreviewOverlays
            layout={layout}
            compositor={compositor}
            guides={interaction.guides}
            hideHandles={editing !== null}
          />
          <div
            ref={surfaceRef}
            data-testid="preview-surface"
            aria-hidden
            className="absolute inset-0 touch-none select-none"
            style={{ cursor: interaction.cursor }}
            onPointerDown={(e) => {
              rootRef.current?.focus({ preventScroll: true });
              interaction.handlers.onPointerDown(e);
            }}
            onPointerMove={interaction.handlers.onPointerMove}
            onPointerUp={interaction.handlers.onPointerUp}
            onPointerCancel={interaction.handlers.onPointerCancel}
            onDoubleClick={interaction.handlers.onDoubleClick}
          />
          {editing && compositor ? (
            <TextEditLayer
              itemId={editing}
              compositor={compositor}
              layout={layout}
              onDone={() => {
                setEditing(null);
                rootRef.current?.focus({ preventScroll: true });
              }}
            />
          ) : null}
          {glError ? <PreviewError reason={`the compositor could not start (${glError})`} /> : null}
          {!glError && showError ? (
            <PreviewError
              reason={showError.reason}
              extra={summary.moreErrors}
              onRetry={() => engine?.retryAsset(showError.assetId)}
            />
          ) : null}
          {!glError && !showError && (summary.loading || !engine) ? <PreviewLoading /> : null}
          <Timecode />
          <ResolutionBadge canvasW={canvasW} canvasH={canvasH} layout={layout} />
          {summary.audioErrors.length ? (
            <div
              data-testid="preview-audio-warning"
              className="pointer-events-none absolute left-2 top-2 flex items-center gap-1.5 rounded-md bg-warning-soft px-2 py-1 text-2xs font-medium text-warning backdrop-blur-sm"
            >
              <TriangleAlert className="size-3" aria-hidden />
              Audio unavailable: {summary.audioErrors[0]?.reason ?? 'could not be loaded'}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Safe area, grid, selection handles — separate component so only it re-renders with the playhead. */
function PreviewOverlays({
  layout,
  compositor,
  guides,
  hideHandles,
}: {
  layout: FitResult;
  compositor: Compositor | null;
  guides: { x?: number; y?: number }[];
  hideHandles: boolean;
}) {
  const safeId = useEditorStore((s) => s.safeArea);
  const showGrid = useEditorStore((s) => s.showGrid);
  const t = useEditorStore((s) => s.playheadSec);
  const project = useEditorStore((s) => s.project);
  const selected = useEditorStore((s) => s.selection.itemIds);
  const sa = safeId && SAFE_AREAS[safeId] ? { id: safeId, ...SAFE_AREAS[safeId] } : null;
  const selections: SelectionOverlay[] = [];
  if (compositor) {
    for (const id of selected) {
      const h = compositor.handlesFor(t, id);
      if (h) selections.push({ itemId: id, handles: h, interactive: selected.length === 1 });
    }
  }
  void project; // handles depend on the project (re-render on edits)
  return (
    <PreviewOverlay
      bufW={layout.bufW}
      bufH={layout.bufH}
      k={layout.k}
      safeArea={sa}
      showGrid={showGrid}
      selections={selections}
      guides={guides}
      hideHandles={hideHandles}
    />
  );
}

function Timecode() {
  const t = useEditorStore((s) => s.playheadSec);
  const fps = useEditorStore((s) => s.project.canvas.fps);
  return (
    <span
      data-testid="preview-timecode"
      className="pointer-events-none absolute bottom-2 left-2 rounded-md bg-popover/85 px-2 py-0.5 font-mono text-xs tabular-nums text-foreground shadow-xs backdrop-blur-sm"
    >
      {formatTimecode(t, fps)}
    </span>
  );
}

function ResolutionBadge({
  canvasW,
  canvasH,
  layout,
}: {
  canvasW: number;
  canvasH: number;
  layout: FitResult;
}) {
  return (
    <span
      data-testid="preview-resolution"
      title={`Project ${canvasW}×${canvasH} · preview buffer ${layout.bufW}×${layout.bufH}`}
      className="pointer-events-none absolute bottom-2 right-2 rounded-md bg-popover/85 px-2 py-0.5 text-2xs font-medium tabular-nums text-muted-foreground shadow-xs backdrop-blur-sm"
    >
      {canvasW}×{canvasH}
    </span>
  );
}

/** Inline text editing for a text item / subtitle cue, positioned on the item's handle bounds. */
function TextEditLayer({
  itemId,
  compositor,
  layout,
  onDone,
}: {
  itemId: string;
  compositor: Compositor;
  layout: FitResult;
  onDone(): void;
}) {
  const state = useEditorStore.getState();
  const found = findItem(state.project, itemId);
  const h = compositor.handlesFor(state.playheadSec, itemId);
  if (!found || !h || (found.item.type !== 'text' && found.item.type !== 'subtitle')) {
    queueMicrotask(onDone);
    return null;
  }
  const item = found.item;
  const b = quadBounds(h.corners);
  const box = { x: b.x / layout.k, y: b.y / layout.k, w: b.w / layout.k, h: b.h / layout.k };
  const projectScale = layout.cssW / state.project.canvas.width;
  const text = item.type === 'text' ? item.text : item.words.map((w) => w.w).join(' ');
  const style = item.type === 'text' ? item.style : null;
  const scale = item.type === 'text' ? item.transform.scale.v : 1;
  return (
    <InlineTextEditor
      initialText={text}
      box={box}
      fontPx={(style?.size ?? 64) * projectScale * scale}
      fontFamily={style ? `${style.fontFamily}, var(--font-sans)` : 'var(--font-sans)'}
      fontWeight={style?.weight ?? 800}
      align={style?.align ?? 'center'}
      lineHeight={style?.lineHeight ?? 1.15}
      color={style?.color ?? 'var(--foreground)'}
      onCommit={(next) => {
        const s = useEditorStore.getState();
        if (next !== text) {
          if (item.type === 'text') s.updateItem(itemId, { text: next }, { label: 'Edit text' });
          else s.setCueText(itemId, next);
        }
        onDone();
      }}
      onCancel={onDone}
    />
  );
}
