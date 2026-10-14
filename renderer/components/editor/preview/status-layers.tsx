'use client';

import * as React from 'react';
import { CircleAlert, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

/** Loading / error layers drawn over the preview canvas. */
export function previewErrorText(reason: string | null): string {
  return `Preview unavailable: ${reason?.trim() || 'this media could not be loaded'}`;
}

export function PreviewError({
  reason,
  extra,
  onRetry,
}: {
  reason: string | null;
  extra?: number;
  onRetry?: () => void;
}) {
  return (
    <div
      data-testid="preview-error"
      role="alert"
      className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/80 p-6 text-center backdrop-blur-[2px]"
    >
      <span className="grid size-10 place-items-center rounded-full bg-danger-soft text-danger">
        <CircleAlert className="size-5" aria-hidden />
      </span>
      <p className="max-w-[28ch] text-sm font-medium text-foreground">{previewErrorText(reason)}</p>
      {extra && extra > 0 ? (
        <p className="text-xs text-muted-foreground">
          {extra} more {extra === 1 ? 'asset is' : 'assets are'} unavailable too.
        </p>
      ) : null}
      {onRetry ? (
        <Button size="sm" variant="outline" onClick={onRetry} data-testid="preview-retry">
          <RefreshCw className="size-3.5" aria-hidden /> Try again
        </Button>
      ) : null}
    </div>
  );
}

/** Shown only after a short delay so quick loads never flash a skeleton. */
export function PreviewLoading({ delayMs = 160 }: { delayMs?: number }) {
  const [show, setShow] = React.useState(delayMs === 0);
  React.useEffect(() => {
    if (delayMs === 0) return;
    const id = window.setTimeout(() => setShow(true), delayMs);
    return () => window.clearTimeout(id);
  }, [delayMs]);
  if (!show) return null;
  return (
    <div
      data-testid="preview-loading"
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute inset-0 flex flex-col items-center justify-end gap-2 p-4"
    >
      <Skeleton className="absolute inset-0 rounded-none opacity-60" />
      <span className="relative rounded-full bg-popover/90 px-3 py-1 text-xs font-medium text-muted-foreground shadow-sm">
        Loading media…
      </span>
    </div>
  );
}
