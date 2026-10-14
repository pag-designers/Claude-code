'use client';

import * as React from 'react';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useBrandFonts } from '@/lib/brand/fonts';
import { cn } from '@/lib/utils';
import { EDITOR_FONTS } from '../fonts';

export interface FontChoice {
  family: string;
  /** Weights this family really has (shipped or uploaded). */
  weights: number[];
  source: 'brand' | 'shipped' | 'unknown';
}

/** Brand fonts first (alphabetical), then the shipped ones, plus the current family when it is neither. */
export function fontChoices(
  brand: readonly { family: string; weight: number }[],
  current?: string,
): FontChoice[] {
  const by = new Map<string, Set<number>>();
  for (const f of brand) by.set(f.family, (by.get(f.family) ?? new Set()).add(f.weight));
  const out: FontChoice[] = [...by]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([family, w]) => ({
      family,
      weights: [...w].sort((a, b) => a - b),
      source: 'brand' as const,
    }));
  for (const f of EDITOR_FONTS)
    if (!by.has(f.family)) out.push({ family: f.family, weights: f.weights, source: 'shipped' });
  if (current && !out.some((o) => o.family === current))
    out.push({ family: current, weights: [], source: 'unknown' });
  return out;
}

/**
 * Font family select with LIVE previews: every option is drawn in its own face. Lists the Brand Kit's uploaded fonts
 * (registered with `document.fonts`, so the canvas draws them too) above the fonts Clipfern ships.
 */
export function FontSelect({
  value,
  mixed,
  onChange,
  testId = 'font-family',
  label = 'Font family',
}: {
  value: string;
  mixed?: boolean;
  onChange: (family: string, choice: FontChoice | undefined) => void;
  testId?: string;
  label?: string;
}) {
  const { fonts } = useBrandFonts();
  const choices = React.useMemo(
    () => fontChoices(fonts, mixed ? undefined : value),
    [fonts, value, mixed],
  );
  const group = (title: string, source: FontChoice['source']) => {
    const list = choices.filter((c) => c.source === source);
    if (list.length === 0) return null;
    return (
      <SelectGroup>
        <SelectLabel>{title}</SelectLabel>
        {list.map((c) => (
          <SelectItem
            key={c.family}
            value={c.family}
            aria-label={c.family}
            data-source={c.source}
            className="min-h-8 text-sm"
            style={{ fontFamily: `'${c.family}', var(--font-sans)` }}
          >
            {c.source === 'unknown' ? `${c.family} (not bundled)` : c.family}
          </SelectItem>
        ))}
      </SelectGroup>
    );
  };
  const hasBrand = choices.some((c) => c.source === 'brand');
  return (
    <Select
      value={mixed ? '' : value}
      onValueChange={(v) =>
        onChange(
          v,
          choices.find((c) => c.family === v),
        )
      }
    >
      <SelectTrigger
        aria-label={label}
        data-testid={testId}
        className={cn('h-7 min-w-0 flex-1 px-2 text-xs')}
        style={mixed ? undefined : { fontFamily: `'${value}', var(--font-sans)` }}
      >
        <SelectValue placeholder={mixed ? 'Mixed' : undefined} />
      </SelectTrigger>
      <SelectContent onEscapeKeyDown={(e) => e.stopPropagation()}>
        {group('Brand Kit fonts', 'brand')}
        {group(hasBrand ? 'Clipfern fonts' : 'Fonts', 'shipped')}
        {group('Other', 'unknown')}
      </SelectContent>
    </Select>
  );
}
