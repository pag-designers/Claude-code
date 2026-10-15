import { describe, expect, it } from 'vitest';
import type { PostingWindow } from '../../shared/brand';
import { defaultFieldsFrom, type PostView } from '../../shared/publish';
import {
  applyOverrides,
  earliestStart,
  existingSlots,
  planBulk,
  rowKey,
  rowWarnings,
  seedOf,
  windowsFromKit,
} from '../../renderer/lib/publish/plan';

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m, 0, 0).getTime();
const NOW = at(14, 10, 3);

const post = (over: Partial<PostView> & { id: string; accountId: string }): PostView => ({
  platform: 'shorts',
  accountName: 'x',
  clipId: 'c',
  exportId: null,
  title: 't',
  status: 'scheduled',
  scheduledAt: at(15, 12),
  publishedAt: null,
  nextAttemptAt: null,
  attempts: 0,
  fields: defaultFieldsFrom('shorts', null, 't'),
  media: null,
  autoFixed: false,
  autoFix: true,
  error: null,
  result: null,
  stats: null,
  groupId: null,
  thumbUrl: null,
  createdAt: 0,
  ...over,
});

const base = {
  now: NOW,
  timeZone: TZ,
  windows: [] as PostingWindow[],
  minGapMinutes: 180,
  maxPerDay: 3,
  existing: [] as PostView[],
  seed: 3,
};

describe('earliestStart', () => {
  it('is 15 minutes away, rounded up to 5', () => {
    expect(earliestStart(at(14, 10, 3))).toBe(at(14, 10, 20));
    expect(earliestStart(at(14, 10, 0))).toBe(at(14, 10, 15));
    expect(earliestStart(at(14, 10, 0), 60)).toBe(at(14, 11, 0));
  });
});

describe('windowsFromKit', () => {
  it('maps Brand Kit windows onto plan windows', () => {
    const w: PostingWindow = {
      id: 'w1',
      platform: 'tiktok',
      days: [1, 2],
      start: '18:00',
      end: '20:00',
    };
    expect(windowsFromKit([w])).toEqual([
      { platform: 'tiktok', days: [1, 2], start: '18:00', end: '20:00' },
    ]);
    expect(windowsFromKit(null)).toEqual([]);
  });
});

describe('existingSlots', () => {
  it('only scheduled and queued posts with a time block the plan', () => {
    const s = existingSlots([
      post({ id: '1', accountId: 'a', status: 'scheduled' }),
      post({ id: '2', accountId: 'a', status: 'queued', scheduledAt: at(16, 9) }),
      post({ id: '3', accountId: 'a', status: 'published' }),
      post({ id: '4', accountId: 'a', status: 'draft', scheduledAt: null }),
      post({ id: '5', accountId: 'a', status: 'failed' }),
    ]);
    expect(s).toEqual([
      { accountId: 'a', at: at(15, 12) },
      { accountId: 'a', at: at(16, 9) },
    ]);
  });
});

describe('planBulk', () => {
  it('places every clip on every account, in the future, and is deterministic', () => {
    const input = {
      ...base,
      clips: 4,
      accounts: [
        { id: 'yt', platform: 'shorts' as const },
        { id: 'tt', platform: 'tiktok' as const },
      ],
    };
    const a = planBulk(input);
    const b = planBulk(input);
    expect(a).toEqual(b);
    expect(a.rows).toHaveLength(8);
    for (const r of a.rows) expect(r.at).toBeGreaterThanOrEqual(earliestStart(NOW));
    expect(a.rows.map((r) => r.key)).toContain(rowKey(3, 'tt'));
    expect(a.usedDefaultWindows).toBe(true);
  });

  it('keeps the minimum gap and the daily cap per account', () => {
    const p = planBulk({ ...base, clips: 6, accounts: [{ id: 'yt', platform: 'shorts' }] });
    const times = p.rows.map((r) => r.at).sort((x, y) => x - y);
    for (let i = 1; i < times.length; i++)
      expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(180 * 60_000);
    const perDay = new Map<string, number>();
    for (const t of times) {
      const k = new Date(t).toDateString();
      perDay.set(k, (perDay.get(k) ?? 0) + 1);
    }
    for (const n of perDay.values()) expect(n).toBeLessThanOrEqual(3);
  });

  it('respects Brand Kit windows', () => {
    const w: PostingWindow = {
      id: 'w',
      platform: null,
      days: [0, 1, 2, 3, 4, 5, 6],
      start: '19:00',
      end: '21:00',
    };
    const p = planBulk({
      ...base,
      windows: [w],
      clips: 3,
      accounts: [{ id: 'yt', platform: 'shorts' }],
    });
    expect(p.usedDefaultWindows).toBe(false);
    for (const r of p.rows) {
      const d = new Date(r.at);
      const mins = d.getHours() * 60 + d.getMinutes();
      // jitter may nudge a slot a few minutes outside the window
      expect(mins).toBeGreaterThanOrEqual(19 * 60 - 10);
      expect(mins).toBeLessThanOrEqual(21 * 60 + 10);
    }
  });

  it('avoids times already taken on the same account and honours "not before"', () => {
    const existing = [post({ id: 'e', accountId: 'yt', scheduledAt: at(14, 12) })];
    const p = planBulk({
      ...base,
      existing,
      clips: 2,
      accounts: [{ id: 'yt', platform: 'shorts' }],
      notBefore: at(20, 0),
    });
    for (const r of p.rows) expect(r.at).toBeGreaterThanOrEqual(at(20, 0));
    const q = planBulk({
      ...base,
      existing,
      clips: 1,
      accounts: [{ id: 'yt', platform: 'shorts' }],
    });
    for (const r of q.rows)
      expect(Math.abs(r.at - at(14, 12))).toBeGreaterThanOrEqual(180 * 60_000);
  });
});

describe('manual adjustments', () => {
  const plan = planBulk({ ...base, clips: 2, accounts: [{ id: 'yt', platform: 'shorts' }] });
  it('applyOverrides replaces a time, flags it edited and keeps rows sorted', () => {
    const first = plan.rows[0]!;
    const later = at(30, 9);
    const rows = applyOverrides(plan.rows, { [first.key]: later });
    expect(rows.find((r) => r.key === first.key)).toMatchObject({ at: later, edited: true });
    expect(rows.map((r) => r.at)).toEqual([...rows.map((r) => r.at)].sort((a, b) => a - b));
    expect(applyOverrides(plan.rows, { [first.key]: first.at }).every((r) => !r.edited)).toBe(true);
  });
  it('rowWarnings flags the past, close neighbours and an overfull day', () => {
    const opts = { now: NOW, minGapMinutes: 180, maxPerDay: 2, existing: [] as PostView[] };
    const r = (clipIndex: number, when: number) => ({
      key: rowKey(clipIndex, 'yt'),
      clipIndex,
      accountId: 'yt',
      at: when,
      edited: true,
    });
    const w = rowWarnings([r(0, at(13, 9)), r(1, at(20, 9)), r(2, at(20, 10))], opts);
    expect(w[rowKey(0, 'yt')]).toMatch(/past/);
    expect(w[rowKey(1, 'yt')]).toMatch(/Closer than 180 min/);
    expect(w[rowKey(2, 'yt')]).toMatch(/Closer than 180 min/);
    const day = rowWarnings([r(0, at(20, 8)), r(1, at(20, 12)), r(2, at(20, 16))], opts);
    expect(day[rowKey(2, 'yt')]).toMatch(/More than 2 posts/);
    expect(day[rowKey(0, 'yt')]).toBeUndefined();
    const taken = rowWarnings([r(0, at(20, 9))], {
      ...opts,
      existing: [post({ id: 'x', accountId: 'yt', scheduledAt: at(20, 10) })],
    });
    expect(taken[rowKey(0, 'yt')]).toMatch(/Closer than/);
  });
  it('seedOf is stable and order sensitive', () => {
    expect(seedOf(['a', 'b'])).toBe(seedOf(['a', 'b']));
    expect(seedOf(['a', 'b'])).not.toBe(seedOf(['b', 'a']));
  });
});
