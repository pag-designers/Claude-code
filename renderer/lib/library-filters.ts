/** Pure clip/video filtering + sorting for the Library (client-side over the cached lists). */
import type { ClipView, VideoView } from '@shared/pipeline';

export type DurationBucket = 'any' | 'lt30' | '30-60' | '60-90' | 'gt90';
export type DateRange = 'any' | 'today' | '7d' | '30d';
export type ClipSort = 'score' | 'newest' | 'oldest' | 'duration';

export interface ClipFilters {
  query: string;
  minScore: number;
  duration: DurationBucket;
  videoId: string | 'all';
  date: DateRange;
  favoritesOnly: boolean;
  sort: ClipSort;
}

export const DEFAULT_CLIP_FILTERS: ClipFilters = {
  query: '',
  minScore: 0,
  duration: 'any',
  videoId: 'all',
  date: 'any',
  favoritesOnly: false,
  sort: 'score',
};

export const DURATION_LABELS: Record<DurationBucket, string> = {
  any: 'Any length',
  lt30: 'Under 30 s',
  '30-60': '30–60 s',
  '60-90': '60–90 s',
  gt90: 'Over 90 s',
};
export const DATE_LABELS: Record<DateRange, string> = {
  any: 'Any time',
  today: 'Today',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
};
export const SORT_LABELS: Record<ClipSort, string> = {
  score: 'Top score',
  newest: 'Newest',
  oldest: 'Oldest',
  duration: 'Longest',
};

export function inDurationBucket(sec: number, b: DurationBucket): boolean {
  switch (b) {
    case 'lt30':
      return sec < 30;
    case '30-60':
      return sec >= 30 && sec < 60;
    case '60-90':
      return sec >= 60 && sec < 90;
    case 'gt90':
      return sec >= 90;
    default:
      return true;
  }
}

const DAY = 86_400_000;
export function inDateRange(ts: number, r: DateRange, now: number): boolean {
  if (r === 'any') return true;
  if (r === 'today') {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return ts >= d.getTime();
  }
  return ts >= now - (r === '7d' ? 7 : 30) * DAY;
}

export function activeFilterCount(f: ClipFilters): number {
  return (
    Number(f.query.trim() !== '') +
    Number(f.minScore > 0) +
    Number(f.duration !== 'any') +
    Number(f.videoId !== 'all') +
    Number(f.date !== 'any') +
    Number(f.favoritesOnly)
  );
}

export function filterClips(
  clips: readonly ClipView[],
  f: ClipFilters,
  now = Date.now(),
): ClipView[] {
  const q = f.query.trim().toLowerCase();
  const out = clips.filter((c) => {
    if (f.favoritesOnly && !c.favorite) return false;
    if (f.videoId !== 'all' && c.videoId !== f.videoId) return false;
    if ((c.score ?? 0) < f.minScore) return false;
    if (!inDurationBucket(c.durationSec, f.duration)) return false;
    if (!inDateRange(c.createdAt, f.date, now)) return false;
    if (q) {
      const hay = `${c.title} ${c.hook ?? ''} ${c.videoTitle ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  return sortClips(out, f.sort);
}

export function sortClips(clips: ClipView[], sort: ClipSort): ClipView[] {
  const by = {
    // unscored clips (still being ranked) sink; ties fall back to the model's rank, then recency
    score: (a: ClipView, b: ClipView) =>
      (b.score ?? -1) - (a.score ?? -1) ||
      (a.rank ?? 1e9) - (b.rank ?? 1e9) ||
      b.createdAt - a.createdAt,
    newest: (a: ClipView, b: ClipView) =>
      b.createdAt - a.createdAt || (b.score ?? -1) - (a.score ?? -1),
    oldest: (a: ClipView, b: ClipView) => a.createdAt - b.createdAt,
    duration: (a: ClipView, b: ClipView) => b.durationSec - a.durationSec,
  } satisfies Record<ClipSort, (a: ClipView, b: ClipView) => number>;
  return [...clips].sort(by[sort]);
}

export type VideoSort = 'newest' | 'oldest' | 'clips' | 'title';

export function filterVideos(
  videos: readonly VideoView[],
  opts: { query?: string; favoritesOnly?: boolean; sort?: VideoSort },
): VideoView[] {
  const q = (opts.query ?? '').trim().toLowerCase();
  const out = videos.filter((v) => {
    if (opts.favoritesOnly && !v.favorite) return false;
    if (q && !`${v.title} ${v.channel ?? ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
  const sort = opts.sort ?? 'newest';
  return out.sort((a, b) =>
    sort === 'oldest'
      ? a.createdAt - b.createdAt
      : sort === 'clips'
        ? b.clipCount - a.clipCount || b.createdAt - a.createdAt
        : sort === 'title'
          ? a.title.localeCompare(b.title)
          : b.createdAt - a.createdAt,
  );
}

/** Inclusive index range [a..b] of items between two clicked indices (shift-click selection). */
export function rangeBetween(a: number, b: number): [number, number] {
  return a <= b ? [a, b] : [b, a];
}
