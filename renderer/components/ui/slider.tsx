'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/** Native range input styled with tokens (see `.range` in globals.css). Keyboard + a11y for free. */
export function Slider({
  value,
  onValueChange,
  min = 0,
  max = 100,
  step = 1,
  className,
  ...props
}: Omit<React.ComponentProps<'input'>, 'value' | 'onChange' | 'type' | 'min' | 'max' | 'step'> & {
  value: number;
  onValueChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  const pct = ((value - min) / (max - min || 1)) * 100;
  return (
    <input
      type="range"
      className={cn('range', className)}
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onValueChange(Number(e.target.value))}
      style={{ '--range-fill': `${pct}%` } as React.CSSProperties}
      {...props}
    />
  );
}
