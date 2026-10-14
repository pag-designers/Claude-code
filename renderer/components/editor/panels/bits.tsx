'use client';

import * as React from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Small uppercase heading used between groups in a bin tab. */
export function GroupLabel({
  children,
  action,
  className,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex min-h-6 items-center justify-between gap-2', className)}>
      <h3 className="text-2xs font-semibold uppercase tracking-wider text-subtle">{children}</h3>
      {action}
    </div>
  );
}

/** Compact "nothing here yet" note: icon, one line of what, one line of why/what next. */
export function Note({
  icon: Icon,
  title,
  children,
  className,
}: {
  icon: LucideIcon;
  title: string;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center gap-1.5 rounded-xl border border-dashed px-4 py-6 text-center',
        className,
      )}
    >
      <span className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="size-4.5" aria-hidden />
      </span>
      <p className="text-sm font-semibold">{title}</p>
      {children ? (
        <p className="max-w-[240px] text-xs leading-4 text-muted-foreground">{children}</p>
      ) : null}
    </div>
  );
}

/** Shared look of every clickable tile in the bin. */
export const tileBase =
  'group relative flex min-w-0 flex-col gap-1.5 rounded-lg border bg-card p-1.5 text-left outline-none transition-[border-color,background-color,box-shadow,transform] duration-(--duration-fast) ease-(--ease-standard) hover:border-border-strong hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.985]';
