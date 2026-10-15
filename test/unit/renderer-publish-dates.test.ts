import { describe, expect, it } from 'vitest';
import {
  addDays,
  calendarTitle,
  dayKey,
  formatUntil,
  formatWhen,
  fromLocalInput,
  minuteFromOffset,
  monthWeeks,
  rescheduleTarget,
  stepCursor,
  toLocalInput,
  viewDays,
  viewRange,
  weekStart,
} from '../../renderer/lib/publish/dates';

const at = (y: number, m: number, d: number, h = 0, min = 0) =>
  new Date(y, m - 1, d, h, min, 0, 0).getTime();

describe('month / week / day grids', () => {
  it('monthWeeks covers whole Sunday-first weeks around the month', () => {
    const weeks = monthWeeks(new Date(2026, 9, 14)); // Oct 2026 starts on a Thursday
    expect(weeks).toHaveLength(5);
    expect(weeks[0]![0]!.getDay()).toBe(0);
    expect(dayKey(weeks[0]![0]!)).toBe('2026-09-27');
    expect(dayKey(weeks[0]![4]!)).toBe('2026-10-01');
    expect(dayKey(weeks[4]![6]!)).toBe('2026-10-31');
    for (const w of weeks) expect(w).toHaveLength(7);
  });

  it('uses six rows when the month needs them', () => {
    // Aug 2026 starts on a Saturday and has 31 days
    expect(monthWeeks(new Date(2026, 7, 1))).toHaveLength(6);
  });

  it('weekStart is the Sunday on or before the date', () => {
    expect(dayKey(weekStart(new Date(2026, 9, 14)))).toBe('2026-10-11');
    expect(dayKey(weekStart(new Date(2026, 9, 11)))).toBe('2026-10-11');
  });

  it('viewDays gives 1 or 7 days', () => {
    expect(viewDays('day', new Date(2026, 9, 14, 15))).toHaveLength(1);
    expect(viewDays('week', new Date(2026, 9, 14))).toHaveLength(7);
  });

  it('stepCursor moves by a month, a week or a day', () => {
    const c = new Date(2026, 9, 14);
    expect(dayKey(stepCursor('month', c, 1))).toBe('2026-11-01');
    expect(dayKey(stepCursor('month', c, -1))).toBe('2026-09-01');
    expect(dayKey(stepCursor('week', c, 1))).toBe('2026-10-21');
    expect(dayKey(stepCursor('day', c, -1))).toBe('2026-10-13');
    // December -> January crosses the year
    expect(dayKey(stepCursor('month', new Date(2026, 11, 5), 1))).toBe('2027-01-01');
  });

  it('viewRange is [first day, day after the last)', () => {
    const r = viewRange('week', new Date(2026, 9, 14));
    expect(r.from).toBe(at(2026, 10, 11));
    expect(r.to).toBe(at(2026, 10, 18));
    const m = viewRange('month', new Date(2026, 9, 14));
    expect(m.from).toBe(at(2026, 9, 27));
    expect(m.to).toBe(at(2026, 11, 1));
  });

  it('titles read well', () => {
    expect(calendarTitle('month', new Date(2026, 9, 14))).toBe('October 2026');
    expect(calendarTitle('week', new Date(2026, 9, 14))).toBe('Oct 11 – 17, 2026');
    expect(calendarTitle('week', new Date(2026, 8, 30))).toBe('Sep 27 – Oct 3, 2026');
    expect(calendarTitle('week', new Date(2026, 10, 1))).toBe('Nov 1 – 7, 2026');
    expect(calendarTitle('day', new Date(2026, 9, 14))).toMatch(/Wednesday, October 14, 2026/);
  });
});

describe('datetime-local round trip', () => {
  it('formats and parses local time', () => {
    const ms = at(2026, 10, 20, 18, 5);
    expect(toLocalInput(ms)).toBe('2026-10-20T18:05');
    expect(fromLocalInput('2026-10-20T18:05')).toBe(ms);
  });
  it('rejects empty, malformed and overflowing values', () => {
    expect(fromLocalInput('')).toBeNull();
    expect(fromLocalInput('2026-10-20')).toBeNull();
    expect(fromLocalInput('2026-02-31T10:00')).toBeNull();
    expect(fromLocalInput('nonsense')).toBeNull();
  });
});

describe('relative wording', () => {
  const now = at(2026, 10, 14, 10, 0);
  it('formatWhen names today, tomorrow and yesterday', () => {
    expect(formatWhen(at(2026, 10, 14, 14, 30), now)).toMatch(/^Today 2:30\s?PM$/);
    expect(formatWhen(at(2026, 10, 15, 9, 0), now)).toMatch(/^Tomorrow 9:00\s?AM$/);
    expect(formatWhen(at(2026, 10, 13, 9, 0), now)).toMatch(/^Yesterday/);
    expect(formatWhen(at(2026, 10, 20, 18, 30), now)).toMatch(/^Tue, Oct 20 · 6:30\s?PM$/);
    expect(formatWhen(at(2027, 1, 5, 18, 30), now)).toMatch(/2027/);
  });
  it('formatUntil scales its unit', () => {
    expect(formatUntil(now + 30_000, now)).toBe('now');
    expect(formatUntil(now + 35 * 60_000, now)).toBe('in 35 min');
    expect(formatUntil(now + 2 * 3_600_000, now)).toBe('in 2 h');
    expect(formatUntil(now + 3 * 86_400_000, now)).toBe('in 3 days');
    expect(formatUntil(now + 24 * 3_600_000, now)).toBe('in 1 day');
    expect(formatUntil(now - 10 * 60_000, now)).toBe('overdue');
  });
});

describe('rescheduleTarget (drag and drop)', () => {
  const now = at(2026, 10, 14, 10, 0);
  it('keeps the time of day when dropped on a day cell', () => {
    const r = rescheduleTarget(at(2026, 10, 14, 18, 30), new Date(2026, 9, 16), null, now);
    expect(r).toEqual({ ok: true, at: at(2026, 10, 16, 18, 30) });
  });
  it('uses the dropped minute in a time grid', () => {
    const r = rescheduleTarget(at(2026, 10, 14, 18, 30), new Date(2026, 9, 15), 7 * 60 + 15, now);
    expect(r).toEqual({ ok: true, at: at(2026, 10, 15, 7, 15) });
  });
  it('refuses the past', () => {
    const r = rescheduleTarget(at(2026, 10, 14, 18, 30), new Date(2026, 9, 14), 9 * 60, now);
    expect(r.ok).toBe(false);
    const day = rescheduleTarget(at(2026, 10, 14, 18, 30), new Date(2026, 9, 12), null, now);
    expect(day.ok).toBe(false);
  });
  it('a draft without a time lands at the current time of day', () => {
    const r = rescheduleTarget(null, new Date(2026, 9, 20), null, now);
    expect(r).toEqual({ ok: true, at: at(2026, 10, 20, 10, 0) });
  });
});

describe('minuteFromOffset', () => {
  it('maps the pointer position to 5 minute steps and clamps', () => {
    expect(minuteFromOffset(0, 56)).toBe(0);
    expect(minuteFromOffset(28, 56)).toBe(30);
    expect(minuteFromOffset(999, 56)).toBe(55);
    expect(minuteFromOffset(-5, 56)).toBe(0);
    expect(minuteFromOffset(10, 0)).toBe(0);
  });
});

describe('addDays', () => {
  it('crosses month ends', () => {
    expect(dayKey(addDays(new Date(2026, 9, 31), 1))).toBe('2026-11-01');
  });
});
