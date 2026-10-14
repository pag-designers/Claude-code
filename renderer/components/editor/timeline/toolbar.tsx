'use client';

import * as React from 'react';
import {
  Flag,
  Maximize2,
  MousePointer2,
  Scissors,
  ScissorsLineDashed,
  Trash2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { Kbd } from '@/components/ui/kbd';
import { Slider } from '@/components/ui/slider';
import { Tip } from '@/components/ui/tooltip';
import { useEditorStore } from '@/lib/editor/core';
import { cn } from '@/lib/utils';
import { sliderToZoom, zoomAround, zoomToSlider } from './geometry';
import { useTimelineUi } from './timeline-ui';

function ToolButton({
  label,
  keys,
  pressed,
  disabled,
  onClick,
  children,
  testId,
}: {
  label: string;
  keys?: string[];
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <Tip
      content={
        <span className="flex items-center gap-2">
          {label}
          {keys ? <Kbd keys={keys} /> : null}
        </span>
      }
    >
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        data-testid={testId}
        disabled={disabled}
        onClick={onClick}
        className={cn(
          'app-no-drag inline-flex size-7 items-center justify-center rounded-md transition-colors [&_svg]:size-4',
          'disabled:pointer-events-none disabled:opacity-40',
          pressed
            ? 'bg-primary-soft text-primary-text'
            : 'text-muted-foreground hover:bg-accent hover:text-foreground',
        )}
      >
        {children}
      </button>
    </Tip>
  );
}

/** Editing tools and zoom for the timeline (snap / ripple live in the transport bar). */
export function TimelineToolbar({
  zoomBy,
  fit,
}: {
  zoomBy: (factor: number) => void;
  fit: () => void;
}) {
  const tool = useTimelineUi((s) => s.tool);
  const setUi = useTimelineUi((s) => s.set);
  const pxPerSec = useEditorStore((s) => s.pxPerSec);
  const hasSelection = useEditorStore((s) => s.selection.itemIds.length > 0);
  const act = useEditorStore.getState;
  return (
    <div
      role="toolbar"
      aria-label="Timeline tools"
      className="flex h-9 shrink-0 items-center gap-0.5 border-b bg-card px-2"
    >
      <ToolButton
        label="Select tool"
        keys={['V']}
        pressed={tool === 'select'}
        onClick={() => setUi({ tool: 'select', razor: null })}
        testId="tool-select"
      >
        <MousePointer2 />
      </ToolButton>
      <ToolButton
        label="Razor tool"
        keys={['C']}
        pressed={tool === 'razor'}
        onClick={() => setUi({ tool: tool === 'razor' ? 'select' : 'razor' })}
        testId="tool-razor"
      >
        <Scissors />
      </ToolButton>
      <span className="mx-1.5 h-4 w-px bg-border" aria-hidden />
      <ToolButton
        label="Split at playhead"
        keys={['S']}
        onClick={() => act().split(null)}
        testId="tool-split"
      >
        <ScissorsLineDashed className="rotate-90" />
      </ToolButton>
      <ToolButton
        label="Delete selected"
        keys={['Del']}
        disabled={!hasSelection}
        onClick={() => act().deleteItems(act().selection.itemIds)}
        testId="tool-delete"
      >
        <Trash2 />
      </ToolButton>
      <ToolButton
        label="Delete gaps"
        onClick={() => act().deleteGaps(act().selection.trackId ?? undefined)}
        testId="tool-delete-gaps"
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          aria-hidden
        >
          <path d="M2 3.5v9M14 3.5v9M5.5 8H10.5M8.5 6l2 2-2 2" />
        </svg>
      </ToolButton>
      <span className="mx-1.5 h-4 w-px bg-border" aria-hidden />
      <ToolButton
        label="Add marker"
        keys={['M']}
        onClick={() => act().addMarker(act().playheadSec)}
        testId="tool-marker"
      >
        <Flag />
      </ToolButton>

      <div className="ml-auto flex items-center gap-1.5">
        <ToolButton
          label="Zoom out"
          keys={['-']}
          onClick={() => zoomBy(1 / 1.35)}
          testId="zoom-out"
        >
          <ZoomOut />
        </ToolButton>
        <Slider
          aria-label="Timeline zoom"
          data-testid="zoom-slider"
          className="w-28"
          min={0}
          max={1}
          step={0.001}
          value={zoomToSlider(pxPerSec)}
          onValueChange={(v) => {
            const s = act();
            const vs = useTimelineUi.getState().viewportPx / s.pxPerSec;
            const anchor =
              s.playheadSec >= s.scrollSec && s.playheadSec <= s.scrollSec + vs
                ? s.playheadSec
                : s.scrollSec + vs / 2;
            zoomTo(sliderToZoom(v), anchor);
          }}
        />
        <ToolButton label="Zoom in" keys={['+']} onClick={() => zoomBy(1.35)} testId="zoom-in">
          <ZoomIn />
        </ToolButton>
        <ToolButton label="Zoom to fit" onClick={fit} testId="zoom-fit">
          <Maximize2 />
        </ToolButton>
        <span
          className="w-16 whitespace-nowrap text-right text-2xs tabular-nums text-subtle"
          data-testid="zoom-readout"
        >
          {pxPerSec < 10 ? pxPerSec.toFixed(1) : Math.round(pxPerSec)} px/s
        </span>
      </div>
    </div>
  );
}

/** Apply a zoom level keeping `anchorSec` fixed on screen (shared by the slider, buttons and wheel). */
export function zoomTo(nextPx: number, anchorSec: number) {
  const s = useEditorStore.getState();
  const z = zoomAround({ pxPerSec: s.pxPerSec, scrollSec: s.scrollSec }, nextPx, anchorSec);
  s.setZoom(z.pxPerSec, anchorSec);
  s.setScroll(z.scrollSec);
}
