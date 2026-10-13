import { describe, expect, it } from 'vitest';
import type { ClipView, Sentence, VideoAnalysis, VideoView } from '../../shared/pipeline';
import { pipelineOptionsSchema } from '../../shared/pipeline';
import {
  DEFAULT_CLIP_FILTERS,
  activeFilterCount,
  filterClips,
  filterVideos,
  inDateRange,
  inDurationBucket,
  rangeBetween,
  sortClips,
} from '../../renderer/lib/library-filters';
import { computeOffsets, indexAtOffset, visibleRange } from '../../renderer/lib/virtual';
import {
  activeRangeIndex,
  activeSentenceIndex,
  findMatches,
  notesToMarkdown,
  transcriptToText,
} from '../../renderer/lib/transcript';

const now = new Date('2026-10-13T15:00:00').getTime();
const H = 3_600_000;
const clip = (id: string, p: Partial<ClipView> = {}): ClipView => ({
  id,
  videoId: 'v1',
  videoTitle: 'Video one',
  title: `Clip ${id}`,
  hook: null,
  startSec: 0,
  endSec: 30,
  durationSec: 30,
  score: 70,
  breakdown: null,
  confidence: null,
  whyItWorks: null,
  status: 'rendered',
  renderProgress: null,
  error: null,
  favorite: false,
  tags: [],
  aspect: '9:16',
  hasRender: true,
  hasThumb: true,
  rank: null,
  createdAt: now - H,
  ...p,
});

describe('clip filters', () => {
  const clips = [
    clip('a', { score: 94, durationSec: 18, favorite: true, hook: 'Awareness is not enough' }),
    clip('b', {
      score: 55,
      durationSec: 45,
      videoId: 'v2',
      videoTitle: 'Podcast',
      createdAt: now - 3 * 86_400_000,
    }),
    clip('c', { score: null, durationSec: 75, status: 'candidate', createdAt: now - 10 * 60_000 }),
    clip('d', { score: 80, durationSec: 100, createdAt: now - 40 * 86_400_000 }),
  ];
  const f = (p: Partial<typeof DEFAULT_CLIP_FILTERS>) =>
    filterClips(clips, { ...DEFAULT_CLIP_FILTERS, ...p }, now).map((c) => c.id);

  it('sorts by score with unscored clips last, then by newest / oldest / longest', () => {
    expect(f({})).toEqual(['a', 'd', 'b', 'c']);
    expect(f({ sort: 'newest' })).toEqual(['c', 'a', 'b', 'd']);
    expect(f({ sort: 'oldest' })).toEqual(['d', 'b', 'a', 'c']);
    expect(f({ sort: 'duration' })).toEqual(['d', 'c', 'b', 'a']);
    expect(
      sortClips(
        [clip('x', { score: 60, rank: 2 }), clip('y', { score: 60, rank: 1 })],
        'score',
      ).map((c) => c.id),
    ).toEqual(['y', 'x']);
  });

  it('filters by min score, duration bucket, video, date, favorites and text', () => {
    expect(f({ minScore: 80 })).toEqual(['a', 'd']);
    expect(f({ minScore: 1 })).toEqual(['a', 'd', 'b']); // unscored clips are 0
    expect(f({ duration: 'lt30' })).toEqual(['a']);
    expect(f({ duration: '30-60' })).toEqual(['b']);
    expect(f({ duration: '60-90' })).toEqual(['c']);
    expect(f({ duration: 'gt90' })).toEqual(['d']);
    expect(f({ videoId: 'v2' })).toEqual(['b']);
    expect(f({ date: 'today' })).toEqual(['a', 'c']);
    expect(f({ date: '7d' })).toEqual(['a', 'b', 'c']);
    expect(f({ date: '30d' })).toEqual(['a', 'b', 'c']);
    expect(f({ favoritesOnly: true })).toEqual(['a']);
    expect(f({ query: 'awareness' })).toEqual(['a']);
    expect(f({ query: 'podcast' })).toEqual(['b']);
  });

  it('counts active filters and bucket boundaries', () => {
    expect(activeFilterCount(DEFAULT_CLIP_FILTERS)).toBe(0);
    expect(
      activeFilterCount({
        ...DEFAULT_CLIP_FILTERS,
        minScore: 5,
        query: ' x ',
        favoritesOnly: true,
        sort: 'newest',
      }),
    ).toBe(3);
    expect(inDurationBucket(30, 'lt30')).toBe(false);
    expect(inDurationBucket(30, '30-60')).toBe(true);
    expect(inDurationBucket(90, 'gt90')).toBe(true);
    expect(inDateRange(now - 5 * H, 'today', now)).toBe(true); // 10:00 same day
    expect(inDateRange(now - 20 * H, 'today', now)).toBe(false);
  });

  it('selects shift ranges in either direction', () => {
    expect(rangeBetween(2, 5)).toEqual([2, 5]);
    expect(rangeBetween(5, 2)).toEqual([2, 5]);
  });

  it('filters and sorts videos', () => {
    const v = (id: string, p: Partial<VideoView>): VideoView => ({
      id,
      sourceUrl: 'https://youtu.be/aaaaaaaaaaa',
      sourceId: null,
      title: id,
      channel: 'Chan',
      durationSec: 10,
      thumbnail: null,
      status: 'ready',
      stage: null,
      progress: null,
      error: null,
      favorite: false,
      clipCount: 0,
      renderedCount: 0,
      topScore: null,
      createdAt: 1,
      updatedAt: 1,
      hasProxy: false,
      options: pipelineOptionsSchema.parse({}),
      ...p,
    });
    const vs = [
      v('b', { createdAt: 2, clipCount: 1, favorite: true }),
      v('a', { createdAt: 3, clipCount: 9 }),
      v('c', { createdAt: 1, channel: 'Zed' }),
    ];
    expect(filterVideos(vs, {}).map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(filterVideos(vs, { sort: 'oldest' }).map((x) => x.id)).toEqual(['c', 'b', 'a']);
    expect(filterVideos(vs, { sort: 'clips' }).map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(filterVideos(vs, { sort: 'title' }).map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(filterVideos(vs, { favoritesOnly: true }).map((x) => x.id)).toEqual(['b']);
    expect(filterVideos(vs, { query: 'zed' }).map((x) => x.id)).toEqual(['c']);
  });
});

describe('virtual list maths', () => {
  it('computes offsets from measured and estimated heights', () => {
    const o = computeOffsets(4, (i) => (i === 1 ? 100 : undefined), 40);
    expect(o).toEqual([0, 40, 140, 180, 220]);
  });
  it('finds the row at an offset (binary search, clamped)', () => {
    const o = computeOffsets(5, () => 50, 50);
    expect(indexAtOffset(o, 0)).toBe(0);
    expect(indexAtOffset(o, 49)).toBe(0);
    expect(indexAtOffset(o, 50)).toBe(1);
    expect(indexAtOffset(o, 10_000)).toBe(4);
    expect(indexAtOffset([0], 5)).toBe(0);
  });
  it('visibleRange covers the viewport plus overscan and never exceeds the list', () => {
    const o = computeOffsets(1000, () => 40, 40);
    const r = visibleRange(o, 4000, 500, 200);
    expect(r.start).toBe(Math.floor((4000 - 200) / 40));
    expect(r.end).toBe(Math.floor((4000 + 500 + 200) / 40));
    expect(r.end - r.start).toBeLessThan(25); // a 12k-word transcript only renders a screenful
    expect(visibleRange(o, 0, 500, 200).start).toBe(0);
    expect(visibleRange(o, 999_999, 500, 200).end).toBe(999);
    expect(visibleRange([0], 0, 100)).toEqual({ start: 0, end: -1 });
  });
});

describe('transcript helpers', () => {
  const sent = (
    id: number,
    s: number,
    e: number,
    text: string,
    speaker: string | null = null,
  ): Sentence => ({ id, s, e, text, speaker, wordStart: 0, wordEnd: 0 });
  const sentences = [
    sent(0, 1, 4, 'Welcome to the show.', 'A'),
    sent(1, 5, 9, 'The collage took four hundred hours. Collage again.', 'B'),
    sent(2, 10, 12, 'Thanks.', 'B'),
  ];

  it('finds the active sentence by playhead time', () => {
    expect(activeSentenceIndex(sentences, 0)).toBe(-1);
    expect(activeSentenceIndex(sentences, 1)).toBe(0);
    expect(activeSentenceIndex(sentences, 4.9)).toBe(0);
    expect(activeSentenceIndex(sentences, 9.5)).toBe(1);
    expect(activeSentenceIndex(sentences, 999)).toBe(2);
    expect(activeSentenceIndex([], 3)).toBe(-1);
  });

  it('finds the active chapter (last one stays active at the end)', () => {
    const ch = [
      { start: 0, end: 10 },
      { start: 10, end: 20 },
    ];
    expect(activeRangeIndex(ch, 0)).toBe(0);
    expect(activeRangeIndex(ch, 10)).toBe(1);
    expect(activeRangeIndex(ch, 25)).toBe(1);
    expect(activeRangeIndex([], 1)).toBe(-1);
  });

  it('search is case-insensitive, returns every occurrence, ignores one-letter queries', () => {
    const m = findMatches(sentences, 'COLLAGE');
    expect(m).toEqual([
      {
        sentence: 1,
        ranges: [
          [4, 11],
          [37, 44],
        ],
      },
    ]);
    expect(findMatches(sentences, 'c')).toEqual([]);
    expect(findMatches(sentences, 'nope')).toEqual([]);
    expect(findMatches(sentences, '  the  ').map((x) => x.sentence)).toEqual([0, 1]);
  });

  it('exports text with timestamps and speaker changes only', () => {
    expect(transcriptToText({ sentences })).toBe(
      '[0:01] A: Welcome to the show.\n[0:05] B: The collage took four hundred hours. Collage again.\n[0:10] Thanks.',
    );
    expect(transcriptToText({ sentences }, false).split('\n')[0]).toBe('A: Welcome to the show.');
  });

  it('exports notes as markdown with timestamps', () => {
    const a: VideoAnalysis = {
      overview: { summary: 'S', tone: 't', participants: [], takeaways: ['one', 'two'] },
      chapters: [],
      notes: {
        keyPoints: ['k'],
        quotes: [{ text: 'q', at: 65 }],
        numbers: [],
        claims: [],
        actionItems: ['do it'],
      },
      topics: [],
      entities: [],
      keywords: [],
    };
    const md = notesToMarkdown('Title', a);
    expect(md).toContain('# Title');
    expect(md).toContain('## Summary\nS');
    expect(md).toContain('- [1:05] q');
    expect(md).toContain('## Action items\n- do it');
    expect(md).not.toContain('## Numbers');
  });
});
