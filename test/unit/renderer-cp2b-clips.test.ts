import { describe, expect, it } from 'vitest';
import type { ClipView } from '../../shared/pipeline';
import type { ClipThumbnails, MomentRun, PlatformMeta } from '../../shared/cp2';
import {
  PLATFORM_SPECS,
  addHashtags,
  bestCandidateIndex,
  captionLength,
  captionsOutdated,
  cleanOverlay,
  counterTone,
  countWords,
  expectedLayout,
  formatCopyAll,
  formatHour,
  formatPostingTime,
  layoutFallbackNote,
  matchesRunFilter,
  metaEqual,
  metaIssues,
  normalizeHashtag,
  overlayError,
  runStatusLabel,
  steerOptions,
  upsertRun,
} from '../../renderer/lib/cp2-clips';

const meta = (p: Partial<PlatformMeta> = {}): PlatformMeta => ({
  title: 'A title',
  description: 'A description.',
  hashtags: ['#one', '#two'],
  postingTime: { dayOfWeek: 2, hour: 19, reason: 'Evenings.' },
  ...p,
});

describe('hashtags', () => {
  it('normalises user input', () => {
    expect(normalizeHashtag('  #Brand New! ')).toBe('#BrandNew');
    expect(normalizeHashtag('##ai_tips')).toBe('#ai_tips');
    expect(normalizeHashtag('über')).toBe('#über');
    expect(normalizeHashtag('!!!')).toBeNull();
    expect(normalizeHashtag('')).toBeNull();
  });
  it('adds several at once, de-duplicating case-insensitively', () => {
    expect(addHashtags(['#one'], 'Two, #ONE three  four')).toEqual([
      '#one',
      '#Two',
      '#three',
      '#four',
    ]);
    expect(addHashtags([], ' , ,')).toEqual([]);
  });
});

describe('platform limits', () => {
  it('has the documented limits', () => {
    expect(PLATFORM_SPECS.tiktok.captionMax).toBe(2200);
    expect(PLATFORM_SPECS.reels.captionMax).toBe(2200);
    expect(PLATFORM_SPECS.reels.hashtagMax).toBe(30);
    expect(PLATFORM_SPECS.shorts.titleMax).toBe(100);
  });
  it('counter tone: ok < 90 % <= warn <= max < over', () => {
    expect(counterTone(89, 100)).toBe('ok');
    expect(counterTone(90, 100)).toBe('warn');
    expect(counterTone(100, 100)).toBe('warn');
    expect(counterTone(101, 100)).toBe('over');
    expect(counterTone(5000, null)).toBe('ok');
  });
  it('counts the caption the way the platform does', () => {
    const m = meta();
    expect(captionLength('tiktok', m)).toBe('A title\n\nA description.\n\n#one #two'.length);
    expect(captionLength('shorts', m)).toBe('A description.\n\n#one #two'.length); // title is a separate field
  });
  it('reports over-limit and spam warnings', () => {
    expect(metaIssues('shorts', meta({ title: 'x'.repeat(101) }))[0]).toMatchObject({
      field: 'title',
      level: 'error',
    });
    expect(
      metaIssues('reels', meta({ hashtags: Array.from({ length: 31 }, (_, i) => `#t${i}`) })),
    ).toEqual([expect.objectContaining({ field: 'hashtags', level: 'error' })]);
    expect(metaIssues('tiktok', meta({ description: 'x'.repeat(2200) }))[0]).toMatchObject({
      field: 'caption',
      level: 'error',
    });
    expect(
      metaIssues('shorts', meta({ hashtags: Array.from({ length: 16 }, (_, i) => `#t${i}`) }))[0],
    ).toMatchObject({
      level: 'warning',
    });
    expect(metaIssues('tiktok', meta())).toEqual([]);
  });
  it('metaEqual is structural', () => {
    expect(metaEqual(meta(), meta())).toBe(true);
    expect(metaEqual(meta(), meta({ hashtags: ['#one'] }))).toBe(false);
    expect(
      metaEqual(meta(), meta({ postingTime: { dayOfWeek: null, hour: 19, reason: 'Evenings.' } })),
    ).toBe(false);
  });
});

describe('copy all + posting time', () => {
  it('TikTok / Reels: one paste-ready caption', () => {
    expect(formatCopyAll('tiktok', meta())).toBe('A title\n\nA description.\n\n#one #two');
    expect(formatCopyAll('reels', meta({ hashtags: [] }))).toBe('A title\n\nA description.');
  });
  it('Shorts: labelled title and description', () => {
    expect(formatCopyAll('shorts', meta())).toBe(
      'Title: A title\n\nDescription:\nA description.\n\n#one #two',
    );
  });
  it('formats hours and days', () => {
    expect(formatHour(0)).toBe('12:00 AM');
    expect(formatHour(12)).toBe('12:00 PM');
    expect(formatHour(19)).toBe('7:00 PM');
    expect(formatPostingTime({ dayOfWeek: 2, hour: 19, reason: '' })).toBe('Tuesday, 7:00 PM');
    expect(formatPostingTime({ dayOfWeek: null, hour: 9, reason: '' })).toBe('Any day, 9:00 AM');
  });
});

describe('thumbnail helpers', () => {
  const thumbs = (c: { rank: number | null; total: number }[]): ClipThumbnails => ({
    chosenT: null,
    overlayText: null,
    generatedAt: 0,
    candidates: c.map((x, i) => ({
      t: i,
      key: `k${i}`,
      scores: { sharpness: 0, face: 0, composition: 0, total: x.total },
      llmRank: x.rank,
      llmNote: null,
    })),
  });
  it('prefers the vision model rank, then the score', () => {
    expect(bestCandidateIndex(thumbs([]))).toBe(-1);
    expect(
      bestCandidateIndex(
        thumbs([
          { rank: null, total: 0.9 },
          { rank: 2, total: 0.1 },
          { rank: 1, total: 0.2 },
        ]),
      ),
    ).toBe(2);
    expect(
      bestCandidateIndex(
        thumbs([
          { rank: null, total: 0.2 },
          { rank: null, total: 0.7 },
        ]),
      ),
    ).toBe(1);
  });
  it('limits overlay text to five words', () => {
    expect(countWords('  one  two three ')).toBe(3);
    expect(overlayError('one two three four five')).toBeNull();
    expect(overlayError('one two three four five six')).toMatch(/5 words or fewer \(6 now\)/);
    expect(overlayError('x'.repeat(61))).toMatch(/60 characters/);
    expect(cleanOverlay('  Why   we said  no ')).toBe('Why we said no');
    expect(cleanOverlay('   ')).toBeNull();
  });
});

describe('reframe', () => {
  const clip = (reframeMode: ClipView['reframeMode'], layout: ClipView['layout']) => ({
    reframeMode,
    layout,
  });
  it('maps modes to layouts', () => {
    expect(expectedLayout('multi-face')).toBe('split');
    expect(expectedLayout('screen-face')).toBe('screen-face');
    expect(expectedLayout('center')).toBe('single');
    expect(expectedLayout('auto')).toBeNull();
  });
  it('explains a fallback honestly and stays quiet otherwise', () => {
    expect(layoutFallbackNote(clip('multi-face', 'single'))).toMatch(
      /asked for “Split screen”.*single crop/,
    );
    expect(layoutFallbackNote(clip('multi-face', 'split'))).toBeNull();
    expect(layoutFallbackNote(clip('auto', 'split'))).toBeNull();
    expect(layoutFallbackNote(clip('multi-face', null))).toBeNull();
  });
  it('captions are outdated only when the clip predates the edits', () => {
    expect(captionsOutdated({ subtitleRev: 1 }, 2)).toBe(true);
    expect(captionsOutdated({ subtitleRev: 2 }, 2)).toBe(false);
    expect(captionsOutdated({ subtitleRev: 0 }, undefined)).toBe(false);
  });
});

describe('steering', () => {
  const run = (p: Partial<MomentRun>): MomentRun => ({
    id: 'r',
    videoId: 'v',
    prompt: 'p',
    status: 'running',
    found: 0,
    error: null,
    createdAt: 1,
    finishedAt: null,
    ...p,
  });
  it('only sends options the user changed', () => {
    expect(steerOptions('default', 'default')).toBeUndefined();
    expect(steerOptions('60-90', 'default')).toEqual({ clipPreset: '60-90' });
    expect(steerOptions('default', '5')).toEqual({ clipCount: 5 });
    expect(steerOptions('15-30', '12')).toEqual({ clipPreset: '15-30', clipCount: 12 });
  });
  it('labels statuses', () => {
    expect(runStatusLabel(run({}))).toBe('Searching the transcript…');
    expect(runStatusLabel(run({ found: 2 }))).toBe('Searching… 2 found so far');
    expect(runStatusLabel(run({ status: 'done', found: 1 }))).toBe('1 new clip');
    expect(runStatusLabel(run({ status: 'done', found: 3 }))).toBe('3 new clips');
    expect(runStatusLabel(run({ status: 'done', found: 0 }))).toMatch(/no new moments/);
    expect(runStatusLabel(run({ status: 'canceled', found: 2 }))).toBe('Canceled · kept 2');
    expect(runStatusLabel(run({ status: 'failed' }))).toBe('Failed');
  });
  it('upserts runs newest first', () => {
    const a = run({ id: 'a', createdAt: 1 });
    const b = run({ id: 'b', createdAt: 2 });
    expect(upsertRun([a], b).map((r) => r.id)).toEqual(['b', 'a']);
    expect(upsertRun([b, a], { ...a, found: 5 }).find((r) => r.id === 'a')?.found).toBe(5);
  });
  it('run filter', () => {
    expect(matchesRunFilter({ runId: 'x' }, null)).toBe(true);
    expect(matchesRunFilter({ runId: null }, 'auto')).toBe(true);
    expect(matchesRunFilter({ runId: 'x' }, 'auto')).toBe(false);
    expect(matchesRunFilter({ runId: 'x' }, 'x')).toBe(true);
    expect(matchesRunFilter({ runId: 'y' }, 'x')).toBe(false);
  });
});
