import { PLATFORM_LABELS, type Platform } from './cp2';

/* ------------------------------------------------------------------------------------------------
 * Slot planning for bulk scheduling ("smart spacing") and posting-time helpers. PURE (no I/O, no Date.now): the
 * renderer previews a plan with it, main uses the same function. All wall-clock maths goes through the IANA zone
 * (Intl), so it is right across DST changes and for odd offsets (Asia/Kolkata +5:30, Pacific/Chatham +12:45/+13:45).
 *
 * THE RULES `planSchedule` follows (each account is planned on its own; every clip goes to every account):
 *  1. Windows. An account uses the windows of its own platform if there are any, else the platform-less ones, else the
 *     built-in DEFAULT_WINDOWS (with a warning). A window belongs to the local day it STARTS on, and may cross midnight
 *     (22:00-02:00). "24:00" is allowed as an end; start == end means the whole day.
 *  2. One post per window. Clips are dealt, in order, to the next free window occurrence (an occurrence that already holds
 *     an existing post of that account is skipped). So several windows/days spread the clips out instead of piling them
 *     into the first window; the posting rate is "number of windows per day", capped by `maxPerDay`. A single long
 *     window therefore means one post a day: add windows to post more often.
 *  3. Where in the window. The middle of the part that is still free (after `startAt` and after the gap to other posts),
 *     moved by a deterministic jitter of up to ±`jitterMinutes` that is clamped so the post stays inside the window and
 *     keeps the gap. Same input, same plan.
 *  4. Hard limits that jitter can never break: at least `minGapMinutes` to every other post of the account (existing and
 *     planned), at most `maxPerDay` posts per LOCAL calendar day per account (existing ones count), nothing before
 *     `startAt`, everything inside a window.
 *  5. Nothing placeable in 400 days (or windows that never match) → fewer slots plus a warning.
 * ---------------------------------------------------------------------------------------------- */

export interface PlanAccount {
  id: string;
  platform: Platform;
}

/** Same shape as a Brand Kit `PostingWindow` (0 = Sunday … 6 = Saturday, local "HH:MM"). */
export interface PlanWindow {
  platform: Platform | null;
  days: number[];
  start: string;
  end: string;
}

export interface PlanInput {
  /** Number of clips; every clip is posted to every account. */
  clips: number;
  accounts: PlanAccount[];
  /** Earliest allowed time (epoch ms). */
  startAt: number;
  /** IANA zone the windows are written in (the user's local zone). */
  timeZone: string;
  /** Posting windows; empty = built-in defaults per platform. */
  windows: PlanWindow[];
  /** Minimum gap between two posts of the SAME account. */
  minGapMinutes: number;
  /** Max posts per account per local day. */
  maxPerDay: number;
  /** Already scheduled posts (they block time on their account). */
  existing: { accountId: string; at: number }[];
  /** ± minutes of deterministic jitter inside the window so posts do not all land on the minute. */
  jitterMinutes: number;
  seed: number;
}

export interface PlannedSlot {
  clipIndex: number;
  accountId: string;
  at: number;
}

export interface PlanResult {
  slots: PlannedSlot[];
  /** Human-readable notes ("only 2 slots fit before …", "Instagram limit of 3 a day reached"). */
  warnings: string[];
}

/** Built-in windows (general short-form advice; NOT based on the user's analytics): lunch and evening, every day. */
export const DEFAULT_WINDOWS: PlanWindow[] = [
  { platform: null, days: [0, 1, 2, 3, 4, 5, 6], start: '11:30', end: '13:30' },
  { platform: null, days: [0, 1, 2, 3, 4, 5, 6], start: '17:30', end: '21:00' },
];

/** How far ahead the planner looks for room (local days). */
export const PLAN_HORIZON_DAYS = 400;

const MIN_MS = 60_000;
const DAY_MS = 86_400_000;

/* ------------------------------------------------------------------------------------ zone maths ----- */

export interface ZonedParts {
  year: number;
  /** 1-12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
  /** "YYYY-MM-DD" of the local calendar day. */
  dayKey: string;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        weekday: 'short',
      });
    } catch {
      throw new Error(`Unknown time zone "${timeZone}"`);
    }
    formatters.set(timeZone, f);
  }
  return f;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Wall-clock fields of the instant `t` in `timeZone`. */
export function zonedParts(t: number, timeZone: string): ZonedParts {
  const p = formatterFor(timeZone).formatToParts(new Date(t));
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let weekday = 0;
  for (const x of p) {
    switch (x.type) {
      case 'year':
        year = +x.value;
        break;
      case 'month':
        month = +x.value;
        break;
      case 'day':
        day = +x.value;
        break;
      case 'hour':
        hour = +x.value % 24;
        break;
      case 'minute':
        minute = +x.value;
        break;
      case 'weekday':
        weekday = WEEKDAYS.indexOf(x.value);
        break;
      default:
        break;
    }
  }
  return {
    year,
    month,
    day,
    hour,
    minute,
    weekday,
    dayKey: `${year}-${pad2(month)}-${pad2(day)}`,
  };
}

/** UTC offset (ms, local - UTC) of `timeZone` at instant `t`, minute precision. */
function offsetAt(t: number, timeZone: string): number {
  const p = zonedParts(t, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(t / MIN_MS) * MIN_MS;
}

/**
 * The instant at which the clocks in `timeZone` read `y-m-d hh:mm` (month 1-12; `d`/`hh` may overflow and are normalised,
 * so `hh = 24` is midnight of the next day). Daylight-saving edge cases:
 *  - the time does not exist (clocks jumped forward): the result is the first instant after the jump, i.e. the wall
 *    time shifted by the length of the gap (02:30 → 03:30);
 *  - the time happens twice (clocks went back): the first one, or the second with `prefer: 'later'`.
 */
export function zonedTimeToEpoch(
  local: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string,
  prefer: 'earlier' | 'later' = 'earlier',
): number {
  const guess = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  const before = offsetAt(guess - DAY_MS, timeZone);
  const after = offsetAt(guess + DAY_MS, timeZone);
  const valid: number[] = [];
  for (const o of before === after ? [before] : [before, after]) {
    const t = guess - o;
    if (offsetAt(t, timeZone) === o) valid.push(t);
  }
  if (valid.length === 0) return guess - before; // inside a gap: the instant the gap ends
  if (valid.length === 1) return valid[0]!;
  return prefer === 'earlier' ? Math.min(...valid) : Math.max(...valid);
}

/** The local calendar day of instant `t` ("YYYY-MM-DD"). Used for the per-day post cap. */
export const localDayKey = (t: number, timeZone: string): string => zonedParts(t, timeZone).dayKey;

/** "Tue 14 Oct, 11:42" (24-hour clock, in `timeZone`); `withYear` appends the year: "Tue 14 Oct 2025, 11:42". */
export function formatSlotLocal(
  at: number,
  timeZone: string,
  opts: { withYear?: boolean } = {},
): string {
  const p = zonedParts(at, timeZone);
  const date = `${WEEKDAYS[p.weekday]} ${p.day} ${MONTHS[p.month - 1]}${opts.withYear ? ` ${p.year}` : ''}`;
  return `${date}, ${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** A civil date (no zone) advanced by `n` days. */
function addCivilDays(
  c: { year: number; month: number; day: number },
  n: number,
): { year: number; month: number; day: number; weekday: number } {
  const d = new Date(Date.UTC(c.year, c.month - 1, c.day + n));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    weekday: d.getUTCDay(),
  };
}

/* ----------------------------------------------------------------------------------- randomness ----- */

/** Deterministic value in [0, 1) from a string (FNV-1a → one mulberry32 step). */
export function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let t = (h + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/* ------------------------------------------------------------------------------------- windows ----- */

interface ParsedWindow {
  days: ReadonlySet<number>;
  /** Minutes after local midnight. */
  start: number;
  /** Minutes after local midnight of the START day (may be ≥ 1440 for windows crossing midnight). */
  end: number;
}

/** "HH:MM" (end may be "24:00") → minutes; null when malformed. */
function parseClock(s: string, allow24: boolean): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (mi > 59 || h > 24 || (h === 24 && (!allow24 || mi !== 0))) return null;
  return h * 60 + mi;
}

function parseWindow(w: PlanWindow): ParsedWindow | null {
  const start = parseClock(w.start, false);
  const end = parseClock(w.end, true);
  const days = w.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  if (start === null || end === null || days.length === 0) return null;
  return {
    days: new Set(days),
    start,
    // end <= start: crosses midnight (equal = the whole day)
    end: end > start ? end : end + 1440,
  };
}

interface WindowChoice {
  windows: ParsedWindow[];
  usedDefault: boolean;
  invalid: number;
}

function windowsFor(platform: Platform, all: readonly PlanWindow[]): WindowChoice {
  const own = all.filter((w) => w.platform === platform);
  const generic = all.filter((w) => w.platform === null);
  const pick = own.length > 0 ? own : generic;
  const parsed = pick.map(parseWindow);
  const good = parsed.filter((w): w is ParsedWindow => w !== null);
  if (good.length > 0) {
    return { windows: good, usedDefault: false, invalid: parsed.length - good.length };
  }
  return {
    windows: DEFAULT_WINDOWS.map(parseWindow).filter((w): w is ParsedWindow => w !== null),
    usedDefault: true,
    invalid: parsed.length - good.length,
  };
}

/* --------------------------------------------------------------------------------- the planner ----- */

/** First index in sorted `a` with a[i] >= x. */
function lowerBound(a: readonly number[], x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Smart spacing. See the rules at the top of this file. Deterministic for equal input. */
export function planSchedule(input: PlanInput): PlanResult {
  const tz = input.timeZone;
  formatterFor(tz); // throws a clear error for an unknown zone
  const clips = Number.isFinite(input.clips) ? Math.max(0, Math.floor(input.clips)) : 0;
  const maxPerDay = Number.isFinite(input.maxPerDay) ? Math.floor(input.maxPerDay) : 0;
  const gapMs =
    Math.max(0, Number.isFinite(input.minGapMinutes) ? input.minGapMinutes : 0) * MIN_MS;
  const jitter = Math.max(
    0,
    Math.floor(Number.isFinite(input.jitterMinutes) ? input.jitterMinutes : 0),
  );
  const slots: PlannedSlot[] = [];
  const warnings: string[] = [];
  if (clips === 0 || input.accounts.length === 0) return { slots, warnings };
  if (maxPerDay < 1) {
    return {
      slots,
      warnings: ['"Max posts per day" must be at least 1, so nothing was scheduled.'],
    };
  }

  // local-time conversions are the expensive part: memoise them for the whole call
  const epochCache = new Map<number, number>();
  const localEpoch = (c: { year: number; month: number; day: number }, minutes: number): number => {
    const key = Date.UTC(c.year, c.month - 1, c.day) / MIN_MS + minutes;
    let v = epochCache.get(key);
    if (v === undefined) {
      v = zonedTimeToEpoch({ ...c, hour: Math.floor(minutes / 60), minute: minutes % 60 }, tz);
      epochCache.set(key, v);
    }
    return v;
  };
  const dayCache = new Map<number, string>();
  const dayOf = (t: number): string => {
    const m = Math.floor(t / MIN_MS);
    let v = dayCache.get(m);
    if (v === undefined) {
      v = localDayKey(m * MIN_MS, tz);
      dayCache.set(m, v);
    }
    return v;
  };

  const startAt = Number.isFinite(input.startAt) ? input.startAt : 0;
  const startLocal = zonedParts(startAt, tz);
  const seen = new Set<string>();

  for (const acc of input.accounts) {
    if (seen.has(acc.id)) continue;
    seen.add(acc.id);
    const label = PLATFORM_LABELS[acc.platform];
    const choice = windowsFor(acc.platform, input.windows);
    if (choice.usedDefault && input.windows.length > 0) {
      warnings.push(
        `No usable posting window for ${label}; the default times (lunchtime and evening) were used.`,
      );
    }
    if (choice.invalid > 0) {
      warnings.push(
        `${choice.invalid} posting window(s) for ${label} are malformed and were ignored.`,
      );
    }

    // everything that occupies this account's time, sorted: existing posts + the ones planned below
    const blockers = input.existing
      .filter((e) => e.accountId === acc.id && Number.isFinite(e.at))
      .map((e) => e.at)
      .sort((a, b) => a - b);
    const perDay = new Map<string, number>();
    for (const b of blockers) perDay.set(dayOf(b), (perDay.get(dayOf(b)) ?? 0) + 1);

    let placed = 0;
    let lastEnd = -Infinity;
    let skippedOccupied = 0;
    let skippedGap = 0;
    let skippedDayFull = 0;

    for (let dayIdx = 0; dayIdx < PLAN_HORIZON_DAYS + 1 && placed < clips; dayIdx++) {
      const civil = addCivilDays(startLocal, dayIdx - 1); // yesterday's windows may run into today
      const today: { s: number; e: number }[] = [];
      for (const w of choice.windows) {
        if (!w.days.has(civil.weekday)) continue;
        const s = localEpoch(civil, w.start);
        const e = localEpoch(civil, w.end);
        if (e > s) today.push({ s, e });
      }
      today.sort((a, b) => a.s - b.s);

      for (const win of today) {
        if (placed >= clips) break;
        const s = Math.max(win.s, lastEnd); // overlapping windows: the later one only owns what is left
        const e = win.e;
        lastEnd = Math.max(lastEnd, e);
        if (e - s < MIN_MS || e <= startAt) continue;

        // already holds a post of this account: this window is taken
        const i0 = lowerBound(blockers, s);
        if (i0 < blockers.length && blockers[i0]! < e) {
          skippedOccupied++;
          continue;
        }

        // free minutes: [lo, hi] inside the window, ≥ startAt, outside every (b - gap, b + gap)
        const lo = Math.ceil(Math.max(s, startAt) / MIN_MS);
        const hi = Math.ceil(e / MIN_MS) - 1;
        if (hi < lo) continue;
        const free: [number, number][] = [];
        let cursor = lo;
        for (let k = lowerBound(blockers, lo * MIN_MS - gapMs - MIN_MS); k < blockers.length; k++) {
          const b = blockers[k]!;
          if (b - gapMs > (hi + 1) * MIN_MS) break;
          const forbidFrom = Math.floor((b - gapMs) / MIN_MS) + 1; // first minute that is too close
          const forbidTo = Math.ceil((b + gapMs) / MIN_MS) - 1; // last minute that is too close
          if (forbidTo < forbidFrom) continue;
          if (forbidFrom > cursor) free.push([cursor, Math.min(hi, forbidFrom - 1)]);
          cursor = Math.max(cursor, forbidTo + 1);
          if (cursor > hi) break;
        }
        if (cursor <= hi) free.push([cursor, hi]);

        // cut at local midnight (windows crossing it) and drop days that are full
        const pieces: [number, number][] = [];
        let dayFull = false;
        for (const [a, b] of free) {
          if (b < a) continue;
          let from = a;
          while (from <= b) {
            const key = dayOf(from * MIN_MS);
            const lp = zonedParts(from * MIN_MS, tz);
            const nextMidnight = Math.floor(localEpoch(addCivilDays(lp, 1), 0) / MIN_MS);
            const to = Math.min(b, nextMidnight - 1);
            if ((perDay.get(key) ?? 0) < maxPerDay) pieces.push([from, to]);
            else dayFull = true;
            from = to + 1;
          }
        }
        if (pieces.length === 0) {
          if (dayFull) skippedDayFull++;
          else skippedGap++;
          continue;
        }

        // the middle of what is left of the window (lo..hi are whole minutes, hi inclusive); the piece nearest to it, and
        // the middle itself when it lies in that piece, else the piece's own middle
        const mid = (lo + hi + 1) / 2;
        let best = pieces[0]!;
        let bestDist = Infinity;
        for (const pc of pieces) {
          const d = mid < pc[0] ? pc[0] - mid : mid > pc[1] ? mid - pc[1] : 0;
          if (d < bestDist) {
            best = pc;
            bestDist = d;
          }
        }
        const clipIndex = placed;
        const offset = jitter
          ? Math.round((hash01(`${input.seed}|${acc.id}|${clipIndex}`) * 2 - 1) * jitter)
          : 0;
        const centre = Math.floor(
          mid >= best[0] && mid <= best[1] ? mid : (best[0] + best[1] + 1) / 2,
        );
        const minute = Math.min(best[1], Math.max(best[0], centre + offset));
        const at = minute * MIN_MS;

        slots.push({ clipIndex, accountId: acc.id, at });
        blockers.splice(lowerBound(blockers, at), 0, at);
        const key = dayOf(at);
        perDay.set(key, (perDay.get(key) ?? 0) + 1);
        placed++;
      }
    }

    if (placed < clips) {
      const why: string[] = [];
      if (skippedDayFull > 0) {
        why.push(
          `${label} is limited to ${maxPerDay} post${maxPerDay === 1 ? '' : 's'} a day (${skippedDayFull} window${skippedDayFull === 1 ? '' : 's'} skipped)`,
        );
      }
      if (skippedGap > 0) {
        why.push(
          `${skippedGap} window${skippedGap === 1 ? ' was' : 's were'} too close to another post (minimum gap ${Math.round(gapMs / MIN_MS)} min)`,
        );
      }
      if (skippedOccupied > 0) {
        why.push(
          `${skippedOccupied} window${skippedOccupied === 1 ? ' already has' : 's already have'} a post`,
        );
      }
      warnings.push(
        `Only ${placed} of ${clips} clips could be scheduled on ${label} (${acc.id}) within the next ${PLAN_HORIZON_DAYS} days${why.length ? `: ${why.join('; ')}` : ''}.`,
      );
    } else if (skippedDayFull > 0) {
      warnings.push(
        `${label} is limited to ${maxPerDay} post${maxPerDay === 1 ? '' : 's'} a day: ${skippedDayFull} window${skippedDayFull === 1 ? ' was' : 's were'} skipped, so the plan runs a little longer.`,
      );
    }
  }

  slots.sort(
    (a, b) =>
      a.at - b.at ||
      a.clipIndex - b.clipIndex ||
      (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0),
  );
  return { slots, warnings };
}

/**
 * The next occurrence (≥ `from`) of a posting-time suggestion ({dayOfWeek 0-6 | null = any day, hour 0-23}) in `timeZone`:
 * the local `hour`:00 on a matching weekday. Returns epoch ms. DST: an hour that does not exist that day (clocks jumped
 * over it) resolves to the first instant after the jump; an hour that happens twice resolves to the earliest occurrence
 * that is still ≥ `from`. Invalid input returns `from`.
 */
export function nextOccurrence(
  s: { dayOfWeek: number | null; hour: number },
  from: number,
  timeZone: string,
): number {
  if (!Number.isInteger(s.hour) || s.hour < 0 || s.hour > 23) return from;
  if (
    s.dayOfWeek !== null &&
    (!Number.isInteger(s.dayOfWeek) || s.dayOfWeek < 0 || s.dayOfWeek > 6)
  ) {
    return from;
  }
  const start = zonedParts(from, timeZone);
  for (let i = 0; i < 9; i++) {
    const civil = addCivilDays(start, i);
    if (s.dayOfWeek !== null && civil.weekday !== s.dayOfWeek) continue;
    const local = { ...civil, hour: s.hour, minute: 0 };
    const first = zonedTimeToEpoch(local, timeZone, 'earlier');
    if (first >= from) return first;
    const second = zonedTimeToEpoch(local, timeZone, 'later');
    if (second >= from) return second;
  }
  return from;
}
