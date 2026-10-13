import * as React from 'react';
import { AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Label } from './label';

/** Label + control + hint/error, wired for a11y (htmlFor, aria-describedby is the caller's job via ids). */
export function Field({
  label,
  htmlFor,
  description,
  error,
  className,
  children,
  action,
}: {
  label: React.ReactNode;
  htmlFor?: string;
  description?: React.ReactNode;
  error?: string;
  className?: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={htmlFor}>{label}</Label>
        {action}
      </div>
      {children}
      {error ? (
        <p role="alert" className="flex items-center gap-1.5 text-xs text-danger">
          <AlertCircle className="size-3.5 shrink-0" aria-hidden />
          {error}
        </p>
      ) : description ? (
        <p className="text-xs text-muted-foreground">{description}</p>
      ) : null}
    </div>
  );
}
