'use client';

import * as React from 'react';
import { Stamp } from 'lucide-react';
import type { ClipView } from '@shared/pipeline';
import { badgeVariants } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { BRAND_SECTION_ID } from './brand-section';
import { needsRender } from './logic';
import { useClipBrand } from './use-brand-apply';

/**
 * Header chip of the clip drawer: "Branded · <kit>" (amber when the kit changed or the setting differs from the render).
 * Clicking it jumps to the Brand Kit section. Renders nothing for a plain, unbranded clip.
 */
export function DrawerBrandChip({
  clip,
  onOpen,
}: {
  clip: ClipView;
  /** Switch the drawer to the tab that holds the Brand Kit section. */
  onOpen: () => void;
}) {
  const b = useClipBrand(clip);
  if (b.loading || b.state === 'plain' || b.state === 'unrendered') return null;
  const outdated = needsRender(b.state);
  const text = clip.brandApplied
    ? outdated
      ? 'Brand Kit outdated'
      : `Branded · ${b.appliedName ?? 'deleted kit'}`
    : 'Brand Kit not applied';
  const go = () => {
    onOpen();
    // the section mounts with the tab: scroll once it exists
    window.setTimeout(() => {
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      document
        .getElementById(BRAND_SECTION_ID)
        ?.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
    }, 60);
  };
  return (
    <button
      type="button"
      onClick={go}
      data-testid="drawer-brand-chip"
      data-outdated={outdated || undefined}
      aria-label={`${text}. Open the Brand Kit section`}
      className={cn(
        badgeVariants({ variant: outdated ? 'warning' : 'primary' }),
        'cursor-pointer outline-none transition-colors duration-(--duration-fast) hover:brightness-110 focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      <Stamp /> {text}
    </button>
  );
}
