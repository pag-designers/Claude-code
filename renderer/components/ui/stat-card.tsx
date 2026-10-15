import * as React from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Skeleton } from './skeleton';

export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  loading,
  tone = 'default',
  className,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  icon?: LucideIcon;
  loading?: boolean;
  tone?: 'default' | 'success' | 'warning' | 'danger';
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-xs', className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-muted-foreground">{label}</span>
        {Icon ? (
          <span className="flex size-7 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <Icon className="size-3.5" aria-hidden />
          </span>
        ) : null}
      </div>
      {loading ? (
        <Skeleton className="h-8 w-24" />
      ) : (
        <div
          className={cn(
            'font-display text-3xl font-semibold tabular-nums leading-none tracking-tight',
            tone === 'success' && 'text-success',
            tone === 'warning' && 'text-warning',
            tone === 'danger' && 'text-danger',
          )}
        >
          {value}
        </div>
      )}
      {hint ? <p className="text-xs leading-4 text-subtle">{hint}</p> : null}
    </div>
  );
}
