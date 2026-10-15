'use client';

import * as React from 'react';
import { ListChecks, RotateCcw, Search, Send, SearchX, X } from 'lucide-react';
import type { PostView, SocialAccount } from '@shared/publish';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { formatUntil, formatWhen } from '@/lib/publish/dates';
import {
  NO_FILTERS,
  PLATFORM_INFO,
  PLATFORM_ORDER,
  STATUS_FILTERS,
  calendarTime,
  canPostNow,
  hasActiveFilters,
  queueSections,
  type PostFilters,
  type StatusFilter,
} from '@/lib/publish/model';
import { cn } from '@/lib/utils';
import { PlatformIcon, PostStatusChip } from './platform';
import type { Platform } from '@shared/cp2';

/* ---------------------------------------------------------------------------------- filters ----- */

export function PostFilterBar({
  filters,
  onChange,
  accounts,
  className,
}: {
  filters: PostFilters;
  onChange: (f: PostFilters) => void;
  accounts: readonly SocialAccount[];
  className?: string;
}) {
  const patch = (p: Partial<PostFilters>) => onChange({ ...filters, ...p });
  return (
    <div
      className={cn('flex flex-wrap items-center gap-2', className)}
      role="search"
      aria-label="Filter posts"
    >
      <div className="w-64 max-[1180px]:w-52">
        <Input
          type="search"
          value={filters.query}
          onChange={(e) => patch({ query: e.target.value })}
          placeholder="Search posts…"
          aria-label="Search posts"
          leading={<Search />}
          className="h-8"
          data-testid="filter-search"
        />
      </div>
      <Select value={filters.status} onValueChange={(v) => patch({ status: v as StatusFilter })}>
        <SelectTrigger
          aria-label="Filter by status"
          className="h-8 w-44"
          data-testid="filter-status"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {STATUS_FILTERS.map((s) => (
            <SelectItem key={s.value} value={s.value}>
              {s.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={filters.platform}
        onValueChange={(v) => patch({ platform: v as Platform | 'all' })}
      >
        <SelectTrigger
          aria-label="Filter by platform"
          className="h-8 w-40"
          data-testid="filter-platform"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All platforms</SelectItem>
          {PLATFORM_ORDER.map((p) => (
            <SelectItem key={p} value={p}>
              {PLATFORM_INFO[p].name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={filters.accountId} onValueChange={(v) => patch({ accountId: v })}>
        <SelectTrigger
          aria-label="Filter by account"
          className="h-8 w-44"
          data-testid="filter-account"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All accounts</SelectItem>
          {accounts.map((a) => (
            <SelectItem key={a.id} value={a.id}>
              {a.displayName} · {PLATFORM_INFO[a.platform].short}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {hasActiveFilters(filters) ? (
        <Button
          variant="ghost"
          size="xs"
          onClick={() => onChange(NO_FILTERS)}
          data-testid="filter-clear"
        >
          <X /> Clear filters
        </Button>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------------------------- rows ----- */

function QueueRow({
  post,
  now,
  onOpen,
  onRetry,
  onPostNow,
  busyId,
}: {
  post: PostView;
  now: number | null;
  onOpen: (id: string) => void;
  onRetry: (id: string) => void;
  onPostNow: (id: string) => void;
  busyId: string | null;
}) {
  const at = calendarTime(post);
  return (
    <li
      className={cn(
        'group/row relative grid grid-cols-[40px_minmax(0,1fr)_auto_auto] items-center gap-x-4 gap-y-1 px-4 py-3 transition-colors duration-(--duration-fast) hover:bg-accent/50',
        'min-[1100px]:grid-cols-[40px_minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_auto_auto]',
      )}
      data-testid="queue-row"
      data-post-id={post.id}
      data-status={post.status}
    >
      <div className="relative aspect-[9/16] w-10 overflow-hidden rounded-md border bg-black">
        {post.thumbUrl ? (
          <img src={post.thumbUrl} alt="" className="size-full object-cover" />
        ) : null}
      </div>
      <div className="min-w-0">
        <button
          type="button"
          onClick={() => onOpen(post.id)}
          className="block max-w-full truncate rounded-xs text-left text-sm font-medium outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring"
          data-testid="queue-open"
        >
          {post.title}
        </button>
        <p className="mt-0.5 truncate text-xs text-muted-foreground min-[1100px]:hidden">
          {PLATFORM_INFO[post.platform].short} · {post.accountName}
          {at !== null && now !== null ? ` · ${formatWhen(at, now)}` : ''}
        </p>
        {post.error && post.status === 'failed' ? (
          <p className="mt-0.5 truncate text-xs text-danger" title={post.error.message}>
            {post.error.message}
          </p>
        ) : null}
      </div>
      <div className="hidden min-w-0 items-center gap-2 min-[1100px]:flex">
        <PlatformIcon platform={post.platform} />
        <div className="min-w-0">
          <p className="truncate text-sm">{PLATFORM_INFO[post.platform].name}</p>
          <p className="truncate text-xs text-muted-foreground">{post.accountName}</p>
        </div>
      </div>
      <div className="hidden min-w-0 min-[1100px]:block">
        {at !== null && now !== null ? (
          <>
            <p className="truncate text-sm tabular-nums">{formatWhen(at, now)}</p>
            {post.status === 'scheduled' ? (
              <p className="text-xs text-muted-foreground">{formatUntil(at, now)}</p>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">No date</p>
        )}
      </div>
      <PostStatusChip status={post.status} className="justify-self-start" />
      <div className="relative z-10 flex items-center justify-end gap-1.5">
        {post.status === 'failed' ? (
          <Button
            size="xs"
            variant="outline"
            loading={busyId === post.id}
            onClick={() => onRetry(post.id)}
            data-testid="queue-retry"
          >
            <RotateCcw /> Retry
          </Button>
        ) : post.status === 'missed' ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() => onOpen(post.id)}
            data-testid="queue-reschedule"
          >
            Reschedule
          </Button>
        ) : post.status === 'scheduled' && canPostNow(post.status) ? (
          <Button
            size="xs"
            variant="ghost"
            loading={busyId === post.id}
            onClick={() => onPostNow(post.id)}
            className="opacity-0 focus-visible:opacity-100 group-hover/row:opacity-100"
            data-testid="queue-post-now"
          >
            <Send /> Post now
          </Button>
        ) : null}
      </div>
    </li>
  );
}

/* ------------------------------------------------------------------------------------ queue ----- */

export function PostQueue({
  posts,
  allCount,
  filters,
  now,
  loading,
  hasAccounts,
  onOpen,
  onRetry,
  onPostNow,
  busyId,
  onClearFilters,
  onPick,
}: {
  posts: readonly PostView[];
  allCount: number;
  filters: PostFilters;
  now: number | null;
  loading: boolean;
  hasAccounts: boolean;
  onOpen: (id: string) => void;
  onRetry: (id: string) => void;
  onPostNow: (id: string) => void;
  busyId: string | null;
  onClearFilters: () => void;
  onPick: () => void;
}) {
  const sections = React.useMemo(() => queueSections(posts), [posts]);
  if (loading)
    return (
      <div
        className="overflow-hidden rounded-xl border bg-card"
        aria-busy
        aria-label="Loading posts"
      >
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-4 border-b px-4 py-3 last:border-b-0">
            <Skeleton className="h-14 w-10" />
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="ml-auto h-5 w-24 rounded-full" />
          </div>
        ))}
      </div>
    );
  if (allCount === 0)
    return (
      <div className="rounded-xl border bg-card" data-testid="queue-empty">
        <EmptyState
          icon={ListChecks}
          title="Nothing scheduled yet"
          description={
            hasAccounts
              ? 'Pick a rendered clip, choose where it goes and when. Failed posts show the platform’s own error with a retry.'
              : 'Connect YouTube, Instagram or TikTok first, then pick a clip to schedule.'
          }
          actions={
            hasAccounts ? (
              <Button variant="primary" onClick={onPick}>
                Pick a clip to schedule
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  if (posts.length === 0)
    return (
      <div className="rounded-xl border bg-card" data-testid="queue-no-match">
        <EmptyState
          size="sm"
          icon={SearchX}
          title="No posts match"
          description="Try another status, platform or search."
          actions={
            hasActiveFilters(filters) ? (
              <Button variant="outline" onClick={onClearFilters}>
                Clear filters
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  return (
    <div className="flex flex-col gap-5" data-testid="queue">
      {sections.map((s) => (
        <section key={s.id} aria-label={s.title} data-section={s.id}>
          <h3 className="mb-2 flex items-center gap-2 text-2xs font-semibold uppercase tracking-wider text-subtle">
            {s.title}
            <span className="rounded-full bg-muted px-1.5 py-px tabular-nums text-muted-foreground">
              {s.posts.length}
            </span>
          </h3>
          <ul className="divide-y overflow-hidden rounded-xl border bg-card">
            {s.posts.map((p) => (
              <QueueRow
                key={p.id}
                post={p}
                now={now}
                onOpen={onOpen}
                onRetry={onRetry}
                onPostNow={onPostNow}
                busyId={busyId}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
