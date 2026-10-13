import * as React from 'react';
import { cn } from '@/lib/utils';

/** Standard page container: centered, capped for ultrawide, 32px gutters. */
export function Page({
  className,
  wide,
  ...props
}: React.ComponentProps<'div'> & { wide?: boolean }) {
  return (
    <div
      className={cn(
        'mx-auto flex w-full flex-col gap-8 px-8 py-8',
        wide ? 'max-w-[1680px]' : 'max-w-[1360px]',
        className,
      )}
      {...props}
    />
  );
}

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
  className,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  eyebrow?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={cn('flex flex-wrap items-end justify-between gap-4', className)}>
      <div className="min-w-0">
        {eyebrow ? (
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-primary-text">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="font-display text-3xl font-semibold leading-tight">{title}</h1>
        {description ? (
          <p className="mt-1.5 max-w-2xl text-base text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function SectionTitle({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-end justify-between gap-4', className)}>
      <div>
        <h2 className="font-display text-lg font-semibold">{title}</h2>
        {description ? <p className="mt-0.5 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}
