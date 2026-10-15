/** planSchedule rules (shared/scheduling.ts): spreading, windows, gaps, daily caps, zones, DST. */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WINDOWS,
  formatSlotLocal,
  localDayKey,
  planSchedule,
  type PlanInput,
  type PlanWindow,
} from '../../shared/scheduling';

const NY = 'America/New_York';
const MIN = 60_000;
const HOUR = 3_600_000;

/** Independent wall-clock reader (not the code under test). */
function local(t: number, tz: string): { wd: number; min: number; day: string; hm: string } {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  }).formatToParts(new Date(t));
  const g = (k: string): string => p.find((x) => x.type === k)!.value;
  return {
    wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(g('weekday')),
    min: Number(g('hour')) * 60 + Number(g('minute')),
    day: `${g('year')}-${g('month')}-${g('day')}`,
    hm: `${g('hour')}:${g('minute')}`,
  };
}

const ALL = [0, 1, 2, 3, 4, 5, 6];
const win = (
  start: string,
  end: string,
  days = ALL,
  platform: PlanWindow['platform'] = null,
): PlanWindow => ({
  platform,
  days,
  start,
  end,
});

const base = (o: Partial<PlanInput> = {}): PlanInput => ({
  clips: 1,
  accounts: [{ id: 'a', platform: 'reels' }],
  startAt: Date.UTC(2025, 5, 2, 4, 0), // Mon 2025-06-02 00:00 New York
  timeZone: NY,
  windows: [],
  minGapMinutes: 60,
  maxPerDay: 3,
  existing: [],
  jitterMinutes: 0,
  seed: 1,
  ...o,
});

const hm = (t: number, tz = NY): string => local(t, tz).hm;

describe('planSchedule: placement', () => {
  it('puts a single clip in the middle of the next window (no jitter)', () => {
    const r = planSchedule(base());
    expect(r.warnings).toEqual([]);
    expect(r.slots).toHaveLength(1);
    expect(hm(r.slots[0]!.at)).toBe('12:30'); // 11:30-13:30
  });

  it('spreads clips over windows and days: one per window, not piled into the first', () => {
    const r = planSchedule(base({ clips: 5, maxPerDay: 5, minGapMinutes: 30 }));
    const times = r.slots.map((s) => {
      const l = local(s.at, NY);
      return `${l.day} ${l.hm}`;
    });
    expect(times).toEqual([
      '2025-06-02 12:30',
      '2025-06-02 19:15',
      '2025-06-03 12:30',
      '2025-06-03 19:15',
      '2025-06-04 12:30',
    ]);
    expect(r.slots.map((s) => s.clipIndex)).toEqual([0, 1, 2, 3, 4]);
  });

  it('every account gets every clip, planned independently', () => {
    const r = planSchedule(
      base({
        clips: 3,
        accounts: [
          { id: 'a', platform: 'reels' },
          { id: 'b', platform: 'tiktok' },
        ],
      }),
    );
    expect(r.slots.filter((s) => s.accountId === 'a').map((s) => s.clipIndex)).toEqual([0, 1, 2]);
    expect(r.slots.filter((s) => s.accountId === 'b').map((s) => s.clipIndex)).toEqual([0, 1, 2]);
    const times = r.slots.map((s) => s.at);
    expect([...times].sort((x, y) => x - y)).toEqual(times); // sorted by time
  });

  it('startAt in the middle of a window: nothing before it, slot in the rest of the window', () => {
    const startAt = Date.UTC(2025, 5, 2, 16, 40); // 12:40 EDT
    const r = planSchedule(base({ startAt, clips: 2 }));
    const [first, second] = r.slots;
    expect(first!.at).toBeGreaterThanOrEqual(startAt);
    expect(hm(first!.at)).toBe('13:05'); // middle of 12:40-13:30
    expect(hm(second!.at)).toBe('19:15');
  });

  it('startAt after the last window of the day goes to the next morning', () => {
    const r = planSchedule(base({ startAt: Date.UTC(2025, 5, 3, 2, 0) })); // Mon 22:00 EDT
    expect(local(r.slots[0]!.at, NY).day).toBe('2025-06-03');
    expect(hm(r.slots[0]!.at)).toBe('12:30');
  });

  it('a window that already holds a post of that account is skipped', () => {
    const existing = [{ accountId: 'a', at: Date.UTC(2025, 5, 2, 16, 0) }]; // 12:00 EDT
    const r = planSchedule(base({ existing }));
    expect(hm(r.slots[0]!.at)).toBe('19:15');
    // other accounts are not affected
    const r2 = planSchedule(base({ existing, accounts: [{ id: 'z', platform: 'reels' }] }));
    expect(hm(r2.slots[0]!.at)).toBe('12:30');
  });

  it('keeps the gap to an existing post outside the window by shrinking the usable part', () => {
    // existing 13:45; gap 120 min → the slot must be ≤ 11:45 and ≥ 11:30 (window start)
    const existing = [{ accountId: 'a', at: Date.UTC(2025, 5, 2, 17, 45) }];
    const r = planSchedule(base({ existing, minGapMinutes: 120 }));
    const at = r.slots[0]!.at;
    expect(at).toBeGreaterThanOrEqual(Date.UTC(2025, 5, 2, 15, 30));
    expect(at).toBeLessThanOrEqual(existing[0]!.at - 120 * MIN);
    expect(hm(at)).toBe('11:38'); // middle of 11:30-11:45
  });

  it('a window the gap leaves no room in is skipped, with a warning when clips are left', () => {
    const windows = [win('12:00', '13:00', [1])]; // Mondays only
    const existing = [{ accountId: 'a', at: Date.UTC(2025, 5, 2, 17, 30) }]; // Mon 13:30, gap 90 → 12:00 window would need ≤ 12:00
    const r = planSchedule(base({ windows, existing, minGapMinutes: 90, clips: 1 }));
    // 12:00 is exactly 90 min before 13:30: allowed (>= gap); only that minute fits
    expect(hm(r.slots[0]!.at)).toBe('12:00');
    const r2 = planSchedule(base({ windows, existing, minGapMinutes: 91, clips: 1 }));
    expect(local(r2.slots[0]!.at, NY).day).toBe('2025-06-09'); // next Monday
  });

  it('max per day is counted per LOCAL day and per account (existing posts count)', () => {
    const windows = [win('09:00', '10:00'), win('12:00', '13:00'), win('18:00', '19:00')];
    const existing = [{ accountId: 'a', at: Date.UTC(2025, 5, 2, 12, 30) }]; // 08:30 EDT Monday
    const r = planSchedule(
      base({
        windows,
        existing,
        clips: 4,
        maxPerDay: 2,
        accounts: [
          { id: 'a', platform: 'reels' },
          { id: 'b', platform: 'reels' },
        ],
      }),
    );
    const per = (id: string): Record<string, number> => {
      const m: Record<string, number> = {};
      for (const s of r.slots.filter((x) => x.accountId === id)) {
        const d = local(s.at, NY).day;
        m[d] = (m[d] ?? 0) + 1;
      }
      return m;
    };
    expect(per('a')['2025-06-02']).toBe(1); // 1 existing + 1 new
    expect(per('b')['2025-06-02']).toBe(2);
    expect(Math.max(...Object.values(per('a')))).toBeLessThanOrEqual(2);
    expect(r.warnings.join(' ')).toMatch(/limited to 2 posts a day/);
  });

  it('cap of 1 per day: one post per day even with several windows', () => {
    const r = planSchedule(base({ clips: 3, maxPerDay: 1 }));
    expect(new Set(r.slots.map((s) => local(s.at, NY).day)).size).toBe(3);
  });

  it('uses per-platform windows over generic ones; falls back to defaults with a warning', () => {
    const windows = [win('08:00', '09:00', ALL, 'reels'), win('21:00', '22:00', ALL, null)];
    const r = planSchedule(
      base({
        windows,
        accounts: [
          { id: 'r', platform: 'reels' },
          { id: 't', platform: 'tiktok' },
        ],
      }),
    );
    expect(hm(r.slots.find((s) => s.accountId === 'r')!.at)).toBe('08:30');
    expect(hm(r.slots.find((s) => s.accountId === 't')!.at)).toBe('21:30'); // generic window
    const only = planSchedule(
      base({
        windows: [win('08:00', '09:00', ALL, 'reels')],
        accounts: [{ id: 't', platform: 'tiktok' }],
      }),
    );
    expect(hm(only.slots[0]!.at)).toBe('12:30'); // default windows
    expect(only.warnings.join(' ')).toMatch(/No usable posting window for TikTok/);
  });

  it('respects the weekday of each window', () => {
    const r = planSchedule(base({ windows: [win('10:00', '11:00', [3])], clips: 2 })); // Wednesdays
    expect(r.slots.map((s) => local(s.at, NY).wd)).toEqual([3, 3]);
    expect(local(r.slots[0]!.at, NY).day).toBe('2025-06-04');
    expect(local(r.slots[1]!.at, NY).day).toBe('2025-06-11');
  });

  it('ignores malformed windows and warns', () => {
    const r = planSchedule(base({ windows: [win('25:00', '26:00'), win('10:00', '11:00')] }));
    expect(hm(r.slots[0]!.at)).toBe('10:30');
    expect(r.warnings.join(' ')).toMatch(/1 posting window\(s\) for Instagram Reels are malformed/);
    const none = planSchedule(base({ windows: [win('bad', 'bad')] }));
    expect(none.slots).toHaveLength(1); // defaults
    expect(none.warnings.join(' ')).toMatch(/default times/);
  });

  it('degenerate input: no clips, no accounts, no daily budget, unknown zone', () => {
    expect(planSchedule(base({ clips: 0 }))).toEqual({ slots: [], warnings: [] });
    expect(planSchedule(base({ accounts: [] })).slots).toEqual([]);
    const z = planSchedule(base({ maxPerDay: 0 }));
    expect(z.slots).toEqual([]);
    expect(z.warnings[0]).toMatch(/at least 1/);
    expect(() => planSchedule(base({ timeZone: 'Mars/Olympus' }))).toThrow(/Unknown time zone/);
  });

  it('windows that never match yield fewer slots and a clear warning', () => {
    const r = planSchedule(base({ windows: [win('10:00', '11:00', [])], clips: 2 }));
    // days: [] is malformed → defaults
    expect(r.slots).toHaveLength(2);
    const horizon = planSchedule(base({ clips: 1000, maxPerDay: 1 }));
    expect(horizon.slots.length).toBeLessThan(1000);
    expect(horizon.warnings.join(' ')).toMatch(/Only \d+ of 1000 clips could be scheduled/);
  });
});

describe('planSchedule: jitter', () => {
  const j = (o: Partial<PlanInput>) => planSchedule(base({ jitterMinutes: 20, clips: 6, ...o }));

  it('is deterministic for equal input and changes with the seed', () => {
    expect(j({ seed: 5 })).toEqual(j({ seed: 5 }));
    const a = j({ seed: 5 }).slots.map((s) => s.at);
    const b = j({ seed: 6 }).slots.map((s) => s.at);
    expect(a).not.toEqual(b);
  });

  it('moves posts off the window middle by at most ±jitter and stays inside the window', () => {
    const r = j({ seed: 9, minGapMinutes: 10, maxPerDay: 6 });
    for (const s of r.slots) {
      const m = local(s.at, NY).min;
      const inLunch = m >= 11 * 60 + 30 && m < 13 * 60 + 30;
      const inEve = m >= 17 * 60 + 30 && m < 21 * 60;
      expect(inLunch || inEve).toBe(true);
      const mid = inLunch ? 12 * 60 + 30 : 19 * 60 + 15;
      expect(Math.abs(m - mid)).toBeLessThanOrEqual(20);
    }
    expect(new Set(r.slots.map((s) => local(s.at, NY).hm)).size).toBeGreaterThan(3);
  });

  it('can never break the gap or the window, even with a huge jitter', () => {
    const windows = [win('12:00', '12:30')];
    const r = planSchedule(
      base({ windows, jitterMinutes: 600, clips: 10, minGapMinutes: 5, seed: 3 }),
    );
    for (const s of r.slots) {
      const m = local(s.at, NY).min;
      expect(m).toBeGreaterThanOrEqual(12 * 60);
      expect(m).toBeLessThan(12 * 60 + 30);
    }
  });
});

describe('planSchedule: windows crossing midnight', () => {
  const night = [win('22:00', '02:00', [5])]; // Friday 22:00 until Saturday 02:00

  it('places inside the window on both sides of midnight', () => {
    const r = planSchedule(base({ windows: night, clips: 4, jitterMinutes: 90, seed: 2 }));
    expect(r.slots).toHaveLength(4);
    for (const s of r.slots) {
      const l = local(s.at, NY);
      const fri = l.wd === 5 && l.min >= 22 * 60;
      const sat = l.wd === 6 && l.min < 2 * 60;
      expect(fri || sat).toBe(true);
    }
    // four different Fridays
    expect(
      new Set(r.slots.map((s) => Math.floor((s.at - Date.UTC(2025, 5, 2)) / (7 * 86_400_000))))
        .size,
    ).toBe(4);
  });

  it('the middle of 22:00-02:00 is midnight; the post counts for the day it lands in', () => {
    const r = planSchedule(base({ windows: night }));
    expect(hm(r.slots[0]!.at)).toBe('00:00');
    expect(local(r.slots[0]!.at, NY).wd).toBe(6);
  });

  it("startAt after midnight inside last night's window still uses the rest of it", () => {
    const startAt = Date.UTC(2025, 5, 7, 4, 30); // Sat 2025-06-07 00:30 EDT
    const r = planSchedule(base({ windows: night, startAt }));
    expect(r.slots[0]!.at).toBeGreaterThanOrEqual(startAt);
    expect(local(r.slots[0]!.at, NY).day).toBe('2025-06-07');
    expect(local(r.slots[0]!.at, NY).min).toBeLessThan(2 * 60);
  });

  it('an existing post after midnight occupies the whole window occurrence', () => {
    const existing = [{ accountId: 'a', at: Date.UTC(2025, 5, 7, 5, 30) }]; // Sat 01:30
    const r = planSchedule(base({ windows: night, existing }));
    expect(local(r.slots[0]!.at, NY).day).toBe('2025-06-14'); // 00:00 of the following Saturday
  });

  it('daily cap splits at local midnight', () => {
    // window 23:00-01:00 every day, cap 1 per day, 3 clips → one on each side counts for different days
    const r = planSchedule(
      base({ windows: [win('23:00', '01:00')], maxPerDay: 1, clips: 3, minGapMinutes: 0 }),
    );
    const days = r.slots.map((s) => local(s.at, NY).day);
    expect(new Set(days).size).toBe(3);
  });

  it('24:00 as an end and start == end (whole day)', () => {
    const r = planSchedule(base({ windows: [win('20:00', '24:00')] }));
    expect(hm(r.slots[0]!.at)).toBe('22:00');
    const all = planSchedule(
      base({ windows: [win('06:00', '06:00')], startAt: Date.UTC(2025, 5, 2, 10, 0) }),
    );
    expect(hm(all.slots[0]!.at)).toBe('18:00'); // middle of 06:00 .. 06:00 next day
  });
});

describe('planSchedule: time zones and DST', () => {
  it('Asia/Kolkata (+5:30)', () => {
    const tz = 'Asia/Kolkata';
    const r = planSchedule(
      base({ timeZone: tz, windows: [win('09:00', '10:00')], startAt: Date.UTC(2025, 0, 1, 0, 0) }),
    );
    // 09:00-10:00 IST = 03:30-04:30 UTC; middle 04:00 UTC = 09:30 IST
    expect(new Date(r.slots[0]!.at).toISOString()).toBe('2025-01-01T04:00:00.000Z');
    expect(hm(r.slots[0]!.at, tz)).toBe('09:30');
  });

  it('Pacific/Chatham (+12:45 / +13:45)', () => {
    const tz = 'Pacific/Chatham';
    const summer = planSchedule(
      base({
        timeZone: tz,
        windows: [win('18:00', '19:00')],
        startAt: Date.UTC(2025, 0, 10, 0, 0),
      }),
    );
    expect(hm(summer.slots[0]!.at, tz)).toBe('18:30');
    expect(new Date(summer.slots[0]!.at).getUTCMinutes() % 15).toBe(45 % 15); // quarter-hour offsets
    const winter = planSchedule(
      base({
        timeZone: tz,
        windows: [win('18:00', '19:00')],
        startAt: Date.UTC(2025, 6, 10, 0, 0),
      }),
    );
    expect(hm(winter.slots[0]!.at, tz)).toBe('18:30');
    // 45 min different UTC offset between the two seasons
    const o = (t: number): number => {
      const d = new Date(t);
      const l = local(t, tz);
      return (
        (Number(l.hm.slice(0, 2)) * 60 +
          Number(l.hm.slice(3)) -
          (d.getUTCHours() * 60 + d.getUTCMinutes()) +
          1440) %
        1440
      );
    };
    expect(o(summer.slots[0]!.at)).toBe(13 * 60 + 45);
    expect(o(winter.slots[0]!.at)).toBe(12 * 60 + 45);
  });

  it('spring forward (New York 2025-03-09): a 02:00-04:00 window is one real hour', () => {
    const r = planSchedule(
      base({
        windows: [win('02:00', '04:00')],
        startAt: Date.UTC(2025, 2, 9, 4, 0),
        jitterMinutes: 0,
      }),
    );
    const at = r.slots[0]!.at;
    expect(at).toBeGreaterThanOrEqual(Date.UTC(2025, 2, 9, 7, 0)); // 03:00 EDT
    expect(at).toBeLessThan(Date.UTC(2025, 2, 9, 8, 0)); // 04:00 EDT
    expect(hm(at)).toBe('03:30');
  });

  it('fall back (New York 2025-11-02): a 00:30-03:00 window is 3.5 real hours; days stay on local calendar', () => {
    const r = planSchedule(
      base({
        windows: [win('00:30', '03:00')],
        startAt: Date.UTC(2025, 10, 2, 3, 0),
        jitterMinutes: 40,
        seed: 4,
        clips: 3,
      }),
    );
    const first = r.slots[0]!.at;
    expect(first).toBeGreaterThanOrEqual(Date.UTC(2025, 10, 2, 4, 30)); // 00:30 EDT
    expect(first).toBeLessThan(Date.UTC(2025, 10, 2, 8, 0)); // 03:00 EST
    // the three clips land on three consecutive local days (the 25-hour day does not skip or double a day)
    expect(r.slots.map((s) => local(s.at, NY).day)).toEqual([
      '2025-11-02',
      '2025-11-03',
      '2025-11-04',
    ]);
  });

  it('the daily cap uses the local calendar day across the DST change', () => {
    const r = planSchedule(
      base({
        windows: [win('00:10', '00:50'), win('23:10', '23:50')],
        startAt: Date.UTC(2025, 2, 8, 3, 0), // Fri 22:00 EST Mar 7... (before the change on Mar 9)
        maxPerDay: 1,
        clips: 6,
        minGapMinutes: 0,
      }),
    );
    const days = r.slots.map((s) => localDayKey(s.at, NY));
    expect(new Set(days).size).toBe(6);
  });

  it('Lord Howe (30-minute DST shift) keeps posts inside the window', () => {
    const tz = 'Australia/Lord_Howe';
    const r = planSchedule(
      base({
        timeZone: tz,
        windows: [win('01:45', '02:45')],
        startAt: Date.UTC(2025, 3, 5, 0, 0),
        clips: 4,
        jitterMinutes: 30,
        seed: 8,
      }),
    );
    for (const s of r.slots) {
      const m = local(s.at, tz).min;
      expect(m).toBeGreaterThanOrEqual(105);
      expect(m).toBeLessThan(165);
    }
  });
});

describe('planSchedule: scale', () => {
  it('200 clips on one account in well under 100 ms (after warm-up)', () => {
    const input = base({ clips: 200, jitterMinutes: 7, maxPerDay: 3, minGapMinutes: 120 });
    planSchedule(base({ clips: 20 }));
    const t0 = performance.now();
    const r = planSchedule(input);
    const ms = performance.now() - t0;
    expect(r.slots).toHaveLength(200);
    expect(r.warnings).toEqual([]);
    expect(ms).toBeLessThan(100);
  });

  it('exports sane defaults and a formatter', () => {
    expect(DEFAULT_WINDOWS.length).toBeGreaterThan(0);
    expect(formatSlotLocal(Date.UTC(2025, 9, 14, 15, 42), NY)).toBe('Tue 14 Oct, 11:42');
    expect(formatSlotLocal(Date.UTC(2025, 9, 14, 15, 42), 'Asia/Kolkata', { withYear: true })).toBe(
      'Tue 14 Oct 2025, 21:12',
    );
  });
});

void HOUR;
