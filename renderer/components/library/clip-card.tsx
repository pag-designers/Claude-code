'use client';

import * as React from 'react';
import { motion } from 'framer-motion';
import { CircleAlert, Clock, Film, Loader2, Play, Sparkles } from 'lucide-react';
import type { ClipView } from '@shared/pipeline';
import { Checkbox } from '@/components/ui/checkbox';
import { ProgressRing } from '@/components/ui/progress-ring';
import { ScoreBadge, ScoreChip } from '@/components/ui/score-badge';
import { StarButton } from '@/components/ui/star-button';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { formatClock, timeAgo } from '@/lib/format';
import { useClipMediaUrl, useFetchMediaUrl } from '@/lib/library';
import { useInView } from '@/lib/use-in-view';

const ASPECT_CSS: Record<ClipView['aspect'], string> = {
  '9:16': '9 / 16',
  '1:1': '1 / 1',
  '4:5': '4 / 5',
  '16:9': '16 / 9',
};
export const aspectCss = (a: ClipView['aspect']) => ASPECT_CSS[a] ?? ASPECT_CSS['9:16'];

/** Score count-up plays once per clip per session, not every time a tab or filter re-mounts the card. */
const seenScores = new Set<string>();
export function ClipScore({
  clip,
  size = 40,
  showLabel,
}: {
  clip: Pick<ClipView, 'id' | 'score'>;
  size?: number;
  showLabel?: boolean;
}) {
  const [fresh] = React.useState(() => !seenScores.has(clip.id));
  React.useEffect(() => {
    seenScores.add(clip.id);
  }, [clip.id]);
  if (clip.score === null)
    return (
      <span
        title="Scoring…"
        aria-label="Score pending"
        className="inline-flex"
        style={{ width: size, height: size }}
      >
        <ProgressRing value={0} size={size} stroke={Math.max(3, Math.round(size / 11))} dashed>
          <span className="text-xs font-semibold text-subtle">…</span>
        </ProgressRing>
      </span>
    );
  return <ScoreBadge score={clip.score} size={size} animated={fresh} showLabel={showLabel} />;
}

export function ClipStatusPill({ clip, className }: { clip: ClipView; className?: string }) {
  const base =
    'inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-full px-2 text-2xs font-semibold backdrop-blur-sm';
  if (clip.status === 'rendering')
    return (
      <span className={cn(base, 'bg-primary text-primary-foreground', className)}>
        <Loader2 className="size-3 animate-spin" aria-hidden />
        Rendering{clip.renderProgress !== null ? ` ${Math.round(clip.renderProgress * 100)}%` : ''}
      </span>
    );
  if (clip.status === 'queued')
    return (
      <span className={cn(base, 'bg-card/90 text-muted-foreground', className)}>
        <Clock className="size-3" aria-hidden />
        Queued
      </span>
    );
  if (clip.status === 'candidate')
    return (
      <span className={cn(base, 'bg-card/90 text-muted-foreground', className)}>
        <Sparkles className="size-3" aria-hidden />
        Found
      </span>
    );
  if (clip.status === 'failed')
    return (
      <Tip content={clip.error ?? 'Rendering failed'}>
        <span className={cn(base, 'bg-danger-solid text-white', className)}>
          <CircleAlert className="size-3" aria-hidden />
          Render failed
        </span>
      </Tip>
    );
  return null;
}

interface CardProps {
  clip: ClipView;
  selected: boolean;
  selectionActive: boolean;
  isNew?: boolean;
  showVideo?: boolean;
  onOpen: (clip: ClipView) => void;
  onSelect: (clip: ClipView, e: { shiftKey: boolean }) => void;
  onToggleFavorite: (clip: ClipView) => void;
}

/** Vertical clip card: presigned thumbnail, hover-to-preview autoplay, animated score, selection + favorite. */
export const ClipCard = React.memo(function ClipCard({
  clip,
  selected,
  selectionActive,
  isNew,
  showVideo,
  onOpen,
  onSelect,
  onToggleFavorite,
}: CardProps) {
  const [ref, inView] = useInView<HTMLDivElement>();
  const thumb = useClipMediaUrl(clip.id, 'thumb', inView && clip.hasThumb);
  const fetchUrl = useFetchMediaUrl();
  const [preview, setPreview] = React.useState<string | null>(null);
  const [previewReady, setPreviewReady] = React.useState(false);
  const timer = React.useRef<number | undefined>(undefined);

  const startPreview = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse' || !clip.hasRender || clip.status !== 'rendered') return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      fetchUrl(clip.id, 'render')
        .then((u) => setPreview(u))
        .catch(() => setPreview(null));
    }, 220);
  };
  const stopPreview = () => {
    window.clearTimeout(timer.current);
    setPreview(null);
    setPreviewReady(false);
  };
  React.useEffect(() => () => window.clearTimeout(timer.current), []);

  const click = (e: React.MouseEvent) => {
    if (selectionActive || e.metaKey || e.ctrlKey || e.shiftKey) onSelect(clip, e);
    else onOpen(clip);
  };

  const body = (
    <article
      ref={ref}
      data-testid="clip-card"
      data-clip-id={clip.id}
      data-selected={selected || undefined}
      className={cn(
        'group relative flex flex-col overflow-hidden rounded-xl border bg-card shadow-xs transition-[border-color,box-shadow,transform] duration-(--duration-base) ease-(--ease-standard)',
        'hover:-translate-y-px hover:border-border-strong hover:shadow-sm',
        selected && 'border-primary ring-2 ring-primary/40 hover:border-primary',
        isNew && 'animate-arrive',
      )}
    >
      <div className="relative bg-muted" style={{ aspectRatio: aspectCss(clip.aspect) }}>
        <button
          type="button"
          onClick={click}
          onPointerEnter={startPreview}
          onPointerLeave={stopPreview}
          aria-label={`Open clip: ${clip.title}`}
          className="absolute inset-0 block size-full overflow-hidden text-left outline-offset-[-2px]"
        >
          {thumb.data?.url ? (
            <img
              src={thumb.data.url}
              alt=""
              loading="lazy"
              draggable={false}
              className="absolute inset-0 size-full object-cover"
              onError={() => void thumb.refetch()}
            />
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-primary-soft p-4 text-center">
              <Film className="size-6 text-primary-text" strokeWidth={1.6} aria-hidden />
              {clip.hook ? (
                <p className="line-clamp-5 text-balance font-display text-sm font-semibold leading-snug text-foreground">
                  “{clip.hook}”
                </p>
              ) : null}
            </div>
          )}
          {preview ? (
            <video
              src={preview}
              muted
              loop
              autoPlay
              playsInline
              preload="auto"
              onLoadedData={() => setPreviewReady(true)}
              onError={stopPreview}
              data-testid="clip-preview"
              className={cn(
                'absolute inset-0 size-full object-cover transition-opacity duration-(--duration-base)',
                previewReady ? 'opacity-100' : 'opacity-0',
              )}
            />
          ) : null}
          {clip.status === 'rendering' ? (
            <span className="absolute inset-0 flex items-center justify-center bg-black/45">
              <ProgressRing value={clip.renderProgress ?? 0} size={52} stroke={4} tone="primary">
                <span className="text-xs font-bold tabular-nums text-white">
                  {clip.renderProgress !== null ? Math.round(clip.renderProgress * 100) : '…'}
                </span>
              </ProgressRing>
            </span>
          ) : null}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/70 to-transparent"
          />
          {clip.hasRender && clip.status === 'rendered' ? (
            <span
              aria-hidden
              className="absolute left-1/2 top-1/2 flex size-11 -translate-x-1/2 -translate-y-1/2 scale-90 items-center justify-center rounded-full bg-black/55 text-white opacity-0 backdrop-blur-sm transition-[opacity,transform] duration-(--duration-base) group-hover:scale-100 group-hover:opacity-100"
            >
              <Play className="size-5 fill-current" />
            </span>
          ) : null}
        </button>
        <div
          className={cn(
            'absolute left-2 top-2 transition-opacity duration-(--duration-fast)',
            selected || selectionActive
              ? 'opacity-100'
              : 'opacity-0 focus-within:opacity-100 group-hover:opacity-100',
          )}
        >
          <Checkbox
            checked={selected}
            aria-label={`Select ${clip.title}`}
            onCheckedChange={(_c, e) => onSelect(clip, e)}
            className="size-5 border-white/70 bg-black/40 backdrop-blur-sm"
          />
        </div>
        <StarButton
          overlay
          label={clip.title}
          active={clip.favorite}
          onToggle={() => onToggleFavorite(clip)}
          className={cn(
            'absolute right-2 top-2 size-7',
            !clip.favorite && 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100',
          )}
        />
        <ClipStatusPill clip={clip} className="absolute bottom-2 left-2" />
        <span className="absolute bottom-2 right-2 rounded-md bg-black/60 px-1.5 py-0.5 text-2xs font-semibold tabular-nums text-white backdrop-blur-sm">
          {formatClock(clip.durationSec)}
        </span>
      </div>
      <div className="flex items-start gap-3 p-3">
        <ClipScore clip={clip} size={40} />
        <div className="min-w-0 flex-1">
          <h3 className="line-clamp-2 font-sans text-sm font-semibold leading-[18px] tracking-normal">
            {clip.title}
          </h3>
          {clip.hook ? (
            <p className="mt-1 line-clamp-2 text-xs leading-4 text-muted-foreground">
              “{clip.hook}”
            </p>
          ) : null}
          <p className="mt-1.5 truncate text-2xs text-subtle">
            {showVideo && clip.videoTitle ? `${clip.videoTitle} · ` : ''}
            {timeAgo(clip.createdAt)}
          </p>
        </div>
      </div>
    </article>
  );

  if (!isNew) return body;
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.94, y: 14 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 320, damping: 26 }}
    >
      {body}
    </motion.div>
  );
});

/** Dense list row used by the Library's list layout. */
export const ClipRow = React.memo(function ClipRow({
  clip,
  selected,
  selectionActive,
  showVideo,
  onOpen,
  onSelect,
  onToggleFavorite,
}: CardProps) {
  const [ref, inView] = useInView<HTMLLIElement>();
  const thumb = useClipMediaUrl(clip.id, 'thumb', inView && clip.hasThumb);
  return (
    <li
      ref={ref}
      data-testid="clip-row"
      data-clip-id={clip.id}
      data-selected={selected || undefined}
      className={cn(
        'group flex items-center gap-4 px-4 py-2.5 transition-colors duration-(--duration-fast) hover:bg-accent/50',
        selected && 'bg-primary-soft hover:bg-primary-soft',
      )}
    >
      <Checkbox
        checked={selected}
        aria-label={`Select ${clip.title}`}
        onCheckedChange={(_c, e) => onSelect(clip, e)}
      />
      <button
        type="button"
        onClick={(e) =>
          selectionActive || e.metaKey || e.ctrlKey ? onSelect(clip, e) : onOpen(clip)
        }
        aria-label={`Open clip: ${clip.title}`}
        className="relative h-[72px] shrink-0 overflow-hidden rounded-md bg-muted"
        style={{ aspectRatio: aspectCss(clip.aspect) }}
      >
        {thumb.data?.url ? (
          <img
            src={thumb.data.url}
            alt=""
            draggable={false}
            className="size-full object-cover"
            onError={() => void thumb.refetch()}
          />
        ) : (
          <span className="flex size-full items-center justify-center bg-primary-soft text-primary-text">
            <Film className="size-4" aria-hidden />
          </span>
        )}
      </button>
      <div className="min-w-0 flex-1">
        <button type="button" onClick={() => onOpen(clip)} className="block max-w-full text-left">
          <span className="line-clamp-1 text-sm font-semibold">{clip.title}</span>
        </button>
        {clip.hook ? (
          <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">“{clip.hook}”</p>
        ) : null}
        {showVideo && clip.videoTitle ? (
          <p className="mt-0.5 truncate text-2xs text-subtle">{clip.videoTitle}</p>
        ) : null}
      </div>
      <div className="hidden w-14 shrink-0 text-right text-xs tabular-nums text-muted-foreground min-[1100px]:block">
        {formatClock(clip.durationSec)}
      </div>
      <div className="hidden w-20 shrink-0 text-right text-xs text-subtle min-[1100px]:block">
        {timeAgo(clip.createdAt)}
      </div>
      <div className="flex w-32 shrink-0 justify-end">
        <ClipStatusPill clip={clip} className="bg-muted" />
      </div>
      <div className="flex w-12 shrink-0 justify-center">
        {clip.score === null ? (
          <span className="text-xs text-subtle">…</span>
        ) : (
          <ScoreChip score={clip.score} />
        )}
      </div>
      <StarButton
        label={clip.title}
        active={clip.favorite}
        onToggle={() => onToggleFavorite(clip)}
      />
    </li>
  );
});
