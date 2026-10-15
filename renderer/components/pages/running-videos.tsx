'use client';

import * as React from 'react';
import Link from 'next/link';
import { Activity, ArrowUpRight, CircleAlert } from 'lucide-react';
import type { VideoView } from '@shared/pipeline';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { VideoThumb } from '@/components/library/video-card';
import { PipelineProgressCompact } from '@/components/pipeline/pipeline-progress';
import { timeAgo } from '@/lib/format';
import { videoHref } from '@/lib/hrefs';
import { useNow } from '@/lib/clock';
import { useCancelPipeline, useVideos } from '@/lib/library';
import { failureSummary, isActiveVideo } from '@/lib/pipeline-ui';
import { JobsPanelRows } from './jobs-panel';

const DAY = 86_400_000;

function RunningRow({ video }: { video: VideoView }) {
  const cancel = useCancelPipeline();
  const failed = video.status === 'failed';
  return (
    <li
      data-testid="running-video"
      data-video-id={video.id}
      className="relative flex items-center gap-4 px-5 py-3.5 transition-colors duration-(--duration-fast) hover:bg-accent/40"
    >
      <div className="w-[88px] shrink-0 overflow-hidden rounded-md">
        <VideoThumb video={video} />
      </div>
      <div className="min-w-0 flex-1">
        <Link
          href={videoHref(video.id)}
          className="block truncate text-sm font-semibold after:absolute after:inset-0 after:content-[''] focus-visible:outline-offset-[-2px]"
        >
          {video.title}
        </Link>
        <p className="mb-2 truncate text-xs text-muted-foreground">
          {video.channel ?? 'Unknown channel'} · started {timeAgo(video.createdAt)}
        </p>
        <div className="relative z-10">
          {failed ? (
            <p className="flex items-start gap-1.5 text-xs text-danger">
              <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span className="line-clamp-2 font-medium" title={video.error ?? undefined}>
                {failureSummary(video.error)}
              </span>
            </p>
          ) : (
            <PipelineProgressCompact
              video={video}
              onCancel={() => cancel.mutate({ videoId: video.id })}
            />
          )}
        </div>
      </div>
      {failed ? (
        <Button variant="outline" size="sm" asChild className="relative z-10">
          <Link href={videoHref(video.id)}>
            Fix <ArrowUpRight />
          </Link>
        </Button>
      ) : null}
    </li>
  );
}

/** Home → "Running jobs": real videos in progress (plus recent failures), live from videos:updated / pipeline:event. */
export function RunningVideos() {
  const { data, isPending } = useVideos();
  const nowDate = useNow();
  const items = React.useMemo(() => {
    const now = nowDate?.getTime() ?? 0;
    return (data?.items ?? [])
      .filter((v) => isActiveVideo(v) || (v.status === 'failed' && now - v.updatedAt < DAY))
      .sort(
        (a, b) => Number(isActiveVideo(b)) - Number(isActiveVideo(a)) || b.updatedAt - a.updatedAt,
      )
      .slice(0, 6);
  }, [data, nowDate]);
  const active = items.filter(isActiveVideo).length;

  return (
    <Card>
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="font-display text-lg">Running jobs</CardTitle>
            <CardDescription>Live progress for everything Clipfern is working on.</CardDescription>
          </div>
          {active > 0 ? (
            <Badge variant="primary" dot>
              {active} active
            </Badge>
          ) : null}
        </div>
      </CardHeader>
      {isPending ? (
        <div className="flex flex-col gap-3 px-5 pb-5">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          size="sm"
          icon={Activity}
          title="Nothing is running"
          description="When you start clipping, each stage (download, transcribe, find moments, render) shows up here with live progress and ETA."
          actions={
            <Button variant="outline" asChild>
              <Link href="/library/">Open library</Link>
            </Button>
          }
        />
      ) : (
        <ul className="divide-y border-t" data-testid="running-list">
          {items.map((v) => (
            <RunningRow key={v.id} video={v} />
          ))}
        </ul>
      )}
      <JobsPanelRows />
    </Card>
  );
}
