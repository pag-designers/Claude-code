import type { Platform } from './cp2';

/* ------------------------------------------------------------------------------------------------
 * Slot planning for bulk scheduling ("smart spacing") and posting-time helpers. PURE (no I/O, no Date.now):
 * the renderer previews a plan with it, main uses the same function. Owned by the scheduling-maths engineer, who
 * hardens it (DST, windows crossing midnight, per-platform defaults, deterministic jitter) and tests it; the
 * exported names and shapes below are the contract the UI and main code against.
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

/** Smart spacing. See `PlanInput`. Deterministic for equal input. */
export function planSchedule(input: PlanInput): PlanResult {
  const windows = input.windows.length ? input.windows : DEFAULT_WINDOWS;
  const slots: PlannedSlot[] = [];
  const warnings: string[] = [];
  const gapMs = input.minGapMinutes * 60_000;
  const parts = (t: number) => {
    const f = new Intl.DateTimeFormat('en-GB', {
      timeZone: input.timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    }).formatToParts(new Date(t));
    const g = (ty: string) => f.find((p) => p.type === ty)?.value ?? '';
    const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(g('weekday'));
    return {
      day: `${g('year')}-${g('month')}-${g('day')}`,
      wd,
      min: +g('hour') * 60 + +g('minute'),
    };
  };
  const toMin = (hhmm: string) => +hhmm.slice(0, 2) * 60 + +hhmm.slice(3);
  for (const acc of input.accounts) {
    const mine = input.existing.filter((e) => e.accountId === acc.id).map((e) => e.at);
    const ws = windows.filter((w) => w.platform === null || w.platform === acc.platform);
    let cursor = input.startAt;
    for (let clip = 0; clip < input.clips; clip++) {
      let placed = false;
      // scan minute by minute (5-minute steps) for up to 60 days: simple, correct, fast enough for ≤ 200 posts
      for (let t = cursor; t < input.startAt + 60 * 86_400_000; t += 5 * 60_000) {
        const p = parts(t);
        const inWindow = ws.some(
          (w) => w.days.includes(p.wd) && p.min >= toMin(w.start) && p.min < toMin(w.end),
        );
        if (!inWindow) continue;
        if (mine.some((m) => Math.abs(m - t) < gapMs)) continue;
        if (mine.filter((m) => parts(m).day === p.day).length >= input.maxPerDay) continue;
        const jitter = input.jitterMinutes
          ? Math.round(
              (((Math.sin(input.seed + clip * 7.13 + acc.id.length) + 1) / 2) * 2 - 1) *
                input.jitterMinutes,
            ) * 60_000
          : 0;
        const at = Math.max(input.startAt, t + jitter);
        slots.push({ clipIndex: clip, accountId: acc.id, at });
        mine.push(at);
        cursor = at + gapMs;
        placed = true;
        break;
      }
      if (!placed) {
        warnings.push(
          `Could not find a free slot for clip ${clip + 1} on one account within 60 days.`,
        );
        break;
      }
    }
  }
  slots.sort((a, b) => a.at - b.at || a.clipIndex - b.clipIndex);
  return { slots, warnings };
}

/**
 * The next occurrence (≥ `from`) of a posting-time suggestion ({dayOfWeek 0-6 | null = any day, hour 0-23}) in `timeZone`.
 * Returns epoch ms.
 */
export function nextOccurrence(
  s: { dayOfWeek: number | null; hour: number },
  from: number,
  timeZone: string,
): number {
  const f = (t: number) => {
    const p = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    }).formatToParts(new Date(t));
    const g = (ty: string) => p.find((x) => x.type === ty)?.value ?? '';
    return {
      wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(g('weekday')),
      h: +g('hour'),
      m: +g('minute'),
    };
  };
  for (let t = Math.ceil(from / 60_000) * 60_000; t < from + 8 * 86_400_000; t += 60_000) {
    const p = f(t);
    if (p.h === s.hour && p.m === 0 && (s.dayOfWeek === null || p.wd === s.dayOfWeek)) return t;
  }
  return from;
}
