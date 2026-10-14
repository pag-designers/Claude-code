'use client';

import * as React from 'react';
import type { ItemTransition, TransitionType } from '@shared/editor';
import { transitionOps } from '@shared/editor-eval';
import { cn } from '@/lib/utils';
import { NumberField } from '../fields/number-field';
import { Hint, Row, Section } from '../fields/section';
import { SliderField } from '../fields/slider-field';
import { useInspector } from '../context';
import { useEditorStore } from '../store';

const TYPES: { value: TransitionType; label: string }[] = [
  { value: 'cut', label: 'Cut' },
  { value: 'crossfade', label: 'Crossfade' },
  { value: 'dip-black', label: 'Dip black' },
  { value: 'dip-white', label: 'Dip white' },
  { value: 'slide-left', label: 'Slide left' },
  { value: 'slide-right', label: 'Slide right' },
  { value: 'slide-up', label: 'Slide up' },
  { value: 'slide-down', label: 'Slide down' },
  { value: 'zoom', label: 'Zoom' },
  { value: 'blur', label: 'Blur' },
  { value: 'whip-pan', label: 'Whip pan' },
  { value: 'glitch', label: 'Glitch' },
];

const W = 44;
const H = 28;

/** Schematic of a transition at progress p, drawn from the SAME ops the compositor and exporter use. */
function Glyph({ type, p }: { type: TransitionType; p: number }) {
  const ops = transitionOps(type, p);
  const layer = (o: typeof ops.from, cls: string, key: string) => {
    const sw = W * o.scale;
    const sh = H * o.scale;
    return (
      <rect
        key={key}
        x={(W - sw) / 2 + o.dx * W}
        y={(H - sh) / 2 + o.dy * H}
        width={sw}
        height={sh}
        rx={2}
        opacity={o.opacity}
        className={cls}
        style={o.blur > 0 ? { filter: `blur(${(o.blur * H).toFixed(1)}px)` } : undefined}
      />
    );
  };
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width={W}
      height={H}
      aria-hidden
      className="overflow-hidden rounded-sm border border-border bg-field"
    >
      <clipPath id={`gc-${type}`}>
        <rect width={W} height={H} rx={2} />
      </clipPath>
      <g clipPath={`url(#gc-${type})`}>
        {layer(ops.from, 'fill-border-strong', 'from')}
        {layer(ops.to, 'fill-primary', 'to')}
        {ops.veil ? (
          <rect
            width={W}
            height={H}
            opacity={ops.veil.alpha}
            className={
              ops.veil.color === '#000000'
                ? 'fill-[var(--swatch-black)]'
                : 'fill-[var(--swatch-white)]'
            }
          />
        ) : null}
      </g>
    </svg>
  );
}

function TransitionTile({
  type,
  label,
  active,
  disabled,
  onPick,
}: {
  type: TransitionType;
  label: string;
  active: boolean;
  disabled: boolean;
  onPick: () => void;
}) {
  const [p, setP] = React.useState(0.5);
  const raf = React.useRef(0);
  const stop = () => {
    cancelAnimationFrame(raf.current);
    setP(0.5);
  };
  const play = () => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    cancelAnimationFrame(raf.current);
    const t0 = performance.now();
    const tick = (now: number) => {
      setP(((now - t0) / 900) % 1);
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  };
  React.useEffect(() => () => cancelAnimationFrame(raf.current), []);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      aria-label={label}
      data-testid={`transition-${type}`}
      disabled={disabled}
      onClick={onPick}
      onPointerEnter={play}
      onPointerLeave={stop}
      onFocus={play}
      onBlur={stop}
      className={cn(
        'flex min-w-0 flex-col items-center gap-1 rounded-md border p-1.5 text-2xs font-medium outline-none transition-colors duration-(--duration-fast) focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-45',
        active
          ? 'border-primary/70 bg-primary-soft text-primary-text'
          : 'border-border-strong text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      {type === 'cut' ? (
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width={W}
          height={H}
          aria-hidden
          className="rounded-sm border border-border bg-field"
        >
          <rect x={4} y={5} width={16} height={18} rx={2} className="fill-border-strong" />
          <rect x={24} y={5} width={16} height={18} rx={2} className="fill-primary" />
        </svg>
      ) : (
        <Glyph type={type} p={p} />
      )}
      <span className="w-full truncate text-center">{label}</span>
    </button>
  );
}

/** Transition in: the type grid + duration (overlap with the previous clip on the track). */
export function TransitionSection() {
  const ctx = useInspector();
  const item = ctx.primary;
  const track = ctx.project.tracks.find((t) => t.items.some((i) => i.id === item.id));
  const idx = track ? track.items.findIndex((i) => i.id === item.id) : -1;
  const prev = track && idx > 0 ? track.items[idx - 1] : undefined;
  const cur: ItemTransition | null = 'transitionIn' in item ? item.transitionIn : null;
  const noPrev = !prev;
  const disabled = ctx.multi || noPrev;
  const reason = ctx.multi
    ? 'Select one clip to set its transition'
    : noPrev
      ? 'Transitions sit between two clips: this is the first clip on its track.'
      : null;
  const maxDur = Math.max(0.05, Math.min(5, item.durationSec, prev?.durationSec ?? 5));
  const set = (t: ItemTransition | null) => useEditorStore.getState().setTransition(item.id, t);
  const dur = cur?.durationSec ?? 0.5;
  return (
    <Section title="Transition in" testId="section-transition">
      {disabled ? null : (
        <div role="radiogroup" aria-label="Transition type" className="grid grid-cols-3 gap-1.5">
          {TYPES.map((t) => (
            <TransitionTile
              key={t.value}
              type={t.value}
              label={t.label}
              disabled={false}
              active={(cur?.type ?? 'cut') === t.value}
              onPick={() =>
                set(
                  t.value === 'cut' ? null : { type: t.value, durationSec: Math.min(dur, maxDur) },
                )
              }
            />
          ))}
        </div>
      )}
      {cur && !disabled ? (
        <Row label="Duration">
          <NumberField
            label="Transition duration"
            testId="transition-duration"
            value={cur.durationSec}
            min={0.05}
            max={maxDur}
            step={0.05}
            decimals={2}
            unit="s"
            onChange={() => undefined}
            onCommit={(v) => set({ type: cur.type, durationSec: v })}
          />
          <SliderField
            label="Transition duration slider"
            testId="transition-duration-slider"
            min={0.05}
            max={maxDur}
            step={0.05}
            value={Math.min(cur.durationSec, maxDur)}
            deferred
            onCommit={(v) => set({ type: cur.type, durationSec: v })}
          />
        </Row>
      ) : null}
      <Hint>
        {reason ?? 'The clip starts early and overlaps the previous one by the duration.'}
      </Hint>
    </Section>
  );
}
