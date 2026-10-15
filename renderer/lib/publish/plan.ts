/**
 * Smart-spacing glue: turns the user's settings, Brand Kit posting windows and already-scheduled posts into a
 * `planSchedule` call, and keeps the manual adjustments the user makes in the preview. Pure.
 */
import {
  DEFAULT_WINDOWS,
  planSchedule,
  type PlanAccount,
  type PlanWindow,
} from '@shared/scheduling';
import type { PostingWindow } from '@shared/brand';
import type { PostView } from '@shared/publish';
import { dayKey } from './dates';

export interface PlanRow {
  /** Stable key: `${clipIndex}:${accountId}`. */
  key: string;
  clipIndex: number;
  accountId: string;
  /** Epoch ms. */
  at: number;
  /** The user moved this row away from the plan. */
  edited: boolean;
}

export const rowKey = (clipIndex: number, accountId: string): string => `${clipIndex}:${accountId}`;

export function windowsFromKit(windows: readonly PostingWindow[] | undefined | null): PlanWindow[] {
  return (windows ?? []).map((w) => ({
    platform: w.platform,
    days: [...w.days],
    start: w.start,
    end: w.end,
  }));
}

/** Earliest allowed slot: 15 minutes from now, rounded up to the next 5. */
export function earliestStart(now: number, leadMinutes = 15): number {
  const step = 5 * 60_000;
  return Math.ceil((now + leadMinutes * 60_000) / step) * step;
}

/** Posts that still occupy time on their account (they block smart spacing). */
export function existingSlots(posts: readonly PostView[]): { accountId: string; at: number }[] {
  return posts
    .filter((p) => (p.status === 'scheduled' || p.status === 'queued') && p.scheduledAt !== null)
    .map((p) => ({ accountId: p.accountId, at: p.scheduledAt as number }));
}

export interface BulkPlanInput {
  clips: number;
  accounts: PlanAccount[];
  now: number;
  timeZone: string;
  windows: readonly PostingWindow[] | undefined | null;
  minGapMinutes: number;
  maxPerDay: number;
  existing: readonly PostView[];
  /** Stable seed so the preview does not reshuffle on every render. */
  seed: number;
  /** Do not place anything before this time (the user's "start no earlier than"). */
  notBefore?: number | null;
}

export interface BulkPlan {
  rows: PlanRow[];
  warnings: string[];
  /** The plan used the built-in windows because the Brand Kit has none. */
  usedDefaultWindows: boolean;
}

export function planBulk(i: BulkPlanInput): BulkPlan {
  const kitWindows = windowsFromKit(i.windows);
  const res = planSchedule({
    clips: i.clips,
    accounts: i.accounts,
    startAt: Math.max(earliestStart(i.now), i.notBefore ?? 0),
    timeZone: i.timeZone,
    windows: kitWindows,
    minGapMinutes: i.minGapMinutes,
    maxPerDay: i.maxPerDay,
    existing: existingSlots(i.existing),
    jitterMinutes: 7,
    seed: i.seed,
  });
  return {
    rows: res.slots.map((s) => ({
      key: rowKey(s.clipIndex, s.accountId),
      clipIndex: s.clipIndex,
      accountId: s.accountId,
      at: s.at,
      edited: false,
    })),
    warnings: res.warnings,
    usedDefaultWindows: kitWindows.length === 0 && DEFAULT_WINDOWS.length > 0,
  };
}

/** Applies manual time edits (by row key) over a plan; rows the plan could not place are dropped. */
export function applyOverrides(
  rows: readonly PlanRow[],
  overrides: Readonly<Record<string, number>>,
) {
  return rows
    .map((r) => {
      const o = overrides[r.key];
      return o === undefined ? r : { ...r, at: o, edited: o !== r.at };
    })
    .sort((a, b) => a.at - b.at || a.clipIndex - b.clipIndex);
}

/**
 * Soft problems with the (possibly hand-edited) rows: in the past, closer than the minimum gap to another post of
 * the same account, or more than the daily cap on one local day. Returns messages by row key.
 */
export function rowWarnings(
  rows: readonly PlanRow[],
  opts: { now: number; minGapMinutes: number; maxPerDay: number; existing: readonly PostView[] },
): Record<string, string> {
  const out: Record<string, string> = {};
  const gap = opts.minGapMinutes * 60_000;
  const taken = existingSlots(opts.existing);
  for (const r of rows) {
    if (r.at <= opts.now) {
      out[r.key] = 'This time is in the past.';
      continue;
    }
    const mine = [
      ...rows.filter((x) => x.accountId === r.accountId && x.key !== r.key).map((x) => x.at),
      ...taken.filter((x) => x.accountId === r.accountId).map((x) => x.at),
    ];
    if (mine.some((t) => Math.abs(t - r.at) < gap)) {
      out[r.key] = `Closer than ${opts.minGapMinutes} min to another post on this account.`;
      continue;
    }
    // only the posts that come AFTER the cap-th one of that day are over the limit
    const earlierThatDay = mine.filter((t) => dayKey(t) === dayKey(r.at) && t < r.at).length;
    if (earlierThatDay + 1 > opts.maxPerDay)
      out[r.key] = `More than ${opts.maxPerDay} posts that day on this account.`;
  }
  return out;
}

/** Cheap stable hash for the plan seed. */
export function seedOf(parts: readonly string[]): number {
  let h = 17;
  for (const s of parts) for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 9973;
  return h;
}
