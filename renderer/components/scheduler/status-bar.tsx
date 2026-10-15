'use client';

import * as React from 'react';
import Link from 'next/link';
import { Pause, Play, TriangleAlert } from 'lucide-react';
import type { SchedulerStatus } from '@shared/publish';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatUntil, formatWhen } from '@/lib/publish/dates';
import { timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';

export type SchedulerTone = 'active' | 'paused' | 'stopped';

export function schedulerTone(s: Pick<SchedulerStatus, 'active' | 'paused'>): SchedulerTone {
  return s.paused ? 'paused' : s.active ? 'active' : 'stopped';
}

/** The coloured dot that says whether the scheduler is alive (pulses while active, respects reduced motion). */
export function StatusDot({ tone, className }: { tone: SchedulerTone; className?: string }) {
  return (
    <span className={cn('relative flex size-2.5 shrink-0', className)} aria-hidden>
      {tone === 'active' ? (
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60 motion-reduce:animate-none" />
      ) : null}
      <span
        className={cn(
          'relative inline-flex size-2.5 rounded-full',
          tone === 'active' && 'bg-success',
          tone === 'paused' && 'bg-warning',
          tone === 'stopped' && 'bg-danger',
        )}
      />
    </span>
  );
}

function Fact({
  label,
  children,
  testId,
}: {
  label: string;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-2xs font-semibold uppercase tracking-wider text-subtle">{label}</dt>
      <dd className="truncate text-sm font-medium tabular-nums" data-testid={testId}>
        {children}
      </dd>
    </div>
  );
}

/** "Scheduler active" strip: state + pause/resume, next post, upcoming count, catch-up note and the tray hint. */
export function SchedulerStatusBar({
  status,
  loading,
  now,
  missed,
  pausing,
  onSetPaused,
}: {
  status: SchedulerStatus | undefined;
  loading: boolean;
  now: number | null;
  missed: number;
  pausing: boolean;
  onSetPaused: (paused: boolean) => void;
}) {
  if (loading || !status)
    return <Skeleton className="h-[76px] rounded-xl" aria-label="Loading scheduler status" />;
  const tone = schedulerTone(status);
  const title =
    tone === 'active'
      ? 'Scheduler active'
      : tone === 'paused'
        ? 'Scheduler paused'
        : 'Scheduler not running';
  const trayOn = status.trayMode && status.trayAvailable;
  const detail =
    tone === 'active'
      ? trayOn
        ? 'Posting on schedule. Closing the window keeps it running in the system tray.'
        : 'Posting on schedule while Clipfern is open.'
      : tone === 'paused'
        ? 'Nothing is published until you resume.'
        : 'Restart Clipfern to start the scheduler.';
  // only what needs attention gets its own row; the normal tray note lives in the detail line above
  const hints: React.ReactNode[] = [];
  if (!status.trayAvailable)
    hints.push('The system tray is not available here, so keep Clipfern open for posts to go out.');
  else if (!status.trayMode)
    hints.push(
      <>
        Closing the window stops the scheduler.{' '}
        <Link href="/settings/scheduler/" className="font-medium text-primary-text hover:underline">
          Turn on tray mode
        </Link>{' '}
        to keep posting in the background.
      </>,
    );
  if (status.catchUp.pending > 0)
    hints.push(
      `Catching up on ${status.catchUp.pending} ${status.catchUp.pending === 1 ? 'post' : 'posts'} that came due while Clipfern was closed.`,
    );
  else if (status.catchUp.lastRunAt !== null)
    hints.push(`Last catch-up ran ${timeAgo(status.catchUp.lastRunAt)}.`);

  return (
    <section
      aria-label="Scheduler status"
      data-testid="scheduler-status"
      data-tone={tone}
      className="overflow-hidden rounded-xl border bg-card shadow-xs"
    >
      <div className="flex flex-wrap items-center gap-x-8 gap-y-3 px-5 py-3.5">
        <div className="flex min-w-0 items-center gap-3">
          <StatusDot tone={tone} />
          <div className="min-w-0">
            <p
              className="font-display text-md font-semibold leading-5"
              data-testid="scheduler-title"
            >
              {title}
            </p>
            <p className="max-w-[22rem] text-xs text-muted-foreground">{detail}</p>
          </div>
        </div>
        <dl className="flex min-w-0 flex-1 flex-wrap items-center gap-x-8 gap-y-2">
          <Fact label="Next post" testId="status-next">
            {status.nextAt !== null && now !== null ? (
              <>
                {formatWhen(status.nextAt, now)}{' '}
                <span className="font-normal text-muted-foreground">
                  ({formatUntil(status.nextAt, now)})
                </span>
              </>
            ) : (
              <span className="font-normal text-muted-foreground">Nothing scheduled</span>
            )}
          </Fact>
          <Fact label="Upcoming" testId="status-upcoming">
            {status.upcoming}
          </Fact>
          {status.publishing > 0 ? (
            <Fact label="Publishing" testId="status-publishing">
              {status.publishing} now
            </Fact>
          ) : null}
          {missed > 0 ? (
            <Fact label="Missed" testId="status-missed">
              <span className="inline-flex items-center gap-1 text-warning">
                <TriangleAlert className="size-3.5" aria-hidden /> {missed}
              </span>
            </Fact>
          ) : null}
        </dl>
        <Button
          variant={status.paused ? 'primary' : 'outline'}
          size="sm"
          loading={pausing}
          onClick={() => onSetPaused(!status.paused)}
          data-testid="scheduler-toggle"
        >
          {status.paused ? <Play /> : <Pause />}
          {status.paused ? 'Resume scheduler' : 'Pause scheduler'}
        </Button>
      </div>
      {hints.length ? (
        <ul
          className="flex flex-col gap-1 border-t bg-muted/30 px-5 py-2.5 text-xs text-muted-foreground"
          data-testid="scheduler-hints"
        >
          {hints.map((h, i) => (
            <li key={i}>{h}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
