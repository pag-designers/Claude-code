'use client';

import * as React from 'react';
import Link from 'next/link';
import { Palette } from 'lucide-react';
import type { TextItem } from '@shared/editor';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { useBrandFonts } from '@/lib/brand/fonts';
import { brandRestylePatch, brandStyleName } from '@/lib/editor-panels/brand';
import { useBrandPanelKit } from '@/lib/editor-panels/brand-hooks';
import { textStyleCss } from '@/lib/editor-panels/brand-css';
import { cn } from '@/lib/utils';
import { useInspector } from '../context';

const KIND_LABEL = {
  title: 'Title',
  hook: 'Hook',
  cta: 'Call to action',
  'lower-third': 'Lower third',
} as const;

/**
 * "Brand Kit style" chip: lists the Brand Kit's text styles and restyles the selected text layers with the one you pick
 * (font, size, colours, effects, animations, vertical position; the words and timing stay). The chip names the kit
 * style a layer currently follows.
 */
export function BrandStyleChip() {
  const ctx = useInspector();
  const panel = useBrandPanelKit();
  useBrandFonts();
  const [open, setOpen] = React.useState(false);
  const ref = ctx.read((i) => (i as TextItem).styleRef);
  const current = panel.kit && !ref.mixed ? brandStyleName(panel.kit, ref.value) : null;
  const styles = panel.kit?.spec.textStyles ?? [];

  let body: React.ReactNode;
  if (panel.loading) body = <Skeleton className="h-16 w-full rounded-md" />;
  else if (panel.error) body = <p className="text-xs text-danger">Could not load the Brand Kit.</p>;
  else if (!panel.kit)
    body = (
      <p className="text-xs leading-4 text-muted-foreground">
        No Brand Kit yet.{' '}
        <Link href="/brand-kit/" className="font-medium text-primary-text hover:underline">
          Create one
        </Link>{' '}
        to reuse its text styles here.
      </p>
    );
  else if (styles.length === 0)
    body = (
      <p className="text-xs leading-4 text-muted-foreground">
        {panel.kit.name} has no text styles yet.{' '}
        <Link href="/brand-kit/" className="font-medium text-primary-text hover:underline">
          Add some
        </Link>
        .
      </p>
    );
  else
    body = (
      <ul className="flex flex-col gap-1" aria-label="Brand Kit text styles">
        {styles.map((ts) => {
          const active = !ref.mixed && ref.value === `brand:${panel.kit!.id}:${ts.id}`;
          return (
            <li key={ts.id}>
              <button
                type="button"
                data-testid="brand-style-option"
                data-style-id={ts.id}
                aria-pressed={active}
                onClick={() => {
                  ctx.set(
                    brandRestylePatch(panel.kit!, ts, ctx.project.canvas),
                    `Apply “${ts.name}”`,
                  );
                  setOpen(false);
                }}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-md px-1.5 py-1 text-left outline-none transition-colors duration-(--duration-fast) hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
                  active && 'bg-primary-soft',
                )}
              >
                <span className="flex h-9 w-14 shrink-0 items-center justify-center overflow-hidden rounded bg-black">
                  <span style={{ ...textStyleCss(ts.style, 0.12), whiteSpace: 'nowrap' }}>Aa</span>
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium">{ts.name}</span>
                  <span className="block truncate text-2xs text-subtle">{KIND_LABEL[ts.kind]}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="brand-style-chip"
          aria-label={current ? `Brand Kit style: ${current}` : 'Brand Kit style'}
          className={cn(
            'inline-flex h-6 max-w-[11rem] items-center gap-1.5 rounded-full border px-2.5 text-2xs font-medium outline-none transition-colors duration-(--duration-fast) focus-visible:ring-2 focus-visible:ring-ring',
            current
              ? 'border-transparent bg-primary-soft text-primary-text'
              : 'border-border-strong text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
        >
          <Palette className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{current ?? 'Brand Kit style'}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-64 p-2"
        data-testid="brand-style-popover"
        onEscapeKeyDown={(e) => e.stopPropagation()}
      >
        <p className="px-1.5 pb-1.5 text-2xs font-semibold uppercase tracking-wider text-subtle">
          {panel.kit ? `${panel.kit.name} text styles` : 'Brand Kit'}
        </p>
        {body}
      </PopoverContent>
    </Popover>
  );
}
