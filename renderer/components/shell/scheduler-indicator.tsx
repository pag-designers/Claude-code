'use client';

import Link from 'next/link';
import { useAccounts, usePosts, useSchedulerLive, useSchedulerStatus } from '@/lib/publish/queries';
import { formatUntil } from '@/lib/publish/dates';
import { useNowMs } from '@/lib/publish/now';
import { StatusDot, schedulerTone } from '@/components/scheduler/status-bar';
import { cn } from '@/lib/utils';

/**
 * Top-bar "Scheduler active · next post in 2 h" / "Scheduler paused" / "N missed" chip linking to /scheduler/.
 * Hidden until at least one account is connected. Also owns the live subscription that keeps the posts, accounts and
 * scheduler caches current for every page.
 */
export function SchedulerIndicator() {
  useSchedulerLive();
  const now = useNowMs();
  const accounts = useAccounts();
  const status = useSchedulerStatus();
  const posts = usePosts();
  const hasAccounts = (accounts.data?.accounts.length ?? 0) > 0;
  const s = status.data;
  if (!hasAccounts || !s) return null;

  const tone = schedulerTone(s);
  const missed = (posts.data?.items ?? []).filter((p) => p.status === 'missed').length;
  const failed = (posts.data?.items ?? []).filter((p) => p.status === 'failed').length;
  const word = tone === 'active' ? 'active' : tone === 'paused' ? 'paused' : 'off';
  const lead =
    tone === 'active'
      ? 'Scheduler active'
      : tone === 'paused'
        ? 'Scheduler paused'
        : 'Scheduler off';
  const until =
    tone === 'active' && s.nextAt !== null && now !== null ? formatUntil(s.nextAt, now) : null;
  const next = until
    ? `next ${until}`
    : tone === 'active' && s.upcoming === 0
      ? 'nothing queued'
      : null;
  const attention = missed + failed;
  const label = [
    lead,
    until ? `next post ${until}` : next,
    missed ? `${missed} missed` : null,
    failed ? `${failed} failed` : null,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <Link
      href="/scheduler/"
      aria-label={label}
      title={label}
      data-testid="scheduler-indicator"
      data-tone={tone}
      className={cn(
        'mr-1 flex h-8 min-w-0 max-w-[22rem] shrink-[8] items-center gap-2 whitespace-nowrap rounded-md border border-border-strong bg-transparent px-2.5 text-sm text-muted-foreground outline-none transition-colors',
        'hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
        attention > 0 && 'border-warning/50',
      )}
    >
      <StatusDot tone={tone} />
      <span className="shrink-0 font-medium text-foreground">
        <span className="max-[1360px]:hidden">Scheduler </span>
        <span className="max-[1360px]:capitalize">{word}</span>
      </span>
      {next ? (
        <span className="min-w-0 truncate max-[1360px]:hidden">
          <span aria-hidden className="mr-2 text-subtle">
            ·
          </span>
          {next}
        </span>
      ) : null}
      {attention > 0 ? (
        <span className="shrink-0 rounded-full bg-warning-soft px-1.5 py-px text-2xs font-semibold tabular-nums text-warning">
          {missed ? `${missed} missed` : `${failed} failed`}
        </span>
      ) : null}
    </Link>
  );
}
