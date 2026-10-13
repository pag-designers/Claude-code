'use client';

import * as React from 'react';
import Link from 'next/link';
import { ArrowLeftRight, ChevronRight, ExternalLink } from 'lucide-react';
import type { VideoView } from '@shared/pipeline';
import { Button } from '@/components/ui/button';
import { Page } from '@/components/ui/page';
import { StatusBadge, VideoThumb } from '@/components/library/video-card';
import { formatClock } from '@/lib/format';
import { videoHref } from '@/lib/hrefs';
import { TOOLS } from '@/lib/tools';
import { TOOL_ROUTE_META, type ToolRouteId } from '@/lib/cp2-tools';

export function ToolBreadcrumb({ tool }: { tool: ToolRouteId }) {
  return (
    <nav aria-label="Breadcrumb" className="-mb-3">
      <ol className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <li>
          <Link href="/tools/" className="font-medium hover:text-foreground">
            Tools
          </Link>
        </li>
        <li aria-hidden>
          <ChevronRight className="size-3.5 text-subtle" />
        </li>
        <li aria-current="page" className="font-medium text-foreground">
          {TOOL_ROUTE_META[tool].title}
        </li>
      </ol>
    </nav>
  );
}

/** Page frame of a standalone tool: breadcrumb, title with icon, the chosen source video and a "Change" action. */
export function ToolShell({
  tool,
  video,
  onChange,
  wide,
  children,
}: {
  tool: ToolRouteId;
  video?: VideoView | null;
  onChange?: () => void;
  wide?: boolean;
  children: React.ReactNode;
}) {
  const meta = TOOL_ROUTE_META[tool];
  const Icon = TOOLS.find((t) => t.id === tool)?.icon;
  return (
    <Page wide={wide} className="gap-6" data-testid="tool-page" data-tool={tool}>
      <ToolBreadcrumb tool={tool} />
      <header className="flex items-start gap-4">
        {Icon ? (
          <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary-text">
            <Icon className="size-6" aria-hidden />
          </span>
        ) : null}
        <div className="min-w-0">
          <h1 className="font-display text-3xl font-semibold leading-tight">{meta.title}</h1>
          <p className="mt-1 max-w-2xl text-base text-muted-foreground">{meta.blurb}</p>
        </div>
      </header>
      {video ? (
        <section
          aria-label="Source video"
          data-testid="tool-source"
          className="flex items-center gap-4 rounded-xl border bg-card p-3 pr-4"
        >
          <div className="w-28 shrink-0 overflow-hidden rounded-lg border">
            <VideoThumb video={video} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="line-clamp-1 text-md font-semibold" data-testid="tool-source-title">
              {video.title}
            </p>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
              <StatusBadge video={video} />
              <span>{video.channel ?? 'Unknown channel'}</span>
              {video.durationSec !== null ? (
                <>
                  <span aria-hidden>·</span>
                  <span className="tabular-nums">{formatClock(video.durationSec)}</span>
                </>
              ) : null}
              {video.clipCount > 0 ? (
                <>
                  <span aria-hidden>·</span>
                  <span className="tabular-nums">
                    {video.clipCount} {video.clipCount === 1 ? 'clip' : 'clips'}
                  </span>
                </>
              ) : null}
            </p>
          </div>
          <Button variant="ghost" size="sm" asChild>
            <Link href={videoHref(video.id)}>
              <ExternalLink /> Open video
            </Link>
          </Button>
          <Button variant="outline" size="sm" onClick={onChange} data-testid="change-video">
            <ArrowLeftRight /> Change video
          </Button>
        </section>
      ) : null}
      {children}
    </Page>
  );
}
