'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

export interface ChipOption<T extends string> {
  value: T;
  label: string;
  hint?: string;
  disabled?: boolean;
}

/** Preset chips (radio semantics) used for clip length / count / aspect. */
export function ChipGroup<T extends string>({
  label,
  value,
  onValueChange,
  options,
  className,
}: {
  label: string;
  value: T;
  onValueChange: (v: T) => void;
  options: ChipOption<T>[];
  className?: string;
}) {
  const refs = React.useRef<(HTMLButtonElement | null)[]>([]);
  const move = (from: number, dir: 1 | -1) => {
    const n = options.length;
    const idx = (from + dir + n) % n;
    const opt = options[idx];
    if (opt && !opt.disabled) {
      onValueChange(opt.value);
      refs.current[idx]?.focus();
    }
  };
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <span
        className="text-xs font-semibold uppercase tracking-wider text-subtle"
        id={`chips-${label}`}
      >
        {label}
      </span>
      <div role="radiogroup" aria-labelledby={`chips-${label}`} className="flex flex-wrap gap-1.5">
        {options.map((o, i) => {
          const active = o.value === value;
          return (
            <button
              key={o.value}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={active}
              title={o.hint}
              tabIndex={active ? 0 : -1}
              disabled={o.disabled}
              onClick={() => onValueChange(o.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                  e.preventDefault();
                  move(i, 1);
                } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  move(i, -1);
                }
              }}
              className={cn(
                'h-8 rounded-full border px-3.5 text-sm font-medium transition-[background-color,border-color,color,transform] duration-(--duration-fast) active:scale-[0.97] disabled:opacity-45',
                active
                  ? 'border-primary/70 bg-primary-soft text-primary-text'
                  : 'border-border-strong bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
