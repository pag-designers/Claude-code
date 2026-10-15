'use client';

import * as React from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Collapsible group of rows with an uppercase caption (dense NLE style). Open state is remembered per title. */
export function Section({
  title,
  children,
  action,
  defaultOpen = true,
  testId,
}: {
  title: string;
  children: React.ReactNode;
  /** Right-aligned header control (e.g. a Reset button). */
  action?: React.ReactNode;
  defaultOpen?: boolean;
  testId?: string;
}) {
  const key = `clipfern.inspector.section.${title}`;
  const [open, setOpen] = React.useState(() => {
    try {
      const v = localStorage.getItem(key);
      return v === null ? defaultOpen : v === '1';
    } catch {
      return defaultOpen;
    }
  });
  const id = React.useId();
  const toggle = () => {
    setOpen((o) => {
      try {
        localStorage.setItem(key, o ? '0' : '1');
      } catch {
        /* storage unavailable: the section simply is not remembered */
      }
      return !o;
    });
  };
  return (
    <section
      className="border-b border-border last:border-b-0"
      data-testid={testId ?? `section-${title}`}
    >
      <div className="flex h-8 items-center gap-1 pl-2 pr-3">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={toggle}
          className="flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md px-1 text-left text-2xs font-semibold uppercase tracking-wider text-subtle outline-none transition-colors duration-(--duration-fast) hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight
            className={cn(
              'size-3.5 shrink-0 transition-transform duration-(--duration-fast)',
              open && 'rotate-90',
            )}
            aria-hidden
          />
          <span className="truncate">{title}</span>
        </button>
        {action}
      </div>
      {open && React.Children.toArray(children).length > 0 ? (
        <div id={id} className="flex flex-col gap-1.5 px-3 pb-3 pt-0.5">
          {children}
        </div>
      ) : null}
    </section>
  );
}

/** Label + controls on one line. */
export function Row({
  label,
  hint,
  children,
  className,
  labelFor,
}: {
  label: React.ReactNode;
  /** Small right-aligned read-out next to the label (e.g. "−6.0 dB"). */
  hint?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  labelFor?: string;
}) {
  return (
    <div
      className={cn(
        'grid min-h-7 grid-cols-[4.75rem_minmax(0,1fr)] items-center gap-x-2',
        className,
      )}
    >
      <label
        htmlFor={labelFor}
        className="flex min-w-0 flex-col text-xs leading-4 text-muted-foreground"
      >
        <span className="truncate">{label}</span>
        {hint ? <span className="truncate text-2xs tabular-nums text-subtle">{hint}</span> : null}
      </label>
      <div className="flex min-w-0 items-center gap-1.5">{children}</div>
    </div>
  );
}

/** Small caption under a group of rows. */
export function Hint({
  children,
  className,
  testId,
}: {
  children: React.ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <p data-testid={testId} className={cn('text-2xs leading-4 text-subtle', className)}>
      {children}
    </p>
  );
}

/** Dense inline message (errors with a recovery action, short notices). Not for page-level banners. */
export function Notice({
  tone = 'info',
  title,
  children,
  action,
  testId,
}: {
  tone?: 'info' | 'danger' | 'warning';
  title?: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
  testId?: string;
}) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      data-testid={testId}
      className={cn(
        'flex items-start gap-2 rounded-md border px-2.5 py-2 text-xs leading-4',
        tone === 'danger' && 'border-danger/35 bg-danger-soft text-foreground',
        tone === 'warning' && 'border-warning/35 bg-warning-soft text-foreground',
        tone === 'info' && 'border-info/30 bg-info-soft text-foreground',
      )}
    >
      <div className="min-w-0 flex-1">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? <div className="text-muted-foreground">{children}</div> : null}
      </div>
      {action}
    </div>
  );
}
