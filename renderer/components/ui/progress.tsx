'use client';

import * as React from 'react';
import * as ProgressPrimitive from '@radix-ui/react-progress';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const bar = cva(
  'h-full rounded-full transition-[width,background-color] duration-(--duration-slow) ease-(--ease-standard)',
  {
    variants: {
      tone: {
        primary: 'bg-primary',
        success: 'bg-success',
        warning: 'bg-warning',
        danger: 'bg-danger',
        info: 'bg-info',
        viral: 'bg-viral',
      },
    },
    defaultVariants: { tone: 'primary' },
  },
);

interface ProgressProps
  extends
    Omit<React.ComponentProps<typeof ProgressPrimitive.Root>, 'value'>,
    VariantProps<typeof bar> {
  /** 0–100. `null` renders an indeterminate sweep. */
  value: number | null;
  trackClassName?: string;
  /** Marker lines at percentages (0–100), e.g. budget target. */
  markers?: { at: number; label: string }[];
}

export function Progress({ value, tone, className, markers, ...props }: ProgressProps) {
  const pct = value === null ? null : Math.max(0, Math.min(100, value));
  return (
    <div className="relative w-full">
      <ProgressPrimitive.Root
        data-slot="progress"
        value={pct}
        className={cn('relative h-2 w-full overflow-hidden rounded-full bg-muted', className)}
        {...props}
      >
        {pct === null ? (
          <ProgressPrimitive.Indicator
            className={cn('absolute inset-y-0 left-0 w-1/3 animate-indeterminate', bar({ tone }))}
          />
        ) : (
          <ProgressPrimitive.Indicator className={bar({ tone })} style={{ width: `${pct}%` }} />
        )}
      </ProgressPrimitive.Root>
      {markers?.map((m) => (
        <span
          key={m.label}
          title={m.label}
          aria-hidden
          className="absolute -top-0.5 h-3 w-0.5 rounded-full bg-foreground/70"
          style={{ left: `calc(${m.at}% - 1px)` }}
        />
      ))}
    </div>
  );
}
