'use client';

import * as React from 'react';
import Link from 'next/link';
import { Activity, CircleAlert, RotateCcw, X } from 'lucide-react';
import { toast } from 'sonner';
import type { JobView } from '@shared/domain';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { useIpcMutation } from '@/lib/ipc';
import { useJobs } from '@/lib/queries';
import { timeAgo } from '@/lib/format';

const humanize = (s: string) => s.replace(/[._:-]+/g, ' ').replace(/^./, (c) => c.toUpperCase());

function statusBadge(j: JobView) {
  switch (j.status) {
    case 'running':
      return (
        <Badge variant="primary" dot>
          Running
        </Badge>
      );
    case 'queued':
      return (
        <Badge variant="neutral" dot>
          Queued
        </Badge>
      );
    case 'succeeded':
      return <Badge variant="success">Done</Badge>;
    case 'failed':
      return <Badge variant="danger">Failed</Badge>;
    default:
      return <Badge variant="neutral">Canceled</Badge>;
  }
}

function JobRow({ job }: { job: JobView }) {
  const cancel = useIpcMutation('jobs:cancel', {
    invalidate: ['jobs:list'],
    onError: (e) => toast.error('Could not cancel job', { description: e.message }),
  });
  const retry = useIpcMutation('jobs:retry', {
    invalidate: ['jobs:list'],
    onError: (e) => toast.error('Could not retry job', { description: e.message }),
  });
  const active = job.status === 'running' || job.status === 'queued';
  return (
    <li className="flex flex-col gap-2 px-5 py-3.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{humanize(job.kind)}</p>
          <p className="truncate text-xs text-muted-foreground">
            {job.stage ? `${humanize(job.stage)} · ` : ''}
            {active
              ? `started ${timeAgo(job.startedAt ?? job.createdAt)}`
              : timeAgo(job.finishedAt ?? job.updatedAt)}
            {job.attempts > 1 ? ` · attempt ${job.attempts}/${job.maxAttempts}` : ''}
          </p>
        </div>
        {statusBadge(job)}
        {active ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Cancel ${humanize(job.kind)}`}
            onClick={() => cancel.mutate({ id: job.id })}
          >
            <X />
          </Button>
        ) : job.status === 'failed' ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => retry.mutate({ id: job.id })}
            loading={retry.isPending}
          >
            <RotateCcw /> Retry
          </Button>
        ) : null}
      </div>
      {job.status === 'running' ? (
        <div className="flex items-center gap-3">
          <Progress
            value={job.progress > 0 ? job.progress * 100 : null}
            className="h-1.5"
            aria-label="Job progress"
          />
          <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">
            {Math.round(job.progress * 100)}%
          </span>
        </div>
      ) : null}
      {job.status === 'failed' && job.error ? (
        <p className="flex items-start gap-1.5 text-xs text-danger">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {job.error}
        </p>
      ) : null}
    </li>
  );
}

export function JobsPanel() {
  const { data, isPending } = useJobs();
  const items = (data?.items ?? [])
    .filter((j) => j.status !== 'canceled' && j.status !== 'succeeded')
    .concat((data?.items ?? []).filter((j) => j.status === 'succeeded').slice(0, 3))
    .sort(
      (a, b) =>
        Number(b.status === 'running') - Number(a.status === 'running') ||
        b.createdAt - a.createdAt,
    )
    .slice(0, 8);
  const running = items.filter((j) => j.status === 'running' || j.status === 'queued').length;

  return (
    <Card>
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="font-display text-lg">Running jobs</CardTitle>
            <CardDescription>Live progress for everything Clipfern is working on.</CardDescription>
          </div>
          {running > 0 ? (
            <Badge variant="primary" dot>
              {running} active
            </Badge>
          ) : null}
        </div>
      </CardHeader>
      {isPending ? (
        <CardContent className="flex flex-col gap-3 pt-0">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </CardContent>
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
        <ul className="divide-y border-t">
          {items.map((j) => (
            <JobRow key={j.id} job={j} />
          ))}
        </ul>
      )}
    </Card>
  );
}
