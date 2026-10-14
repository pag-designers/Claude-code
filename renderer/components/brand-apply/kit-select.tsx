'use client';

import * as React from 'react';
import type { BrandKitSummary } from '@shared/brand';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

/** Up to three of the kit's colours as tiny dots (user content, so the colours are data, not design tokens). */
export function KitSwatches({ swatches, className }: { swatches: string[]; className?: string }) {
  if (swatches.length === 0) return null;
  return (
    <span aria-hidden className={cn('flex shrink-0 items-center -space-x-1', className)}>
      {swatches.slice(0, 3).map((c, i) => (
        <span
          key={`${c}-${i}`}
          className="size-3 rounded-full border border-border-strong"
          style={{ backgroundColor: c }}
        />
      ))}
    </span>
  );
}

export interface KitSpecialOption {
  value: string;
  label: string;
}

/**
 * Select of the user's Brand Kits with leading "special" options (Inherit, Default, No brand kit). The caller makes
 * sure `value` is selectable (see `normalizeChoice`), so the trigger is never blank.
 */
export function BrandKitSelect({
  value,
  onValueChange,
  kits,
  specials,
  id,
  className,
  disabled,
  ariaLabel,
  testId,
}: {
  value: string;
  onValueChange: (v: string) => void;
  kits: readonly BrandKitSummary[];
  specials: readonly KitSpecialOption[];
  id?: string;
  className?: string;
  disabled?: boolean;
  ariaLabel?: string;
  testId?: string;
}) {
  return (
    <Select value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger id={id} className={className} aria-label={ariaLabel} data-testid={testId}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {specials.map((s) => (
          <SelectItem key={s.value} value={s.value} data-testid={`brand-option-${s.value}`}>
            {s.label}
          </SelectItem>
        ))}
        {kits.map((k) => (
          <SelectItem key={k.id} value={k.id} data-testid={`brand-option-${k.id}`}>
            <span className="flex min-w-0 items-center gap-2">
              <KitSwatches swatches={k.swatches} />
              <span className="truncate">{k.name}</span>
              {k.isDefault ? <span className="text-2xs text-subtle">{' default'}</span> : null}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
