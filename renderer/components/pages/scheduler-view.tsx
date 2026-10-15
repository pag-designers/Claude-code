'use client';

import * as React from 'react';
import {
  CalendarClock,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ListChecks,
  Plus,
} from 'lucide-react';
import type { PostSource } from '@shared/publish';
import { AccountsStrip } from '@/components/scheduler/accounts-strip';
import { SchedulerCalendar } from '@/components/scheduler/calendar';
import { PickSourceDialog } from '@/components/scheduler/pick-source-dialog';
import { PostDrawer } from '@/components/scheduler/post-drawer';
import { PostFilterBar, PostQueue } from '@/components/scheduler/queue';
import { SchedulePostDialog } from '@/components/scheduler/schedule-dialog';
import { SchedulerStatusBar } from '@/components/scheduler/status-bar';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { Page, PageHeader } from '@/components/ui/page';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { usePersistedChoice } from '@/lib/persist';
import {
  calendarTitle,
  localZoneLabel,
  startOfDay,
  stepCursor,
  type CalendarView,
} from '@/lib/publish/dates';
import { NO_FILTERS, filterPosts, type PostFilters } from '@/lib/publish/model';
import { useNowMs } from '@/lib/publish/now';
import {
  useAccounts,
  usePostNow,
  usePosts,
  useReschedulePost,
  useRetryPost,
  useSchedulerStatus,
  useSetPaused,
} from '@/lib/publish/queries';

type Mode = 'calendar' | 'queue';
const MODES = ['calendar', 'queue'] as const;
const VIEWS = ['month', 'week', 'day'] as const;

/** `?post=<id>` (notification / tray deep link) opens that post's panel on arrival. */
function initialPostId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return new URLSearchParams(window.location.search).get('post');
  } catch {
    return null;
  }
}

export function SchedulerView() {
  const nowMs = useNowMs();
  const accountsQ = useAccounts();
  const postsQ = usePosts();
  const statusQ = useSchedulerStatus();
  const setPaused = useSetPaused();
  const reschedule = useReschedulePost();
  const retry = useRetryPost();
  const postNow = usePostNow();

  const [mode, setMode] = usePersistedChoice<Mode>('clipfern.scheduler.mode', MODES, 'calendar');
  const [view, setView] = usePersistedChoice<CalendarView>(
    'clipfern.scheduler.view',
    VIEWS,
    'month',
  );
  const [cursorMs, setCursorMs] = React.useState<number | null>(null);
  const [filters, setFilters] = React.useState<PostFilters>(NO_FILTERS);
  const [openId, setOpenId] = React.useState<string | null>(initialPostId);
  const [pickOpen, setPickOpen] = React.useState(false);
  const [sched, setSched] = React.useState<{ sources: PostSource[]; at: number | null } | null>(
    null,
  );
  const [pickAt, setPickAt] = React.useState<number | null>(null);

  const accounts = accountsQ.data?.accounts;
  const allPosts = postsQ.data?.items;
  const posts = React.useMemo(() => filterPosts(allPosts ?? [], filters), [allPosts, filters]);
  const missed = (allPosts ?? []).filter((p) => p.status === 'missed').length;
  const cursor = React.useMemo(
    () => (nowMs === null ? null : new Date(cursorMs ?? nowMs)),
    [cursorMs, nowMs],
  );
  const isCurrent = cursorMs === null;
  const hasConnected = (accounts ?? []).some((a) => a.status === 'connected');
  const busyId =
    (retry.isPending ? retry.variables?.id : postNow.isPending ? postNow.variables?.id : null) ??
    null;

  const openPicker = (at: number | null) => {
    setPickAt(at);
    setPickOpen(true);
  };

  return (
    <Page wide className="gap-5">
      <PageHeader
        title="Scheduler"
        description="Plan posts and let Clipfern publish them through the official APIs while the app is running."
        actions={
          <Button variant="primary" onClick={() => openPicker(null)} data-testid="schedule-new">
            <CalendarClock /> Schedule a post
          </Button>
        }
      />

      <SchedulerStatusBar
        status={statusQ.data}
        loading={statusQ.isPending}
        now={nowMs}
        missed={missed}
        pausing={setPaused.isPending}
        onSetPaused={(p) => setPaused.mutate(p)}
      />

      {accountsQ.isError ? (
        <Banner
          tone="danger"
          title="Could not load your accounts"
          action={
            <Button size="sm" variant="outline" onClick={() => void accountsQ.refetch()}>
              Retry
            </Button>
          }
        >
          {accountsQ.error.message}
        </Banner>
      ) : (
        <AccountsStrip
          accounts={accounts}
          setup={accountsQ.data?.setup}
          quota={statusQ.data?.quota}
          loading={accountsQ.isPending}
          now={nowMs}
        />
      )}

      <section aria-label="Posts" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <Segmented<Mode>
            label="Scheduler view"
            value={mode}
            onValueChange={setMode}
            options={[
              { value: 'calendar', label: 'Calendar', icon: <CalendarDays /> },
              { value: 'queue', label: 'Queue', icon: <ListChecks /> },
            ]}
          />
          {mode === 'calendar' ? (
            <>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label="Previous"
                  onClick={() => cursor && setCursorMs(stepCursor(view, cursor, -1).getTime())}
                >
                  <ChevronLeft />
                </Button>
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label="Next"
                  onClick={() => cursor && setCursorMs(stepCursor(view, cursor, 1).getTime())}
                >
                  <ChevronRight />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="ml-1"
                  disabled={isCurrent}
                  onClick={() => setCursorMs(null)}
                >
                  Today
                </Button>
              </div>
              <h2
                className="min-w-44 font-display text-xl font-semibold"
                aria-live="polite"
                data-testid="calendar-title"
              >
                {cursor ? calendarTitle(view, cursor) : <Skeleton className="h-7 w-44" />}
              </h2>
              <Segmented<CalendarView>
                className="ml-auto"
                label="Calendar view"
                value={view}
                onValueChange={(v) => {
                  setView(v);
                }}
                options={[
                  { value: 'month', label: 'Month' },
                  { value: 'week', label: 'Week' },
                  { value: 'day', label: 'Day' },
                ]}
              />
            </>
          ) : null}
        </div>
        <PostFilterBar filters={filters} onChange={setFilters} accounts={accounts ?? []} />

        {mode === 'calendar' ? (
          <>
            {hasConnected && allPosts && allPosts.length === 0 ? (
              <Banner
                tone="info"
                title="Pick a clip to schedule"
                action={
                  <Button size="sm" variant="primary" onClick={() => openPicker(null)}>
                    <Plus /> Pick a clip
                  </Button>
                }
              >
                Your calendar is empty. Choose a rendered clip, tick the accounts, and Clipfern
                posts it at the time you pick.
              </Banner>
            ) : null}
            {!accountsQ.isPending && accounts && accounts.length === 0 ? (
              <Banner tone="info" title="Connect an account to start scheduling">
                Connect YouTube, Instagram or TikTok above. Nothing is posted until you schedule a
                clip.
              </Banner>
            ) : null}
            {nowMs !== null && cursor && allPosts ? (
              <SchedulerCalendar
                view={view}
                cursor={cursor}
                now={nowMs}
                posts={posts}
                onOpenPost={setOpenId}
                onAdd={(day, at) => {
                  openPicker(at ?? withTimeOfDay(day, nowMs));
                }}
                onReschedule={(post, at) => reschedule.mutate({ post, at })}
                onShowDay={(day) => {
                  setView('day');
                  setCursorMs(startOfDay(day).getTime());
                }}
              />
            ) : (
              <Skeleton className="h-[560px] rounded-xl" aria-label="Loading calendar" />
            )}
            <p className="text-xs text-subtle">
              Drag a scheduled post to another day or hour to reschedule it. Times are in your local
              time zone: {localZoneLabel(nowMs ?? undefined)}.
            </p>
          </>
        ) : (
          <PostQueue
            posts={posts}
            allCount={allPosts?.length ?? 0}
            filters={filters}
            now={nowMs}
            loading={postsQ.isPending}
            hasAccounts={hasConnected}
            onOpen={setOpenId}
            onRetry={(id) => retry.mutate({ id })}
            onPostNow={(id) => postNow.mutate({ id })}
            busyId={busyId}
            onClearFilters={() => setFilters(NO_FILTERS)}
            onPick={() => openPicker(null)}
          />
        )}
      </section>

      <PostDrawer postId={openId} onClose={() => setOpenId(null)} />
      <PickSourceDialog
        open={pickOpen}
        onOpenChange={setPickOpen}
        onContinue={(sources) => {
          setPickOpen(false);
          setSched({ sources, at: pickAt });
        }}
      />
      {sched ? (
        <SchedulePostDialog
          open
          source={sched.sources}
          defaultScheduledAt={sched.at}
          onOpenChange={(o) => !o && setSched(null)}
        />
      ) : null}
    </Page>
  );
}

/** A day clicked in the calendar: noon that day, or an hour from now when it is today. */
function withTimeOfDay(day: Date, now: number): number {
  const noon = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 12, 0, 0, 0).getTime();
  return noon > now + 15 * 60_000 ? noon : now + 60 * 60_000;
}
