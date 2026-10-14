'use client';

import * as React from 'react';
import { AlertCircle, Check, ExternalLink, ImageOff, Loader2, Play, Pause } from 'lucide-react';
import type { BrollItem } from '@shared/brand';
import { cn } from '@/lib/utils';
import { clipDuration, dimensionsLabel, type ImportState } from '@/lib/broll/model';

/** Pointer must rest this long on a card before its preview starts (no flicker while sweeping the mouse). */
const HOVER_INTENT_MS = 140;

export interface ResultCardProps {
  item: BrollItem;
  index: number;
  aspect: string;
  selected: boolean;
  focusable: boolean;
  importState: ImportState | undefined;
  /** This card owns the single running preview. */
  previewing: boolean;
  /** `prefers-reduced-motion`: previews start only from the play button. */
  reducedMotion: boolean;
  onToggle: (item: BrollItem) => void;
  onPreview: (id: string | null) => void;
  onFocusCell: (index: number) => void;
  onOpenLink: (url: string) => void;
}

function ResultCardImpl({
  item,
  index,
  aspect,
  selected,
  focusable,
  importState,
  previewing,
  reducedMotion,
  onToggle,
  onPreview,
  onFocusCell,
  onOpenLink,
}: ResultCardProps) {
  const [thumbFailed, setThumbFailed] = React.useState(false);
  const [thumbLoaded, setThumbLoaded] = React.useState(false);
  const timer = React.useRef<number | null>(null);
  React.useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const busy = importState?.status === 'busy';
  const done = importState?.status === 'done';
  const failed = importState?.status === 'error' ? importState.message : null;
  const showVideo = previewing && !!item.previewUrl;
  const label = [
    item.title,
    item.author ? `by ${item.author}` : null,
    clipDuration(item.durationSec),
    dimensionsLabel(item),
    done ? 'added' : failed ? `failed: ${failed}` : null,
  ]
    .filter(Boolean)
    .join(', ');

  const startHover = () => {
    if (reducedMotion || !item.previewUrl) return;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => onPreview(item.id), HOVER_INTENT_MS);
  };
  const endHover = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    if (previewing) onPreview(null);
  };

  return (
    <div
      role="presentation"
      data-testid="broll-card"
      data-id={item.id}
      data-state={done ? 'done' : busy ? 'busy' : failed ? 'error' : selected ? 'selected' : 'idle'}
      className="flex min-w-0 flex-col gap-2 [contain-intrinsic-size:auto_300px] [content-visibility:auto]"
    >
      <div className="relative">
        <div
          role="option"
          aria-selected={selected}
          aria-disabled={busy || done || undefined}
          aria-label={label}
          tabIndex={focusable ? 0 : -1}
          data-index={index}
          data-testid="broll-option"
          onClick={() => !busy && !done && onToggle(item)}
          onFocus={() => {
            onFocusCell(index);
            if (!reducedMotion && item.previewUrl) onPreview(item.id);
          }}
          onBlur={endHover}
          onPointerEnter={startHover}
          onPointerLeave={endHover}
          className={cn(
            'group/card relative block w-full cursor-pointer overflow-hidden rounded-lg border bg-muted outline-none transition-[border-color,box-shadow] duration-(--duration-fast)',
            'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover',
            selected
              ? 'border-primary ring-2 ring-primary'
              : 'border-border hover:border-border-strong',
            (busy || done) && 'cursor-default',
          )}
          style={{ aspectRatio: aspect }}
        >
          {thumbFailed ? (
            <span className="absolute inset-0 flex items-center justify-center text-subtle">
              <ImageOff className="size-6" aria-hidden />
            </span>
          ) : (
            <img
              src={item.thumbUrl}
              alt=""
              loading="lazy"
              decoding="async"
              draggable={false}
              referrerPolicy="no-referrer"
              onLoad={() => setThumbLoaded(true)}
              onError={() => setThumbFailed(true)}
              className={cn(
                'absolute inset-0 size-full object-cover transition-opacity duration-(--duration-base)',
                thumbLoaded ? 'opacity-100' : 'opacity-0',
              )}
            />
          )}

          {showVideo ? (
            <PreviewVideo src={item.previewUrl!} onFail={() => onPreview(null)} />
          ) : null}

          <span
            className={cn(
              'absolute left-2 top-2 flex size-5 items-center justify-center rounded-full border transition-[background-color,border-color,opacity] duration-(--duration-fast)',
              selected
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border-strong bg-background/80 text-transparent opacity-0 backdrop-blur group-hover/card:opacity-100 group-focus-visible/card:opacity-100',
            )}
            aria-hidden
          >
            <Check className="size-3.5" strokeWidth={3} />
          </span>

          <span className="pointer-events-none absolute inset-x-2 bottom-2 flex items-end justify-between gap-2">
            <span className="rounded-sm bg-background/80 px-1.5 py-0.5 text-2xs font-semibold tabular-nums text-foreground backdrop-blur">
              {clipDuration(item.durationSec)}
            </span>
            <span className="rounded-sm bg-background/80 px-1.5 py-0.5 text-2xs font-medium tabular-nums text-muted-foreground backdrop-blur">
              {dimensionsLabel(item)}
            </span>
          </span>

          {busy ? (
            <span
              className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/75 text-xs font-medium text-foreground backdrop-blur-[2px]"
              data-testid="broll-busy"
            >
              <Loader2 className="size-5 animate-spin text-primary-text" aria-hidden />
              Downloading&hellip;
            </span>
          ) : null}
          {done ? (
            <span
              className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-background/70 text-xs font-semibold text-success"
              data-testid="broll-done"
            >
              <Check className="size-6" strokeWidth={2.5} aria-hidden />
              Added
            </span>
          ) : null}
        </div>

        {reducedMotion && item.previewUrl && !busy && !done ? (
          <button
            type="button"
            aria-label={previewing ? 'Pause preview' : 'Play preview'}
            aria-pressed={previewing}
            data-testid="broll-play"
            onClick={() => onPreview(previewing ? null : item.id)}
            className="absolute right-2 top-2 flex size-6 items-center justify-center rounded-full border border-border-strong bg-background/80 text-foreground backdrop-blur transition-colors hover:bg-accent"
          >
            {previewing ? (
              <Pause className="size-3" aria-hidden />
            ) : (
              <Play className="size-3" aria-hidden />
            )}
          </button>
        ) : null}
      </div>

      <div className="min-w-0 px-0.5">
        <p className="truncate text-sm font-medium text-foreground" title={item.title}>
          {item.title}
        </p>
        <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          {item.pageUrl ? (
            <a
              href={item.pageUrl}
              onClick={(e) => {
                e.preventDefault();
                onOpenLink(item.pageUrl!);
              }}
              data-testid="broll-credit"
              title={`Open this clip on ${item.provider === 'pexels' ? 'Pexels' : 'Pixabay'}`}
              className="inline-flex min-w-0 items-center gap-1 rounded-xs hover:text-foreground hover:underline focus-visible:text-foreground"
            >
              <span className="truncate">{item.author ? `by ${item.author}` : 'View source'}</span>
              <ExternalLink className="size-3 shrink-0" aria-hidden />
            </a>
          ) : (
            <span className="truncate">{item.author ? `by ${item.author}` : 'Unknown author'}</span>
          )}
        </div>
        {failed ? (
          <p
            className="mt-1 flex items-start gap-1 text-xs leading-4 text-danger"
            data-testid="broll-error"
          >
            <AlertCircle className="mt-px size-3 shrink-0" aria-hidden />
            <span className="line-clamp-3">{failed}</span>
          </p>
        ) : null}
      </div>
    </div>
  );
}

export const ResultCard = React.memo(ResultCardImpl);

/** Placeholder with the same box as a card, shown while the first page loads. */
export function ResultCardSkeleton({ aspect }: { aspect: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-2" aria-hidden>
      <div
        className="animate-shimmer rounded-lg border bg-[linear-gradient(100deg,var(--muted)_30%,var(--accent)_50%,var(--muted)_70%)] bg-[length:200%_100%]"
        style={{ aspectRatio: aspect }}
      />
      <div className="h-3.5 w-3/4 rounded-xs bg-muted" />
      <div className="h-3 w-1/2 rounded-xs bg-muted" />
    </div>
  );
}

/** The muted hover preview. Mounted only while previewing, so it starts hidden and fades in once a frame exists. */
function PreviewVideo({ src, onFail }: { src: string; onFail: () => void }) {
  const [ready, setReady] = React.useState(false);
  return (
    <video
      src={src}
      muted
      loop
      autoPlay
      playsInline
      preload="auto"
      disablePictureInPicture
      aria-hidden
      data-testid="broll-preview"
      onLoadedData={() => setReady(true)}
      onError={onFail}
      className={cn(
        'absolute inset-0 size-full object-cover transition-opacity duration-(--duration-fast)',
        ready ? 'opacity-100' : 'opacity-0',
      )}
    />
  );
}
