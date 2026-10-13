'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ExternalLink, Film, MoreHorizontal, Star, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { VideoView } from '@shared/pipeline';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScoreChip } from '@/components/ui/score-badge';
import { StarButton } from '@/components/ui/star-button';
import { PipelineProgressCompact } from '@/components/pipeline/pipeline-progress';
import { cn } from '@/lib/utils';
import { formatClock, timeAgo } from '@/lib/format';
import { videoHref } from '@/lib/hrefs';
import { invoke } from '@/lib/ipc';
import { useCancelPipeline, useDeleteVideo, useSetVideoFavorite } from '@/lib/library';
import { failureSummary, isActiveVideo, videoStatusInfo } from '@/lib/pipeline-ui';

export function VideoThumb({
  video,
  className,
}: {
  video: Pick<VideoView, 'thumbnail'>;
  className?: string;
}) {
  const [failed, setFailed] = React.useState(false);
  return (
    <div className={cn('relative aspect-video overflow-hidden bg-muted', className)}>
      {video.thumbnail && !failed ? (
        <img
          src={video.thumbnail}
          alt=""
          loading="lazy"
          draggable={false}
          referrerPolicy="no-referrer"
          className="size-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="flex size-full items-center justify-center bg-primary-soft text-primary-text">
          <Film className="size-6" strokeWidth={1.6} aria-hidden />
        </div>
      )}
    </div>
  );
}

export function StatusBadge({
  video,
}: {
  video: Pick<VideoView, 'status' | 'stage' | 'progress'>;
}) {
  const s = videoStatusInfo(video);
  return (
    <Badge
      variant={
        s.tone === 'primary'
          ? 'primary'
          : s.tone === 'success'
            ? 'success'
            : s.tone === 'danger'
              ? 'danger'
              : s.tone === 'warning'
                ? 'warning'
                : 'neutral'
      }
      dot={s.tone === 'primary'}
    >
      {s.label}
    </Badge>
  );
}

/** Delete with the "also delete from cloud storage" choice (default on: the point is to free the free-tier quota). */
export function DeleteVideoDialog({
  video,
  open,
  onOpenChange,
  onDeleted,
}: {
  video: Pick<VideoView, 'id' | 'title' | 'clipCount'> | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDeleted?: () => void;
}) {
  const del = useDeleteVideo();
  const [fromStorage, setFromStorage] = React.useState(true);
  return (
    <ConfirmDialog
      open={open && !!video}
      onOpenChange={onOpenChange}
      title="Delete this video?"
      description={
        <>
          “{video?.title}” and its {video?.clipCount ?? 0}{' '}
          {video?.clipCount === 1 ? 'clip' : 'clips'}, transcript and notes are removed from your
          library.
        </>
      }
      loading={del.isPending}
      onConfirm={() =>
        video &&
        del.mutate(
          { id: video.id, deleteFromStorage: fromStorage, title: video.title },
          {
            onSuccess: () => {
              onOpenChange(false);
              onDeleted?.();
            },
          },
        )
      }
    >
      <label className="flex cursor-pointer items-start gap-3 rounded-lg border bg-muted/40 p-3">
        <Checkbox
          checked={fromStorage}
          onCheckedChange={setFromStorage}
          aria-label="Also delete from cloud storage"
          className="mt-0.5"
        />
        <span className="text-sm">
          <span className="font-medium">Also delete from cloud storage</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            Removes the 480p proxy, clip renders and captions from your bucket to free space.
            Uncheck to keep the files there.
          </span>
        </span>
      </label>
    </ConfirmDialog>
  );
}

function VideoMenu({
  video,
  onDelete,
  className,
}: {
  video: VideoView;
  onDelete: () => void;
  className?: string;
}) {
  const router = useRouter();
  const fav = useSetVideoFavorite();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`More actions for ${video.title}`}
          className={cn(
            'relative z-10 bg-card/90 shadow-xs backdrop-blur-sm hover:bg-card',
            className,
          )}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onSelect={() => router.push(videoHref(video.id))}>
          <Film /> Open video
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => fav.mutate({ id: video.id, value: !video.favorite })}>
          <Star /> {video.favorite ? 'Remove from favorites' : 'Add to favorites'}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() =>
            void invoke('shell:openExternal', { url: video.sourceUrl }).catch((e: Error) =>
              toast.error('Could not open the link', { description: e.message }),
            )
          }
        >
          <ExternalLink /> Open on YouTube
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-danger [&_svg]:text-danger" onSelect={onDelete}>
          <Trash2 /> Delete…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export const VideoCard = React.memo(function VideoCard({
  video,
  onDelete,
}: {
  video: VideoView;
  onDelete: (v: VideoView) => void;
}) {
  const fav = useSetVideoFavorite();
  const cancel = useCancelPipeline();
  const active = isActiveVideo(video);
  return (
    <article
      data-testid="video-card"
      data-video-id={video.id}
      className="group relative flex flex-col overflow-hidden rounded-xl border bg-card shadow-xs transition-[border-color,box-shadow,transform] duration-(--duration-base) ease-(--ease-standard) hover:-translate-y-px hover:border-border-strong hover:shadow-sm"
    >
      <div className="relative">
        <VideoThumb video={video} />
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-black/60 to-transparent"
        />
        {video.durationSec !== null ? (
          <span className="absolute bottom-2 right-2 rounded-md bg-black/60 px-1.5 py-0.5 text-2xs font-semibold tabular-nums text-white backdrop-blur-sm">
            {formatClock(video.durationSec)}
          </span>
        ) : null}
        {video.status !== 'ready' ? (
          <span className="absolute bottom-2 left-2">
            <StatusBadge video={video} />
          </span>
        ) : null}
        <div
          className={cn(
            'absolute right-2 top-2 z-10 flex items-center gap-1 transition-opacity duration-(--duration-fast)',
            'opacity-0 focus-within:opacity-100 group-hover:opacity-100',
            video.favorite && 'opacity-100',
          )}
        >
          <StarButton
            overlay
            label={video.title}
            active={video.favorite}
            onToggle={() => fav.mutate({ id: video.id, value: !video.favorite })}
            className="size-8"
          />
          <VideoMenu
            video={video}
            onDelete={() => onDelete(video)}
            className="size-8 rounded-full"
          />
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-2 p-3.5">
        <div className="min-w-0">
          <h3 className="line-clamp-2 font-sans text-sm font-semibold leading-[18px] tracking-normal">
            <Link
              href={videoHref(video.id)}
              className="after:absolute after:inset-0 after:content-[''] focus-visible:outline-offset-[-2px]"
            >
              {video.title}
            </Link>
          </h3>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {video.channel ?? 'Unknown channel'} · {timeAgo(video.createdAt)}
          </p>
        </div>
        {active ? (
          <div className="relative z-10 mt-auto">
            <PipelineProgressCompact
              video={video}
              onCancel={() => cancel.mutate({ videoId: video.id })}
            />
          </div>
        ) : video.status === 'failed' ? (
          <p
            className="mt-auto line-clamp-2 text-xs font-medium text-danger"
            title={video.error ?? undefined}
          >
            {failureSummary(video.error)}
          </p>
        ) : (
          <div className="mt-auto flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="tabular-nums">
              {video.clipCount} {video.clipCount === 1 ? 'clip' : 'clips'}
            </span>
            {video.topScore !== null ? (
              <span className="flex items-center gap-1.5">
                <span className="text-2xs text-subtle">Top</span>
                <ScoreChip score={video.topScore} />
              </span>
            ) : null}
          </div>
        )}
      </div>
    </article>
  );
});

export const VideoRow = React.memo(function VideoRow({
  video,
  onDelete,
}: {
  video: VideoView;
  onDelete: (v: VideoView) => void;
}) {
  const fav = useSetVideoFavorite();
  const cancel = useCancelPipeline();
  const active = isActiveVideo(video);
  return (
    <li
      data-testid="video-row"
      data-video-id={video.id}
      className="group relative flex items-center gap-4 px-4 py-3 transition-colors duration-(--duration-fast) hover:bg-accent/50"
    >
      <div className="relative w-32 shrink-0 overflow-hidden rounded-md">
        <VideoThumb video={video} />
        {video.durationSec !== null ? (
          <span className="absolute bottom-1 right-1 rounded bg-black/60 px-1 text-2xs font-semibold tabular-nums text-white">
            {formatClock(video.durationSec)}
          </span>
        ) : null}
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="truncate font-sans text-sm font-semibold tracking-normal">
          <Link
            href={videoHref(video.id)}
            className="after:absolute after:inset-0 after:content-[''] focus-visible:outline-offset-[-2px]"
          >
            {video.title}
          </Link>
        </h3>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {video.channel ?? 'Unknown channel'} · {timeAgo(video.createdAt)}
        </p>
        {active ? (
          <div className="relative z-10 mt-2 max-w-md">
            <PipelineProgressCompact
              video={video}
              onCancel={() => cancel.mutate({ videoId: video.id })}
            />
          </div>
        ) : video.status === 'failed' ? (
          <p
            className="mt-1 line-clamp-1 text-xs font-medium text-danger"
            title={video.error ?? undefined}
          >
            {failureSummary(video.error)}
          </p>
        ) : null}
      </div>
      <div className="hidden w-28 shrink-0 min-[1100px]:block">
        {video.status === 'ready' ? null : <StatusBadge video={video} />}
      </div>
      <div className="w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {video.clipCount} {video.clipCount === 1 ? 'clip' : 'clips'}
      </div>
      <div className="flex w-12 shrink-0 justify-center">
        {video.topScore !== null ? <ScoreChip score={video.topScore} /> : null}
      </div>
      <div className="relative z-10 flex shrink-0 items-center gap-1">
        <StarButton
          label={video.title}
          active={video.favorite}
          onToggle={() => fav.mutate({ id: video.id, value: !video.favorite })}
        />
        <VideoMenu video={video} onDelete={() => onDelete(video)} />
      </div>
    </li>
  );
});
