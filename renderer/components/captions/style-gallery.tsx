'use client';

import * as React from 'react';
import { Check, Lock, Plus } from 'lucide-react';
import type { CaptionStyle } from '@shared/cp2';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { StyleThumb } from './style-thumb';

function Tile({
  style,
  selected,
  current,
  onSelect,
  clipId,
}: {
  style: CaptionStyle;
  selected: boolean;
  /** The style the caller currently uses (marked with a check). */
  current: boolean;
  onSelect: (id: string) => void;
  clipId?: string;
}) {
  return (
    <button
      type="button"
      data-testid="style-tile"
      data-style-id={style.id}
      aria-pressed={selected}
      onClick={() => onSelect(style.id)}
      className={cn(
        'group relative flex min-w-0 flex-col gap-1.5 rounded-lg p-1 text-left outline-none transition-[background-color,box-shadow] duration-(--duration-fast)',
        'hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
        selected && 'bg-primary-soft shadow-[inset_0_0_0_2px_var(--primary)]',
      )}
    >
      <div className="relative overflow-hidden rounded-md border border-border-strong">
        <StyleThumb style={style} clipId={clipId} />
        {current ? (
          <span
            className="absolute right-1.5 top-1.5 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-xs"
            title="Currently used"
          >
            <Check className="size-3" aria-hidden />
            <span className="sr-only">Currently used</span>
          </span>
        ) : null}
      </div>
      <span className="flex min-w-0 items-center gap-1 px-0.5">
        <span
          className={cn(
            'truncate text-xs font-medium',
            selected ? 'text-primary-text' : 'text-foreground',
          )}
        >
          {style.name}
        </span>
        {style.builtin ? <Lock className="size-3 shrink-0 text-subtle" aria-label="Built-in" /> : null}
      </span>
    </button>
  );
}

export function StyleGallery({
  styles,
  loading,
  error,
  selectedId,
  currentId,
  onSelect,
  onRetry,
  clipId,
}: {
  styles: CaptionStyle[] | undefined;
  loading: boolean;
  error: string | null;
  selectedId: string;
  currentId: string | null;
  onSelect: (id: string) => void;
  onRetry: () => void;
  clipId?: string;
}) {
  if (loading)
    return (
      <div className="grid grid-cols-3 gap-2 p-1" aria-busy aria-label="Loading styles">
        {Array.from({ length: 9 }, (_, i) => (
          <Skeleton key={i} className="aspect-[9/16] w-full rounded-md" />
        ))}
      </div>
    );
  if (error)
    return (
      <div className="rounded-lg border border-danger/35 bg-danger-soft p-4 text-sm" role="alert">
        <p className="font-semibold text-foreground">Could not load caption styles</p>
        <p className="mt-1 text-muted-foreground">{error}</p>
        <button type="button" onClick={onRetry} className="mt-2 font-medium text-primary-text hover:underline">
          Try again
        </button>
      </div>
    );
  const builtin = (styles ?? []).filter((s) => s.builtin);
  const custom = (styles ?? []).filter((s) => !s.builtin);
  return (
    <div className="flex flex-col gap-4" data-testid="style-gallery">
      <section aria-label="Built-in styles">
        <h3 className="mb-1.5 px-1 text-2xs font-semibold uppercase tracking-wider text-subtle">
          Built-in · {builtin.length}
        </h3>
        <div className="grid grid-cols-3 gap-1">
          {builtin.map((s) => (
            <Tile
              key={s.id}
              style={s}
              selected={s.id === selectedId}
              current={s.id === currentId}
              onSelect={onSelect}
              clipId={clipId}
            />
          ))}
        </div>
      </section>
      <section aria-label="My styles">
        <h3 className="mb-1.5 px-1 text-2xs font-semibold uppercase tracking-wider text-subtle">
          My styles · {custom.length}
        </h3>
        {custom.length === 0 ? (
          <p className="flex items-start gap-2 rounded-lg border border-dashed border-border-strong px-3 py-3 text-xs text-muted-foreground">
            <Plus className="mt-0.5 size-3.5 shrink-0 text-subtle" aria-hidden />
            Tweak any preset on the right, then choose “Save as custom copy” to keep your own version here.
          </p>
        ) : (
          <div className="grid grid-cols-3 gap-1">
            {custom.map((s) => (
              <Tile
                key={s.id}
                style={s}
                selected={s.id === selectedId}
                current={s.id === currentId}
                onSelect={onSelect}
                clipId={clipId}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
