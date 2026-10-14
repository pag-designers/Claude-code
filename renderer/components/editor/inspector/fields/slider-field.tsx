'use client';

import * as React from 'react';
import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/utils';

/**
 * Native range with a gesture model matching `NumberField`: `onChange` fires continuously while dragging, `onCommit`
 * once on release. With `deferred` the thumb follows a local draft and ONLY `onCommit` reaches the store (used where
 * the store action cannot coalesce, e.g. setTransition / track gain).
 */
export function SliderField({
  label,
  value,
  min,
  max,
  step,
  onChange,
  onCommit,
  deferred,
  disabled,
  className,
  testId,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange?: (v: number) => void;
  onCommit?: (v: number) => void;
  deferred?: boolean;
  disabled?: boolean;
  className?: string;
  testId?: string;
}) {
  const [draft, setDraft] = React.useState<number | null>(null);
  const dirty = React.useRef(false);
  const latest = React.useRef(value);
  const finish = () => {
    if (!dirty.current) return;
    dirty.current = false;
    onCommit?.(latest.current);
    setDraft(null);
  };
  return (
    <Slider
      aria-label={label}
      data-testid={testId}
      className={cn('min-w-0 flex-1', className)}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      value={draft ?? value}
      onValueChange={(v) => {
        dirty.current = true;
        latest.current = v;
        if (deferred) setDraft(v);
        else onChange?.(v);
      }}
      onPointerUp={finish}
      onKeyUp={finish}
      onBlur={finish}
    />
  );
}
