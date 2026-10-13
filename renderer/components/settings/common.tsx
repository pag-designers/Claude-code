'use client';

import * as React from 'react';
import { Check, X } from 'lucide-react';
import { toast } from 'sonner';
import type { ValidationResult } from '@shared/domain';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { invoke } from '@/lib/ipc';
import { cn } from '@/lib/utils';

export function SettingsCard({
  title,
  description,
  action,
  children,
  className,
  id,
}: {
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <Card id={id} className={className}>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <CardTitle className="font-display text-lg">{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </div>
        {action}
      </CardHeader>
      <CardContent className="flex flex-col gap-5 pt-5">{children}</CardContent>
    </Card>
  );
}

/** Label + helper on the left, control on the right. */
export function SettingRow({
  label,
  description,
  htmlFor,
  children,
  className,
}: {
  label: string;
  description?: React.ReactNode;
  htmlFor?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center justify-between gap-6', className)}>
      <div className="min-w-0">
        <label htmlFor={htmlFor} className="text-sm font-medium">
          {label}
        </label>
        {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** Sticky bar for react-hook-form sections: appears only while there are unsaved changes. */
export function SaveBar({
  dirty,
  saving,
  onReset,
  onSave,
}: {
  dirty: boolean;
  saving: boolean;
  onReset: () => void;
  onSave: () => void;
}) {
  if (!dirty) return null;
  return (
    <div
      role="region"
      aria-label="Unsaved changes"
      className="sticky bottom-0 z-20 -mx-2 mt-2 flex animate-in items-center justify-between gap-4 rounded-xl border border-border-strong bg-popover/95 px-4 py-3 shadow-lg backdrop-blur slide-in-from-bottom-2 fade-in-0"
    >
      <p className="flex items-center gap-2 text-sm font-medium">
        <span className="size-2 rounded-full bg-warning" aria-hidden /> You have unsaved changes
      </p>
      <div className="flex items-center gap-2">
        <Button variant="ghost" onClick={onReset} disabled={saving}>
          Reset
        </Button>
        <Button variant="primary" onClick={onSave} loading={saving}>
          Save changes
        </Button>
      </div>
    </div>
  );
}

export function ResultChip({
  result,
  error,
}: {
  result: ValidationResult | null;
  error?: string | null;
}) {
  if (error)
    return (
      <Badge variant="danger" role="status" className="max-w-full whitespace-normal">
        <X /> {error}
      </Badge>
    );
  if (!result) return null;
  return (
    <span role="status" className="inline-flex flex-wrap items-center gap-2">
      <Badge variant={result.ok ? 'success' : 'danger'}>
        {result.ok ? <Check /> : <X />}
        {result.ok ? 'Connected' : 'Failed'} · {Math.round(result.latencyMs)} ms
      </Badge>
      <span className={cn('text-xs', result.ok ? 'text-muted-foreground' : 'text-danger')}>
        {result.message}
      </span>
    </span>
  );
}

export async function openExternal(url: string) {
  try {
    await invoke('shell:openExternal', { url });
  } catch (e) {
    toast.error('Could not open link', { description: e instanceof Error ? e.message : undefined });
  }
}
