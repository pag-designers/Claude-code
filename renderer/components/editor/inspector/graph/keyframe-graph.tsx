'use client';

import * as React from 'react';
import type { Keyframe } from '@shared/editor';
import { interpolate } from '@shared/editor-eval';
import { cn } from '@/lib/utils';
import {
  autoDomain,
  axisTicks,
  clampKeyframeTime,
  graphMapper,
  hitKeyframe,
  sampleCurve,
} from '../lib/graph';

export interface KeyframeGraphProps {
  keyframes: readonly Keyframe[];
  /** Value used before any keyframe exists (only the framing of an empty graph). */
  base: number;
  durationSec: number;
  /** Hard bounds of the property (the dragged value is clamped to them). */
  floor?: number;
  ceil?: number;
  /** Value axis: 'log' for speed. */
  scale?: 'linear' | 'log';
  /** Minimum vertical span in value units (framing). */
  minSpan?: number;
  format: (v: number) => string;
  /** Playhead, item-local seconds. */
  playheadSec?: number | null;
  selected: number | null;
  onSelect: (index: number | null) => void;
  /** A drag finished or a point was nudged with the keyboard: ONE call per gesture. */
  onMove: (index: number, tLocal: number, v: number) => void;
  /** Double-click on empty space. */
  onAdd?: (tLocal: number, v: number) => void;
  onRemove?: (index: number) => void;
  /** Keep the first / last keyframe at 0 / duration (speed ramps). */
  pinEnds?: boolean;
  /** Extra horizontal guide (e.g. 1× for speed). */
  guideValue?: number;
  label: string;
  height?: number;
  testId?: string;
}

const PAD_X = 34;
const PAD_Y = 12;
const HIT = 11;

/**
 * Value-over-time curve of one animated property: draggable keyframes (one store edit per drag), the real interpolated
 * curve (every segment's easing, holds as steps), grid, playhead. Keyboard: focus a point, ←/→ nudge time by a frame,
 * ↑/↓ nudge value, Delete removes. Double-click empty space adds a keyframe.
 */
export function KeyframeGraph({
  keyframes,
  base,
  durationSec,
  floor,
  ceil,
  scale = 'linear',
  minSpan,
  format,
  playheadSec = null,
  selected,
  onSelect,
  onMove,
  onAdd,
  onRemove,
  pinEnds,
  guideValue,
  label,
  height = 132,
  testId,
}: KeyframeGraphProps) {
  const wrap = React.useRef<HTMLDivElement>(null);
  const svgRef = React.useRef<SVGSVGElement>(null);
  const [width, setWidth] = React.useState(280);
  React.useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      if (e) setWidth(Math.max(160, Math.round(e.contentRect.width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The axis is framed from the COMMITTED keyframes, so it stays put while a point is dragged.
  const domain = React.useMemo(() => {
    const values = keyframes.length ? keyframes.map((k) => k.v) : [base];
    const unbounded = floor === undefined || ceil === undefined;
    const d = autoDomain(values, {
      floor,
      ceil,
      scale,
      minSpan: minSpan ?? (scale === 'log' ? 3 : undefined),
      margin: unbounded ? 0.35 : 0.12,
    });
    return { ...d, duration: Math.max(durationSec, 0.04), scale };
  }, [keyframes, base, floor, ceil, scale, minSpan, durationSec]);

  const box = { width, height, padX: PAD_X, padY: PAD_Y };
  const m = React.useMemo(() => graphMapper(box, domain), [width, height, domain]); // eslint-disable-line react-hooks/exhaustive-deps

  type Drag = { i: number; t: number; v: number; moved: boolean; sx: number; sy: number };
  const [drag, setDrag] = React.useState<Drag | null>(null);
  const keys = React.useMemo(
    () =>
      drag
        ? keyframes.map((k, i) => (i === drag.i ? { ...k, t: drag.t, v: drag.v } : k))
        : keyframes,
    [keyframes, drag],
  );
  const pts = keys.map((k) => ({ x: m.tToX(k.t), y: m.vToY(k.v) }));
  const curve = React.useMemo(
    () => sampleCurve(keys, base, domain.duration, 120),
    [keys, base, domain.duration],
  );
  const path = curve
    .map((p, i) => `${i ? 'L' : 'M'}${m.tToX(p.t).toFixed(1)},${m.vToY(p.v).toFixed(1)}`)
    .join('');

  const pointer = (e: React.PointerEvent): { x: number; y: number } => {
    const r = svgRef.current!.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * width,
      y: ((e.clientY - r.top) / r.height) * height,
    };
  };

  const clampV = (v: number) => Math.min(ceil ?? Infinity, Math.max(floor ?? -Infinity, v));
  const isEnd = (i: number) => !!pinEnds && (i === 0 || i === keyframes.length - 1);

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const p = pointer(e);
    const hit = hitKeyframe(pts, p.x, p.y, HIT);
    if (hit < 0) {
      onSelect(null);
      return;
    }
    e.preventDefault();
    svgRef.current?.setPointerCapture(e.pointerId);
    onSelect(hit);
    const k = keyframes[hit] as Keyframe;
    setDrag({ i: hit, t: k.t, v: k.v, moved: false, sx: p.x, sy: p.y });
    (document.activeElement as HTMLElement | null)?.blur?.();
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!drag) return;
    const p = pointer(e);
    const moved = drag.moved || Math.hypot(p.x - drag.sx, p.y - drag.sy) > 3;
    if (!moved) return;
    const orig = keyframes[drag.i] as Keyframe;
    const t =
      isEnd(drag.i) || e.shiftKey
        ? orig.t
        : clampKeyframeTime(keyframes, drag.i, m.xToT(p.x), domain.duration);
    const v = clampV(m.yToV(p.y));
    setDrag({ ...drag, t, v, moved: true });
  };
  const finish = (cancel: boolean) => {
    const d = drag;
    setDrag(null);
    if (d?.moved && !cancel) onMove(d.i, d.t, d.v);
  };

  const nudge = (i: number, e: React.KeyboardEvent) => {
    const k = keyframes[i] as Keyframe;
    const fine = e.altKey ? 0.1 : e.shiftKey ? 10 : 1;
    const frame = 1 / 30;
    const vStep = scale === 'log' ? k.v * 0.05 * fine : ((domain.vMax - domain.vMin) / 100) * fine;
    switch (e.key) {
      case 'ArrowUp':
        onMove(i, k.t, clampV(k.v + vStep));
        break;
      case 'ArrowDown':
        onMove(i, k.t, clampV(k.v - vStep));
        break;
      case 'ArrowLeft':
        if (!isEnd(i))
          onMove(i, clampKeyframeTime(keyframes, i, k.t - frame * fine, domain.duration), k.v);
        break;
      case 'ArrowRight':
        if (!isEnd(i))
          onMove(i, clampKeyframeTime(keyframes, i, k.t + frame * fine, domain.duration), k.v);
        break;
      case 'Delete':
      case 'Backspace':
        onRemove?.(i);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const ticks = axisTicks(domain);
  const phX =
    playheadSec !== null && playheadSec >= 0 && playheadSec <= domain.duration
      ? m.tToX(playheadSec)
      : null;
  const phV = playheadSec !== null && keys.length ? interpolate(keys, playheadSec, base) : null;
  const sel = selected !== null && selected < keys.length ? selected : null;
  const fmtT = (t: number) => `${t.toFixed(2)}s`;

  return (
    <div ref={wrap} className="w-full" data-testid={testId}>
      <svg
        ref={svgRef}
        role="group"
        aria-label={label}
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => finish(false)}
        onPointerCancel={() => finish(true)}
        onDoubleClick={(e) => {
          if (!onAdd) return;
          const r = svgRef.current!.getBoundingClientRect();
          const x = ((e.clientX - r.left) / r.width) * width;
          const y = ((e.clientY - r.top) / r.height) * height;
          if (hitKeyframe(pts, x, y, HIT) >= 0) return;
          onAdd(m.xToT(x), clampV(m.yToV(y)));
        }}
        className="block touch-none select-none rounded-md border border-border bg-field"
      >
        {/* value grid */}
        {ticks.map((v) => (
          <g key={v}>
            <line
              x1={PAD_X}
              x2={width - PAD_X / 3}
              y1={m.vToY(v)}
              y2={m.vToY(v)}
              className="stroke-border"
              strokeWidth={1}
            />
            <text
              x={PAD_X - 5}
              y={m.vToY(v) + 3}
              textAnchor="end"
              className="fill-subtle text-[9px] tabular-nums"
            >
              {format(v)}
            </text>
          </g>
        ))}
        {guideValue !== undefined && guideValue >= domain.vMin && guideValue <= domain.vMax ? (
          <line
            x1={PAD_X}
            x2={width - PAD_X / 3}
            y1={m.vToY(guideValue)}
            y2={m.vToY(guideValue)}
            className="stroke-border-strong"
            strokeDasharray="3 3"
          />
        ) : null}
        {/* time axis */}
        {[0, 0.5, 1].map((f) => (
          <text
            key={f}
            x={m.tToX(domain.duration * f)}
            y={height - 1.5}
            textAnchor={f === 0 ? 'start' : f === 1 ? 'end' : 'middle'}
            className="fill-subtle text-[9px] tabular-nums"
          >
            {fmtT(domain.duration * f)}
          </text>
        ))}
        {phX !== null ? (
          <g aria-hidden>
            <line
              x1={phX}
              x2={phX}
              y1={PAD_Y - 4}
              y2={height - PAD_Y}
              className="stroke-foreground/50"
            />
            {phV !== null ? (
              <circle cx={phX} cy={m.vToY(phV)} r={2.5} className="fill-foreground" />
            ) : null}
          </g>
        ) : null}
        <path
          d={path}
          fill="none"
          strokeWidth={1.75}
          strokeLinejoin="round"
          className="stroke-primary"
          data-testid="graph-curve"
        />
        {keys.map((k, i) => {
          const x = pts[i]!.x;
          const y = pts[i]!.y;
          const on = sel === i;
          return (
            <g
              key={i}
              role="slider"
              tabIndex={0}
              data-testid="graph-point"
              data-index={i}
              data-selected={on || undefined}
              aria-label={`Keyframe ${i + 1} of ${keys.length}`}
              aria-valuetext={`${fmtT(k.t)}, ${format(k.v)}`}
              aria-valuenow={k.v}
              onFocus={() => onSelect(i)}
              onKeyDown={(e) => nudge(i, e)}
              className="cursor-grab outline-none active:cursor-grabbing [&:focus-visible_.ring]:opacity-100"
            >
              <circle cx={x} cy={y} r={HIT} fill="transparent" />
              <rect
                className="ring fill-none stroke-ring opacity-0"
                x={x - 8}
                y={y - 8}
                width={16}
                height={16}
                rx={4}
                strokeWidth={2}
              />
              <rect
                x={x - 4.5}
                y={y - 4.5}
                width={9}
                height={9}
                rx={1.5}
                transform={`rotate(45 ${x} ${y})`}
                strokeWidth={1.5}
                className={cn(
                  'transition-[fill] duration-(--duration-fast)',
                  on ? 'fill-primary stroke-foreground' : 'fill-card stroke-primary',
                )}
              />
            </g>
          );
        })}
        {sel !== null ? (
          <text
            x={Math.min(width - 6, Math.max(PAD_X, pts[sel]!.x))}
            y={Math.max(PAD_Y + 6, pts[sel]!.y - 11)}
            textAnchor="middle"
            className="fill-foreground text-[10px] font-medium tabular-nums"
            data-testid="graph-readout"
          >
            {fmtT(keys[sel]!.t)} · {format(keys[sel]!.v)}
          </text>
        ) : null}
      </svg>
    </div>
  );
}
