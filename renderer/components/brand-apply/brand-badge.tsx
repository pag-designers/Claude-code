'use client';

import * as React from 'react';
import { Stamp } from 'lucide-react';
import type { ClipView } from '@shared/pipeline';
import { Tip } from '@/components/ui/tooltip';
import { useBrandKits } from '@/lib/brand/queries';
import { cn } from '@/lib/utils';

/**
 * Small "Branded" pill for clip cards and rows: the clip's current render carries a Brand Kit. The tooltip names the
 * kit and its revision; the kit list is one cached query shared by every badge on the page.
 */
export function BrandedBadge({
  applied,
  className,
}: {
  applied: NonNullable<ClipView['brandApplied']>;
  className?: string;
}) {
  const kits = useBrandKits();
  const name = kits.data?.items.find((k) => k.id === applied.kitId)?.name ?? null;
  const label = name ?? 'a Brand Kit that was deleted';
  return (
    <Tip content={`Branded with ${label} (rev ${applied.rev})`}>
      <span
        data-testid="clip-branded-badge"
        data-kit-id={applied.kitId}
        className={cn(
          'inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-card/90 px-2 text-2xs font-semibold text-foreground backdrop-blur-sm',
          className,
        )}
      >
        <Stamp className="size-3 text-primary-text" aria-hidden />
        Branded
        <span className="sr-only"> with {label}</span>
      </span>
    </Tip>
  );
}
