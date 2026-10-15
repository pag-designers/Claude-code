'use client';

import * as React from 'react';
import { Flag } from 'lucide-react';
import type { ProjectMarker } from '@shared/editor';
import { useEditorStore } from '@/lib/editor/core';
import { HEADER_W, RULER_H, rulerTicks, type TimeWindow } from './geometry';
import { useSettled, useSettledWindow } from './engine-cache';
import { useTimelineUi } from './timeline-ui';
import { readTokens, useThemeVersion } from './use-css-tokens';

const RULER_TOKENS = ['--muted-foreground', '--border-strong', '--subtle'] as const;

/** Tick marks + labels, drawn only for the render window and positioned natively (so they never tear against the tracks). */
function RulerCanvas({
  win: liveWin,
  pxPerSec,
  fps,
}: {
  win: TimeWindow;
  pxPerSec: number;
  fps: number;
}) {
  const win = useSettledWindow(liveWin, 90);
  const ref = React.useRef<HTMLCanvasElement>(null);
  const theme = useThemeVersion();
  // the bitmap is drawn at the settled zoom and stretched with CSS while the zoom is changing (cheap, like the clips)
  const drawPx = useSettled(pxPerSec, 90);
  const width = Math.max(1, Math.round((win.end - win.start) * drawPx));
  React.useLayoutEffect(() => {
    const c = ref.current;
    if (!c) return;
    const r = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.min(width, 16000);
    c.width = Math.ceil(w * r);
    c.height = Math.ceil((RULER_H - 12) * r);
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(r, 0, 0, r, 0, 0);
    const tk = readTokens(null, RULER_TOKENS);
    const h = RULER_H - 12;
    ctx.clearRect(0, 0, w, h);
    ctx.font = '500 10px "Inter Variable", ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'top';
    for (const tick of rulerTicks(drawPx, win.start, win.end, fps)) {
      const x = Math.round((tick.t - win.start) * drawPx) + 0.5;
      if (tick.kind === 'major') {
        ctx.fillStyle = tk['--subtle'] || 'transparent';
        ctx.fillRect(x - 0.5, h - 12, 1, 12);
        if (tick.label) {
          ctx.fillStyle = tk['--muted-foreground'] || 'transparent';
          ctx.fillText(tick.label, x + 4, 2);
        }
      } else {
        ctx.fillStyle = tk['--border-strong'] || 'transparent';
        ctx.globalAlpha = 0.9;
        ctx.fillRect(x - 0.5, h - 5, 1, 5);
        ctx.globalAlpha = 1;
      }
    }
  }, [width, win.start, win.end, drawPx, fps, theme]);
  return (
    <canvas
      ref={ref}
      aria-hidden
      className="pointer-events-none absolute top-0"
      style={{
        left: win.start * pxPerSec,
        width: (win.end - win.start) * pxPerSec,
        height: RULER_H - 12,
      }}
    />
  );
}

function MarkerFlag({
  marker,
  pxPerSec,
  onContextMenu,
}: {
  marker: ProjectMarker;
  pxPerSec: number;
  onContextMenu: (e: React.MouseEvent, m: ProjectMarker) => void;
}) {
  const drag = useTimelineUi((s) => (s.markerDrag?.id === marker.id ? s.markerDrag : null));
  const editing = useTimelineUi((s) => s.editingMarkerId === marker.id);
  const setUi = useTimelineUi((s) => s.set);
  const at = drag ? drag.atSec : marker.atSec;
  return (
    <div
      className="absolute bottom-0 z-10 flex h-[14px] items-center"
      style={{ left: at * pxPerSec - 4 }}
      data-marker-wrap={marker.id}
    >
      <button
        type="button"
        data-marker-id={marker.id}
        aria-label={`Marker ${marker.label || 'unnamed'} at ${marker.atSec.toFixed(2)} seconds. Double-click to rename.`}
        title={`${marker.label || 'Marker'} — ${at.toFixed(2)} s (drag to move, double-click to rename)`}
        onContextMenu={(e) => onContextMenu(e, marker)}
        onDoubleClick={() => setUi({ editingMarkerId: marker.id })}
        className="app-no-drag flex h-[14px] items-center gap-1 rounded-xs pl-0.5 pr-1.5 text-2xs font-medium leading-none text-foreground hover:bg-accent focus-visible:bg-accent"
      >
        <Flag
          className="size-3 shrink-0"
          style={{ color: marker.color, fill: marker.color }}
          aria-hidden
        />
        {editing ? null : marker.label ? (
          <span className="max-w-24 truncate">{marker.label}</span>
        ) : null}
      </button>
      {editing ? <MarkerLabelEditor id={marker.id} label={marker.label} /> : null}
    </div>
  );
}

function MarkerLabelEditor({ id, label }: { id: string; label: string }) {
  const setUi = useTimelineUi((s) => s.set);
  const [draft, setDraft] = React.useState(label);
  const done = React.useRef(false);
  const commit = () => {
    if (done.current) return;
    done.current = true;
    const next = draft.trim();
    if (next !== label) useEditorStore.getState().updateMarker(id, { label: next });
    setUi({ editingMarkerId: null });
  };
  return (
    <input
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      aria-label="Marker label"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') commit();
        else if (e.key === 'Escape') {
          done.current = true;
          setUi({ editingMarkerId: null });
        }
      }}
      className="absolute left-4 top-0 h-[14px] w-24 rounded-xs border border-ring bg-field px-1 text-2xs text-foreground outline-none"
    />
  );
}

/**
 * The time ruler (sticky to the top of the timeline scroller). `corner` is the sticky top-left cell (add-track menu).
 */
export const Ruler = React.memo(function Ruler({
  contentW,
  win,
  corner,
  onMarkerContextMenu,
}: {
  contentW: number;
  win: TimeWindow;
  corner: React.ReactNode;
  onMarkerContextMenu: (e: React.MouseEvent, m: ProjectMarker) => void;
}) {
  const pxPerSec = useEditorStore((s) => s.pxPerSec);
  const fps = useEditorStore((s) => s.project.canvas.fps);
  const markers = useEditorStore((s) => s.project.markers);
  return (
    <div
      className="sticky top-0 z-30 flex border-b bg-card"
      style={{ width: HEADER_W + contentW, height: RULER_H }}
      data-testid="tl-ruler-row"
    >
      <div
        className="sticky left-0 z-40 flex shrink-0 items-center border-r bg-card px-2"
        style={{ width: HEADER_W, height: RULER_H }}
      >
        {corner}
      </div>
      <div
        data-ruler
        data-testid="tl-ruler"
        className="relative cursor-col-resize select-none"
        style={{ width: contentW, height: RULER_H }}
        aria-label="Time ruler. Drag to move the playhead."
      >
        <RulerCanvas win={win} pxPerSec={pxPerSec} fps={fps} />
        {markers.map((m) => {
          const x = m.atSec;
          if (x < win.start - 5 || x > win.end + 5) return null;
          return (
            <MarkerFlag
              key={m.id}
              marker={m}
              pxPerSec={pxPerSec}
              onContextMenu={onMarkerContextMenu}
            />
          );
        })}
        <PlayheadHead />
      </div>
    </div>
  );
});

/** The triangular grip of the playhead, living in the ruler. */
export function PlayheadHead() {
  const t = useEditorStore((s) => s.playheadSec);
  const pxPerSec = useEditorStore((s) => s.pxPerSec);
  return (
    <div
      aria-hidden
      data-testid="playhead-head"
      className="pointer-events-none absolute left-0 top-0 z-20 will-change-transform"
      style={{ transform: `translateX(${t * pxPerSec}px)` }}
    >
      <div
        className="absolute -left-[6px] top-[3px] h-[14px] w-[13px] bg-foreground"
        style={{ clipPath: 'polygon(0 0, 100% 0, 100% 55%, 50% 100%, 0 55%)' }}
      />
      <div
        className="absolute left-0 top-[16px] w-px bg-foreground"
        style={{ height: RULER_H - 16 }}
      />
    </div>
  );
}

/** The playhead line through the tracks. */
export function PlayheadLine({ height }: { height: number }) {
  const t = useEditorStore((s) => s.playheadSec);
  const pxPerSec = useEditorStore((s) => s.pxPerSec);
  return (
    <div
      aria-hidden
      data-testid="playhead-line"
      className="tl-playhead-line z-10"
      style={{ left: HEADER_W, height, transform: `translateX(${t * pxPerSec}px)` }}
    />
  );
}
