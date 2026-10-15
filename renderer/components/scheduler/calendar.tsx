'use client';

import * as React from 'react';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import type { PostView } from '@shared/publish';
import { Tip } from '@/components/ui/tooltip';
import {
  WEEKDAYS_SHORT,
  calendarTitle,
  dayKey,
  formatClockTime,
  formatDateTimeLabel,
  minuteFromOffset,
  monthWeeks,
  rescheduleTarget,
  sameDay,
  startOfDay,
  viewDays,
  type CalendarView,
} from '@/lib/publish/dates';
import {
  PLATFORM_INFO,
  PLATFORM_STYLE,
  STATUS_META,
  calendarTime,
  isEditable,
  postsByDay,
} from '@/lib/publish/model';
import { cn } from '@/lib/utils';
import { PlatformIcon, STATUS_ICON } from './platform';

export interface CalendarProps {
  view: CalendarView;
  cursor: Date;
  /** Epoch ms of "now" (minute resolution). */
  now: number;
  posts: readonly PostView[];
  onOpenPost: (id: string) => void;
  /** "+" on a day (or a double-click on an hour): `at` is a suggested start for the picker. */
  onAdd: (day: Date, at: number | null) => void;
  onReschedule: (post: PostView, at: number) => void;
  /** "+N more" in the month view. */
  onShowDay: (day: Date) => void;
}

/* ----------------------------------------------------------------------------------- chip ----- */

/** Status styling of a calendar chip (platform colour stays on the left edge). */
function chipTone(status: PostView['status'], platform: PostView['platform']): string {
  const p = PLATFORM_STYLE[platform];
  switch (status) {
    case 'published':
      return 'bg-muted/70 text-muted-foreground hover:bg-muted';
    case 'failed':
      return 'border-danger/50 bg-danger-soft text-foreground hover:bg-danger-soft';
    case 'missed':
      return 'border-dashed border-warning/60 bg-warning-soft text-foreground';
    case 'draft':
      return 'border-dashed border-border-strong bg-transparent text-muted-foreground hover:bg-accent/60';
    case 'canceled':
      return 'bg-muted/40 text-subtle line-through opacity-70';
    default:
      return cn(p.soft, 'text-foreground hover:brightness-110');
  }
}

export function PostChip({
  post,
  onOpen,
  onDragStart,
  onDragEnd,
  compact,
}: {
  post: PostView;
  onOpen: (id: string) => void;
  onDragStart?: (id: string) => void;
  onDragEnd?: () => void;
  compact?: boolean;
}) {
  const at = calendarTime(post);
  const StatusIcon = STATUS_ICON[post.status];
  const draggable = isEditable(post.status) && post.status !== 'draft' && onDragStart !== undefined;
  const label = `${post.title}, ${PLATFORM_INFO[post.platform].name}, ${post.accountName}, ${STATUS_META[post.status].label}${at ? `, ${formatDateTimeLabel(at)}` : ''}`;
  const flag = post.status !== 'scheduled' && post.status !== 'queued';
  return (
    <button
      type="button"
      draggable={draggable}
      data-testid="post-chip"
      data-post-id={post.id}
      data-status={post.status}
      data-platform={post.platform}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onOpen(post.id);
      }}
      onDragStart={(e) => {
        if (!draggable) return;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', post.id);
        onDragStart?.(post.id);
      }}
      onDragEnd={() => onDragEnd?.()}
      className={cn(
        'group/chip flex w-full min-w-0 items-center gap-1.5 rounded-md border border-l-[3px] border-transparent px-1.5 text-left text-xs outline-none',
        'transition-[background-color,box-shadow,filter,opacity] duration-(--duration-fast) focus-visible:ring-2 focus-visible:ring-ring',
        compact ? 'h-6' : 'min-h-7 py-1',
        PLATFORM_STYLE[post.platform].edge,
        chipTone(post.status, post.platform),
        draggable && 'cursor-grab active:cursor-grabbing',
      )}
    >
      {flag ? (
        <StatusIcon
          className={cn(
            'size-3 shrink-0',
            post.status === 'failed' && 'text-danger',
            post.status === 'missed' && 'text-warning',
            post.status === 'published' && 'text-success',
            post.status === 'publishing' && 'animate-spin text-info',
          )}
          aria-hidden
        />
      ) : (
        <PlatformIcon platform={post.platform} className="size-3 shrink-0" />
      )}
      {at !== null ? (
        <span className="shrink-0 font-medium tabular-nums">
          {formatClockTime(at).replace(' ', '')}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate">{post.title}</span>
    </button>
  );
}

/* ---------------------------------------------------------------------------------- shared ----- */

function useDnd(
  now: number,
  posts: readonly PostView[],
  onReschedule: CalendarProps['onReschedule'],
) {
  const [dragId, setDragId] = React.useState<string | null>(null);
  const [over, setOver] = React.useState<string | null>(null);
  const drop = (slotKey: string, day: Date, minutes: number | null) => {
    const post = posts.find((p) => p.id === dragId);
    setDragId(null);
    setOver(null);
    if (!post) return;
    const res = rescheduleTarget(post.scheduledAt, day, minutes, now);
    if (!res.ok) toast.error('Could not reschedule', { description: res.reason });
    else if (res.at !== post.scheduledAt) onReschedule(post, res.at);
    void slotKey;
  };
  return {
    dragging: dragId !== null,
    over,
    setOver,
    start: setDragId,
    end: () => {
      setDragId(null);
      setOver(null);
    },
    drop,
  };
}

function AddButton({
  day,
  at,
  onAdd,
  className,
  tabbable = true,
}: {
  day: Date;
  at: number | null;
  onAdd: CalendarProps['onAdd'];
  className?: string;
  tabbable?: boolean;
}) {
  const label = day.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  return (
    <Tip content="Schedule a post" side="top">
      <button
        type="button"
        data-testid="day-add"
        aria-label={`Schedule a post on ${label}`}
        tabIndex={tabbable ? 0 : -1}
        onClick={(e) => {
          e.stopPropagation();
          onAdd(day, at);
        }}
        className={cn(
          'flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-0 outline-none transition-[opacity,background-color,color] duration-(--duration-fast)',
          'hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring',
          className,
        )}
      >
        <Plus className="size-3.5" aria-hidden />
      </button>
    </Tip>
  );
}

/* ----------------------------------------------------------------------------------- month ----- */

const MAX_CHIPS = 3;

function MonthGrid(p: CalendarProps) {
  const weeks = React.useMemo(() => monthWeeks(p.cursor), [p.cursor]);
  const byDay = React.useMemo(() => postsByDay(p.posts), [p.posts]);
  const dnd = useDnd(p.now, p.posts, p.onReschedule);
  const today = new Date(p.now);
  const todayStart = startOfDay(today);
  return (
    <div
      role="grid"
      aria-label={calendarTitle('month', p.cursor)}
      className="overflow-hidden rounded-xl border bg-card"
      data-testid="calendar-month"
    >
      <div role="row" className="grid grid-cols-7 border-b bg-muted/50">
        {WEEKDAYS_SHORT.map((w) => (
          <div
            key={w}
            role="columnheader"
            className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-subtle"
          >
            {w}
          </div>
        ))}
      </div>
      {weeks.map((week, wi) => (
        <div
          key={dayKey(week[0]!)}
          role="row"
          className={cn('grid grid-cols-7', wi < weeks.length - 1 && 'border-b')}
        >
          {week.map((d, di) => {
            const key = dayKey(d);
            const inMonth = d.getMonth() === p.cursor.getMonth();
            const isToday = sameDay(d, today);
            const past = d < todayStart;
            const list = byDay.get(key) ?? [];
            const shown = list.length > MAX_CHIPS ? list.slice(0, MAX_CHIPS - 1) : list;
            const hidden = list.length - shown.length;
            const dropping = dnd.over === key;
            return (
              <div
                key={key}
                role="gridcell"
                data-testid="day-cell"
                data-day={key}
                aria-label={
                  d.toLocaleDateString('en-US', {
                    weekday: 'long',
                    month: 'long',
                    day: 'numeric',
                  }) +
                  (isToday ? ', today' : '') +
                  (list.length ? `, ${list.length} ${list.length === 1 ? 'post' : 'posts'}` : '')
                }
                aria-current={isToday ? 'date' : undefined}
                onDragOver={(e) => {
                  if (!dnd.dragging) return;
                  if (past) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  if (dnd.over !== key) dnd.setOver(key);
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) dnd.setOver(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  dnd.drop(key, d, null);
                }}
                className={cn(
                  'group/day relative flex min-h-[116px] min-w-0 flex-col gap-1 p-1.5 transition-colors duration-(--duration-fast)',
                  di < 6 && 'border-r',
                  !inMonth && 'bg-muted/30',
                  past && inMonth && 'bg-muted/15',
                  dropping && 'bg-primary-soft ring-2 ring-inset ring-primary/70',
                )}
              >
                <div className="flex items-center justify-between px-0.5">
                  <span
                    className={cn(
                      'inline-flex size-6 items-center justify-center rounded-full text-xs font-medium tabular-nums',
                      isToday
                        ? 'bg-primary text-primary-foreground'
                        : inMonth
                          ? 'text-foreground'
                          : 'text-subtle',
                    )}
                  >
                    {d.getDate()}
                  </span>
                  {past ? null : (
                    <AddButton
                      day={d}
                      at={null}
                      onAdd={p.onAdd}
                      className="group-hover/day:opacity-100 group-focus-within/day:opacity-100"
                    />
                  )}
                </div>
                <div className="flex min-w-0 flex-col gap-1">
                  {shown.map((post) => (
                    <PostChip
                      key={post.id}
                      post={post}
                      compact
                      onOpen={p.onOpenPost}
                      onDragStart={dnd.start}
                      onDragEnd={dnd.end}
                    />
                  ))}
                  {hidden > 0 ? (
                    <button
                      type="button"
                      onClick={() => p.onShowDay(d)}
                      data-testid="day-more"
                      className="h-5 rounded-md px-1.5 text-left text-2xs font-medium text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      +{hidden} more
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------------------ week / day ----- */

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const hourLabel = (h: number) =>
  h === 0 ? '' : new Date(2000, 0, 1, h).toLocaleTimeString('en-US', { hour: 'numeric' });

function TimeGrid(p: CalendarProps & { days: Date[] }) {
  const { days } = p;
  const byDay = React.useMemo(() => postsByDay(p.posts), [p.posts]);
  const dnd = useDnd(p.now, p.posts, p.onReschedule);
  const now = new Date(p.now);
  const cols = days.length;
  const scroller = React.useRef<HTMLDivElement>(null);
  const firstHour = React.useRef<number | null>(null);

  // open scrolled to the first post of the view (or the current hour) so something useful is visible
  React.useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const times = days.flatMap((d) => (byDay.get(dayKey(d)) ?? []).map((x) => calendarTime(x)!));
    const target = times.length
      ? new Date(Math.min(...times)).getHours()
      : days.some((d) => sameDay(d, now))
        ? now.getHours()
        : 8;
    firstHour.current = target;
    const row = el.querySelector<HTMLElement>(`[data-hour-row="${Math.max(0, target - 1)}"]`);
    if (row) el.scrollTop = row.offsetTop - 40;
    // run when the visible days change, not on every minute tick
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days[0]?.getTime(), cols]);

  return (
    <div
      className="overflow-hidden rounded-xl border bg-card"
      data-testid={cols === 1 ? 'calendar-day' : 'calendar-week'}
      role="grid"
      aria-label={calendarTitle(cols === 1 ? 'day' : 'week', days[0]!)}
    >
      <div
        role="row"
        className="grid border-b bg-muted/50"
        style={{ gridTemplateColumns: `56px repeat(${cols}, minmax(0, 1fr))` }}
      >
        <div role="columnheader" aria-label="Time" />
        {days.map((d) => {
          const isToday = sameDay(d, now);
          const past = d < startOfDay(now);
          return (
            <div
              key={dayKey(d)}
              role="columnheader"
              className="group/day flex items-center gap-2 border-l px-3 py-2"
            >
              <span className="text-xs font-semibold uppercase tracking-wider text-subtle">
                {WEEKDAYS_SHORT[d.getDay()]}
              </span>
              <span
                className={cn(
                  'inline-flex size-6 items-center justify-center rounded-full text-sm font-medium tabular-nums',
                  isToday && 'bg-primary text-primary-foreground',
                )}
              >
                {d.getDate()}
              </span>
              {past ? null : (
                <AddButton
                  day={d}
                  at={null}
                  onAdd={p.onAdd}
                  className="ml-auto opacity-70 group-hover/day:opacity-100"
                />
              )}
            </div>
          );
        })}
      </div>
      <div
        ref={scroller}
        className="scrollbar-thin max-h-[min(640px,calc(100dvh-220px))] overflow-y-auto"
      >
        {HOURS.map((h) => (
          <div
            key={h}
            role="row"
            data-hour-row={h}
            className="grid"
            style={{ gridTemplateColumns: `56px repeat(${cols}, minmax(0, 1fr))` }}
          >
            <div role="rowheader" className="relative pr-2 text-right">
              <span className="relative -top-2 text-2xs tabular-nums text-subtle">
                {hourLabel(h)}
              </span>
            </div>
            {days.map((d) => {
              const key = `${dayKey(d)}-${h}`;
              const list = (byDay.get(dayKey(d)) ?? []).filter(
                (x) => new Date(calendarTime(x)!).getHours() === h,
              );
              const slotStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h).getTime();
              const past = slotStart + 3_600_000 <= p.now;
              const isNowHour = sameDay(d, now) && now.getHours() === h;
              return (
                <div
                  key={key}
                  role="gridcell"
                  data-testid="hour-cell"
                  data-slot={key}
                  aria-label={`${d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}, ${hourLabel(h) || '12 AM'}${list.length ? `, ${list.length} ${list.length === 1 ? 'post' : 'posts'}` : ''}`}
                  onDoubleClick={() => !past && p.onAdd(d, Math.max(slotStart, p.now + 5 * 60_000))}
                  onDragOver={(e) => {
                    if (!dnd.dragging || past) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    if (dnd.over !== key) dnd.setOver(key);
                  }}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null))
                      dnd.setOver(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const r = e.currentTarget.getBoundingClientRect();
                    dnd.drop(key, d, h * 60 + minuteFromOffset(e.clientY - r.top, r.height));
                  }}
                  className={cn(
                    'relative flex min-h-14 flex-col gap-1 border-l border-t p-1 transition-colors duration-(--duration-fast)',
                    past && 'bg-muted/20',
                    dnd.over === key && 'bg-primary-soft ring-2 ring-inset ring-primary/70',
                  )}
                >
                  {list.map((post) => (
                    <PostChip
                      key={post.id}
                      post={post}
                      onOpen={p.onOpenPost}
                      onDragStart={dnd.start}
                      onDragEnd={dnd.end}
                    />
                  ))}
                  {isNowHour ? (
                    <div
                      className="pointer-events-none absolute inset-x-0 z-10 flex items-center"
                      style={{ top: `${(now.getMinutes() / 60) * 100}%` }}
                      aria-hidden
                      data-testid="now-line"
                    >
                      <span className="-ml-1 size-2 rounded-full bg-danger" />
                      <span className="h-px flex-1 bg-danger" />
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Month / week / day calendar of posts with drag-to-reschedule. Pure view: the page owns data and mutations. */
export function SchedulerCalendar(p: CalendarProps) {
  const days = React.useMemo(() => viewDays(p.view, p.cursor), [p.view, p.cursor]);
  return p.view === 'month' ? <MonthGrid {...p} /> : <TimeGrid {...p} days={days} />;
}
