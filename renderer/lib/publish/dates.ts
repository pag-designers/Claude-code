/**
 * Pure calendar/date helpers for the Scheduler (no React, no Date.now(): callers pass `now`).
 * Everything is in the viewer's LOCAL time zone, which the UI states explicitly next to every picker.
 */

export const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const addDays = (d: Date, n: number): Date =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
export const sameDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();
export const weekStart = (d: Date): Date => addDays(startOfDay(d), -startOfDay(d).getDay());

const pad = (n: number) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' of a local day. */
export function dayKey(d: Date | number): string {
  const x = typeof d === 'number' ? new Date(d) : d;
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
}

export type CalendarView = 'month' | 'week' | 'day';

/** Weeks (arrays of 7 local days, Sunday first) that cover the month containing `cursor`. */
export function monthWeeks(cursor: Date): Date[][] {
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const gridStart = addDays(first, -first.getDay());
  const daysInMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
  const weeks = Math.ceil((first.getDay() + daysInMonth) / 7);
  return Array.from({ length: weeks }, (_, w) =>
    Array.from({ length: 7 }, (_, i) => addDays(gridStart, w * 7 + i)),
  );
}

/** The days a view shows around `cursor` (month view: not used, see monthWeeks). */
export function viewDays(view: CalendarView, cursor: Date): Date[] {
  if (view === 'day') return [startOfDay(cursor)];
  const s = weekStart(cursor);
  return Array.from({ length: 7 }, (_, i) => addDays(s, i));
}

/** The cursor after moving `dir` steps in a view. */
export function stepCursor(view: CalendarView, cursor: Date, dir: -1 | 1): Date {
  if (view === 'month') return new Date(cursor.getFullYear(), cursor.getMonth() + dir, 1);
  return addDays(cursor, dir * (view === 'week' ? 7 : 1));
}

/** [from, to) epoch range a view displays (for range queries and "is this post visible"). */
export function viewRange(view: CalendarView, cursor: Date): { from: number; to: number } {
  if (view === 'month') {
    const weeks = monthWeeks(cursor);
    return {
      from: weeks[0]![0]!.getTime(),
      to: addDays(weeks[weeks.length - 1]![6]!, 1).getTime(),
    };
  }
  const days = viewDays(view, cursor);
  return { from: days[0]!.getTime(), to: addDays(days[days.length - 1]!, 1).getTime() };
}

export function calendarTitle(view: CalendarView, cursor: Date): string {
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
  const head = s.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const tail = e.toLocaleDateString(
    'en-US',
    sameMonth
      ? { day: 'numeric', year: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' },
  );
  return `${head} – ${tail}`;
}

/* --------------------------------------------------------------------------- datetime-local ----- */

/** 'YYYY-MM-DDTHH:mm' (the value format of <input type="datetime-local">) for an epoch, in local time. */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  return `${dayKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Inverse of `toLocalInput`; null for an empty or malformed value. */
export function fromLocalInput(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const date = new Date(y, mo - 1, d, h, mi, 0, 0);
  // reject overflowing parts such as 2026-02-31 (Date would roll them into March)
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date.getTime();
}

/** "Europe/Berlin (GMT+2)" for the viewer's zone. */
export function localZoneLabel(at: number = Date.now()): string {
  let name = 'Local time';
  try {
    name = Intl.DateTimeFormat().resolvedOptions().timeZone || name;
  } catch {
    /* keep the generic label */
  }
  let off = '';
  try {
    off =
      new Intl.DateTimeFormat('en-US', { timeZoneName: 'shortOffset' })
        .formatToParts(new Date(at))
        .find((p) => p.type === 'timeZoneName')?.value ?? '';
  } catch {
    /* some engines lack shortOffset */
  }
  return off ? `${name.replace(/_/g, ' ')} (${off})` : name.replace(/_/g, ' ');
}

/** The IANA zone id of the viewer (what `planSchedule` expects). */
export function localZoneId(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/* ------------------------------------------------------------------------------- formatting ----- */

export const formatClockTime = (ms: number): string =>
  new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

/** "Today 2:30 PM", "Tomorrow 9:00 AM", "Mon, Oct 20 · 6:30 PM", with the year when it is not this year. */
export function formatWhen(ms: number, now: number): string {
  const d = new Date(ms);
  const n = new Date(now);
  const time = formatClockTime(ms);
  if (sameDay(d, n)) return `Today ${time}`;
  if (sameDay(d, addDays(n, 1))) return `Tomorrow ${time}`;
  if (sameDay(d, addDays(n, -1))) return `Yesterday ${time}`;
  const date = d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() !== n.getFullYear() ? { year: 'numeric' } : {}),
  });
  return `${date} · ${time}`;
}

/** "in 35 min", "in 2 h", "in 3 days", "now" (future only; past values read "overdue"). */
export function formatUntil(ms: number, now: number): string {
  const diff = ms - now;
  if (diff < -60_000) return 'overdue';
  const min = Math.round(diff / 60_000);
  if (min <= 0) return 'now';
  if (min < 60) return `in ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `in ${h} h`;
  const days = Math.round(h / 24);
  return `in ${days} ${days === 1 ? 'day' : 'days'}`;
}

/* ------------------------------------------------------------------------------ rescheduling ----- */

export type DropResult = { ok: true; at: number } | { ok: false; reason: string };

/**
 * New time for a post dropped on a calendar slot. `minutes` is the minute of the day inside the slot (time grid) or
 * null for a whole-day cell (month view), which keeps the post's own time of day. Past targets are refused.
 */
export function rescheduleTarget(
  current: number | null,
  day: Date,
  minutes: number | null,
  now: number,
): DropResult {
  const base = current ?? now;
  const prev = new Date(base);
  const mins = minutes ?? prev.getHours() * 60 + prev.getMinutes();
  const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, mins, 0, 0).getTime();
  if (at <= now) return { ok: false, reason: 'That time has already passed. Pick a later slot.' };
  return { ok: true, at };
}

/** Rounds a pointer offset inside a tall hour cell to a minute of the hour (5-minute steps). */
export function minuteFromOffset(offsetY: number, height: number, step = 5): number {
  if (height <= 0) return 0;
  const raw = Math.min(59, Math.max(0, (offsetY / height) * 60));
  return Math.min(55, Math.floor(raw / step) * step);
}
