/**
 * Property-style tests: random inputs (seeded, reproducible) must always satisfy the planner's invariants, and the zone
 * helpers must be right around DST changes. The checker reads local time with Intl directly, not with the code under test.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WINDOWS,
  nextOccurrence,
  planSchedule,
  zonedParts,
  zonedTimeToEpoch,
  type PlanAccount,
  type PlanInput,
  type PlanWindow,
} from '../../shared/scheduling';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const fmts = new Map<string, Intl.DateTimeFormat>();
function wall(t: number, tz: string): { wd: number; min: number; day: string } {
  let f = fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    });
    fmts.set(tz, f);
  }
  const p = f.formatToParts(new Date(t));
  const g = (k: string): string => p.find((x) => x.type === k)!.value;
  return {
    wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(g('weekday')),
    min: Number(g('hour')) * 60 + Number(g('minute')),
    day: `${g('year')}-${g('month')}-${g('day')}`,
  };
}

const ZONES = [
  'UTC',
  'America/New_York',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Kolkata',
  'Asia/Kathmandu',
  'Pacific/Chatham',
  'Australia/Lord_Howe',
  'America/Sao_Paulo',
  'Pacific/Auckland',
  'America/St_Johns',
  'Asia/Tokyo',
];
const PLATFORMS = ['reels', 'tiktok', 'shorts'] as const;

const clock = (m: number): string =>
  `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

function randomWindows(r: () => number): PlanWindow[] {
  const n = Math.floor(r() * 5);
  const out: PlanWindow[] = [];
  for (let i = 0; i < n; i++) {
    const start = Math.floor(r() * 96) * 15;
    const len = (1 + Math.floor(r() * 24)) * 15; // 15 min .. 6 h, may cross midnight
    const days = [0, 1, 2, 3, 4, 5, 6].filter(() => r() < 0.6);
    out.push({
      platform: r() < 0.4 ? null : PLATFORMS[Math.floor(r() * 3)]!,
      days: days.length ? days : [Math.floor(r() * 7)],
      start: clock(start),
      end: clock((start + len) % 1440),
    });
  }
  return out;
}

/** The windows an account should be planned with (same precedence rule as documented). */
function windowsOf(platform: string, all: PlanWindow[]): PlanWindow[] {
  const own = all.filter((w) => w.platform === platform);
  const pick = own.length ? own : all.filter((w) => w.platform === null);
  return pick.length ? pick : DEFAULT_WINDOWS;
}

const toMin = (s: string): number => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));

function insideSomeWindow(t: number, tz: string, ws: PlanWindow[]): boolean {
  const w = wall(t, tz);
  return ws.some((win) => {
    const s = toMin(win.start);
    const e0 = toMin(win.end);
    const e = e0 > s ? e0 : e0 + 1440;
    // today's occurrence
    if (win.days.includes(w.wd) && w.min >= s && w.min < e) return true;
    // yesterday's occurrence running past midnight (a day is 24 h of wall clock; DST makes that +-1 h, never a different window)
    const yesterday = (w.wd + 6) % 7;
    return win.days.includes(yesterday) && w.min + 1440 >= s && w.min + 1440 < e;
  });
}

interface Case {
  input: PlanInput;
}

function randomCase(seed: number): Case {
  const r = rng(seed);
  const nAcc = 1 + Math.floor(r() * 3);
  const accounts: PlanAccount[] = Array.from({ length: nAcc }, (_, i) => ({
    id: `acc${i}`,
    platform: PLATFORMS[Math.floor(r() * 3)]!,
  }));
  const tz = ZONES[Math.floor(r() * ZONES.length)]!;
  // start times concentrated around the spring/autumn DST changes of both hemispheres
  const anchors = [
    Date.UTC(2025, 2, 9),
    Date.UTC(2025, 9, 26),
    Date.UTC(2025, 10, 2),
    Date.UTC(2025, 3, 6),
    Date.UTC(2025, 8, 28),
    Date.UTC(2026, 0, 15),
  ];
  const startAt =
    anchors[Math.floor(r() * anchors.length)]! + Math.floor((r() - 0.3) * 6 * 86_400_000);
  const startAtRounded = Math.floor(startAt / 60_000) * 60_000 + (r() < 0.3 ? 17_000 : 0);
  const existing = Array.from({ length: Math.floor(r() * 12) }, () => ({
    accountId: accounts[Math.floor(r() * nAcc)]!.id,
    at: startAtRounded + Math.floor((r() - 0.2) * 20 * 86_400_000),
  }));
  return {
    input: {
      clips: 1 + Math.floor(r() * 40),
      accounts,
      startAt: startAtRounded,
      timeZone: tz,
      windows: randomWindows(r),
      minGapMinutes: [0, 1, 30, 90, 240, 600][Math.floor(r() * 6)]!,
      maxPerDay: 1 + Math.floor(r() * 4),
      existing,
      jitterMinutes: [0, 3, 15, 45, 400][Math.floor(r() * 5)]!,
      seed: Math.floor(r() * 1e6),
    },
  };
}

describe('planSchedule invariants (random inputs)', () => {
  const N = 300;
  it(`holds for ${N} random cases`, () => {
    let planned = 0;
    let withWarnings = 0;
    for (let seed = 1; seed <= N; seed++) {
      const { input } = randomCase(seed);
      const tag = `seed ${seed} ${JSON.stringify({ ...input, existing: input.existing.length })}`;
      const res = planSchedule(input);
      planned += res.slots.length;
      if (res.warnings.length) withWarnings++;
      // deterministic and pure
      expect(planSchedule(input), tag).toEqual(res);
      const gap = input.minGapMinutes * 60_000;
      for (const acc of input.accounts) {
        const mine = res.slots
          .filter((s) => s.accountId === acc.id)
          .sort((a, b) => a.clipIndex - b.clipIndex);
        const old = input.existing.filter((e) => e.accountId === acc.id).map((e) => e.at);
        expect(mine.length, tag).toBeLessThanOrEqual(input.clips);
        // clips are dealt in order: indices 0..n-1, strictly later times
        mine.forEach((s, i) => expect(s.clipIndex, tag).toBe(i));
        for (let i = 1; i < mine.length; i++)
          expect(mine[i]!.at, tag).toBeGreaterThanOrEqual(mine[i - 1]!.at);
        const ws = windowsOf(acc.platform, input.windows);
        for (const s of mine) {
          expect(s.at, tag).toBeGreaterThanOrEqual(input.startAt);
          expect(Number.isInteger(s.at / 60_000), tag).toBe(true);
          expect(
            insideSomeWindow(s.at, input.timeZone, ws),
            `${tag} @${new Date(s.at).toISOString()}`,
          ).toBe(true);
        }
        // gap to every other post of the account
        const all = [...old, ...mine.map((s) => s.at)];
        for (const s of mine) {
          for (const o of all) {
            if (o === s.at && all.indexOf(o) === all.lastIndexOf(o)) continue; // itself
            if (gap > 0 && o !== s.at) expect(Math.abs(o - s.at), tag).toBeGreaterThanOrEqual(gap);
            if (gap > 0 && o === s.at)
              expect(false, `${tag}: two posts at the same minute`).toBe(true);
          }
        }
        // per local day cap (days that got new posts)
        const count = new Map<string, number>();
        for (const t of all)
          count.set(wall(t, input.timeZone).day, (count.get(wall(t, input.timeZone).day) ?? 0) + 1);
        for (const s of mine) {
          expect(count.get(wall(s.at, input.timeZone).day)!, tag).toBeLessThanOrEqual(
            input.maxPerDay,
          );
        }
        // nothing left unexplained: fewer slots than clips come with a warning naming the account
        if (mine.length < input.clips) {
          expect(res.warnings.join('\n'), tag).toContain(`(${acc.id})`);
        }
      }
      // output sorted
      for (let i = 1; i < res.slots.length; i++)
        expect(res.slots[i]!.at, tag).toBeGreaterThanOrEqual(res.slots[i - 1]!.at);
    }
  }, 60_000);
});

describe('zone helpers around DST', () => {
  it('zonedTimeToEpoch inverts zonedParts for random instants (first of two ambiguous times)', () => {
    const r = rng(77);
    for (let i = 0; i < 1500; i++) {
      const tz = ZONES[Math.floor(r() * ZONES.length)]!;
      const t = Math.floor(Date.UTC(2024, 0, 1) / 60_000 + r() * 3 * 365 * 1440) * 60_000;
      const p = zonedParts(t, tz);
      const back = zonedTimeToEpoch(p, tz);
      const later = zonedTimeToEpoch(p, tz, 'later');
      expect([back, later], `${tz} ${new Date(t).toISOString()}`).toContain(t);
      expect(back).toBeLessThanOrEqual(t);
      expect(later).toBeGreaterThanOrEqual(t);
      expect(zonedParts(back, tz)).toEqual(p);
    }
  });

  it('gap and overlap in New York', () => {
    const ny = 'America/New_York';
    const at = (m: number, d: number, h: number, mi: number, pref?: 'earlier' | 'later'): string =>
      new Date(
        zonedTimeToEpoch({ year: 2025, month: m, day: d, hour: h, minute: mi }, ny, pref),
      ).toISOString();
    expect(at(3, 9, 2, 30)).toBe('2025-03-09T07:30:00.000Z'); // does not exist → 03:30 EDT
    expect(at(3, 9, 1, 59)).toBe('2025-03-09T06:59:00.000Z');
    expect(at(3, 9, 3, 0)).toBe('2025-03-09T07:00:00.000Z');
    expect(at(11, 2, 1, 30)).toBe('2025-11-02T05:30:00.000Z'); // twice: EDT first
    expect(at(11, 2, 1, 30, 'later')).toBe('2025-11-02T06:30:00.000Z');
    expect(at(11, 2, 2, 0)).toBe('2025-11-02T07:00:00.000Z');
  });

  it('half-hour and 45-minute zones', () => {
    expect(
      new Date(
        zonedTimeToEpoch({ year: 2025, month: 1, day: 1, hour: 0, minute: 0 }, 'Asia/Kolkata'),
      ).toISOString(),
    ).toBe('2024-12-31T18:30:00.000Z');
    expect(
      new Date(
        zonedTimeToEpoch({ year: 2025, month: 1, day: 1, hour: 0, minute: 0 }, 'Asia/Kathmandu'),
      ).toISOString(),
    ).toBe('2024-12-31T18:15:00.000Z');
    expect(
      new Date(
        zonedTimeToEpoch({ year: 2025, month: 1, day: 1, hour: 12, minute: 0 }, 'Pacific/Chatham'),
      ).toISOString(),
    ).toBe('2024-12-31T22:15:00.000Z');
    expect(
      new Date(
        zonedTimeToEpoch({ year: 2025, month: 7, day: 1, hour: 12, minute: 0 }, 'Pacific/Chatham'),
      ).toISOString(),
    ).toBe('2025-06-30T23:15:00.000Z');
  });
});

describe('nextOccurrence', () => {
  const ny = 'America/New_York';
  const iso = (t: number): string => new Date(t).toISOString();

  it('any day: today if still ahead, else tomorrow', () => {
    expect(
      iso(nextOccurrence({ dayOfWeek: null, hour: 18 }, Date.UTC(2025, 5, 2, 20, 0), ny)),
    ).toBe('2025-06-02T22:00:00.000Z');
    expect(
      iso(nextOccurrence({ dayOfWeek: null, hour: 18 }, Date.UTC(2025, 5, 2, 22, 0), ny)),
    ).toBe('2025-06-02T22:00:00.000Z'); // exactly now
    expect(
      iso(nextOccurrence({ dayOfWeek: null, hour: 18 }, Date.UTC(2025, 5, 2, 22, 1), ny)),
    ).toBe('2025-06-03T22:00:00.000Z');
  });

  it('a given weekday', () => {
    // Mon 2025-06-02; next Friday 09:00 EDT
    expect(iso(nextOccurrence({ dayOfWeek: 5, hour: 9 }, Date.UTC(2025, 5, 2, 12, 0), ny))).toBe(
      '2025-06-06T13:00:00.000Z',
    );
    // same weekday but already past → a week later
    expect(iso(nextOccurrence({ dayOfWeek: 1, hour: 9 }, Date.UTC(2025, 5, 2, 14, 0), ny))).toBe(
      '2025-06-09T13:00:00.000Z',
    );
  });

  it('across DST', () => {
    // the 02:00 hour does not exist on 2025-03-09 → 03:00 EDT
    expect(iso(nextOccurrence({ dayOfWeek: null, hour: 2 }, Date.UTC(2025, 2, 9, 5, 0), ny))).toBe(
      '2025-03-09T07:00:00.000Z',
    );
    // 01:00 happens twice on 2025-11-02: from between the two → the second
    expect(
      iso(nextOccurrence({ dayOfWeek: null, hour: 1 }, Date.UTC(2025, 10, 2, 5, 30), ny)),
    ).toBe('2025-11-02T06:00:00.000Z');
    expect(iso(nextOccurrence({ dayOfWeek: null, hour: 1 }, Date.UTC(2025, 10, 2, 4, 0), ny))).toBe(
      '2025-11-02T05:00:00.000Z',
    );
    // a day later the wall clock is still right (EST)
    expect(
      iso(nextOccurrence({ dayOfWeek: null, hour: 9 }, Date.UTC(2025, 10, 2, 15, 0), ny)),
    ).toBe('2025-11-03T14:00:00.000Z');
  });

  it('half-hour zones', () => {
    expect(
      iso(
        nextOccurrence({ dayOfWeek: null, hour: 18 }, Date.UTC(2025, 0, 1, 0, 0), 'Asia/Kolkata'),
      ),
    ).toBe('2025-01-01T12:30:00.000Z');
  });

  it('never earlier than `from`, always on the hour and weekday (random)', () => {
    const r = rng(5);
    for (let i = 0; i < 600; i++) {
      const tz = ZONES[Math.floor(r() * ZONES.length)]!;
      const from = Math.floor(Date.UTC(2025, 0, 1) / 1000 + r() * 400 * 86400) * 1000;
      const hour = Math.floor(r() * 24);
      const dow = r() < 0.5 ? null : Math.floor(r() * 7);
      const t = nextOccurrence({ dayOfWeek: dow, hour }, from, tz);
      expect(t).toBeGreaterThanOrEqual(from);
      expect(t - from).toBeLessThanOrEqual(8 * 86_400_000);
      const w = wall(t, tz);
      if (dow !== null) expect(w.wd).toBe(dow);
      // on the requested hour, except when that hour does not exist that day (then the first instant after the jump)
      const exists = w.min === hour * 60;
      if (!exists) {
        const before = wall(t - 60_000, tz);
        expect(before.min).not.toBe(w.min - 1); // there was a clock jump right before
      }
    }
  });

  it('invalid input returns `from`', () => {
    expect(nextOccurrence({ dayOfWeek: null, hour: 24 }, 12345, ny)).toBe(12345);
    expect(nextOccurrence({ dayOfWeek: 7, hour: 3 }, 12345, ny)).toBe(12345);
  });
});
