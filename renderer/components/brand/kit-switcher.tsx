'use client';

import * as React from 'react';
import { Copy, MoreHorizontal, Palette, Plus, Star, Trash2 } from 'lucide-react';
import type { BrandKitSummary } from '@shared/brand';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { KIND_NOUN } from '@/lib/brand/helpers';

function countsLine(k: BrandKitSummary): string {
  const parts: string[] = [];
  for (const kind of ['logo', 'image', 'video', 'audio', 'font'] as const) {
    const n = k.counts[kind] ?? 0;
    if (n > 0) parts.push(`${n} ${n === 1 ? KIND_NOUN[kind].one : KIND_NOUN[kind].many}`);
  }
  return parts.length ? parts.slice(0, 3).join(' · ') : 'Empty kit';
}

function KitCard({
  kit,
  selected,
  onSelect,
  onMakeDefault,
  onDuplicate,
  onDelete,
}: {
  kit: BrandKitSummary;
  selected: boolean;
  onSelect: () => void;
  onMakeDefault: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  return (
    <li className="w-[272px] flex-none" data-testid="kit-card" data-kit-id={kit.id}>
      <div
        className={cn(
          'group/kit relative rounded-xl border bg-card transition-[border-color,box-shadow,transform] duration-(--duration-base) ease-(--ease-standard)',
          selected
            ? 'border-primary shadow-[0_0_0_1px_var(--primary),var(--elev-2)]'
            : 'hover:-translate-y-px hover:border-border-strong hover:shadow-sm',
        )}
      >
        <button
          type="button"
          onClick={onSelect}
          aria-current={selected ? 'true' : undefined}
          aria-label={`${kit.name}${kit.isDefault ? ' (default kit)' : ''}`}
          className="flex w-full items-center gap-3 rounded-xl p-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-muted text-subtle">
            {kit.logoThumbUrl ? (
              <img
                src={kit.logoThumbUrl}
                alt=""
                className="size-full object-contain p-1"
                draggable={false}
              />
            ) : (
              <Palette className="size-5" aria-hidden />
            )}
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="truncate pr-14 text-sm font-semibold text-foreground">{kit.name}</span>
            <span className="truncate text-xs text-muted-foreground">{countsLine(kit)}</span>
            <span className="flex h-3 items-center -space-x-1" aria-hidden>
              {kit.swatches.slice(0, 5).map((c, i) => (
                <span
                  key={`${c}-${i}`}
                  className="size-3 rounded-full border border-card ring-1 ring-border-strong"
                  style={{ background: c }}
                />
              ))}
            </span>
          </span>
        </button>
        <div className="absolute right-2 top-2 flex items-center gap-0.5">
          <button
            type="button"
            aria-pressed={kit.isDefault}
            aria-label={
              kit.isDefault ? `${kit.name} is the default kit` : `Make ${kit.name} the default kit`
            }
            title={kit.isDefault ? 'Default kit' : 'Make default'}
            onClick={onMakeDefault}
            disabled={kit.isDefault}
            className={cn(
              'flex size-7 items-center justify-center rounded-full transition-[color,background-color,transform] duration-(--duration-fast) active:scale-90',
              kit.isDefault ? 'text-warning' : 'text-subtle hover:bg-accent hover:text-foreground',
            )}
          >
            <Star className={cn('size-4', kit.isDefault && 'fill-current')} aria-hidden />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={`More actions for ${kit.name}`}
                className="flex size-7 items-center justify-center rounded-full text-subtle transition-colors hover:bg-accent hover:text-foreground"
              >
                <MoreHorizontal className="size-4" aria-hidden />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onSelect={onMakeDefault} disabled={kit.isDefault}>
                <Star /> Make default
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onDuplicate}>
                <Copy /> Duplicate
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-danger [&_svg]:!text-danger" onSelect={onDelete}>
                <Trash2 /> Delete…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </li>
  );
}

/** Horizontal strip of kit cards: logo, name, swatches, default star. */
export function KitSwitcher({
  kits,
  selectedId,
  onSelect,
  onNew,
  onMakeDefault,
  onDuplicate,
  onDelete,
}: {
  kits: BrandKitSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onMakeDefault: (id: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <nav aria-label="Brand kits">
      <ul className="scrollbar-thin -mx-1 flex gap-3 overflow-x-auto px-1 pb-2 pt-1">
        {kits.map((k) => (
          <KitCard
            key={k.id}
            kit={k}
            selected={k.id === selectedId}
            onSelect={() => onSelect(k.id)}
            onMakeDefault={() => onMakeDefault(k.id)}
            onDuplicate={() => onDuplicate(k.id)}
            onDelete={() => onDelete(k.id)}
          />
        ))}
        <li className="flex-none">
          <button
            type="button"
            onClick={onNew}
            className="flex h-full min-h-[84px] w-[148px] flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-border-strong text-sm font-medium text-muted-foreground outline-none transition-[border-color,color,background-color] duration-(--duration-fast) hover:border-primary/60 hover:bg-primary-soft hover:text-primary-text focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Plus className="size-4" aria-hidden />
            New brand kit
          </button>
        </li>
      </ul>
    </nav>
  );
}
