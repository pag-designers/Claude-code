'use client';

import * as React from 'react';
import { ImageOff, RefreshCw } from 'lucide-react';
import type { CaptionStyle } from '@shared/cp2';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { usePreview } from '@/lib/cp2-captions';
import { useInView } from '@/lib/use-in-view';

const BAND_ZOOM = 1.6;

/** Positions a zoomed portrait render inside a 16:9 band so the caption (yPct of the frame height) is centred. */
function bandStyle(yPct: number): React.CSSProperties {
  const frameH = 16 / 9; // frame height in units of its width
  const bandH = 9 / 16;
  // all lengths are in container-width units (cqw), so the band scales with whatever width the caller gives it
  const top = (bandH / 2 - (yPct / 100) * frameH * BAND_ZOOM) * 100;
  return {
    position: 'absolute',
    maxWidth: 'none',
    height: 'auto',
    width: `${BAND_ZOOM * 100}%`,
    left: `${((1 - BAND_ZOOM) / 2) * 100}%`,
    top: `${top}cqw`,
  };
}

/**
 * A real libass render of a style (`captions:preview`). Fetched lazily once the thumbnail scrolls into view, at most two
 * at a time, and cached by style hash, so the gallery stays cheap even with many custom presets.
 */
export function StyleThumb({
  style,
  clipId,
  className,
  alt,
  band,
}: {
  style: CaptionStyle;
  clipId?: string;
  className?: string;
  alt?: string;
  /** Crop to the strip around the caption instead of the whole portrait frame (compact option rows). */
  band?: boolean;
}) {
  const [ref, seen] = useInView<HTMLDivElement>('0px');
  const p = usePreview(seen ? { style, clipId } : null, 'tile');
  return (
    <div
      ref={ref}
      data-testid="style-thumb"
      data-state={p.error ? 'error' : p.image && !p.stale ? 'ready' : 'loading'}
      style={band ? { containerType: 'inline-size' } : undefined}
      className={cn(
        'relative w-full overflow-hidden bg-muted',
        band ? 'aspect-[16/9]' : 'aspect-[9/16]',
        className,
      )}
    >
      {p.image ? (
        <img
          src={p.image.dataUrl}
          alt={alt ?? `${style.name} caption preview`}
          draggable={false}
          style={band ? bandStyle(style.layout.yPct) : undefined}
          className={cn(
            'transition-opacity duration-(--duration-base)',
            !band && 'size-full object-cover',
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
