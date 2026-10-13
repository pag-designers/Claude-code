'use client';

import * as React from 'react';
import { Star } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Favorite toggle. `overlay` styles it as a small card-coloured chip so it stays legible on any thumbnail. */
export function StarButton({
  active,
  onToggle,
  label,
  overlay,
  className,
}: {
  active: boolean;
  onToggle: () => void;
  label: string;
  overlay?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={active ? `Remove ${label} from favorites` : `Add ${label} to favorites`}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className={cn(
        'flex size-8 shrink-0 items-center justify-center rounded-full transition-[background-color,color,transform] duration-(--duration-fast) active:scale-90',
        overlay
          ? 'bg-card/90 text-muted-foreground shadow-xs backdrop-blur-sm hover:bg-card hover:text-foreground'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground',
        active && 'text-warning hover:text-warning',
        className,
      )}
    >
      <Star className={cn('size-4', active && 'fill-current')} aria-hidden />
    </button>
  );
}
