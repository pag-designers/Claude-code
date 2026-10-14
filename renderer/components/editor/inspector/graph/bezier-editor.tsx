'use client';

import * as React from 'react';
import type { Easing } from '@shared/editor';
import { cn } from '@/lib/utils';
import { NumberField } from '../fields/number-field';
import {
  BEZIER_PRESETS,
  bezierMapper,
  bezierToEasing,
  easingToBezier,
  matchPreset,
  moveHandle,
  nearestHandle,
  type BezierTuple,
} from '../lib/bezier';

const VP = { size: 104, pad: 14, yMin: -0.4, yMax: 1.4 };
const map = bezierMapper(VP);

/**
 * Cubic-bezier editor: two draggable control handles on the unit square (overshoot allowed in y), presets and the
 * four numbers. `value` is the segment's easing; `onChange` always receives `{type:'bezier', …}`. One `onChange` per
 * handle move (the store coalesces); keyboard: arrows move the focused handle by 0.01 (shift 0.1).
 */
export function BezierEditor({
  value,
  onChange,
  onCommit,
}: {
  value: Easing;
  onChange: (e: Easing) => void;
  /** Fires once at the end of a drag / after a discrete edit (lets the host defer the store write). */
  onCommit?: (e: Easing) => void;
}) {
  const b: BezierTuple = easingToBezier(value) ?? [0, 0, 1, 1];
  const svg = React.useRef<SVGSVGElement>(null);
  const [active, setActive] = React.useState<1 | 2 | null>(null);
  const live = React.useRef(b);
  React.useEffect(() => {
    live.current = b;
  });
  const last = React.useRef<Easing>(value);

  const emit = (tuple: readonly number[], final: boolean) => {
    const e = bezierToEasing(tuple);
    last.current = e;
    onChange(e);
    if (final) onCommit?.(e);
  };

  const toUnit = (e: React.PointerEvent) => {
    const r = svg.current!.getBoundingClientRect();
    return map.fromPx(
      ((e.clientX - r.left) / r.width) * map.width,
      ((e.clientY - r.top) / r.height) * map.height,
    );
  };

  const [h1x, h1y] = [b[0], b[1]];
  const [h2x, h2y] = [b[2], b[3]];
  const p0 = map.toPx(0, 0);
  const p3 = map.toPx(1, 1);
  const c1 = map.toPx(h1x, h1y);
  const c2 = map.toPx(h2x, h2y);
  const preset = matchPreset(b);

  const key = (which: 1 | 2) => (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.01;
    const cur = live.current;
    const x = which === 1 ? cur[0] : cur[2];
    const y = which === 1 ? cur[1] : cur[3];
    let nx = x;
    let ny = y;
    if (e.key === 'ArrowLeft') nx -= step;
    else if (e.key === 'ArrowRight') nx += step;
    else if (e.key === 'ArrowUp') ny += step;
    else if (e.key === 'ArrowDown') ny -= step;
    else return;
    e.preventDefault();
    emit(moveHandle(cur, which, Math.min(1, Math.max(0, nx)), ny), true);
  };

  return (
    <div className="flex gap-3" data-testid="bezier-editor">
      <svg
        ref={svg}
        role="group"
        aria-label="Bezier curve editor"
        viewBox={`0 0 ${map.width} ${map.height}`}
        width={map.width}
        height={map.height}
        className="shrink-0 touch-none select-none rounded-md border border-border bg-field"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          const u = toUnit(e);
          const which = nearestHandle(live.current, u.x, u.y);
          svg.current?.setPointerCapture(e.pointerId);
          setActive(which);
          emit(moveHandle(live.current, which, u.x, u.y), false);
        }}
        onPointerMove={(e) => {
          if (!active) return;
          const u = toUnit(e);
          emit(moveHandle(live.current, active, u.x, u.y), false);
        }}
        onPointerUp={() => {
          if (active) onCommit?.(last.current);
          setActive(null);
        }}
        onPointerCancel={() => setActive(null)}
      >
        {/* unit square */}
        <rect
          x={p0.px}
          y={p3.py}
          width={VP.size}
          height={VP.size}
          className="fill-none stroke-border-strong"
          strokeDasharray="2 3"
        />
        <line x1={p0.px} y1={p0.py} x2={p3.px} y2={p3.py} className="stroke-border" />
        <line x1={p0.px} y1={p0.py} x2={c1.px} y2={c1.py} className="stroke-subtle" />
        <line x1={p3.px} y1={p3.py} x2={c2.px} y2={c2.py} className="stroke-subtle" />
        <path
          d={`M${p0.px},${p0.py} C${c1.px},${c1.py} ${c2.px},${c2.py} ${p3.px},${p3.py}`}
          fill="none"
          strokeWidth={2}
          className="stroke-primary"
          data-testid="bezier-curve"
        />
        {([1, 2] as const).map((w) => {
          const c = w === 1 ? c1 : c2;
          return (
            <g
              key={w}
              role="slider"
              tabIndex={0}
              aria-label={`Bezier handle ${w}`}
              aria-valuetext={`x ${(w === 1 ? h1x : h2x).toFixed(2)}, y ${(w === 1 ? h1y : h2y).toFixed(2)}`}
              aria-valuenow={w === 1 ? h1x : h2x}
              data-testid={`bezier-handle-${w}`}
              onKeyDown={key(w)}
              className="cursor-grab outline-none [&:focus-visible_.ring]:opacity-100"
            >
              <circle cx={c.px} cy={c.py} r={11} fill="transparent" />
              <circle
                className="ring fill-none stroke-ring opacity-0"
                cx={c.px}
                cy={c.py}
                r={8}
                strokeWidth={2}
              />
              <circle
                cx={c.px}
                cy={c.py}
                r={5}
                strokeWidth={2}
                className={cn(
                  'stroke-primary transition-[fill] duration-(--duration-fast)',
                  active === w ? 'fill-primary' : 'fill-card',
                )}
              />
            </g>
          );
        })}
        <circle cx={p0.px} cy={p0.py} r={2.5} className="fill-foreground" />
        <circle cx={p3.px} cy={p3.py} r={2.5} className="fill-foreground" />
      </svg>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="grid grid-cols-2 gap-1.5">
          {(
            [
              ['x1', 0, 0, 1],
              ['y1', 1, -2, 2],
              ['x2', 2, 0, 1],
              ['y2', 3, -2, 2],
            ] as const
          ).map(([name, idx, lo, hi]) => (
            <label key={name} className="flex min-w-0 items-center gap-1 text-2xs text-subtle">
              <span className="w-4 shrink-0 uppercase">{name}</span>
              <NumberField
                label={`Bezier ${name}`}
                testId={`bezier-${name}`}
                value={b[idx]}
                min={lo}
                max={hi}
                step={0.01}
                decimals={2}
                className="w-full min-w-0 shrink"
                onChange={(v) => {
                  const next = [...live.current] as BezierTuple;
                  next[idx] = v;
                  emit(next, false);
                }}
                onCommit={(v) => {
                  const next = [...live.current] as BezierTuple;
                  next[idx] = v;
                  emit(next, true);
                }}
              />
            </label>
          ))}
        </div>
        <div role="group" aria-label="Curve presets" className="flex flex-wrap gap-1">
          {BEZIER_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              data-testid={`bezier-preset-${p.id}`}
              aria-pressed={preset?.id === p.id}
              onClick={() => emit(p.b, true)}
              className={cn(
                'h-6 rounded-md border px-1.5 text-2xs font-medium outline-none transition-colors duration-(--duration-fast) focus-visible:ring-2 focus-visible:ring-ring',
                preset?.id === p.id
                  ? 'border-primary/70 bg-primary-soft text-primary-text'
                  : 'border-border-strong text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
