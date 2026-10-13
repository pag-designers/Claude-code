'use client';

import * as React from 'react';
import { ImageOff, RefreshCw } from 'lucide-react';
import type { CaptionStyle } from '@shared/cp2';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { usePreview } from '@/lib/cp2-captions';
import { useInView } from '@/lib/use-in-view';

/**
 * A real libass render of a style (`captions:preview`). Fetched lazily once the thumbnail scrolls into view, at most two
 * at a time, and cached by style hash, so the gallery stays cheap even with many custom presets.
 */
export function StyleThumb({
  style,
  clipId,
  className,
  alt,
}: {
  style: CaptionStyle;
  clipId?: string;
  className?: string;
  alt?: string;
}) {
  const [ref, seen] = useInView<HTMLDivElement>('0px');
  const p = usePreview(seen ? { style, clipId } : null, 'tile');
  return (
    <div
      ref={ref}
      data-testid="style-thumb"
      data-state={p.error ? 'error' : p.image && !p.stale ? 'ready' : 'loading'}
      className={cn('relative aspect-[9/16] w-full overflow-hidden bg-muted', className)}
    >
      {p.image ? (
        <img
          src={p.image.dataUrl}
          alt={alt ?? `${style.name} caption preview`}
          draggable={false}
          className={cn(
            'size-full object-cover transition-opacity duration-(--duration-base)',
            p.stale && 'opacity-60',
          )}
        />
      ) : p.error ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            p.retry();
          }}
          className="flex size-full flex-col items-center justify-center gap-1.5 p-2 text-center text-2xs text-muted-foreground hover:text-foreground"
          title={p.error}
        >
          <ImageOff className="size-4" aria-hidden />
          Preview failed
          <span className="inline-flex items-center gap-1 font-medium text-primary-text">
            <RefreshCw className="size-3" aria-hidden /> Retry
          </span>
        </button>
      ) : (
        <Skeleton className="size-full rounded-none" />
      )}
    </div>
  );
}
