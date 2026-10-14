'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { clampNum, formatNumeric, modStep, parseNumeric, roundTo } from '../lib/numeric';

export interface NumberFieldProps {
  /** Accessible name (also the tooltip of the scrub area). */
  label: string;
  /** Value in DISPLAY units. */
  value: number;
  /** Live value: fires repeatedly while scrubbing and once per discrete edit (typing, arrow keys). */
  onChange: (v: number) => void;
  /** Fires once when a gesture ends (release after a scrub) and after every discrete edit. */
  onCommit?: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  decimals?: number;
  unit?: string;
  /** Shown as an em dash: the selected items disagree. */
  mixed?: boolean;
  disabled?: boolean;
  className?: string;
  testId?: string;
  /** Tint when the value is animated (has keyframes). */
  animated?: boolean;
}

/**
 * Scrubbable numeric field (dense, tabular numerals).
 *  - drag horizontally to scrub (shift ×10, alt ×0.1), click to type;
 *  - ↑/↓ step (same modifiers), Enter commits, Esc reverts, blur commits;
 *  - everything is clamped to min/max and rounded to `decimals`.
 */
export function NumberField({
  label,
  value,
  onChange,
  onCommit,
  min = -Infinity,
  max = Infinity,
  step = 1,
  decimals = 0,
  unit,
  mixed,
  disabled,
  className,
  testId,
  animated,
}: NumberFieldProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [draft, setDraft] = React.useState<string | null>(null);
  const [scrubbing, setScrubbing] = React.useState(false);
  const skipBlurCommit = React.useRef(false);
  const drag = React.useRef<{
    lastX: number;
    acc: number;
    v0: number;
    moved: boolean;
    last: number;
  } | null>(null);
  // latest props for the pointer handlers (they are attached once per gesture)
  const live = React.useRef({ onChange, onCommit, min, max, step, decimals });
  React.useEffect(() => {
    live.current = { onChange, onCommit, min, max, step, decimals };
  });

  const shown = mixed ? '' : formatNumeric(value, decimals);
  const editing = draft !== null;

  const emit = (v: number, final: boolean) => {
    const { min: lo, max: hi, decimals: dp } = live.current;
    const nv = roundTo(clampNum(v, lo, hi), dp);
    live.current.onChange(nv);
    if (final) live.current.onCommit?.(nv);
    return nv;
  };

  const commitDraft = () => {
    if (draft === null) return;
    const parsed = parseNumeric(draft, value);
    setDraft(null);
    if (parsed === null) return;
    const nv = roundTo(clampNum(parsed, min, max), decimals);
    if (!mixed && nv === roundTo(value, decimals)) return;
    emit(nv, true);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0 || editing) return;
    e.preventDefault(); // we decide on release whether this was a click (type) or a scrub
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { lastX: e.clientX, acc: 0, v0: mixed ? 0 : value, moved: false, last: value };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.abs(e.clientX - d.lastX) < 3) return;
    if (!d.moved) {
      d.moved = true;
      setScrubbing(true);
    }
    d.acc +=
      (e.clientX - d.lastX) * modStep(live.current.step, { shift: e.shiftKey, alt: e.altKey });
    d.lastX = e.clientX;
    const next = roundTo(
      clampNum(d.v0 + d.acc, live.current.min, live.current.max),
      live.current.decimals + (e.altKey ? 1 : 0),
    );
    if (next !== d.last) {
      d.last = next;
      live.current.onChange(next);
    }
  };
  const endDrag = (e: React.PointerEvent<HTMLDivElement>, cancel: boolean) => {
    const d = drag.current;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
    if (!d) return;
    setScrubbing(false);
    if (d.moved) {
      if (!cancel) live.current.onCommit?.(d.last);
    } else if (!cancel) {
      inputRef.current?.focus();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitDraft();
      inputRef.current?.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      skipBlurCommit.current = true;
      setDraft(null);
      inputRef.current?.blur();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const base = draft !== null ? (parseNumeric(draft, value) ?? value) : mixed ? 0 : value;
      const dir = e.key === 'ArrowUp' ? 1 : -1;
      const nv = emit(base + dir * modStep(step, { shift: e.shiftKey, alt: e.altKey }), true);
      setDraft(formatNumeric(nv, decimals + (e.altKey ? 1 : 0)));
    }
  };

  return (
    <div
      data-testid={testId}
      data-scrubbing={scrubbing || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => endDrag(e, false)}
      onPointerCancel={(e) => endDrag(e, true)}
      className={cn(
        'group/nf relative flex h-7 w-[4.5rem] min-w-0 shrink-0 items-center rounded-md border border-input bg-field text-xs text-foreground',
        'transition-[border-color,box-shadow] duration-(--duration-fast) hover:border-border-strong',
        'focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/25',
        !editing && !disabled && 'cursor-ew-resize',
        scrubbing && 'border-ring ring-2 ring-ring/25',
        animated && 'border-primary/50',
        disabled && 'pointer-events-none opacity-50',
        className,
      )}
    >
      <input
        ref={inputRef}
        type="text"
        inputMode="decimal"
        role="spinbutton"
        aria-label={label}
        aria-valuenow={mixed ? undefined : roundTo(value, decimals)}
        aria-valuemin={Number.isFinite(min) ? min : undefined}
        aria-valuemax={Number.isFinite(max) ? max : undefined}
        aria-valuetext={mixed ? 'Mixed values' : `${shown}${unit ? ` ${unit}` : ''}`}
        title={label}
        spellCheck={false}
        autoComplete="off"
        disabled={disabled}
        placeholder={mixed ? '—' : undefined}
        value={editing ? draft : shown}
        onFocus={(e) => {
          const el = e.currentTarget;
          skipBlurCommit.current = false;
          setDraft(shown);
          requestAnimationFrame(() => el.select());
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (skipBlurCommit.current) {
            skipBlurCommit.current = false;
            return;
          }
          commitDraft();
        }}
        onKeyDown={onKeyDown}
        className={cn(
          'h-full min-w-0 flex-1 bg-transparent px-1.5 text-right font-[inherit] tabular-nums outline-none',
          'placeholder:text-subtle',
          !editing && !disabled && 'cursor-ew-resize',
          unit ? 'pr-0.5' : '',
        )}
      />
      {unit ? (
        <span
          className="w-[1.125rem] shrink-0 select-none pr-1.5 text-left text-2xs text-subtle"
          aria-hidden
        >
          {unit}
        </span>
      ) : null}
    </div>
  );
}
