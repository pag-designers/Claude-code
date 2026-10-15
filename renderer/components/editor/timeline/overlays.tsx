'use client';

import * as React from 'react';
import { Scissors } from 'lucide-react';
import { useEditorStore } from '@/lib/editor/core';
import { HEADER_W, RULER_H, formatTimecode, type TracksLayout } from './geometry';
import { useTimelineUi } from './timeline-ui';

const GUIDE_LABEL: Record<string, string> = {
  item: 'Clip edge',
  playhead: 'Playhead',
  marker: 'Marker',
  beat: 'Beat',
  start: 'Start',
  grid: 'Grid',
};

/** Vertical snap line with a small tag naming what was snapped to. */
export function SnapGuide({ height }: { height: number }) {
  const guide = useTimelineUi((s) => s.guide);
  const px = useEditorStore((s) => s.pxPerSec);
  if (!guide) return null;
  return (
    <div
      data-testid="snap-guide"
      data-t={guide.t}
      data-kind={guide.kind ?? ''}
      className="tl-guide"
      style={{ left: HEADER_W + guide.t * px, top: RULER_H, height }}
    >
      <span className="absolute -top-px left-1 whitespace-nowrap rounded-xs bg-warning px-1 text-2xs font-semibold leading-4 text-background">
        {guide.kind ? (GUIDE_LABEL[guide.kind] ?? 'Snap') : 'Snap'}
      </span>
    </div>
  );
}

/** Preview of where dragged items land (valid) or why they cannot (hatched red). */
export function Ghosts({ layout }: { layout: TracksLayout }) {
  const ghosts = useTimelineUi((s) => s.ghosts);
  const valid = useTimelineUi((s) => s.ghostValid);
  const px = useEditorStore((s) => s.pxPerSec);
  if (!ghosts) return null;
  return (
    <>
      {ghosts.map((g) => {
        const row = layout.byId.get(g.trackId);
        if (!row) return null;
        return (
          <div
            key={g.itemId}
            data-testid="move-ghost"
            data-valid={valid}
            className="tl-ghost"
            style={{
              left: HEADER_W + g.startSec * px,
              width: Math.max(2, g.durationSec * px),
              top: RULER_H + row.top + 3,
              height: row.height - 6,
            }}
          />
        );
      })}
    </>
  );
}

/** The item being trimmed: shows its resulting extent. */
export function TrimGhost({ layout }: { layout: TracksLayout }) {
  const trim = useTimelineUi((s) => s.trim);
  const px = useEditorStore((s) => s.pxPerSec);
  const trackId = useEditorStore((s) => {
    if (!trim) return null;
    for (const t of s.project.tracks) if (t.items.some((i) => i.id === trim.itemId)) return t.id;
    return null;
  });
  if (!trim || !trackId) return null;
  const row = layout.byId.get(trackId);
  if (!row) return null;
  return (
    <div
      data-testid="trim-ghost"
      className="tl-ghost"
      style={{
        left: HEADER_W + trim.startSec * px,
        width: Math.max(2, trim.durationSec * px),
        top: RULER_H + row.top + 3,
        height: row.height - 6,
      }}
    />
  );
}

export function MarqueeBox() {
  const m = useTimelineUi((s) => s.marquee);
  if (!m) return null;
  return (
    <div
      data-testid="marquee"
      className="tl-marquee"
      style={{
        left: HEADER_W + m.x0,
        top: RULER_H + m.y0,
        width: m.x1 - m.x0,
        height: m.y1 - m.y0,
      }}
    />
  );
}

/** Where a dropped asset would be inserted: a vertical hairline in the target lane, or a "new track" slot. */
export function DropHint({ layout, bottom }: { layout: TracksLayout; bottom: number }) {
  const drop = useTimelineUi((s) => s.drop);
  const px = useEditorStore((s) => s.pxPerSec);
  const fps = useEditorStore((s) => s.project.canvas.fps);
  if (!drop) return null;
  const row = drop.trackId ? layout.byId.get(drop.trackId) : null;
  return (
    <>
      {drop.newTrack ? (
        <div
          data-testid="drop-new-track"
          className="pointer-events-none absolute z-[11] flex items-center justify-center rounded-md border-2 border-dashed border-primary-text/70 bg-primary-soft text-xs font-medium text-primary-text"
          style={{
            left: HEADER_W + 8,
            right: 8,
            top: RULER_H + layout.height + 6,
            height: Math.max(36, bottom - layout.height - 12),
          }}
        >
          Drop to create a new track
        </div>
      ) : null}
      <div
        data-testid="drop-line"
        className="pointer-events-none absolute z-[12] w-px bg-primary-text"
        style={{
          left: HEADER_W + drop.sec * px,
          top: RULER_H + (row ? row.top : 0),
          height: row ? row.height : layout.height,
        }}
      >
        <span className="absolute -top-4 left-1 whitespace-nowrap rounded-xs bg-primary px-1 text-2xs font-semibold leading-4 text-primary-foreground tabular-nums">
          {formatTimecode(drop.sec, fps)}
        </span>
      </div>
    </>
  );
}

/** Highlights the clip that would receive a transition dropped from the bin. */
export function TransitionDropTarget({ layout }: { layout: TracksLayout }) {
  const t = useTimelineUi((s) => s.dropTransition);
  const px = useEditorStore((s) => s.pxPerSec);
  if (!t) return null;
  const row = layout.byId.get(t.trackId);
  if (!row) return null;
  return (
    <div
      data-testid="transition-drop-target"
      className="tl-ghost"
      style={{
        left: HEADER_W + t.startSec * px,
        width: Math.max(8, t.durationSec * px),
        top: RULER_H + row.top + 3,
        height: row.height - 6,
      }}
    />
  );
}

/** Razor hairline with a scissors glyph, following the pointer over a clip. */
export function RazorLine({ layout }: { layout: TracksLayout }) {
  const razor = useTimelineUi((s) => s.razor);
  const px = useEditorStore((s) => s.pxPerSec);
  if (!razor) return null;
  const row = layout.byId.get(razor.trackId);
  if (!row) return null;
  return (
    <div
      data-testid="razor-line"
      className="pointer-events-none absolute z-[12] w-px bg-foreground"
      style={{ left: HEADER_W + razor.sec * px, top: RULER_H + row.top, height: row.height }}
    >
      <Scissors className="absolute -left-2 -top-3 size-4 text-foreground" aria-hidden />
    </div>
  );
}

/** Insertion line while re-ordering tracks. */
export function ReorderLine({ layout }: { layout: TracksLayout }) {
  const r = useTimelineUi((s) => s.reorder);
  if (!r || !r.overTrackId) return null;
  const row = layout.byId.get(r.overTrackId);
  if (!row) return null;
  return (
    <div
      data-testid="reorder-line"
      className="pointer-events-none absolute z-[14] h-0.5"
      style={{
        left: 0,
        right: 0,
        top: RULER_H + row.top - 1,
        background: r.valid ? 'var(--ring)' : 'var(--danger)',
      }}
    />
  );
}

/** A small floating timecode next to the pointer while dragging. */
export function DragLabel() {
  const l = useTimelineUi((s) => s.dragLabel);
  if (!l) return null;
  return (
    <div
      data-testid="drag-label"
      className="pointer-events-none fixed z-[90] rounded-xs border border-border-strong bg-popover px-1.5 py-0.5 text-2xs font-semibold tabular-nums text-foreground shadow-md"
      style={{ left: l.x + 14, top: l.y + 16 }}
    >
      {l.text}
    </div>
  );
}
