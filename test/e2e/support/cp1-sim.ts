/**
 * TEST-ONLY simulation of main's CP1 behaviour: seeded library, URL probing (incl. bot-check / private / live),
 * `pipeline:start` with a scripted, step-by-step run (idle -> stages -> clips appearing -> done), a failure + retry
 * path, cancel, favorites, deletes, presigned-URL stand-ins. Every response and every pushed event is validated by
 * the REAL zod contract in the stub, so this file cannot drift from shared/ipc.ts.
 *
 * Runs are driven by the test (`sim.step()`), so timing is deterministic. `autoplayMs` makes them run on a timer
 * for screenshots/demos.
 */
import { encodeIpcError } from '../../../shared/ipc';
import { PIPELINE_STAGES, parseYouTubeId } from '../../../shared/pipeline';
import type {
  ClipView,
  PipelineEvent,
  PipelineStage,
  StageState,
  Transcript,
  UrlInfo,
  VideoAnalysis,
  VideoView,
} from '../../../shared/pipeline';
import type { EventChannel, EventPayload } from '../../../shared/ipc';
import type { AppNotification } from '../../../shared/domain';
import { CLIP_THUMBS, CLIP_RENDERS, PROXY_FILE, VIDEO_THUMBS } from './cp1-fixtures';
import {
  CLIP_TEMPLATES,
  INTERVIEW,
  buildLongLines,
  buildTranscript,
  clipFromTemplate,
  doneStages,
  interviewAnalysis,
  videoView,
  BASE_OPTIONS,
  type ClipTemplate,
} from './cp1-data';

export type Emit = <E extends EventChannel>(event: E, payload: EventPayload<E>) => Promise<void>;

export interface Sim {
  videoId: string;
  /** Index of the next step to run. */
  cursor: number;
  steps: (() => Promise<void>)[];
  canceled: boolean;
  /** Runs the next scripted step; resolves false when the script is finished. */
  step: () => Promise<boolean>;
  /** Runs `n` steps (or all remaining when omitted). */
  run: (n?: number) => Promise<void>;
  remaining: () => number;
}

export interface Cp1State {
  assetBase: string;
  videos: VideoView[];
  clips: ClipView[];
  analyses: Record<string, VideoAnalysis>;
  transcripts: Record<string, Transcript>;
  stages: Record<string, StageState[]>;
  clipAssets: Record<string, { thumb: string; render: string }>;
  costSpent: number;
  sims: Record<string, Sim>;
  /** stage at which a run of the given YouTube id fails ONCE (a retry then succeeds). */
  failPlans: Record<string, { stage: PipelineStage; error: string; fired: boolean }>;
  autoplayMs: number | null;
  /** Recorded side effects for assertions. */
  log: {
    started: { url: string; options: unknown }[];
    deleted: { id: string; deleteFromStorage: boolean }[];
    deletedClips: string[][];
    downloads: string[][];
    retries: { videoId: string; stage: string }[];
    cancels: string[];
    external: string[];
  };
  emit?: Emit;
  /** Adds to the notification list AND pushes `notifications:new` (what main's notify() does). */
  notify?: (n: AppNotification) => Promise<void>;
  counter: number;
}

export const BOT_TEXT =
  'ERROR: [youtube] Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.';

const HOUR = 3_600_000;
const MIN = 60_000;

export function emptyCp1State(assetBase: string): Cp1State {
  return {
    assetBase,
    videos: [],
    clips: [],
    analyses: {},
    transcripts: {},
    stages: {},
    clipAssets: {},
    costSpent: 0,
    sims: {},
    failPlans: {},
    autoplayMs: null,
    log: {
      started: [],
      deleted: [],
      deletedClips: [],
      downloads: [],
      retries: [],
      cancels: [],
      external: [],
    },
    counter: 0,
  };
}

const asset = (s: Cp1State, f: string) => `${s.assetBase}/__assets/${f}`;
const thumbOf = (i: number) => VIDEO_THUMBS[i % VIDEO_THUMBS.length]!;

/* ------------------------------------------------------- seeding -------------------------------------------------- */

const PODCAST_CLIPS: Pick<ClipTemplate, 'title' | 'hook' | 'why' | 'breakdown' | 'confidence'>[] = [
  {
    title: 'Why we turned down our Series A',
    hook: 'Honestly, we said no to the money and nobody clapped for it.',
    why: 'Counter-intuitive claim in the first sentence, a clear stake, and a candid explanation.',
    breakdown: { hook: 23, retention: 21, emotion: 16, clarity: 13, shareability: 14 },
    confidence: 0.9,
  },
  {
    title: 'The first ten customers decide everything',
    hook: 'Look, the first ten conversations matter more than any roadmap.',
    why: 'Strong aphorism with a practical takeaway founders will share.',
    breakdown: { hook: 20, retention: 19, emotion: 12, clarity: 14, shareability: 13 },
    confidence: 0.84,
  },
  {
    title: 'A calm week of shipping beats a loud launch',
    hook: 'Here’s what nobody tells you: calm weeks compound.',
    why: 'Contrarian framing; moderate retention because the example arrives late.',
    breakdown: { hook: 17, retention: 15, emotion: 10, clarity: 12, shareability: 11 },
    confidence: 0.75,
  },
  {
    title: 'Pricing is a statement about who you serve',
    hook: 'Pricing is always a statement.',
    why: 'Short, quotable, and easy to understand without context.',
    breakdown: { hook: 15, retention: 13, emotion: 9, clarity: 13, shareability: 10 },
    confidence: 0.72,
  },
  {
    title: 'What we would do with one more year of runway',
    hook: 'If I had one more year, I’d do less.',
    why: 'Honest reflection; weaker visual interest.',
    breakdown: { hook: 11, retention: 12, emotion: 8, clarity: 12, shareability: 8 },
    confidence: 0.64,
  },
];

export function seedLibrary(state: Cp1State, now = Date.now()): void {
  const s = state;
  // ---- v1: the interview, fully processed -------------------------------------------------------------------------
  const tr1 = buildTranscript(INTERVIEW, 176);
  const v1Title = 'Community Conversations: Autism Awareness & Local Art';
  const v1 = videoView({
    id: 'vid-interview',
    sourceId: 'Ab3dEf9GhIj',
    sourceUrl: 'https://www.youtube.com/watch?v=Ab3dEf9GhIj',
    title: v1Title,
    channel: 'Riverside Community TV',
    durationSec: 180,
    thumbnail: asset(s, thumbOf(0)),
    status: 'ready',
    favorite: true,
    createdAt: now - 3 * HOUR,
    updatedAt: now - 2.8 * HOUR,
    hasProxy: true,
  });
  s.transcripts[v1.id] = tr1;
  s.analyses[v1.id] = interviewAnalysis(tr1);
  s.stages[v1.id] = doneStages(now - 3 * HOUR);
  const c1 = CLIP_TEMPLATES.map((tpl, i) => {
    const id = `${v1.id}-c${i + 1}`;
    s.clipAssets[id] = { thumb: tpl.thumb, render: tpl.render };
    const failed = i === 8;
    const clip = clipFromTemplate(tpl, tr1, {
      id,
      videoId: v1.id,
      videoTitle: v1Title,
      createdAt: now - 3 * HOUR + (i + 1) * 90_000,
      rank: i + 1,
      status: failed ? 'failed' : 'rendered',
      favorite: i === 0 || i === 3,
      error: failed
        ? 'ffmpeg exited with code 1 while burning captions (libass: font not found).'
        : null,
    });
    if (failed) {
      clip.hasRender = false;
      clip.hasThumb = true;
    }
    return clip;
  });
  s.clips.push(...c1);
  v1.clipCount = c1.length;
  v1.renderedCount = c1.filter((c) => c.status === 'rendered').length;
  v1.topScore = Math.max(...c1.map((c) => c.score ?? 0));

  // ---- v2: a long podcast (12k words, no proxy kept) ------------------------------------------------------------
  const tr2 = buildTranscript(buildLongLines(12_000), 4_320, { seed: 11 });
  const v2Title = 'The Slow Founder Podcast #84: Why we turned down our Series A';
  const v2 = videoView({
    id: 'vid-podcast',
    sourceId: 'Pd84SlowFnd',
    sourceUrl: 'https://www.youtube.com/watch?v=Pd84SlowFnd',
    title: v2Title,
    channel: 'The Slow Founder',
    durationSec: 4_320,
    thumbnail: asset(s, thumbOf(1)),
    status: 'ready',
    createdAt: now - 2 * 24 * HOUR,
    updatedAt: now - 2 * 24 * HOUR + 30 * MIN,
    hasProxy: false,
    options: { ...v1.options, clipPreset: '30-60', clipCount: 5 },
  });
  s.transcripts[v2.id] = tr2;
  s.analyses[v2.id] = {
    overview: {
      summary:
        'An unhurried founder conversation about why a small team chose to stay independent: the trade-offs of venture capital, how pricing signals who you serve, and why calm, compounding weeks of shipping beat loud launches.',
      tone: 'Candid, conversational',
      participants: ['Host', 'Co-founder'],
      takeaways: [
        'Saying no early protects your pricing.',
        'The first ten conversations beat any roadmap.',
        'Calm weeks compound.',
        'One honest metric is enough.',
        'Runway buys optionality, not speed.',
      ],
    },
    chapters: [
      {
        title: 'Why we said no',
        start: 0,
        end: 1200,
        summary: 'The decision and the board conversation.',
        source: 'ai',
      },
      {
        title: 'Pricing and trust',
        start: 1200,
        end: 2500,
        summary: 'What customers really pay for.',
        source: 'ai',
      },
      {
        title: 'Shipping calmly',
        start: 2500,
        end: 4320,
        summary: 'Cadence, support and focus.',
        source: 'ai',
      },
    ],
    notes: {
      keyPoints: ['Independence was a pricing decision.', 'Trust builds slowly and compounds.'],
      quotes: [],
      numbers: [],
      claims: [],
      actionItems: ['Write down the one metric you will not game.'],
    },
    topics: ['Bootstrapping', 'Pricing', 'Founder life'],
    entities: [],
    keywords: ['runway', 'pricing', 'trust'],
  };
  s.stages[v2.id] = doneStages(now - 2 * 24 * HOUR);
  const c2 = PODCAST_CLIPS.map((p, i) => {
    const id = `${v2.id}-c${i + 1}`;
    s.clipAssets[id] = {
      thumb: CLIP_THUMBS[(i + 3) % CLIP_THUMBS.length]!,
      render: CLIP_RENDERS[i % CLIP_RENDERS.length]!,
    };
    const from = 60 + i * 120;
    return clipFromTemplate({ ...p, from, to: from + 8, thumb: '', render: '' }, tr2, {
      id,
      videoId: v2.id,
      videoTitle: v2Title,
      createdAt: now - 2 * 24 * HOUR + (i + 1) * 120_000,
      rank: i + 1,
      favorite: false,
    });
  });
  s.clips.push(...c2);
  v2.clipCount = c2.length;
  v2.renderedCount = c2.length;
  v2.topScore = Math.max(...c2.map((c) => c.score ?? 0));

  // ---- v3: still processing (Find moments) ------------------------------------------------------------------------
  const v3Title = 'Why nobody finishes online courses (and what to do about it)';
  const v3 = videoView({
    id: 'vid-processing',
    sourceId: 'Crs24x7Abc1',
    sourceUrl: 'https://www.youtube.com/watch?v=Crs24x7Abc1',
    title: v3Title,
    channel: 'Learning Lab',
    durationSec: 1450,
    thumbnail: asset(s, thumbOf(2)),
    status: 'processing',
    stage: 'moments',
    progress: 0.55,
    createdAt: now - 6 * MIN,
    updatedAt: now - 5_000,
    hasProxy: true,
  });
  const started = now - 6 * MIN;
  s.stages[v3.id] = [
    {
      stage: 'ingest',
      status: 'done',
      progress: 1,
      message: 'Downloaded 1080p (388 MB)',
      startedAt: started,
      finishedAt: started + 62_000,
      error: null,
      detail: null,
    },
    {
      stage: 'prepare',
      status: 'done',
      progress: 1,
      message: 'Audio extracted · 480p proxy ready',
      startedAt: started + 62_000,
      finishedAt: started + 80_000,
      error: null,
      detail: null,
    },
    {
      stage: 'transcribe',
      status: 'done',
      progress: 1,
      message: 'Transcribed 3,902 words (EN)',
      startedAt: started + 80_000,
      finishedAt: started + 190_000,
      error: null,
      detail: null,
    },
    {
      stage: 'understand',
      status: 'done',
      progress: 1,
      message: 'Overview, 7 chapters and notes written',
      startedAt: started + 190_000,
      finishedAt: started + 230_000,
      error: null,
      detail: null,
    },
    {
      stage: 'moments',
      status: 'running',
      progress: 0.55,
      message: 'Ranking window 2 of 3',
      startedAt: started + 230_000,
      finishedAt: null,
      error: null,
      detail: '3 moments so far · Sonnet',
    },
  ];
  s.transcripts[v3.id] = tr1;
  s.analyses[v3.id] = interviewAnalysis(tr1);
  const live: [ClipTemplate, ClipView['status']][] = [
    [CLIP_TEMPLATES[1]!, 'rendering'],
    [CLIP_TEMPLATES[4]!, 'queued'],
    [CLIP_TEMPLATES[5]!, 'candidate'],
  ];
  const c3 = live.map(([tpl, status], i) => {
    const id = `${v3.id}-c${i + 1}`;
    s.clipAssets[id] = { thumb: tpl.thumb, render: tpl.render };
    return clipFromTemplate(tpl, tr1, {
      id,
      videoId: v3.id,
      videoTitle: v3Title,
      createdAt: now - 90_000 + i * 20_000,
      rank: i + 1,
      status,
    });
  });
  s.clips.push(...c3);
  v3.clipCount = c3.length;
  v3.topScore = Math.max(...c3.map((c) => c.score ?? 0));

  // ---- v4: failed at download (bot check) -------------------------------------------------------------------------
  const v4 = videoView({
    id: 'vid-failed',
    sourceId: 'BotAtIngest',
    sourceUrl: 'https://www.youtube.com/watch?v=BotAtIngest',
    title: 'Live Q&A: Product roadmap and what we are cutting',
    channel: 'Orbit Software',
    durationSec: 3_050,
    thumbnail: asset(s, thumbOf(3)),
    status: 'failed',
    stage: 'ingest',
    progress: null,
    error: BOT_TEXT,
    createdAt: now - 26 * HOUR,
    updatedAt: now - 20 * MIN,
  });
  s.stages[v4.id] = [
    {
      stage: 'ingest',
      status: 'failed',
      progress: null,
      message: null,
      startedAt: now - 26 * HOUR,
      finishedAt: now - 26 * HOUR + 4_000,
      error: BOT_TEXT,
      detail: null,
    },
  ];

  s.videos.push(v3, v1, v2, v4);
  s.costSpent = 12.84;
}

/* ------------------------------------------------------- probing -------------------------------------------------- */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fail = (msg: string, code: 'FAILED' | 'NOT_FOUND' = 'FAILED') =>
  new Error(encodeIpcError(code, msg));

export async function probe(state: Cp1State, url: string): Promise<UrlInfo> {
  await sleep(150);
  const id = parseYouTubeId(url);
  if (!id) throw fail('That is not a YouTube video link.');
  if (id === 'BotCheck001') throw fail(BOT_TEXT);
  if (id === 'Private0001')
    throw fail(
      'ERROR: [youtube] Private0001: Private video. Sign in if you’ve been granted access to this video.',
    );
  if (id === 'AgeLimit001')
    throw fail(
      'ERROR: [youtube] AgeLimit001: Sign in to confirm your age. This video may be inappropriate for some users.',
    );
  const base: UrlInfo = {
    id,
    title: 'Designing for Attention: A 15-Minute Talk',
    channel: 'Open Design Lab',
    durationSec: 912,
    thumbnail: asset(state, VIDEO_THUMBS[4]!),
    description: 'A short talk on designing interfaces that respect attention.',
    isLive: false,
    chapters: [
      { title: 'Intro', start: 0, end: 90 },
      { title: 'Attention is a budget', start: 90, end: 280 },
      { title: 'Three patterns', start: 280, end: 610 },
      { title: 'Case study', start: 610, end: 840 },
      { title: 'Wrap up', start: 840, end: 912 },
    ],
    uploadDate: '20250412',
    license: 'Creative Commons Attribution license (reuse allowed)',
  };
  if (id === 'LiveStream1')
    return {
      ...base,
      title: 'LIVE: Weekly community stream',
      isLive: true,
      durationSec: null,
      chapters: [],
      license: null,
    };
  if (id === 'StdLicense1')
    return {
      ...base,
      title: 'Why Most Startups Ignore Their Own Data',
      channel: 'Founder Notes',
      license: 'Standard YouTube License',
      chapters: [],
    };
  return base;
}

/* ------------------------------------------------- pipeline script ---------------------------------------------- */

const STAGE_START_STEP: Record<PipelineStage, number> = {
  ingest: 0,
  prepare: 2,
  transcribe: 3,
  understand: 5,
  moments: 6,
  render: 8,
  finalize: 10,
};

function patchStage(
  state: Cp1State,
  videoId: string,
  stage: PipelineStage,
  p: Partial<StageState>,
): StageState[] {
  const list = state.stages[videoId] ?? [];
  const at = list.findIndex((x) => x.stage === stage);
  const base: StageState =
    at >= 0
      ? list[at]!
      : {
          stage,
          status: 'pending',
          progress: null,
          message: null,
          startedAt: null,
          finishedAt: null,
          error: null,
          detail: null,
        };
  const next = { ...base, ...p };
  const out = at >= 0 ? list.map((x, i) => (i === at ? next : x)) : [...list, next];
  state.stages[videoId] = PIPELINE_STAGES.map((s) => out.find((x) => x.stage === s)).filter(
    (x): x is StageState => !!x,
  );
  return state.stages[videoId]!;
}

async function pushVideo(state: Cp1State, v: VideoView) {
  v.updatedAt = Date.now();
  await state.emit?.('videos:updated', { ...v });
}

async function pushClip(state: Cp1State, c: ClipView) {
  await state.emit?.('clips:updated', { ...c });
}

async function stageEvent(
  state: Cp1State,
  videoId: string,
  e: Omit<PipelineEvent, 'videoId' | 'at' | 'message' | 'detail'> & {
    message?: string | null;
    detail?: string | null;
  },
) {
  const full: PipelineEvent = { videoId, at: Date.now(), message: null, detail: null, ...e };
  patchStage(state, videoId, e.stage, {
    status: e.status,
    progress: e.progress,
    message: full.message,
    detail: full.detail,
    startedAt:
      state.stages[videoId]?.find((x) => x.stage === e.stage)?.startedAt ??
      (e.status === 'pending' ? null : full.at),
    finishedAt:
      e.status === 'done' || e.status === 'failed' || e.status === 'canceled' ? full.at : null,
    error: e.status === 'failed' ? (full.message ?? 'failed') : null,
  });
  await state.emit?.('pipeline:event', full);
}

function setVideo(state: Cp1State, id: string, p: Partial<VideoView>): VideoView {
  const v = state.videos.find((x) => x.id === id)!;
  Object.assign(v, p);
  return v;
}

function newClips(
  state: Cp1State,
  videoId: string,
  from: number,
  to: number,
  status: ClipView['status'],
): ClipView[] {
  const v = state.videos.find((x) => x.id === videoId)!;
  const tr = state.transcripts['__interview__']!;
  const out: ClipView[] = [];
  for (let i = from; i < to; i++) {
    const tpl = CLIP_TEMPLATES[i]!;
    const id = `${videoId}-c${i + 1}`;
    state.clipAssets[id] = { thumb: tpl.thumb, render: tpl.render };
    const c = clipFromTemplate(tpl, tr, {
      id,
      videoId,
      videoTitle: v.title,
      createdAt: Date.now(),
      rank: i + 1,
      status,
    });
    state.clips.push(c);
    out.push(c);
  }
  return out;
}

function refreshCounts(state: Cp1State, videoId: string) {
  const mine = state.clips.filter((c) => c.videoId === videoId);
  setVideo(state, videoId, {
    clipCount: mine.length,
    renderedCount: mine.filter((c) => c.status === 'rendered').length,
    topScore: mine.length ? Math.max(...mine.map((c) => c.score ?? 0)) : null,
  });
}

/** Scripted run for a new video. 12 steps; see the comments for what the UI should show after each. */
function buildSteps(state: Cp1State, videoId: string, ytId: string): (() => Promise<void>)[] {
  const plan = () => state.failPlans[ytId];
  const guard =
    (stage: PipelineStage, run: () => Promise<void>, pre?: () => Promise<void>) => async () => {
      await pre?.();
      const p = plan();
      if (p && !p.fired && p.stage === stage) {
        p.fired = true;
        const v = setVideo(state, videoId, {
          status: 'failed',
          stage,
          progress: null,
          error: p.error,
        });
        await stageEvent(state, videoId, {
          stage,
          status: 'failed',
          progress: null,
          message: p.error,
        });
        await pushVideo(state, v);
        throw new Error('__stopped__');
      }
      await run();
    };
  const running = async (
    stage: PipelineStage,
    progress: number | null,
    message: string | null,
    detail: string | null = null,
  ) => {
    const v = setVideo(state, videoId, {
      status: stage === 'ingest' ? 'ingesting' : 'processing',
      stage,
      progress,
      error: null,
    });
    await stageEvent(state, videoId, { stage, status: 'running', progress, message, detail });
    await pushVideo(state, v);
  };
  const done = async (stage: PipelineStage, message: string) => {
    await stageEvent(state, videoId, { stage, status: 'done', progress: 1, message });
  };
  if (state.videos.find((x) => x.id === videoId)?.options.mode === 'analysis') {
    // Analysis mode (CP2 tools): transcript + overview/chapters/notes only; no moments, no clips, no renders.
    return [
      guard('ingest', () => running('ingest', 0.15, 'Downloading 1080p', '4.1 MiB/s · 00:41 left')),
      guard('ingest', () => running('ingest', 0.72, 'Downloading 1080p', '5.0 MiB/s · 00:08 left')),
      async () => {
        await done('ingest', 'Downloaded 1080p (212 MB)');
        await running('prepare', null, 'Extracting audio and building the 480p proxy');
      },
      guard(
        'transcribe',
        () => running('transcribe', 0.3, 'large-v3-turbo · 11× realtime', 'ETA 01:20'),
        async () => {
          await done('prepare', 'Audio extracted · 480p proxy ready');
          await pushVideo(state, setVideo(state, videoId, { hasProxy: true }));
        },
      ),
      guard('transcribe', () =>
        running('transcribe', 0.85, 'large-v3-turbo · 11× realtime', 'ETA 00:14'),
      ),
      async () => {
        state.transcripts[videoId] = state.transcripts['__interview__']!;
        await done('transcribe', 'Transcribed 2,986 words (EN)');
        state.costSpent += 0.18;
        await running('understand', null, 'Claude is reading the transcript');
      },
      async () => {
        state.analyses[videoId] = state.analyses['__interview__']!;
        state.costSpent += 0.42;
        await done('understand', 'Overview, 6 chapters and notes written');
        await stageEvent(state, videoId, {
          stage: 'moments',
          status: 'skipped',
          progress: null,
          message: 'Analysis only: no clips requested',
        });
        await stageEvent(state, videoId, {
          stage: 'render',
          status: 'skipped',
          progress: null,
          message: 'Analysis only: no clips requested',
        });
        await running('finalize', null, 'Uploading the proxy to your bucket');
      },
      async () => {
        await done('finalize', 'Uploaded 3 files · cleaned up');
        const v = setVideo(state, videoId, {
          status: 'ready',
          stage: null,
          progress: null,
          error: null,
        });
        await pushVideo(state, v);
      },
    ];
  }
  return [
    // 0 download 15%
    guard('ingest', () => running('ingest', 0.15, 'Downloading 1080p', '4.1 MiB/s · 00:41 left')),
    // 1 download 72%
    guard('ingest', () => running('ingest', 0.72, 'Downloading 1080p', '5.0 MiB/s · 00:08 left')),
    // 2 prepare (indeterminate)
    async () => {
      await done('ingest', 'Downloaded 1080p (212 MB)');
      await running('prepare', null, 'Extracting audio and building the 480p proxy');
    },
    // 3 transcribe 30%
    guard(
      'transcribe',
      () => running('transcribe', 0.3, 'large-v3-turbo · 11× realtime', 'ETA 01:20'),
      async () => {
        await done('prepare', 'Audio extracted · 480p proxy ready');
        const v = setVideo(state, videoId, { hasProxy: true });
        await pushVideo(state, v);
      },
    ),
    // 4 transcribe 85%
    guard('transcribe', () =>
      running('transcribe', 0.85, 'large-v3-turbo · 11× realtime', 'ETA 00:14'),
    ),
    // 5 understand (indeterminate)
    async () => {
      state.transcripts[videoId] = state.transcripts['__interview__']!;
      await done('transcribe', 'Transcribed 2,986 words (EN)');
      state.costSpent += 0.18;
      await running('understand', null, 'Claude is reading the transcript');
    },
    // 6 moments 20%: the first two clips appear LIVE
    async () => {
      state.analyses[videoId] = state.analyses['__interview__']!;
      state.costSpent += 0.42;
      await done('understand', 'Overview, 6 chapters and notes written');
      await running('moments', 0.2, 'Ranking window 1 of 3', '2 moments so far');
      const cs = newClips(state, videoId, 0, 2, 'candidate');
      refreshCounts(state, videoId);
      for (const c of cs) await pushClip(state, c);
      await pushVideo(
        state,
        state.videos.find((x) => x.id === videoId)!,
      );
      await state.notify?.({
        id: `n-first-${videoId}`,
        kind: 'clips-ready',
        level: 'success',
        title: 'First clips are ready',
        body: '2 clips found. More are on the way.',
        href: `/library/video?id=${videoId}`,
        createdAt: Date.now(),
        readAt: null,
      });
    },
    // 7 moments 70%: four more
    async () => {
      state.costSpent += 0.31;
      await running('moments', 0.7, 'Ranking window 2 of 3', '6 moments so far');
      const cs = newClips(state, videoId, 2, 6, 'candidate');
      refreshCounts(state, videoId);
      for (const c of cs) await pushClip(state, c);
    },
    // 8 render 10%: clip 1 rendering
    async () => {
      await done('moments', 'Found 6 moments');
      await running('render', 0.1, 'Rendering clip 1 of 6');
      const c = state.clips.find((x) => x.id === `${videoId}-c1`)!;
      Object.assign(c, { status: 'rendering', renderProgress: 0.4, hasThumb: true });
      await pushClip(state, c);
    },
    // 9 render 50%: clips 1-2 rendered, 3 rendering
    async () => {
      await running('render', 0.5, 'Rendering clip 3 of 6', 'face tracking · captions · hook card');
      for (const n of [1, 2]) {
        const c = state.clips.find((x) => x.id === `${videoId}-c${n}`)!;
        Object.assign(c, {
          status: 'rendered',
          renderProgress: null,
          hasRender: true,
          hasThumb: true,
        });
        await pushClip(state, c);
      }
      const c3 = state.clips.find((x) => x.id === `${videoId}-c3`)!;
      Object.assign(c3, { status: 'rendering', renderProgress: 0.6, hasThumb: true });
      await pushClip(state, c3);
      refreshCounts(state, videoId);
      await pushVideo(
        state,
        state.videos.find((x) => x.id === videoId)!,
      );
    },
    // 10 render done -> finalize
    async () => {
      for (const c of state.clips.filter((x) => x.videoId === videoId && x.status !== 'rendered')) {
        Object.assign(c, {
          status: 'rendered',
          renderProgress: null,
          hasRender: true,
          hasThumb: true,
        });
        await pushClip(state, c);
      }
      refreshCounts(state, videoId);
      await done('render', 'Rendered 6 clips');
      await running('finalize', null, 'Uploading renders to your bucket');
    },
    // 11 finished
    async () => {
      await done('finalize', 'Uploaded 14 files · cleaned up');
      const v = setVideo(state, videoId, {
        status: 'ready',
        stage: null,
        progress: null,
        error: null,
      });
      await pushVideo(state, v);
      await state.notify?.({
        id: `n-done-${videoId}`,
        kind: 'job',
        level: 'success',
        title: 'Clipping finished',
        body: `6 clips ready from “${v.title}”.`,
        href: `/library/video?id=${videoId}`,
        createdAt: Date.now(),
        readAt: null,
      });
    },
  ];
}

function makeSim(state: Cp1State, videoId: string, ytId: string, startAt = 0): Sim {
  const steps = buildSteps(state, videoId, ytId);
  const sim: Sim = {
    videoId,
    cursor: startAt,
    steps,
    canceled: false,
    step: async () => {
      if (sim.canceled || sim.cursor >= steps.length) return false;
      const fn = steps[sim.cursor]!;
      try {
        await fn();
      } catch (e) {
        if ((e as Error).message === '__stopped__') {
          sim.cursor = steps.length; // stopped by a planned failure; retryStage re-arms from the failed stage
          return false;
        }
        throw e;
      }
      sim.cursor += 1;
      return sim.cursor < steps.length;
    },
    run: async (n) => {
      let left = n ?? Infinity;
      while (left-- > 0 && (await sim.step())) {
        /* keep stepping */
      }
    },
    remaining: () => (sim.canceled ? 0 : Math.max(0, steps.length - sim.cursor)),
  };
  return sim;
}

function autoplay(state: Cp1State, sim: Sim) {
  if (state.autoplayMs === null) return;
  const tick = () => {
    if (sim.canceled || sim.remaining() === 0) return;
    void sim
      .step()
      .catch(() => undefined)
      .then(() => setTimeout(tick, state.autoplayMs ?? 1500));
  };
  setTimeout(tick, state.autoplayMs);
}

/* --------------------------------------------------- channel handlers ------------------------------------------- */

const notFound = (what: string) => fail(`${what} not found`, 'NOT_FOUND');

export function costSummary(state: Cp1State, target: number, cap: number, hasKey: boolean) {
  const spent = hasKey ? Math.round(state.costSpent * 100) / 100 : 0;
  const level: 'ok' | 'warn' | 'over-target' | 'hard-cap' =
    spent >= cap
      ? 'hard-cap'
      : spent >= target
        ? 'over-target'
        : spent >= target * 0.8
          ? 'warn'
          : 'ok';
  return {
    month: '2026-10',
    spentUsd: spent,
    projectedUsd: Math.round(spent * 2.1 * 100) / 100,
    targetUsd: target,
    hardCapUsd: cap,
    calls: hasKey ? Math.round(318 + (spent - 12.84) * 40) : 0,
    inputTokens: hasKey ? 4_820_000 : 0,
    outputTokens: hasKey ? 212_000 : 0,
    cachedTokens: hasKey ? 3_410_000 : 0,
    level,
  };
}

/** Returns `{ value }` when the channel belongs to CP1, otherwise null so the stub falls through. */
export async function handleCp1(
  state: Cp1State,
  channel: string,
  payload: unknown,
): Promise<{ value: unknown } | null> {
  const p = payload as Record<string, unknown>;
  switch (channel) {
    case 'pipeline:probe':
      return { value: await probe(state, p.url as string) };

    case 'pipeline:start': {
      const url = p.url as string;
      state.log.started.push({ url, options: p.options });
      const ytId = parseYouTubeId(url);
      if (!ytId) throw fail('That is not a YouTube video link.');
      state.counter += 1;
      const id = `vid-new-${state.counter}`;
      const info = await probe(state, url).catch(() => null);
      const v = videoView({
        id,
        sourceId: ytId,
        sourceUrl: url,
        title: info?.title ?? 'Untitled video',
        channel: info?.channel ?? null,
        durationSec: info?.durationSec ?? null,
        thumbnail: info?.thumbnail ?? null,
        status: 'ingesting',
        stage: 'ingest',
        progress: null,
        hasProxy: false,
        createdAt: Date.now(),
        options: { ...BASE_OPTIONS, ...(p.options as object | undefined) },
      });
      state.videos.unshift(v);
      state.stages[id] = [];
      if (ytId === 'FailAtStt01')
        state.failPlans[ytId] = {
          stage: 'transcribe',
          error: 'Transcription engine stopped unexpectedly (exit code 137, out of memory).',
          fired: false,
        };
      if (ytId === 'BotAtIngst2')
        state.failPlans[ytId] = { stage: 'ingest', error: BOT_TEXT, fired: false };
      const sim = makeSim(state, id, ytId);
      state.sims[id] = sim;
      autoplay(state, sim);
      return { value: { videoId: id } };
    }

    case 'pipeline:cancel': {
      const id = p.videoId as string;
      state.log.cancels.push(id);
      const sim = state.sims[id];
      if (sim) sim.canceled = true;
      const v = state.videos.find((x) => x.id === id);
      if (!v) throw notFound('Video');
      const stage = v.stage ?? 'ingest';
      const nv = setVideo(state, id, { status: 'canceled' });
      await stageEvent(state, id, {
        stage,
        status: 'canceled',
        progress: null,
        message: 'Canceled by you',
      });
      await pushVideo(state, nv);
      return { value: { ok: true } };
    }

    case 'pipeline:retryStage': {
      const id = p.videoId as string;
      const stage = p.stage as PipelineStage;
      state.log.retries.push({ videoId: id, stage });
      const v = state.videos.find((x) => x.id === id);
      if (!v) throw notFound('Video');
      const ytId = v.sourceId ?? '';
      const from = STAGE_START_STEP[stage];
      const sim = makeSim(state, id, ytId, from);
      state.sims[id] = sim;
      // re-open the stage right away, exactly like main does when a stage is re-queued
      const nv = setVideo(state, id, {
        status: stage === 'ingest' ? 'ingesting' : 'processing',
        stage,
        progress: null,
        error: null,
      });
      await stageEvent(state, id, {
        stage,
        status: 'running',
        progress: null,
        message: 'Retrying…',
      });
      await pushVideo(state, nv);
      autoplay(state, sim);
      return { value: { ok: true } };
    }

    case 'videos:list': {
      let items = [...state.videos].sort((a, b) => b.createdAt - a.createdAt);
      if (p.favorite !== undefined) items = items.filter((v) => v.favorite === p.favorite);
      return { value: { items: items.slice(0, p.limit as number) } };
    }

    case 'videos:get': {
      const v = state.videos.find((x) => x.id === p.id);
      if (!v) throw notFound('Video');
      return {
        value: {
          video: v,
          analysis: state.analyses[v.id] ?? null,
          stages: state.stages[v.id] ?? [],
        },
      };
    }

    case 'videos:transcript':
      return { value: state.transcripts[p.id as string] ?? null };

    case 'videos:favorite': {
      const v = state.videos.find((x) => x.id === p.id);
      if (!v) throw notFound('Video');
      v.favorite = p.value as boolean;
      return { value: { ok: true } };
    }

    case 'videos:delete': {
      state.log.deleted.push({
        id: p.id as string,
        deleteFromStorage: p.deleteFromStorage as boolean,
      });
      state.videos = state.videos.filter((v) => v.id !== p.id);
      state.clips = state.clips.filter((c) => c.videoId !== p.id);
      return { value: { ok: true } };
    }

    case 'videos:proxyUrl': {
      const v = state.videos.find((x) => x.id === p.id);
      return { value: { url: v?.hasProxy ? asset(state, PROXY_FILE) : null } };
    }

    case 'clips:list': {
      let items = [...state.clips];
      if (p.videoId) items = items.filter((c) => c.videoId === p.videoId);
      if (p.favorite !== undefined) items = items.filter((c) => c.favorite === p.favorite);
      if (p.minScore !== undefined)
        items = items.filter((c) => (c.score ?? 0) >= (p.minScore as number));
      return { value: { items: items.slice(0, p.limit as number) } };
    }

    case 'clips:favorite': {
      for (const c of state.clips)
        if ((p.ids as string[]).includes(c.id)) c.favorite = p.value as boolean;
      return { value: { ok: true } };
    }

    case 'clips:delete': {
      state.log.deletedClips.push(p.ids as string[]);
      const touched = new Set(
        state.clips.filter((c) => (p.ids as string[]).includes(c.id)).map((c) => c.videoId),
      );
      state.clips = state.clips.filter((c) => !(p.ids as string[]).includes(c.id));
      touched.forEach((id) => refreshCounts(state, id));
      return { value: { ok: true } };
    }

    case 'clips:rerender': {
      const c = state.clips.find((x) => x.id === p.id);
      if (!c) throw notFound('Clip');
      Object.assign(c, { status: 'queued', renderProgress: null, error: null, hasRender: false });
      const id = c.id;
      const later = async (ms: number, fn: () => Promise<void>) => {
        await sleep(ms);
        await fn().catch(() => undefined);
      };
      void (async () => {
        await later(500, async () => {
          Object.assign(c, { status: 'rendering', renderProgress: 0.35 });
          await pushClip(state, c);
        });
        await later(700, async () => {
          Object.assign(c, { renderProgress: 0.8 });
          await pushClip(state, c);
        });
        await later(700, async () => {
          Object.assign(c, {
            status: 'rendered',
            renderProgress: null,
            hasRender: true,
            hasThumb: true,
          });
          await pushClip(state, c);
        });
      })();
      void id;
      return { value: { ok: true } };
    }

    case 'clips:mediaUrl': {
      const c = state.clips.find((x) => x.id === p.id);
      const a = state.clipAssets[p.id as string];
      if (!c || !a) return { value: { url: null } };
      if (p.kind === 'render')
        return { value: { url: c.hasRender ? asset(state, a.render) : null } };
      return { value: { url: c.hasThumb ? asset(state, a.thumb) : null } };
    }

    case 'clips:download': {
      state.log.downloads.push(p.ids as string[]);
      const saved = state.clips.filter(
        (c) => (p.ids as string[]).includes(c.id) && c.hasRender,
      ).length;
      return {
        value: { saved, dir: saved ? '/home/demo/Videos/Clipfern' : null, canceled: false },
      };
    }

    case 'shell:openExternal':
      state.log.external.push(p.url as string);
      return { value: { ok: true } };
  }
  return null;
}

/** The interview transcript/analysis every freshly started video "produces" (what faster-whisper + Claude would return). */
export function installRunFixtures(state: Cp1State) {
  const tr = buildTranscript(INTERVIEW, 176);
  state.transcripts['__interview__'] = tr;
  state.analyses['__interview__'] = interviewAnalysis(tr);
}
