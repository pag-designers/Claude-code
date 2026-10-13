'use client';

import * as React from 'react';
import { CircleAlert, RotateCcw, X } from 'lucide-react';
import { toast } from 'sonner';
import type { JobView } from '@shared/domain';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
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

/** Background tasks that are not clipping runs (yt-dlp download, storage refresh, ...). Hidden when there are none. */
export function JobsPanelRows() {
  const { data } = useJobs();
  const items = (data?.items ?? [])
    .filter(
      (j) =>
        !j.kind.startsWith('pipeline') &&
        (j.status === 'running' || j.status === 'queued' || j.status === 'failed'),
    )
    .sort(
      (a, b) =>
        Number(b.status === 'running') - Number(a.status === 'running') ||
        b.createdAt - a.createdAt,
    )
    .slice(0, 4);
  if (items.length === 0) return null;
  return (
    <div className="border-t" data-testid="background-tasks">
      <p className="px-5 pt-3 text-2xs font-semibold uppercase tracking-wider text-subtle">
        Background tasks
      </p>
      <ul className="divide-y">
        {items.map((j) => (
          <JobRow key={j.id} job={j} />
        ))}
      </ul>
    </div>
  );
}
