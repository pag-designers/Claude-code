'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * A neutral stand-in for a video frame (token gradient, no media) that previews overlays at the right proportions.
 * Children are positioned in percentages of the frame; `containerType: size` lets them use `cqw`/`cqh` units.
 */
export function PhoneFrame({
  width,
  height,
  children,
  className,
  testId,
  label,
}: {
  width: number;
  height: number;
  children?: React.ReactNode;
  className?: string;
  testId?: string;
  label: string;
}) {
  return (
    <div
      role="img"
      aria-label={label}
      data-testid={testId}
      data-canvas={`${width}x${height}`}
      className={cn(
        'relative overflow-hidden rounded-[18px] border border-border-strong shadow-md',
        className,
      )}
      style={{
        aspectRatio: `${width} / ${height}`,
        containerType: 'size',
        backgroundImage:
          'radial-gradient(120% 70% at 20% 10%, var(--neutral-600) 0%, transparent 60%), linear-gradient(170deg, var(--neutral-700) 0%, var(--neutral-800) 50%, var(--neutral-900) 100%)',
      }}
    >
      {/* a faint horizon + figure keep the frame from reading as an empty box */}
      <div
        aria-hidden
        className="absolute inset-x-0 bottom-0 h-[38%] opacity-50"
        style={{
          backgroundImage:
            'linear-gradient(to top, var(--neutral-950), transparent), radial-gradient(60% 90% at 50% 100%, var(--neutral-500) 0%, transparent 70%)',
        }}
      />
      {children}
    </div>
  );
}
