'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

const LAYOUT_KEY = 'clipfern.editor.layout.v1';

export interface PaneSizes {
  left: number;
  right: number;
  /** null = automatic (a share of the window height). */
  timeline: number | null;
  leftOpen: boolean;
  rightOpen: boolean;
}

export const DEFAULT_PANES: PaneSizes = {
  left: 288,
  right: 332,
  timeline: null,
  leftOpen: true,
  rightOpen: true,
};

function read(): PaneSizes {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return DEFAULT_PANES;
    const p = JSON.parse(raw) as Partial<PaneSizes>;
    const num = (v: unknown, d: number, lo: number, hi: number) =>
      typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
    return {
      left: num(p.left, DEFAULT_PANES.left, 200, 560),
      right: num(p.right, DEFAULT_PANES.right, 240, 600),
      timeline:
        p.timeline === null || p.timeline === undefined ? null : num(p.timeline, 320, 160, 900),
      leftOpen: p.leftOpen !== false,
      rightOpen: p.rightOpen !== false,
    };
  } catch {
    return DEFAULT_PANES;
  }
}

/** Pane sizes persisted in localStorage (every access guarded: the layout simply is not remembered if storage is blocked). */
export function usePaneSizes() {
  // the workspace only mounts on the client (never in the prerendered HTML), so reading storage in the initialiser is safe
  const [sizes, setSizes] = React.useState<PaneSizes>(read);
  const update = React.useCallback((patch: Partial<PaneSizes>) => {
    setSizes((cur) => {
      const next = { ...cur, ...patch };
      try {
        localStorage.setItem(LAYOUT_KEY, JSON.stringify(next));
      } catch {
        /* not remembered */
      }
      return next;
    });
  }, []);
  return [sizes, update] as const;
}

/**
 * A draggable divider (also keyboard operable: arrows resize by 16 px, Shift by 64, Home/End jump to the limits,
 * double-click resets). `value` is the size of the pane it controls; `invert` flips the drag direction.
 */
export function Splitter({
  orientation,
  value,
  min,
  max,
  onChange,
  onReset,
  label,
  invert,
  className,
}: {
  orientation: 'vertical' | 'horizontal';
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  onReset?: () => void;
  label: string;
  invert?: boolean;
  className?: string;
}) {
  const [dragging, setDragging] = React.useState(false);
  const vertical = orientation === 'vertical';
  const start = React.useRef({ pos: 0, value: 0 });
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  return (
    <div
      role="separator"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      data-dragging={dragging || undefined}
      className={cn(
        'group/split app-no-drag relative z-20 shrink-0 touch-none outline-none',
        vertical ? 'w-px cursor-col-resize bg-border' : 'h-px cursor-row-resize bg-border',
        className,
      )}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { pos: vertical ? e.clientX : e.clientY, value };
        setDragging(true);
      }}
      onPointerMove={(e) => {
        if (!dragging) return;
        const d = (vertical ? e.clientX : e.clientY) - start.current.pos;
        // a pane on the left grows with +x; a pane at the bottom grows with -y
        const signed = vertical ? (invert ? -d : d) : -d;
        onChange(clamp(start.current.value + signed));
      }}
      onPointerUp={(e) => {
        e.currentTarget.releasePointerCapture(e.pointerId);
        setDragging(false);
      }}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 64 : 16;
        const grow = vertical ? (invert ? 'ArrowLeft' : 'ArrowRight') : 'ArrowUp';
        const shrink = vertical ? (invert ? 'ArrowRight' : 'ArrowLeft') : 'ArrowDown';
        if (e.key === grow) onChange(clamp(value + step));
        else if (e.key === shrink) onChange(clamp(value - step));
        else if (e.key === 'Home') onChange(min);
        else if (e.key === 'End') onChange(max);
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {/* generous hit area + visible affordance on hover / drag / focus */}
      <span
        className={cn(
          'absolute z-10',
          vertical ? 'inset-y-0 -left-1.5 w-3' : 'inset-x-0 -top-1.5 h-3',
        )}
      />
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute bg-ring opacity-0 transition-opacity duration-(--duration-fast)',
          'group-hover/split:opacity-70 group-focus-visible/split:opacity-100 group-data-[dragging]/split:opacity-100',
          vertical ? 'inset-y-0 -left-px w-[3px]' : 'inset-x-0 -top-px h-[3px]',
        )}
      />
    </div>
  );
}
