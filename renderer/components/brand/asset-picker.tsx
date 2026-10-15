'use client';

import * as React from 'react';
import { Check, ChevronDown, Film, Music2 } from 'lucide-react';
import type { BrandAssetKind, BrandAssetView } from '@shared/brand';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { formatDur } from '@/lib/brand/helpers';
import { goToSection } from '@/lib/brand/bus';

const SECTION_OF: Record<string, string> = {
  video: 'videos',
  audio: 'audio',
  logo: 'logos',
  image: 'images',
};

/** A popover list of one kind of kit assets with a "None" choice; used for intro, outro and the music bed. */
export function AssetPicker({
  kind,
  assets,
  value,
  onChange,
  label,
  placeholder,
}: {
  kind: Extract<BrandAssetKind, 'video' | 'audio'>;
  assets: BrandAssetView[];
  value: string | null;
  onChange: (id: string | null) => void;
  label: string;
  placeholder: string;
}) {
  const [open, setOpen] = React.useState(false);
  const current = assets.find((a) => a.id === value) ?? null;
  const Icon = kind === 'video' ? Film : Music2;
  const noun = kind === 'video' ? 'video' : 'audio file';
  if (assets.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        No {noun}s in this kit yet.{' '}
        <button
          type="button"
          onClick={() => goToSection(SECTION_OF[kind]!)}
          className="rounded-xs text-primary-text underline underline-offset-2"
        >
          Add one in {kind === 'video' ? 'Videos' : 'Audio'}
        </button>
        .
      </p>
    );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${label}: ${current ? current.name : 'none'}`}
          aria-haspopup="listbox"
          className="flex h-10 w-full items-center gap-2.5 rounded-md border border-input bg-field px-2.5 text-left text-sm outline-none transition-[border-color,box-shadow] duration-(--duration-fast) hover:border-border-strong focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25"
        >
          <span className="flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-muted text-subtle">
            {current?.thumbUrl ? (
              <img
                src={current.thumbUrl}
                alt=""
                className="size-full object-cover"
                draggable={false}
              />
            ) : (
              <Icon className="size-3.5" aria-hidden />
            )}
          </span>
          <span className={cn('min-w-0 flex-1 truncate', !current && 'text-subtle')}>
            {current ? current.name : placeholder}
          </span>
          <ChevronDown className="size-4 shrink-0 text-subtle" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(360px,90vw)] p-1.5">
        <ul role="listbox" aria-label={label} className="scrollbar-thin max-h-72 overflow-y-auto">
          <li role="option" aria-selected={value === null}>
            <button
              type="button"
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
              className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-sm text-muted-foreground outline-none hover:bg-accent focus-visible:bg-accent"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-sm border border-dashed border-border-strong text-2xs">
                None
              </span>
              <span className="flex-1">None</span>
              {value === null ? <Check className="size-4 text-primary-text" aria-hidden /> : null}
            </button>
          </li>
          {assets.map((a) => (
            <li key={a.id} role="option" aria-selected={a.id === value}>
              <button
                type="button"
                onClick={() => {
                  onChange(a.id);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent"
              >
                <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-muted text-subtle">
                  {a.thumbUrl ? (
                    <img
                      src={a.thumbUrl}
                      alt=""
                      className="size-full object-cover"
                      draggable={false}
                    />
                  ) : (
                    <Icon className="size-4" aria-hidden />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{a.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {formatDur(a.durationSec)}
                  </span>
                </span>
                {a.id === value ? (
                  <Check className="size-4 shrink-0 text-primary-text" aria-hidden />
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
