'use client';

import * as React from 'react';
import Link from 'next/link';
import { CalendarClock, ChevronLeft, ChevronRight, Link2, ListChecks } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Page, PageHeader } from '@/components/ui/page';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { DisabledTip } from '@/components/ui/tooltip';
import { InstagramGlyph, TiktokGlyph, YoutubeGlyph } from '@/components/ui/brand-icons';
import { useNow } from '@/lib/clock';
import { cn } from '@/lib/utils';

type View = 'month' | 'week' | 'day';

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();
const weekStart = (d: Date) => addDays(startOfDay(d), -startOfDay(d).getDay());

function titleFor(view: View, cursor: Date): string {
  if (view === 'month')
    return cursor.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  if (view === 'day')
    return cursor.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
  const s = weekStart(cursor);
  const e = addDays(s, 6);
  const sameMonth = s.getMonth() === e.getMonth();
  return `${s.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${e.toLocaleDateString('en-US', sameMonth ? { day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function MonthGrid({ cursor, now }: { cursor: Date; now: Date }) {
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const gridStart = addDays(first, -first.getDay());
  const weeks = Math.ceil(
    (first.getDay() + new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate()) / 7,
  );
  const days = Array.from({ length: weeks * 7 }, (_, i) => addDays(gridStart, i));
  return (
    <div
      role="grid"
      aria-label={titleFor('month', cursor)}
      className="overflow-hidden rounded-xl border"
    >
      <div role="row" className="grid grid-cols-7 border-b bg-muted/50">
        {WEEKDAYS.map((w) => (
          <div
            key={w}
            role="columnheader"
            className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-subtle"
          >
            {w}
          </div>
        ))}
      </div>
      <div
        className="grid grid-cols-7"
        style={{ gridTemplateRows: `repeat(${weeks}, minmax(104px, 1fr))` }}
      >
        {days.map((d, i) => {
          const inMonth = d.getMonth() === cursor.getMonth();
          const today = sameDay(d, now);
          return (
            <div
              key={d.toISOString()}
              role="gridcell"
              aria-label={
                d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) +
                (today ? ', today' : '')
              }
              aria-current={today ? 'date' : undefined}
              className={cn(
                'relative border-b border-r p-2',
                i % 7 === 6 && 'border-r-0',
                i >= days.length - 7 && 'border-b-0',
                !inMonth && 'bg-muted/30',
              )}
            >
              <span
                className={cn(
                  'inline-flex size-7 items-center justify-center rounded-full text-sm font-medium tabular-nums',
                  today
                    ? 'bg-primary text-primary-foreground'
                    : inMonth
                      ? 'text-foreground'
                      : 'text-subtle',
                )}
              >
                {d.getDate()}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TimeGrid({ days, now }: { days: Date[]; now: Date }) {
  const hours = Array.from({ length: 24 }, (_, h) => h);
  const nowTop = ((now.getHours() * 60 + now.getMinutes()) / (24 * 60)) * 100;
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    // Open scrolled to the current time so "now" is visible.
    const el = ref.current;
    if (el) el.scrollTop = Math.max(0, (el.scrollHeight * nowTop) / 100 - el.clientHeight / 3);
  }, [nowTop]);
  const cols = days.length;
  return (
    <div className="overflow-hidden rounded-xl border">
      <div
        className="grid border-b bg-muted/50"
        style={{ gridTemplateColumns: `56px repeat(${cols}, 1fr)` }}
      >
        <div />
        {days.map((d) => {
          const today = sameDay(d, now);
          return (
            <div key={d.toISOString()} className="flex items-center gap-2 px-3 py-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-subtle">
                {WEEKDAYS[d.getDay()]}
              </span>
              <span
                className={cn(
                  'inline-flex size-6 items-center justify-center rounded-full text-sm font-medium tabular-nums',
                  today && 'bg-primary text-primary-foreground',
                )}
              >
                {d.getDate()}
              </span>
            </div>
          );
        })}
      </div>
      <div ref={ref} className="scrollbar-thin relative max-h-[520px] overflow-y-auto">
        <div className="relative grid" style={{ gridTemplateColumns: `56px repeat(${cols}, 1fr)` }}>
          <div>
            {hours.map((h) => (
              <div key={h} className="relative h-14 pr-2 text-right">
                <span className="relative -top-2 text-2xs tabular-nums text-subtle">
                  {h === 0
                    ? ''
                    : new Date(2000, 0, 1, h).toLocaleTimeString('en-US', { hour: 'numeric' })}
                </span>
              </div>
            ))}
          </div>
          {days.map((d) => (
            <div key={d.toISOString()} className="relative border-l">
              {hours.map((h) => (
                <div key={h} className="h-14 border-t" />
              ))}
              {sameDay(d, now) ? (
                <div
                  className="pointer-events-none absolute inset-x-0 z-10 flex items-center"
                  style={{ top: `${nowTop}%` }}
                  aria-hidden
                >
                  <span className="-ml-1 size-2 rounded-full bg-danger" />
                  <span className="h-px flex-1 bg-danger" />
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const ACCOUNTS = [
  {
    id: 'youtube',
    name: 'YouTube Shorts',
    icon: YoutubeGlyph,
    note: 'Official YouTube Data API, ~6 uploads a day on the default quota.',
  },
  {
    id: 'instagram',
    name: 'Instagram Reels',
    icon: InstagramGlyph,
    note: 'Business or Creator account linked to a Facebook Page.',
  },
  {
    id: 'tiktok',
    name: 'TikTok',
    icon: TiktokGlyph,
    note: 'Unaudited apps post privately until TikTok approves a free audit.',
  },
] as const;

export function SchedulerView() {
  const now = useNow();
  const [view, setView] = React.useState<View>('month');
  const [offset, setOffset] = React.useState(0);

  const cursor = React.useMemo(() => {
    if (!now) return null;
    if (view === 'month') return new Date(now.getFullYear(), now.getMonth() + offset, 1);
    if (view === 'week') return addDays(now, offset * 7);
    return addDays(now, offset);
  }, [now, view, offset]);

  const days = React.useMemo(() => {
    if (!cursor) return [];
    if (view === 'day') return [startOfDay(cursor)];
    const s = weekStart(cursor);
    return Array.from({ length: 7 }, (_, i) => addDays(s, i));
  }, [cursor, view]);

  return (
    <Page wide>
      <PageHeader
        title="Scheduler"
        description="Plan posts on a calendar. Clipfern publishes through the official YouTube, Instagram and TikTok APIs while the app is running."
        actions={
          <DisabledTip reason="Posting arrives in checkpoint 5">
            <Button variant="primary" disabled>
              <CalendarClock /> Schedule a post
            </Button>
          </DisabledTip>
        }
      />
      <div className="grid grid-cols-[minmax(0,1fr)_340px] items-start gap-6 max-[1180px]:grid-cols-1">
        <section aria-label="Calendar" className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Previous"
                onClick={() => setOffset((o) => o - 1)}
              >
                <ChevronLeft />
              </Button>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Next"
                onClick={() => setOffset((o) => o + 1)}
              >
                <ChevronRight />
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="ml-1"
                disabled={offset === 0}
                onClick={() => setOffset(0)}
              >
                Today
              </Button>
            </div>
            <h2 className="min-w-48 font-display text-xl font-semibold" aria-live="polite">
              {cursor ? titleFor(view, cursor) : <Skeleton className="h-7 w-44" />}
            </h2>
            <Segmented
              className="ml-auto"
              label="Calendar view"
              value={view}
              onValueChange={(v) => {
                setView(v);
                setOffset(0);
              }}
              options={[
                { value: 'month', label: 'Month' },
                { value: 'week', label: 'Week' },
                { value: 'day', label: 'Day' },
              ]}
            />
          </div>
          {now && cursor ? (
            view === 'month' ? (
              <MonthGrid cursor={cursor} now={now} />
            ) : (
              <TimeGrid days={days} now={now} />
            )
          ) : (
            <Skeleton className="h-[560px] rounded-xl" />
          )}
          <p className="text-xs text-subtle">
            All times shown in your local time zone.{' '}
            {now ? `Today is ${now.toLocaleDateString('en-US', { dateStyle: 'full' })}.` : ''}
          </p>
        </section>

        <aside className="flex flex-col gap-6" aria-label="Queue and accounts">
          <Card>
            <CardHeader className="pb-1">
              <CardTitle className="font-display text-lg">Queue</CardTitle>
              <CardDescription>Posts waiting to go out, soonest first.</CardDescription>
            </CardHeader>
            <EmptyState
              size="sm"
              icon={ListChecks}
              title="Nothing scheduled"
              description="Send a finished clip here and pick a time. Failed posts show the platform's error with a retry."
            />
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="font-display text-lg">Accounts</CardTitle>
              <CardDescription>Connect the channels you post to.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2.5 pt-4">
              {ACCOUNTS.map((a) => (
                <div
                  key={a.id}
                  className="flex flex-col gap-2.5 rounded-lg border bg-muted/30 p-3.5"
                >
                  <div className="flex items-center gap-3">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                      <a.icon className="size-[18px]" />
                    </span>
                    <p className="min-w-0 flex-1 truncate text-sm font-semibold">{a.name}</p>
                    <Badge variant="neutral">Not connected</Badge>
                  </div>
                  <p className="text-xs leading-4 text-muted-foreground">{a.note}</p>
                  <DisabledTip
                    reason="Account connection arrives in checkpoint 5"
                    className="self-start"
                  >
                    <Button size="sm" variant="secondary" disabled>
                      <Link2 /> Connect
                    </Button>
                  </DisabledTip>
                </div>
              ))}
              <Button variant="link" asChild className="mt-1 self-start text-sm">
                <Link href="/settings/integrations/">Set up developer credentials →</Link>
              </Button>
            </CardContent>
          </Card>
        </aside>
      </div>
    </Page>
  );
}
