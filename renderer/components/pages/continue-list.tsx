'use client';

import * as React from 'react';
import Link from 'next/link';
import { ArrowRight, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { ScoreChip } from '@/components/ui/score-badge';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge, VideoThumb } from '@/components/library/video-card';
import { timeAgo } from '@/lib/format';
import { videoHref } from '@/lib/hrefs';
import { useVideos } from '@/lib/library';

/** "Continue where you left off": the most recently touched videos, straight into their detail page. */
export function ContinueList() {
  const { data, isPending } = useVideos();
  const recent = React.useMemo(
    () => [...(data?.items ?? [])].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 4),
    [data],
  );
  return (
    <Card>
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="font-display text-lg">Continue where you left off</CardTitle>
            <CardDescription>Recent projects open straight into their clips.</CardDescription>
          </div>
          {recent.length > 0 ? (
            <Button variant="ghost" size="sm" asChild>
              <Link href="/library/">
                Library <ArrowRight />
              </Link>
            </Button>
          ) : null}
        </div>
      </CardHeader>
      {isPending ? (
        <div className="flex flex-col gap-3 px-5 pb-5">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      ) : recent.length === 0 ? (
        <EmptyState
          size="sm"
          icon={Clock}
          title="No projects yet"
          description="Your first video will appear here with its clips, transcript and chapters, ready to pick up any time."
        />
      ) : (
        <ul className="divide-y border-t" data-testid="continue-list">
          {recent.map((v) => (
            <li
              key={v.id}
              data-testid="continue-item"
              className="relative flex items-center gap-4 px-5 py-3 transition-colors duration-(--duration-fast) hover:bg-accent/40"
            >
              <div className="w-[88px] shrink-0 overflow-hidden rounded-md">
                <VideoThumb video={v} />
              </div>
              <div className="min-w-0 flex-1">
                <Link
                  href={videoHref(v.id)}
                  className="block truncate text-sm font-semibold after:absolute after:inset-0 after:content-[''] focus-visible:outline-offset-[-2px]"
                >
                  {v.title}
                </Link>
                <p className="truncate text-xs text-muted-foreground">
                  {v.status === 'ready'
                    ? `${v.clipCount} ${v.clipCount === 1 ? 'clip' : 'clips'}`
                    : null}
                  {v.status === 'ready' ? ' · ' : ''}
                  {timeAgo(v.updatedAt)}
                </p>
              </div>
              {v.status === 'ready' ? (
                v.topScore !== null ? (
                  <ScoreChip score={v.topScore} />
                ) : null
              ) : (
                <StatusBadge video={v} />
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
