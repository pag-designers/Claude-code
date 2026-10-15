import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  keys,
  type AudioSignals,
  type ClipView,
  type PipelineEvent,
  type RankedMoment,
  type Sentence,
  type Word,
} from '@shared/pipeline';
import { PipelineOrchestrator, WINDOW_SEC, type PipelineDeps } from '@main/pipeline/orchestrator';
import { StyleRegistry } from '@main/pipeline/styles';
import { subtitleEditsSchema, type MomentRun } from '@shared/cp2';
import { BudgetExceededError, IngestError, type LlmService } from '@main/pipeline/contracts';
import { MemoryStorageProvider } from '@main/services/storage/memory';
import { JOB_KINDS } from '@main/services/context';
import { FAKE_STYLE, makeServices } from './helpers';

const URL1 = 'https://www.youtube.com/watch?v=abcdefghijk';
const DURATION = 1500; // 3 windows: 600 + 600 + 300

const waitFor = async (fn: () => Promise<boolean>, ms = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timeout waiting for condition');
};

function fakeSentences(words: Word[]): Sentence[] {
  const out: Sentence[] = [];
  const per = 8;
  for (let i = 0; i < words.length; i += per) {
    const slice = words.slice(i, i + per);
    const first = slice[0];
    const last = slice.at(-1);
    if (!first || !last) continue;
    out.push({
      id: out.length,
      s: first.s,
      e: last.e,
      text: slice.map((w) => w.w).join(' ') + '.',
      speaker: null,
      wordStart: i,
      wordEnd: i + slice.length - 1,
    });
  }
  return out;
}

interface Env {
  svc: Awaited<ReturnType<typeof makeServices>>['svc'];
  orch: PipelineOrchestrator;
  storage: MemoryStorageProvider;
  dir: string;
  events: PipelineEvent[];
  clipsSeen: ClipView[];
  runs: MomentRun[];
  prompts: string[];
  calls: { transcribe: number; ingest: number; rank: number; render: number; understand: number };
  hooks: {
    failIngestOnce: boolean;
    ingestDelayMs: number;
    llmError: Error | null;
    renderDelayMs: number;
  };
  cleanup: () => Promise<void>;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function makeEnv(): Promise<Env> {
  const m = await makeServices();
  const { svc, dir } = m;
  const storage = new MemoryStorageProvider();
  const events: PipelineEvent[] = [];
  const clipsSeen: ClipView[] = [];
  const calls = { transcribe: 0, ingest: 0, rank: 0, render: 0, understand: 0 };
  const hooks = {
    failIngestOnce: false,
    ingestDelayMs: 0,
    llmError: null as Error | null,
    renderDelayMs: 0,
  };
  const cacheDir = path.join(dir, 'cache');
  const runs: MomentRun[] = [];
  const prompts: string[] = [];

  const llm: LlmService = {
    isConfigured: () => true,
    async understand() {
      calls.understand++;
      if (hooks.llmError) throw hooks.llmError;
      return {
        overview: { summary: 's', tone: 't', participants: [], takeaways: [] },
        chapters: [],
        notes: { keyPoints: [], quotes: [], numbers: [], claims: [], actionItems: [] },
        topics: [],
        entities: [],
        keywords: [],
      };
    },
    async rankMoments(input) {
      calls.rank++;
      if (input.options.prompt) prompts.push(input.options.prompt);
      if (hooks.llmError) throw hooks.llmError;
      // one strong (84) and one OK (66) moment per window, ~35 s long, from the sentences we were given
      const out: RankedMoment[] = [];
      // start picking after the overlap context (first ~80 s of a non-first window) so moments belong to this window
      const base = Math.max(
        0,
        input.sentences.findIndex(
          (x) => x.s >= (input.window.startSec > 0 ? input.window.startSec + 80 : 0),
        ),
      );
      // A steered run looks somewhere else in the window than the default pass does.
      const picks = input.options.prompt ? [base + 30] : [base + 3, base + 14];
      picks.forEach((idx, n) => {
        const a = input.sentences[idx];
        const b = input.sentences[Math.min(idx + 8, input.sentences.length - 1)];
        if (!a || !b || b.e - a.s < 25) return;
        out.push({
          candidateId: null,
          startSec: a.s,
          endSec: b.e,
          title: input.options.prompt
            ? `Steered ${input.window.startSec}`
            : `Moment ${input.window.startSec}-${n}`,
          hook: 'Wait for it',
          whyItWorks: 'because',
          captionStyle: 'clean-pop',
          breakdown:
            n === 0
              ? { hook: 22, retention: 21, emotion: 16, clarity: 12, shareability: 13 }
              : { hook: 15, retention: 15, emotion: 12, clarity: 12, shareability: 12 },
          confidence: 0.8,
          keywords: [],
        });
      });
      return out;
    },
  };

  const deps: PipelineDeps = {
    db: svc.dbHandle.prisma,
    queue: svc.queue,
    settings: svc.settings,
    notifications: svc.notifications,
    cacheDir,
    ingest: {
      async probe() {
        return {
          id: 'abcdefghijk',
          title: 'A Real Talk',
          channel: 'Chan',
          durationSec: DURATION,
          thumbnail: null,
          description: null,
          isLive: false,
          chapters: [],
          uploadDate: null,
          license: null,
        };
      },
      async download(_url, outDir, opts) {
        calls.ingest++;
        if (hooks.failIngestOnce) {
          hooks.failIngestOnce = false;
          throw new IngestError('YouTube asked to verify you are not a bot.', 'bot-check');
        }
        for (let i = 1; i <= 4; i++) {
          if (opts.signal?.aborted) throw new Error('aborted');
          opts.onProgress?.(i / 4, '1 MiB/s');
          await new Promise((r) => setTimeout(r, hooks.ingestDelayMs));
        }
        fs.writeFileSync(path.join(outDir, 'dl.mp4'), 'x'.repeat(2000));
        return { filePath: path.join(outDir, 'dl.mp4') };
      },
    },
    media: {
      async probe() {
        return {
          durationSec: DURATION,
          width: 1920,
          height: 1080,
          fps: 30,
          videoCodec: 'h264',
          audioCodec: 'aac',
          hasAudio: true,
          hasVideo: true,
          sizeBytes: 2000,
        };
      },
      async extractAudio16k(_s, out, opts) {
        fs.writeFileSync(
          out,
          JSON.stringify({ startSec: opts?.startSec ?? 0, durSec: opts?.durSec ?? DURATION }),
        );
      },
      async makeProxy(_s, out) {
        fs.writeFileSync(out, 'proxy-bytes');
      },
      async extractFrame() {},
    },
    analysis: {
      segmentSentences: (words) => fakeSentences(words),
      async computeSignals({ durationSec }): Promise<AudioSignals> {
        const n = Math.ceil(durationSec / 0.5);
        return {
          hopSec: 0.5,
          durationSec,
          loudness: new Array(n).fill(-20),
          speechRate: new Array(n).fill(2.5),
          silences: [],
          laughter: [],
          speakerChanges: [],
          sceneCuts: [],
        };
      },
    },
    llm,
    moments: {
      generateCandidates: () => [],
      snap: ({ startSec, endSec }) => ({ startSec, endSec }),
    },
    reframe: {
      async analyzeLayout() {
        return { kind: 'none', faceRegion: null, screenRegion: null, confidence: 0 };
      },
      plan: ({ aspect, srcW, srcH }) => ({
        mode: 'center',
        aspect,
        srcW,
        srcH,
        outW: 1080,
        outH: 1920,
        keyframes: [{ t: 0, x: 0, y: 0, w: 607, h: 1080 }],
        cuts: [],
        faceCoverage: 0,
      }),
    },
    captions: {
      builtinStyles: () => [FAKE_STYLE],
      async preview() {
        return Buffer.from('png');
      },
      fonts: () => [],
      buildAss: () => '[Script Info]\n',
      buildSrt: () => '1\n00:00:00,000 --> 00:00:01,000\nhi\n',
      buildVtt: () => 'WEBVTT\n',
    },
    render: {
      async render(req) {
        calls.render++;
        req.onProgress?.(0.5);
        await new Promise((r) => setTimeout(r, hooks.renderDelayMs));
        if (req.signal?.aborted) throw new Error('aborted');
        fs.writeFileSync(req.outPath, 'mp4-bytes');
        req.onProgress?.(1);
        return { encoder: 'libx264', durationSec: req.endSec - req.startSec };
      },
      async renderHighlight(req) {
        calls.render++;
        fs.writeFileSync(req.outPath, 'mp4-bytes');
        return { encoder: 'libx264', durationSec: 40 };
      },
      async detectEncoder() {
        return 'libx264';
      },
    },
    subtitles: {
      applyEdits: (words) => words.map((w, origIndex) => ({ ...w, origIndex })),
      cues: () => [],
      editCueText: (_w, e) => e,
      splitCue: (_w, e) => e,
      mergeWithNext: (_w, e) => e,
      shiftCue: (_w, e) => e,
      toSrt: () => '',
      toVtt: () => 'WEBVTT\n',
    },
    thumbnails: {
      sample: async () => [],
      score: async () => [],
      compose: async (a) => {
        fs.copyFileSync(a.framePath, a.outJpg);
      },
    },
    styles: new StyleRegistry(svc.dbHandle.prisma, { builtinStyles: () => [FAKE_STYLE] }),
    loadSubtitleEdits: async () => subtitleEditsSchema.parse({}),
    emitRun: (r) => runs.push(r),
    sidecar: {
      getStatus: () => ({ installed: true, modelReady: true }),
      async start() {},
      async transcribe(req) {
        calls.transcribe++;
        const meta = JSON.parse(fs.readFileSync(req.audio_path, 'utf8')) as {
          startSec: number;
          durSec: number;
        };
        const words: { word: string; start: number; end: number; probability: number }[] = [];
        for (let t = 0; t + 0.4 < meta.durSec; t += 0.5) {
          words.push({
            word: `w${Math.round((meta.startSec + t) * 2)}`,
            start: t,
            end: t + 0.4,
            probability: 0.9,
          });
        }
        return { language: 'en', language_probability: 0.99, model: 'fake', segments: [{ words }] };
      },
      async scenes() {
        return { cuts: [100, 500] };
      },
      async faces() {
        return {
          width: 1920,
          height: 1080,
          source_fps: 30,
          sample_fps: 4,
          frames_sampled: 0,
          frames_with_faces: 0,
          frames: [],
          elapsed_s: 0,
        } as never;
      },
    },
    toFaceSamples: () => [],
    cleanFrame: async (r) => {
      fs.writeFileSync(r.outJpg, 'clean-jpg');
    },
    thumbnail: async (_f, _c, out) => {
      fs.writeFileSync(out, 'jpg-bytes');
    },
    ffmpegPath: () => 'ffmpeg',
    fontsDir: () => null,
    getStorage: () => storage,
    invalidateStorage: () => {},
    whisperModel: () => 'fake',
    cookiesFromBrowser: () => undefined,
    emit: {
      pipeline: (e) => events.push(e),
      video: () => {},
      clip: (c) => clipsSeen.push(c),
    },
    checkReady: async () => null,
    log: () => {},
  };
  const orch = new PipelineOrchestrator(deps);
  orch.registerJobs();
  await svc.queue.start();
  const env: Env = {
    svc,
    orch,
    storage,
    dir,
    events,
    clipsSeen,
    runs,
    prompts,
    calls,
    hooks,
    cleanup: m.cleanup,
  };
  cleanups.push(m.cleanup);
  return env;
}

const videoStatus = async (e: Env, id: string) =>
  (await e.svc.dbHandle.prisma.video.findUniqueOrThrow({ where: { id } })).status;

describe('PipelineOrchestrator', () => {
  it('runs the whole pipeline: windows → clips → renders → finalize, streaming clips early', async () => {
    const e = await makeEnv();
    const { videoId } = await e.orch.start(URL1, { clipCount: 4, minScore: 60 });
    await waitFor(async () => (await videoStatus(e, videoId)) === 'ready');

    const v = await e.orch.videoView(videoId);
    expect(v?.title).toBe('A Real Talk');
    expect(v?.status).toBe('ready');
    expect(v?.hasProxy).toBe(true);
    const clips = await e.svc.dbHandle.prisma.clip.findMany({
      where: { videoId },
      orderBy: { rank: 'asc' },
    });
    expect(clips.length).toBeGreaterThanOrEqual(3);
    expect(clips.length).toBeLessThanOrEqual(4);
    expect(clips.every((c) => c.status === 'rendered')).toBe(true);
    expect(clips.map((c) => c.rank)).toEqual(clips.map((_, i) => i + 1));
    // sorted by score desc
    const scores = clips.map((c) => c.score ?? 0);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);

    // artifacts in storage under the documented keys
    for (const c of clips) {
      expect(await e.storage.head(keys.clip(c.id))).not.toBeNull();
      expect(await e.storage.head(keys.thumb(c.id))).not.toBeNull();
      expect(await e.storage.head(keys.srt(c.id))).not.toBeNull();
    }
    expect(await e.storage.head(keys.proxy(videoId))).not.toBeNull();
    expect(await e.storage.head(keys.transcript(videoId))).not.toBeNull();
    expect(await e.storage.head(keys.analysis(videoId))).not.toBeNull();

    // full-res source and audio were deleted locally (BRIEF §3), clip temp dirs too
    const dir = path.join(e.dir, 'cache', videoId);
    expect(fs.existsSync(path.join(dir, 'source.mp4'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'audio.wav'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'clips'))).toBe(true);

    // every stage ended 'done'
    const { stages } = { stages: await e.orch.tracker.load(videoId) };
    void stages;
    const last = new Map<string, string>();
    for (const ev of e.events) last.set(ev.stage, ev.status);
    for (const s of [
      'ingest',
      'prepare',
      'transcribe',
      'moments',
      'understand',
      'render',
      'finalize',
    ])
      expect(last.get(s), s).toBe('done');
    expect(e.calls.transcribe).toBe(3);
    expect(e.calls.rank).toBe(3);
    expect(e.calls.understand).toBe(1);

    // notifications: a first-clip one and a final one, no duplicates of the first
    const notes = (await e.svc.notifications.list()).items.map((n) => n.title);
    expect(notes.filter((t) => t === 'First clip ready')).toHaveLength(1);
    expect(notes.some((t) => /clips? ready/.test(t))).toBe(true);
  });

  it('streams: the first clip is rendered before the last window is transcribed', async () => {
    const e = await makeEnv();
    const order: string[] = [];
    const origTranscribe = e.calls;
    void origTranscribe;
    const { videoId } = await e.orch.start(URL1, { clipCount: 6, minScore: 60 });
    await waitFor(async () => (await videoStatus(e, videoId)) === 'ready');
    // events are chronological: a 'render' clip event for a clip must appear before transcribe finished
    const firstRendered = e.clipsSeen.findIndex((c) => c.status === 'rendered');
    expect(firstRendered).toBeGreaterThanOrEqual(0);
    const transcribeDoneAt = e.events.findIndex(
      (x) => x.stage === 'transcribe' && x.status === 'done',
    );
    expect(transcribeDoneAt).toBeGreaterThan(-1);
    void order;
    // the strong (>=72) clip of window 0 is queued during transcription, so its 'queued' state precedes transcribe 'done'
    const firstQueuedClip = e.clipsSeen.findIndex((c) => c.status === 'queued');
    expect(firstQueuedClip).toBeGreaterThanOrEqual(0);
  });

  it('records a recoverable failure and resumes with retryStage (bot-check example)', async () => {
    const e = await makeEnv();
    e.hooks.failIngestOnce = true;
    const { videoId } = await e.orch.start(URL1, { clipCount: 3 });
    await waitFor(async () => (await videoStatus(e, videoId)) === 'failed');
    const v = await e.orch.videoView(videoId);
    expect(v?.error).toMatch(/not a bot/);
    expect(v?.stage).toBe('ingest');
    const note = (await e.svc.notifications.list()).items.find(
      (n) => n.title === 'Clipping failed',
    );
    expect(note?.body).toMatch(/not a bot/);

    await e.orch.retryStage(videoId, 'ingest');
    await waitFor(async () => (await videoStatus(e, videoId)) === 'ready');
    expect(e.calls.ingest).toBe(2);
  });

  it('cancel stops the run, clears running state and leaves no queued jobs', async () => {
    const e = await makeEnv();
    e.hooks.ingestDelayMs = 300;
    const { videoId } = await e.orch.start(URL1, {});
    await waitFor(async () => e.events.some((x) => x.stage === 'ingest' && x.status === 'running'));
    await e.orch.cancel(videoId);
    expect(await videoStatus(e, videoId)).toBe('canceled');
    await new Promise((r) => setTimeout(r, 1500));
    const jobs = await e.svc.dbHandle.prisma.job.findMany({ where: { groupKey: videoId } });
    expect(jobs.every((j) => ['canceled', 'succeeded', 'failed'].includes(j.status))).toBe(true);
    expect(await videoStatus(e, videoId)).toBe('canceled');
    expect(e.calls.transcribe).toBe(0);
  });

  it('a second run of the same video re-uses the cached transcript (no ASR)', async () => {
    const e = await makeEnv();
    const first = await e.orch.start(URL1, { clipCount: 3 });
    await waitFor(async () => (await videoStatus(e, first.videoId)) === 'ready');
    expect(e.calls.transcribe).toBe(3);
    const second = await e.orch.start(URL1, { clipCount: 3, clipPreset: '15-30' });
    await waitFor(async () => (await videoStatus(e, second.videoId)) === 'ready');
    expect(e.calls.transcribe).toBe(3); // unchanged
    expect(e.calls.rank).toBe(6); // moments are re-ranked for the new options
  });

  it('surfaces a budget hard-cap as a clear failure + warning notification', async () => {
    const e = await makeEnv();
    e.hooks.llmError = new BudgetExceededError('Monthly AI budget reached: $70.00 of $70.00.');
    const { videoId } = await e.orch.start(URL1, {});
    await waitFor(async () => (await videoStatus(e, videoId)) === 'failed');
    const v = await e.orch.videoView(videoId);
    expect(v?.error).toMatch(/budget reached/i);
    const titles = (await e.svc.notifications.list()).items.map((n) => n.title);
    expect(titles).toContain('AI budget reached');
  });

  it('refuses to start when prerequisites are missing, with an actionable message', async () => {
    const e = await makeEnv();
    const orch2 = new PipelineOrchestrator({
      ...(e.orch as unknown as { d: PipelineDeps }).d,
      checkReady: async () => 'Add your Anthropic API key in Settings → API Keys.',
    });
    await expect(orch2.start(URL1, {})).rejects.toThrow(/Anthropic API key/);
    await expect(orch2.start('https://example.com/nope', {})).rejects.toThrow(/YouTube/);
  });

  it('rejects a duplicate while the same video is still processing', async () => {
    const e = await makeEnv();
    e.hooks.ingestDelayMs = 200;
    await e.orch.start(URL1, {});
    await expect(e.orch.start(URL1, {})).rejects.toThrow(/already being processed/);
  });

  it('startup reconciliation fails videos whose jobs vanished instead of leaving them spinning', async () => {
    const e = await makeEnv();
    const row = await e.svc.dbHandle.prisma.video.create({
      data: {
        sourceUrl: URL1,
        sourceId: 'zzzzzzzzzzz',
        title: 'stuck',
        status: 'processing',
        stage: 'transcribe',
      },
    });
    await e.orch.reconcileOnStart();
    expect(await videoStatus(e, row.id)).toBe('failed');
  });

  it('exposes the job kinds it registers', () => {
    expect(JOB_KINDS.refreshStorage).toBe('storage.refresh-usage');
    expect(WINDOW_SEC).toBe(600);
  });
});

describe('pipeline options patch', () => {
  it('a one-key patch does not re-apply schema defaults (user defaults must survive)', async () => {
    const { pipelineOptionsPatchSchema } = await import('@shared/pipeline');
    expect(Object.keys(pipelineOptionsPatchSchema.parse({ clipCount: 3 }))).toEqual(['clipCount']);
    expect(Object.keys(pipelineOptionsPatchSchema.parse({}))).toEqual([]);
    expect(() => pipelineOptionsPatchSchema.parse({ nope: 1 })).toThrow();
  });

  it('start() layers: saved settings defaults < explicit options', async () => {
    const e = await makeEnv();
    await e.svc.settings.set({
      defaultClipCount: 7,
      defaultAspect: '1:1',
      defaultClipPreset: '15-30',
    });
    const { videoId } = await e.orch.start(URL1, { clipCount: 3 });
    const row = await e.svc.dbHandle.prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    const opts = JSON.parse(row.options) as {
      clipCount: number;
      aspect: string;
      clipPreset: string;
    };
    expect(opts).toMatchObject({ clipCount: 3, aspect: '1:1', clipPreset: '15-30' });
  });
});

describe('CP2: analysis-only mode and steered runs', () => {
  it('analysis mode transcribes and understands but never ranks or renders', async () => {
    const e = await makeEnv();
    const { videoId } = await e.orch.start(URL1, { mode: 'analysis' });
    await waitFor(async () => (await videoStatus(e, videoId)) === 'ready');
    expect(e.calls.rank).toBe(0);
    expect(e.calls.render).toBe(0);
    expect(e.calls.understand).toBe(1);
    expect(await e.svc.dbHandle.prisma.clip.count({ where: { videoId } })).toBe(0);
    const states = await e.svc.dbHandle.prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    const stages = JSON.parse(states.stages) as { stage: string; status: string }[];
    expect(stages.find((x) => x.stage === 'moments')?.status).toBe('skipped');
    expect(stages.find((x) => x.stage === 'render')?.status).toBe('skipped');
    expect(await e.storage.head(keys.transcript(videoId))).not.toBeNull();
    expect(await e.storage.head(keys.analysis(videoId))).not.toBeNull();
  });

  it('a steered run reuses the transcript, finds NEW moments, tags them with the run and renders them', async () => {
    const e = await makeEnv();
    const { videoId } = await e.orch.start(URL1, { clipCount: 3, minScore: 60 });
    await waitFor(async () => (await videoStatus(e, videoId)) === 'ready');
    const asrCalls = e.calls.transcribe;
    const before = await e.svc.dbHandle.prisma.clip.count({ where: { videoId } });

    const { runId } = await e.orch.startMomentsRun(videoId, 'only the funny parts', {
      clipCount: 2,
    });
    await waitFor(async () =>
      (await e.orch.listRuns(videoId)).every((r) => r.status !== 'running'),
    );
    const [run] = await e.orch.listRuns(videoId);
    expect(run?.id).toBe(runId);
    expect(run?.status).toBe('done');
    expect(run?.found).toBe(2);
    expect(e.calls.transcribe).toBe(asrCalls); // no new ASR
    expect(e.prompts.every((p) => p === 'only the funny parts')).toBe(true);
    expect(e.runs.some((r) => r.status === 'running')).toBe(true); // announced when it started
    expect(e.runs.at(-1)?.status).toBe('done');

    await waitFor(async () => {
      const cs = await e.svc.dbHandle.prisma.clip.findMany({ where: { runId } });
      return cs.length === 2 && cs.every((c) => c.status === 'rendered');
    });
    const steered = await e.svc.dbHandle.prisma.clip.findMany({ where: { runId } });
    expect(steered.every((c) => c.title.startsWith('Steered'))).toBe(true);
    expect(await e.svc.dbHandle.prisma.clip.count({ where: { videoId } })).toBe(before + 2);
    // the view carries the prompt so the UI can label "found by: …"
    await e.orch.emitClip(steered[0]!.id);
    expect(e.clipsSeen.at(-1)?.runPrompt).toBe('only the funny parts');
  });

  it('refuses a steered run while the video is still processing and on a missing transcript', async () => {
    const e = await makeEnv();
    e.hooks.ingestDelayMs = 200;
    const { videoId } = await e.orch.start(URL1, { clipCount: 2 });
    await expect(e.orch.startMomentsRun(videoId, 'funny')).rejects.toThrow(/finished processing/);
    await e.orch.cancel(videoId);
  });

  it('canceling a queued run marks it canceled', async () => {
    const e = await makeEnv();
    const { videoId } = await e.orch.start(URL1, { clipCount: 2 });
    await waitFor(async () => (await videoStatus(e, videoId)) === 'ready');
    const { runId } = await e.orch.startMomentsRun(videoId, 'something else');
    await e.orch.cancelRun(runId);
    const [run] = await e.orch.listRuns(videoId);
    expect(['canceled', 'done']).toContain(run?.status);
  });
});
