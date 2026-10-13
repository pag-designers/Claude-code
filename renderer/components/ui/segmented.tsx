'use client';

import * as React from 'react';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { spring } from '@/lib/motion';

export interface SegmentedOption<T extends string> {
  value: T;
  label: React.ReactNode;
  icon?: React.ReactNode;
  disabled?: boolean;
  hint?: string;
}

/** Radio-group semantics, animated thumb. Arrow keys move the selection (roving tabindex). */
export function Segmented<T extends string>({
  value,
  onValueChange,
  options,
  label,
  size = 'md',
  className,
  disabled,
}: {
  value: T;
  onValueChange: (v: T) => void;
  options: SegmentedOption<T>[];
  label: string;
  size?: 'sm' | 'md';
  className?: string;
  disabled?: boolean;
}) {
  const id = React.useId();
  const refs = React.useRef<(HTMLButtonElement | null)[]>([]);

  const move = (from: number, dir: 1 | -1) => {
    const n = options.length;
    for (let step = 1; step <= n; step++) {
      const idx = (from + dir * step + n * 2) % n;
      const opt = options[idx];
      if (opt && !opt.disabled) {
        onValueChange(opt.value);
        refs.current[idx]?.focus();
        return;
      }
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn('inline-flex items-center gap-0.5 rounded-lg border bg-muted p-0.5', className)}
    >
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
            disabled={disabled || o.disabled}
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
              'relative inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors duration-(--duration-fast) disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-4',
              size === 'md' ? 'h-8 px-3.5 text-sm' : 'h-7 px-3 text-xs',
              active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {active ? (
              <motion.span
                layoutId={`seg-${id}`}
                transition={spring.snappy}
                className="absolute inset-0 rounded-md border border-border-strong bg-card shadow-xs"
                aria-hidden
              />
            ) : null}
            <span className="relative z-10 inline-flex items-center gap-2">
              {o.icon}
              {o.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
