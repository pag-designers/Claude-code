'use client';

import * as React from 'react';
import Link from 'next/link';
import { Clock, Film, Library, Search, X } from 'lucide-react';
import type { VideoView } from '@shared/pipeline';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge, VideoThumb } from '@/components/library/video-card';
import { formatClock, timeAgo } from '@/lib/format';
import { useVideos } from '@/lib/library';
import { cn } from '@/lib/utils';
import type { ToolRouteId, ToolRouteMeta } from '@/lib/cp2-tools';
import { AnalyseNewVideo } from './analyse-new';

function PickerCard({
  video,
  last,
  needsClips,
  onPick,
}: {
  video: VideoView;
  last: boolean;
  needsClips: boolean;
  onPick: (id: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        data-testid="picker-video"
        data-video-id={video.id}
        onClick={() => onPick(video.id)}
        className={cn(
          'group flex w-full flex-col overflow-hidden rounded-xl border bg-card text-left shadow-xs outline-none transition-[border-color,box-shadow,transform] duration-(--duration-base) ease-(--ease-standard)',
          'hover:-translate-y-px hover:border-border-strong hover:shadow-sm focus-visible:ring-2 focus-visible:ring-ring',
          last && 'border-primary/50',
        )}
      >
        <div className="relative">
          <VideoThumb video={video} />
          {video.durationSec !== null ? (
            <span className="absolute bottom-2 right-2 rounded-md bg-black/60 px-1.5 py-0.5 text-2xs font-semibold tabular-nums text-white backdrop-blur-sm">
              {formatClock(video.durationSec)}
            </span>
          ) : null}
          {last ? (
            <span className="absolute left-2 top-2">
              <Badge variant="primary" data-testid="last-used">
                <Clock aria-hidden /> Last used
              </Badge>
            </span>
          ) : null}
        </div>
        <div className="flex flex-1 flex-col gap-2 p-3.5">
          <div className="min-w-0">
            <h3 className="line-clamp-2 font-sans text-sm font-semibold leading-[18px]">{video.title}</h3>
            <p className="mt-1 truncate text-xs text-muted-foreground">
              {video.channel ?? 'Unknown channel'} · {timeAgo(video.createdAt)}
            </p>
          </div>
          <div className="mt-auto flex items-center justify-between gap-2 text-xs">
            <StatusBadge video={video} />
            {needsClips ? (
              <span
                className={cn('tabular-nums', video.clipCount === 0 ? 'text-subtle' : 'text-muted-foreground')}
              >
                {video.clipCount === 0
                  ? 'No clips yet'
                  : `${video.clipCount} ${video.clipCount === 1 ? 'clip' : 'clips'}`}
              </span>
            ) : null}
          </div>
        </div>
      </button>
    </li>
  );
}

/** Step one of every standalone tool: choose a library video (or analyse a new one). */
export function VideoPicker({
  tool,
  meta,
  lastId,
  onPick,
}: {
  tool: ToolRouteId;
  meta: ToolRouteMeta;
  lastId: string | null;
  onPick: (videoId: string) => void;
}) {
  const q = useVideos();
  const [text, setText] = React.useState('');
  const needsClips = meta.needs === 'clips';
  const canAnalyse = meta.needs !== 'clips';

  const items = React.useMemo(() => {
    const needle = text.trim().toLowerCase();
    const all = (q.data?.items ?? []).filter(
      (v) => !needle || `${v.title} ${v.channel ?? ''}`.toLowerCase().includes(needle),
    );
    // last used first, then newest
    return [...all].sort((a, b) =>
      a.id === lastId ? -1 : b.id === lastId ? 1 : b.createdAt - a.createdAt,
    );
  }, [q.data, text, lastId]);

  return (
    <div className="flex flex-col gap-6" data-testid="video-picker" data-tool={tool}>
      {canAnalyse ? <AnalyseNewVideo onStarted={onPick} /> : null}

      <section aria-labelledby="picker-title" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="picker-title" className="font-display text-lg font-semibold">
              {canAnalyse ? 'Or choose from your library' : 'Choose a video'}
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">{meta.pickerHint}</p>
          </div>
          <Input
            aria-label="Search your videos"
            placeholder="Search videos"
            leading={<Search />}
            value={text}
            onChange={(e) => setText(e.target.value)}
            trailing={
              text ? (
                <button
                  type="button"
                  aria-label="Clear search"
                  className="rounded p-1 hover:text-foreground"
                  onClick={() => setText('')}
                >
                  <X className="size-3.5" />
                </button>
              ) : undefined
            }
            className="h-9"
            wrapperClassName="w-64"
          />
        </div>

        {q.isPending ? (
          <ul
            className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4"
            aria-busy
            aria-label="Loading your videos"
          >
            {Array.from({ length: 4 }, (_, i) => (
              <li key={i} className="overflow-hidden rounded-xl border bg-card">
                <Skeleton className="aspect-video w-full rounded-none" />
                <div className="space-y-2 p-3.5">
                  <Skeleton className="h-3.5 w-full" />
                  <Skeleton className="h-3 w-2/3" />
                </div>
              </li>
            ))}
          </ul>
        ) : q.isError ? (
          <EmptyState
            size="sm"
            icon={Film}
            title="Could not load your library"
            description={q.error.message}
            actions={<Button onClick={() => void q.refetch()}>Try again</Button>}
          />
        ) : (q.data?.items.length ?? 0) === 0 ? (
          <EmptyState
            size="sm"
            icon={Library}
            title="Your library is empty"
            description={
              canAnalyse
                ? 'Analyse a video above, or paste a link on Home to make clips. Every tool works on library videos.'
                : 'Paste a YouTube link on Home to make clips first. This tool works on a video that already has clips.'
            }
            actions={
              <Button variant="primary" asChild>
                <Link href="/">Go to Home</Link>
              </Button>
            }
          />
        ) : items.length === 0 ? (
          <EmptyState
            size="sm"
            icon={Search}
            title="No videos match"
            description={`Nothing in your library matches “${text.trim()}”.`}
            actions={
              <Button variant="outline" onClick={() => setText('')}>
                Clear search
              </Button>
            }
          />
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
            {items.map((v) => (
              <PickerCard
                key={v.id}
                video={v}
                last={v.id === lastId}
                needsClips={needsClips}
                onPick={onPick}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
