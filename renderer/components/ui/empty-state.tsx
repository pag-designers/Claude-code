import * as React from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Illustration-free empty state: an icon "lens" over soft concentric rings and a dotted field.
 * Always explains what will appear here and offers the next action.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  steps,
  actions,
  size = 'md',
  className,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description?: React.ReactNode;
  /** Optional "how it works" bullets. */
  steps?: string[];
  actions?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  children?: React.ReactNode;
}) {
  const big = size === 'lg';
  return (
    <div
      className={cn(
        'relative isolate flex flex-col items-center justify-center overflow-hidden text-center',
        size === 'sm' ? 'px-6 py-10' : big ? 'min-h-[420px] px-8 py-16' : 'px-8 py-14',
        className,
      )}
    >
      <div
        aria-hidden
        className="bg-dots absolute inset-0 -z-10 [mask-image:radial-gradient(ellipse_60%_70%_at_50%_45%,#000_30%,transparent_75%)]"
      />
      <div className="relative mb-5 flex items-center justify-center" aria-hidden>
        <span className="absolute size-28 rounded-full border border-border/70" />
        <span className="absolute size-20 rounded-full border border-border" />
        <span className="absolute size-16 rounded-full bg-primary-soft blur-xl" />
        <span className="relative flex size-12 items-center justify-center rounded-xl border border-border-strong bg-raised text-primary-text shadow-sm">
          <Icon className="size-5.5" strokeWidth={1.75} />
        </span>
      </div>
      <h3
        className={cn('font-display font-semibold text-foreground', big ? 'text-2xl' : 'text-xl')}
      >
        {title}
      </h3>
      {description ? (
        <p className="mt-2 max-w-md text-base text-muted-foreground text-balance">{description}</p>
      ) : null}
      {steps?.length ? (
        <ol className="mt-5 flex max-w-xl flex-col gap-2 text-left text-sm text-muted-foreground">
          {steps.map((s, i) => (
            <li key={s} className="flex items-start gap-3">
              <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-2xs font-semibold text-foreground">
                {i + 1}
              </span>
              <span>{s}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {actions ? (
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2.5">{actions}</div>
      ) : null}
      {children}
    </div>
  );
}
