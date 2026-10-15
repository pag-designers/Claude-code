'use client';

import * as React from 'react';
import Link from 'next/link';
import { ArrowUpRight, Palette, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useBrandKits, useDefaultBrandKitId } from '@/lib/brand/queries';
import { BrandKitSelect } from './kit-select';
import { BRAND_KIT_HREF, DEFAULT_KIT, NO_KIT, normalizeChoice } from './logic';

const STORAGE_KEY = 'clipfern.start.brandKitId';

function readStored(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? DEFAULT_KIT;
  } catch {
    return DEFAULT_KIT;
  }
}

/**
 * The Brand Kit run option of the Home form (`PipelineOptions.brandKitId`): 'default' (the default kit), 'none' or a
 * kit id. Remembered between visits like a per-viewer preference; a remembered kit that was deleted since falls back
 * to 'default'. Returns the effective value to send, and the setter.
 */
export function useStartBrandKit(): readonly [string, (v: string) => void] {
  const kits = useBrandKits();
  // the select only renders once the kit list has loaded, so a first client render that differs from the prerender is invisible
  const [stored, setStored] = React.useState<string>(readStored);
  const value = kits.data
    ? normalizeChoice(stored, kits.data.items, DEFAULT_KIT, [DEFAULT_KIT, NO_KIT])
    : stored === NO_KIT
      ? NO_KIT
      : DEFAULT_KIT;
  const set = React.useCallback((v: string) => {
    setStored(v);
    try {
      localStorage.setItem(STORAGE_KEY, v);
    } catch {
      /* storage blocked: the choice simply is not remembered */
    }
  }, []);
  return [value, set] as const;
}

/** "Brand Kit" select next to the other run options on Home; a "Create a Brand Kit" link while there are no kits. */
export function BrandKitStartOption({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const kitsQ = useBrandKits();
  const defaultKitId = useDefaultBrandKitId() ?? null;
  const kits = kitsQ.data?.items ?? [];
  const defaultName = kits.find((k) => k.id === defaultKitId)?.name ?? null;
  const labelCls = 'text-xs font-semibold uppercase tracking-wider text-subtle';

  return (
    <div className="flex flex-col gap-2" data-testid="home-brand-option">
      <Label htmlFor="brand-kit-start" className={labelCls}>
        Brand Kit
      </Label>
      {kitsQ.isPending ? (
        <Skeleton className="h-11 w-52 rounded-md" aria-label="Loading Brand Kits" />
      ) : kitsQ.isError ? (
        <div className="flex h-11 w-52 items-center gap-2 text-xs text-muted-foreground">
          <TriangleAlert className="size-4 shrink-0 text-warning" aria-hidden />
          <span className="min-w-0">Could not load your kits.</span>
          <Button variant="link" size="xs" onClick={() => void kitsQ.refetch()}>
            Retry
          </Button>
        </div>
      ) : kits.length === 0 ? (
        <Link
          id="brand-kit-start"
          href={BRAND_KIT_HREF}
          data-testid="home-brand-create"
          className="flex h-11 w-52 items-center gap-2.5 rounded-lg border border-dashed border-border-strong px-3 text-sm text-muted-foreground outline-none transition-colors duration-(--duration-fast) hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Palette className="size-4 shrink-0 text-subtle" aria-hidden />
          <span className="min-w-0 flex-1 truncate">Create a Brand Kit</span>
          <ArrowUpRight className="size-4 shrink-0 text-subtle" aria-hidden />
        </Link>
      ) : (
        <BrandKitSelect
          id="brand-kit-start"
          testId="home-brand-kit"
          className="h-11 w-52"
          value={value}
          onValueChange={onChange}
          kits={kits}
          specials={[
            {
              value: DEFAULT_KIT,
              label: defaultName ? `Default: ${defaultName}` : 'Default kit',
            },
            { value: NO_KIT, label: 'No brand kit' },
          ]}
        />
      )}
    </div>
  );
}
