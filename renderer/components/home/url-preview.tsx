'use client';

import Link from 'next/link';
import { Clapperboard, Clock, RefreshCw, ScrollText } from 'lucide-react';
import type { UrlInfo } from '@shared/pipeline';
import { Badge } from '@/components/ui/badge';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatClock, formatUploadDate } from '@/lib/format';
import { classifyFailure } from '@/lib/pipeline-ui';
import { VideoThumb } from '@/components/library/video-card';

export function PreviewSkeleton() {
  return (
    <div
      className="flex gap-4 rounded-xl border bg-background/60 p-3"
      aria-busy
      aria-label="Checking the link"
    >
      <Skeleton className="aspect-video w-48 shrink-0 rounded-lg" />
      <div className="flex-1 space-y-2.5 py-1">
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-3 w-1/2" />
        <div className="flex gap-2 pt-2">
          <Skeleton className="h-5 w-16 rounded-full" />
          <Skeleton className="h-5 w-20 rounded-full" />
        </div>
      </div>
    </div>
  );
}

export function UrlPreviewCard({ info }: { info: UrlInfo }) {
  const cc = !!info.license && /creative commons/i.test(info.license);
  const uploaded = formatUploadDate(info.uploadDate);
  return (
    <div
      className="flex gap-4 rounded-xl border bg-background/60 p-3 backdrop-blur"
      data-testid="url-preview"
    >
      <div className="relative w-48 shrink-0 overflow-hidden rounded-lg">
        <VideoThumb video={{ thumbnail: info.thumbnail }} />
        {info.durationSec !== null ? (
          <span className="absolute bottom-1.5 right-1.5 rounded-md bg-black/65 px-1.5 py-0.5 text-2xs font-semibold tabular-nums text-white">
            {formatClock(info.durationSec)}
          </span>
        ) : null}
      </div>
      <div className="min-w-0 flex-1 py-0.5">
        <p className="line-clamp-2 text-md font-semibold leading-snug" data-testid="preview-title">
          {info.title}
        </p>
        <p className="mt-1 truncate text-sm text-muted-foreground">
          {info.channel ?? 'Unknown channel'}
          {uploaded ? ` · ${uploaded}` : ''}
        </p>
        {info.description ? (
          <p className="mt-2 line-clamp-2 text-xs leading-4 text-subtle">{info.description}</p>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {info.durationSec !== null ? (
            <Badge variant="neutral" className="tabular-nums">
              <Clock aria-hidden /> {formatClock(info.durationSec)}
            </Badge>
          ) : null}
          {info.chapters.length > 0 ? (
            <Badge variant="neutral">
              <ScrollText aria-hidden /> {info.chapters.length}{' '}
              {info.chapters.length === 1 ? 'chapter' : 'chapters'}
            </Badge>
          ) : null}
          {cc ? (
            <Badge variant="success" title={info.license ?? undefined} data-testid="cc-badge">
              <Clapperboard aria-hidden /> Creative Commons
            </Badge>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function LiveRejected() {
  return (
    <Banner tone="warning" title="This is a live stream" className="max-w-3xl">
      Clipfern clips finished videos. Come back once the stream has ended and YouTube has published
      the recording. Live clipping arrives in a later version.
    </Banner>
  );
}

/** Probe failures (bot check, private, age-restricted, ...) with the actual error text and a way out. */
export function ProbeError({
  message,
  onRetry,
  retrying,
}: {
  message: string;
  onRetry: () => void;
  retrying: boolean;
}) {
  const r = classifyFailure(message);
  return (
    <Banner
      tone="danger"
      title={r.kind === 'other' ? 'Could not read this video' : r.title}
      className="max-w-3xl"
    >
      <span className="selectable block" data-testid="probe-error">
        {message}
        {r.kind !== 'other' ? <span className="mt-1 block text-foreground">{r.hint}</span> : null}
      </span>
      <span className="mt-3 flex items-center gap-2">
        {r.action ? (
          <Button size="sm" variant="outline" asChild>
            <Link href={r.action.href}>{r.action.label}</Link>
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={onRetry} loading={retrying}>
          <RefreshCw /> Retry
        </Button>
      </span>
    </Banner>
  );
}
