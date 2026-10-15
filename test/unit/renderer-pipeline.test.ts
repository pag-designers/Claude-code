import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { ClipView, PipelineEvent, StageState, VideoView } from '../../shared/pipeline';
import { pipelineOptionsSchema } from '../../shared/pipeline';
import {
  applyEventToStages,
  classifyFailure,
  currentStage,
  failureSummary,
  mergeStages,
  overallProgress,
  stagesFromVideo,
} from '../../renderer/lib/pipeline-ui';
import {
  applyPipelineEvent,
  clipMatchesListFilter,
  patchClipsInCache,
  removeByIds,
  removeClipsFromCache,
  removeVideoFromCache,
  upsertById,
  upsertClipInCache,
  upsertVideoInCache,
} from '../../renderer/lib/pipeline-cache';
import { usePipelineLog } from '../../renderer/lib/pipeline-log';
import { normalizeHref, videoHref } from '../../renderer/lib/hrefs';
import {
  buildStartOptions,
  customRangeError,
  formFromSettings,
} from '../../renderer/lib/start-options';
import { DEFAULT_SETTINGS } from '../../shared/settings';
import { formatClock, formatSpan, formatUploadDate } from '../../renderer/lib/format';

const now = 1_760_000_000_000;
const stage = (s: Partial<StageState> & Pick<StageState, 'stage'>): StageState => ({
  status: 'pending',
  progress: null,
  message: null,
  startedAt: null,
  finishedAt: null,
  error: null,
  detail: null,
  ...s,
});
const video = (p: Partial<VideoView> = {}): VideoView => ({
  id: 'v1',
  sourceUrl: 'https://youtu.be/aaaaaaaaaaa',
  sourceId: 'aaaaaaaaaaa',
  title: 'T',
  channel: null,
  durationSec: 100,
  thumbnail: null,
  status: 'processing',
  stage: 'transcribe',
  progress: 0.4,
  error: null,
  favorite: false,
  clipCount: 0,
  renderedCount: 0,
  topScore: null,
  createdAt: now,
  updatedAt: now,
  hasProxy: false,
  options: pipelineOptionsSchema.parse({}),
  subtitleRev: 0,
  ...p,
});
const clip = (p: Partial<ClipView> = {}): ClipView => ({
  id: 'c1',
  videoId: 'v1',
  videoTitle: 'T',
  title: 'Clip',
  hook: null,
  startSec: 0,
  endSec: 30,
  durationSec: 30,
  score: 80,
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
  rank: 1,
  createdAt: now,
  kind: 'clip',
  runId: null,
  runPrompt: null,
  captionStyleId: 'clean-pop',
  reframeMode: 'auto',
  layout: null,
  hookApplied: null,
  hasHooks: false,
  hasMeta: false,
  hasThumbOptions: false,
  subtitleRev: 0,
  brandKitId: null,
  brandApplied: null,
  ...p,
});
const ev = (
  p: Partial<PipelineEvent> & Pick<PipelineEvent, 'stage' | 'status'>,
): PipelineEvent => ({
  videoId: 'v1',
  progress: null,
  message: null,
  detail: null,
  at: now,
  ...p,
});

describe('stages', () => {
  it('mergeStages always yields the 7 stages in pipeline order, filling pending', () => {
    const m = mergeStages([stage({ stage: 'transcribe', status: 'running', progress: 0.2 })]);
    expect(m.map((s) => s.stage)).toEqual([
      'ingest',
      'prepare',
      'transcribe',
      'understand',
      'moments',
      'render',
      'finalize',
    ]);
    expect(m.map((s) => s.status)).toEqual([
      'pending',
      'pending',
      'running',
      'pending',
      'pending',
      'pending',
      'pending',
    ]);
    expect(mergeStages(undefined)).toHaveLength(7);
  });

  it('stagesFromVideo derives chips from a list row', () => {
    const s = stagesFromVideo(video());
    expect(s.map((x) => x.status)).toEqual([
      'done',
      'done',
      'running',
      'pending',
      'pending',
      'pending',
      'pending',
    ]);
    expect(s[2]?.progress).toBe(0.4);
    expect(stagesFromVideo(video({ status: 'failed', error: 'x' }))[2]).toMatchObject({
      status: 'failed',
      error: 'x',
    });
    expect(
      stagesFromVideo(video({ status: 'ready', stage: null })).every((x) => x.status === 'done'),
    ).toBe(true);
    expect(stagesFromVideo(video({ status: 'canceled' }))[2]?.status).toBe('canceled');
  });

  it('overallProgress is weighted and monotonic', () => {
    expect(overallProgress([])).toBe(0);
    const a = overallProgress([stage({ stage: 'ingest', status: 'done' })]);
    const b = overallProgress([
      stage({ stage: 'ingest', status: 'done' }),
      stage({ stage: 'prepare', status: 'running', progress: 0.5 }),
    ]);
    expect(b).toBeGreaterThan(a);
    expect(
      overallProgress(mergeStages(stagesFromVideo(video({ status: 'ready', stage: null })))),
    ).toBeCloseTo(1, 5);
  });

  it('applyEventToStages updates the reported stage and closes earlier open ones', () => {
    let st: StageState[] = mergeStages([
      stage({ stage: 'ingest', status: 'running', progress: 0.9 }),
    ]);
    st = applyEventToStages(
      st,
      ev({ stage: 'prepare', status: 'running', message: 'Extracting', at: now + 1 }),
    );
    expect(st[0]).toMatchObject({ status: 'done', progress: 1 });
    expect(st[1]).toMatchObject({ status: 'running', message: 'Extracting', startedAt: now + 1 });
    st = applyEventToStages(
      st,
      ev({ stage: 'prepare', status: 'failed', message: 'boom', at: now + 2 }),
    );
    expect(st[1]).toMatchObject({ status: 'failed', error: 'boom', finishedAt: now + 2 });
    // a later failure also closes a stage that never got its "done" event
    const open = applyEventToStages(
      mergeStages([stage({ stage: 'prepare', status: 'running' })]),
      ev({ stage: 'transcribe', status: 'failed', message: 'x' }),
    );
    expect(open[1]?.status).toBe('done');
    expect(currentStage(st)?.stage).toBe('prepare');
  });
});

describe('failure classification', () => {
  const botText =
    'ERROR: [youtube] Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.';
  it.each([
    [botText, 'bot-check', '/settings/ingest/'],
    [
      'ERROR: [youtube] AgeLimit001: Sign in to confirm your age. This video may be inappropriate for some users.',
      'age',
      '/settings/ingest/',
    ],
    [
      'ERROR: [youtube] x: Private video. Sign in if you’ve been granted access',
      'private',
      '/settings/ingest/',
    ],
    ['Video unavailable. This video has been removed by the uploader', 'unavailable', undefined],
    ['Monthly hard cap reached ($70)', 'budget', '/settings/models/'],
    ['401 invalid x-api-key', 'anthropic', '/settings/api-keys/'],
    ['AccessDenied: bucket policy', 'storage', '/settings/storage/'],
    ['Transcription engine stopped unexpectedly (exit code 137)', 'engine', '/settings/compute/'],
    ['getaddrinfo ENOTFOUND r2.example', 'network', undefined],
    ['something odd', 'other', undefined],
  ])('%s → %s', (msg, kind, href) => {
    const r = classifyFailure(msg);
    expect(r.kind).toBe(kind);
    expect(r.action?.href).toBe(href);
  });

  it('age is not mistaken for a bot check and a hex id is not mistaken for a bucket', () => {
    expect(classifyFailure('Sign in to confirm your age').kind).toBe('age');
    expect(classifyFailure('failed at frame 0xb2f9 of segment').kind).toBe('other');
  });

  it('failureSummary prefers the friendly title and strips yt-dlp prefixes otherwise', () => {
    expect(failureSummary('ERROR: [youtube] x: Sign in to confirm you’re not a bot.')).toMatch(
      /not a bot/,
    );
    expect(failureSummary('ERROR: [youtube] abc: weird failure\nmore')).toBe('abc: weird failure');
    expect(failureSummary(null)).toBe('The run failed');
  });
});

describe('cache glue (events patch cached lists in place)', () => {
  const list = (qc: QueryClient, key: unknown[]) =>
    qc.getQueryData<{ items: { id: string }[] }>(key)?.items.map((x) => x.id);

  it('upsert / remove helpers keep identity when nothing changes', () => {
    const a = [{ id: '1' }, { id: '2' }];
    expect(upsertById(a, { id: '3' }).map((x) => x.id)).toEqual(['3', '1', '2']);
    expect(upsertById(a, { id: '2' })).toHaveLength(2);
    expect(removeByIds(a, ['1']).map((x) => x.id)).toEqual(['2']);
  });

  it('clipMatchesListFilter mirrors clips:list filters', () => {
    expect(clipMatchesListFilter(clip(), undefined)).toBe(true);
    expect(clipMatchesListFilter(clip({ videoId: 'v2' }), { videoId: 'v1' })).toBe(false);
    expect(clipMatchesListFilter(clip({ favorite: false }), { favorite: true })).toBe(false);
    expect(clipMatchesListFilter(clip({ score: 40 }), { minScore: 60 })).toBe(false);
    expect(clipMatchesListFilter(clip({ score: null }), { minScore: 1 })).toBe(false);
  });

  it('clips:updated lands in the all-list and the matching per-video list only', () => {
    const qc = new QueryClient();
    qc.setQueryData(['clips:list', { limit: 1000 }], { items: [clip({ id: 'a' })] });
    qc.setQueryData(['clips:list', { videoId: 'v1', limit: 500 }], { items: [clip({ id: 'a' })] });
    qc.setQueryData(['clips:list', { videoId: 'v2', limit: 500 }], { items: [] });
    qc.setQueryData(['clips:list', { favorite: true, limit: 500 }], { items: [] });
    upsertClipInCache(qc, clip({ id: 'b', favorite: true }));
    expect(list(qc, ['clips:list', { limit: 1000 }])).toEqual(['b', 'a']);
    expect(list(qc, ['clips:list', { videoId: 'v1', limit: 500 }])).toEqual(['b', 'a']);
    expect(list(qc, ['clips:list', { videoId: 'v2', limit: 500 }])).toEqual([]);
    expect(list(qc, ['clips:list', { favorite: true, limit: 500 }])).toEqual(['b']);
    // un-favoriting removes it from the favorites query
    patchClipsInCache(qc, ['b'], { favorite: false });
    expect(list(qc, ['clips:list', { favorite: true, limit: 500 }])).toEqual([]);
    expect(
      qc.getQueryData<{ items: ClipView[] }>(['clips:list', { limit: 1000 }])?.items[0]?.favorite,
    ).toBe(false);
    removeClipsFromCache(qc, ['a']);
    expect(list(qc, ['clips:list', { limit: 1000 }])).toEqual(['b']);
  });

  it('videos:updated patches list rows and the open detail; delete clears everything', () => {
    const qc = new QueryClient();
    qc.setQueryData(['videos:list', { limit: 500 }], { items: [video({ id: 'v1' })] });
    qc.setQueryData(['videos:get', { id: 'v1' }], {
      video: video({ id: 'v1' }),
      analysis: null,
      stages: [],
    });
    upsertVideoInCache(qc, video({ id: 'v1', status: 'ready', clipCount: 4 }));
    upsertVideoInCache(qc, video({ id: 'v9' }));
    expect(list(qc, ['videos:list', { limit: 500 }])).toEqual(['v9', 'v1']);
    expect(
      qc.getQueryData<{ video: VideoView }>(['videos:get', { id: 'v1' }])?.video.clipCount,
    ).toBe(4);
    qc.setQueryData(['clips:list', { limit: 1000 }], {
      items: [clip({ videoId: 'v1' }), clip({ id: 'z', videoId: 'v9' })],
    });
    removeVideoFromCache(qc, 'v1');
    expect(list(qc, ['videos:list', { limit: 500 }])).toEqual(['v9']);
    expect(list(qc, ['clips:list', { limit: 1000 }])).toEqual(['z']);
    expect(qc.getQueryData(['videos:get', { id: 'v1' }])).toBeUndefined();
  });

  it('pipeline:event moves list rows and stage lists without a refetch, and records the log', () => {
    const qc = new QueryClient();
    qc.setQueryData(['videos:list', { limit: 500 }], {
      items: [video({ id: 'v1', status: 'ingesting', stage: 'ingest', progress: 0.1 })],
    });
    qc.setQueryData(['videos:get', { id: 'v1' }], {
      video: video({ id: 'v1', status: 'ingesting', stage: 'ingest', progress: 0.1 }),
      analysis: null,
      stages: [stage({ stage: 'ingest', status: 'running', progress: 0.1 })],
    });
    usePipelineLog.getState().clear('v1');
    applyPipelineEvent(
      qc,
      ev({ stage: 'prepare', status: 'running', progress: null, message: 'Extracting audio' }),
    );
    const row = qc.getQueryData<{ items: VideoView[] }>(['videos:list', { limit: 500 }])?.items[0];
    expect(row).toMatchObject({ status: 'processing', stage: 'prepare', progress: null });
    const d = qc.getQueryData<{ stages: StageState[] }>(['videos:get', { id: 'v1' }]);
    expect(d?.stages.find((s) => s.stage === 'ingest')?.status).toBe('done');
    expect(d?.stages.find((s) => s.stage === 'prepare')?.message).toBe('Extracting audio');
    applyPipelineEvent(qc, ev({ stage: 'prepare', status: 'failed', message: 'ffmpeg missing' }));
    expect(
      qc.getQueryData<{ items: VideoView[] }>(['videos:list', { limit: 500 }])?.items[0],
    ).toMatchObject({ status: 'failed', error: 'ffmpeg missing' });
    const log = usePipelineLog.getState().byVideo['v1'] ?? [];
    expect(log.map((e) => e.status)).toEqual(['running', 'failed']);
    // identical consecutive events are not logged twice
    applyPipelineEvent(qc, ev({ stage: 'prepare', status: 'failed', message: 'ffmpeg missing' }));
    expect(usePipelineLog.getState().byVideo['v1']).toHaveLength(2);
  });
});

describe('hrefs', () => {
  it('normalises deep links to the exported route shape', () => {
    expect(normalizeHref('/library/video?id=abc')).toBe('/library/video/?id=abc');
    expect(normalizeHref('/library/video/?id=abc&tab=clips')).toBe(
      '/library/video/?id=abc&tab=clips',
    );
    expect(normalizeHref('/library')).toBe('/library/');
    expect(normalizeHref('/settings?section=storage')).toBe('/settings/storage/');
    expect(normalizeHref('/settings/storage/#cache')).toBe('/settings/storage/#cache');
    expect(normalizeHref('https://example.com/x')).toBe('https://example.com/x');
    expect(videoHref('a b', 'clips')).toBe('/library/video/?id=a+b&tab=clips');
  });
});

describe('start options', () => {
  it('derives the form from settings defaults and always sends every option', () => {
    const f = formFromSettings({
      ...DEFAULT_SETTINGS,
      defaultClipPreset: '60-90',
      defaultClipCount: 7,
      defaultAspect: '1:1',
    });
    expect(f).toMatchObject({
      clipPreset: '60-90',
      clipCount: 7,
      aspect: '1:1',
      captions: true,
      hookCard: true,
    });
    const o = buildStartOptions({ ...f, prompt: '  funny moments  ' }, 720);
    expect(o).toEqual({
      clipPreset: '60-90',
      clipCount: 7,
      minScore: 60,
      aspect: '1:1',
      brandKitId: 'default',
      captions: true,
      hookCard: true,
      prompt: 'funny moments',
      language: null,
      maxResolution: 720,
      mode: 'clips',
      captionStyleId: 'clean-pop',
      reframeMode: 'auto',
    });
    // it must satisfy the real contract schema
    expect(pipelineOptionsSchema.parse(o).clipCount).toBe(7);
  });

  it('custom range and score mode', () => {
    const f = {
      ...formFromSettings(DEFAULT_SETTINGS),
      clipPreset: 'custom' as const,
      minSec: 25.4,
      maxSec: 70.2,
      countMode: 'score' as const,
      minScore: 80,
    };
    expect(buildStartOptions(f, 1080)).toMatchObject({
      clipPreset: 'custom',
      minSec: 25,
      maxSec: 70,
      clipCount: null,
      minScore: 80,
    });
    expect(customRangeError(f)).toBeNull();
    expect(customRangeError({ ...f, minSec: 3 })).toMatch(/5 seconds/);
    expect(customRangeError({ ...f, maxSec: 30 })).toMatch(/at least 5 seconds above min/);
    expect(customRangeError({ ...f, maxSec: 999 })).toMatch(/300/);
    expect(customRangeError({ ...f, minSec: NaN })).toMatch(/both lengths/);
    expect(customRangeError({ ...f, clipPreset: '30-60', minSec: 1 })).toBeNull();
  });
});

describe('time formatting', () => {
  it('formatClock / formatSpan / formatUploadDate', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(75.9)).toBe('1:15');
    expect(formatClock(3725)).toBe('1:02:05');
    expect(formatClock(-4)).toBe('0:00');
    expect(formatSpan(42)).toBe('42s');
    expect(formatSpan(65)).toBe('1m 05s');
    expect(formatSpan(3720)).toBe('1h 02m');
    expect(formatUploadDate('20250412')).toBe('Apr 12, 2025');
    expect(formatUploadDate('2025-04-12')).toBe('Apr 12, 2025');
    expect(formatUploadDate('nonsense')).toBeNull();
    expect(formatUploadDate(null)).toBeNull();
  });
});
