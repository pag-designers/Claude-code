import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  audioSignalsSchema,
  durationRange,
  keys,
  pipelineOptionsSchema,
  totalScore,
  transcriptSchema,
  videoAnalysisSchema,
  type AudioSignals,
  type PipelineEvent,
  type PipelineOptions,
  type PipelineOptionsInput,
  type PipelineStage,
  type RankedMoment,
  type Transcript,
  type UrlInfo,
  type VideoAnalysis,
  type Word,
  parseYouTubeId,
  type ClipView,
  type VideoView,
} from '@shared/pipeline';
import type { MomentRun } from '@shared/cp2';
import type { Db } from '../db/client';
import type { JobContext, JobQueue } from '../services/queue';
import type { NotificationService } from '../services/notifications';
import type { SettingsService } from '../services/settings';
import type { StorageProvider } from '../services/storage/provider';
import { AppError } from '../ipc/dispatch';
import { BudgetExceededError, IngestError } from './contracts';
import { LlmError } from '../services/llm/errors';
import type {
  AnalysisService,
  IngestService,
  LlmService,
  MediaService,
  MomentService,
} from './contracts';
import { StageTracker } from './state';
import {
  initialStages,
  parseJson,
  readOptions,
  toClipView,
  toVideoView,
  type ClipRow,
  type VideoRow,
} from './views';
import { mergeSignals } from './signals-merge';
import { RenderWorker, type RenderWorkerDeps } from './render-worker';

export const JOB_PROCESS = 'pipeline.process';
export const JOB_RENDER = 'pipeline.render-clip';
export const JOB_MOMENTS_RUN = 'pipeline.moments-run';

/** Transcription / ranking window (BRIEF §4.5: first clips after ~10 minutes of transcript). */
export const WINDOW_SEC = 600;
/** Extra audio on each side of a transcription window so boundary words are not cut. */
const TRANSCRIBE_PAD_SEC = 4;
/** Clips at or above this score start rendering immediately (streaming first clips). */
export const EAGER_RENDER_SCORE = 72;

export interface SidecarLike {
  getStatus(): { installed: boolean; modelReady: boolean };
  start(): Promise<unknown>;
  transcribe(
    req: {
      audio_path: string;
      model?: string;
      language?: string;
      vad_filter?: boolean;
      condition_on_previous_text?: boolean;
    },
    opts?: { signal?: AbortSignal },
  ): Promise<{
    language: string;
    language_probability: number;
    model: string;
    segments: { words: { word: string; start: number; end: number; probability: number }[] }[];
  }>;
  scenes(req: { video_path: string }, opts?: { signal?: AbortSignal }): Promise<{ cuts: number[] }>;
}

export interface PipelineDeps extends Omit<
  RenderWorkerDeps,
  'tracker' | 'ensureSource' | 'onClipChanged' | 'sidecar'
> {
  /** Emits when a steered moment run changes state. */
  emitRun(run: MomentRun): void;
  db: Db;
  queue: JobQueue;
  settings: SettingsService;
  notifications: NotificationService;
  ingest: IngestService;
  media: MediaService;
  analysis: AnalysisService;
  llm: LlmService;
  moments: MomentService;
  sidecar: SidecarLike & RenderWorkerDeps['sidecar'];
  /** Returns a user-facing reason when the pipeline cannot run yet, else null. */
  checkReady(): Promise<string | null>;
  whisperModel(): string;
  cookiesFromBrowser(): string | undefined;
  emit: {
    pipeline(e: PipelineEvent): void;
    video(v: VideoView): void;
    clip(c: ClipView): void;
  };
  log: (m: string) => void;
}

type VideoMeta = { info?: UrlInfo; mainDone?: boolean; cachedTranscript?: boolean };

export class PipelineOrchestrator {
  readonly tracker: StageTracker;
  private readonly render: RenderWorker;
  private sourceLocks = new Map<string, Promise<string>>();
  private finalizing = new Set<string>();
  private firstClipNotified = new Set<string>();
  private abortByVideo = new Map<string, AbortController>();

  constructor(private readonly d: PipelineDeps) {
    this.tracker = new StageTracker(d.db, {
      onEvent: (e) => d.emit.pipeline(e),
      onVideoChanged: (id) => void this.emitVideo(id),
    });
    this.render = new RenderWorker({
      ...d,
      tracker: this.tracker,
      ensureSource: (videoId, signal) => this.ensureSource(videoId, signal),
      onClipChanged: (clipId) => void this.emitClip(clipId),
    });
  }

  registerJobs(): void {
    this.d.queue.register<{ videoId: string }>(JOB_PROCESS, async (ctx) => this.process(ctx), {
      concurrency: 1,
      maxAttempts: 2,
    });
    this.d.queue.register<{ clipId: string; videoId: string }>(
      JOB_RENDER,
      async (ctx) => {
        await this.render.run(ctx);
        await this.checkCompletion(ctx.payload.videoId);
      },
      { concurrency: 2, maxAttempts: 2 },
    );
    this.d.queue.register<{ runId: string; videoId: string }>(
      JOB_MOMENTS_RUN,
      async (ctx) => this.momentsRun(ctx),
      { concurrency: 1, maxAttempts: 1 },
    );
  }

  /* ------------------------------------------------------------------ public API ------------ */

  async start(url: string, input?: Partial<PipelineOptionsInput>): Promise<{ videoId: string }> {
    let sourceId = parseYouTubeId(url);
    if (!sourceId && process.env.CLIPFERN_ALLOW_ANY_URL === '1') {
      // Dev/test only: let yt-dlp's generic extractor take a direct media URL (used by the e2e harness).
      sourceId = `x-${createHash('sha1').update(url.trim()).digest('hex').slice(0, 9)}`;
    }
    if (!sourceId)
      throw new AppError('VALIDATION', 'That does not look like a YouTube video link.');
    const notReady = await this.d.checkReady();
    if (notReady) throw new AppError('UNAVAILABLE', notReady);
    const active = await this.d.db.video.findFirst({
      where: { sourceId, status: { in: ['new', 'ingesting', 'processing'] } },
    });
    if (active) throw new AppError('VALIDATION', 'This video is already being processed.');

    const defaults = await this.d.settings.get();
    const options = pipelineOptionsSchema.parse({
      clipPreset: defaults.defaultClipPreset,
      clipCount: defaults.defaultClipCount,
      aspect: defaults.defaultAspect,
      maxResolution: defaults.maxResolution,
      ...(input ?? {}),
    });
    const row = await this.d.db.video.create({
      data: {
        sourceUrl: url.trim(),
        sourceId,
        title: url.trim(),
        status: 'ingesting',
        stage: 'ingest',
        options: JSON.stringify(options),
        stages: JSON.stringify(initialStages()),
      },
    });
    await this.emitVideo(row.id);
    await this.d.queue.enqueue({
      kind: JOB_PROCESS,
      payload: { videoId: row.id },
      groupKey: row.id,
    });
    return { videoId: row.id };
  }

  async cancel(videoId: string): Promise<void> {
    this.abortByVideo.get(videoId)?.abort(new Error('canceled'));
    await this.cancelJobs(videoId);
    const states = await this.tracker.load(videoId);
    for (const s of states) {
      if (s.status === 'running' || s.status === 'pending')
        await this.tracker.update(videoId, s.stage, { status: 'canceled', message: 'Canceled' });
    }
    await this.d.db.video
      .update({ where: { id: videoId }, data: { status: 'canceled' } })
      .catch(() => {});
    await this.d.db.clip
      .updateMany({
        where: { videoId, status: { in: ['queued', 'rendering'] } },
        data: { status: 'candidate' },
      })
      .catch(() => {});
    await this.emitVideo(videoId);
  }

  async retryStage(videoId: string, stage: PipelineStage): Promise<void> {
    const notReady = await this.d.checkReady();
    if (notReady) throw new AppError('UNAVAILABLE', notReady);
    await this.cancelJobs(videoId);
    // Failed clips are re-rendered individually; everything else restarts from the chosen stage.
    if (stage === 'render') {
      const failed = await this.d.db.clip.findMany({ where: { videoId, status: 'failed' } });
      await this.tracker.update(
        videoId,
        'render',
        { status: 'running', error: null, message: 'Retrying…' },
        'processing',
      );
      await this.tracker.update(videoId, 'finalize', { status: 'pending', error: null });
      for (const c of failed) await this.queueRender(videoId, c.id);
      if (failed.length === 0) await this.checkCompletion(videoId);
      return;
    }
    const video = await this.mustVideo(videoId);
    const meta = parseJson<VideoMeta>(video.metadata, {});
    await this.d.db.video.update({
      where: { id: videoId },
      data: { metadata: JSON.stringify({ ...meta, mainDone: false }) },
    });
    await this.tracker.resetFrom(videoId, stage);
    await this.emitVideo(videoId);
    await this.d.queue.enqueue({ kind: JOB_PROCESS, payload: { videoId }, groupKey: videoId });
  }

  /** Re-render one clip (e.g. after a failure). Re-downloads the source if it was cleaned up. */
  async rerenderClip(clipId: string): Promise<void> {
    const clip = await this.d.db.clip.findUnique({ where: { id: clipId } });
    if (!clip) throw new AppError('NOT_FOUND', 'Clip not found.');
    const notReady = await this.d.checkReady();
    if (notReady) throw new AppError('UNAVAILABLE', notReady);
    await this.d.db.clip.update({
      where: { id: clipId },
      data: { error: null, renderProgress: 0 },
    });
    await this.queueRender(clip.videoId, clipId);
    await this.tracker.update(clip.videoId, 'finalize', { status: 'pending' });
  }

  /** Called on app start: cleans stale 'processing' state for videos whose jobs no longer exist. */
  async reconcileOnStart(): Promise<void> {
    const staleRuns = await this.d.db.momentRun.findMany({ where: { status: 'running' } });
    for (const r of staleRuns) {
      const jobs = await this.d.db.job.count({
        where: { kind: JOB_MOMENTS_RUN, status: { in: ['queued', 'running'] }, payload: { contains: r.id } },
      });
      if (jobs === 0)
        await this.d.db.momentRun.update({
          where: { id: r.id },
          data: { status: 'failed', error: 'Interrupted by a restart.', finishedAt: new Date() },
        });
    }
    const rows = await this.d.db.video.findMany({
      where: { status: { in: ['ingesting', 'processing'] } },
    });
    for (const v of rows) {
      const jobs = await this.d.db.job.count({
        where: { groupKey: v.id, status: { in: ['queued', 'running'] } },
      });
      if (jobs === 0) {
        await this.tracker.update(
          v.id,
          (v.stage as PipelineStage) ?? 'ingest',
          {
            status: 'failed',
            error: 'Interrupted. Press Retry to continue.',
          },
          'failed',
        );
      }
    }
  }

  /* ------------------------------------------------------------------- the main job ---------- */

  private async process(ctx: JobContext<{ videoId: string }>): Promise<void> {
    const { videoId } = ctx.payload;
    const ac = new AbortController();
    ctx.signal.addEventListener('abort', () => ac.abort(ctx.signal.reason), { once: true });
    this.abortByVideo.set(videoId, ac);
    const signal = ac.signal;
    const log = (m: string) => this.d.log(`[${videoId.slice(-6)}] ${m}`);
    try {
      const video = await this.d.db.video.findUnique({ where: { id: videoId } });
      if (!video) return;
      const options = readOptions(video.options);
      const dir = path.join(this.d.cacheDir, videoId);
      fs.mkdirSync(dir, { recursive: true });
      await this.d.db.video.update({ where: { id: videoId }, data: { status: 'processing' } });
      const t = this.tracker;
      const run = async (stage: PipelineStage, fn: () => Promise<void>) => {
        if ((await t.status(videoId, stage)) === 'done') return;
        await t.update(videoId, stage, {
          status: 'running',
          progress: null,
          message: null,
          error: null,
        });
        await fn();
        await t.update(videoId, stage, { status: 'done', message: null, detail: null });
      };

      await run('ingest', () => this.stageIngest(videoId, options, dir, signal));
      const source = path.join(dir, 'source.mp4');
      await run('prepare', () => this.stagePrepare(videoId, dir, source, signal));
      await this.stageTranscribeAndMoments(videoId, options, dir, signal, log);
      await this.stageSelect(videoId, options, signal);
      const meta = parseJson<VideoMeta>((await this.mustVideo(videoId)).metadata, {});
      await this.d.db.video.update({
        where: { id: videoId },
        data: { metadata: JSON.stringify({ ...meta, mainDone: true }) },
      });
      await this.checkCompletion(videoId);
    } catch (err) {
      if (signal.aborted || ctx.signal.aborted) return; // canceled/stopped: state already handled
      await this.fail(videoId, err);
    } finally {
      this.abortByVideo.delete(videoId);
    }
  }

  private async fail(videoId: string, err: unknown): Promise<void> {
    const message = userMessage(err);
    this.d.log(
      `pipeline ${videoId} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
    const states = await this.tracker.load(videoId);
    const running =
      states.find((s) => s.status === 'running') ?? states.find((s) => s.status === 'pending');
    if (running)
      await this.tracker.update(
        videoId,
        running.stage,
        { status: 'failed', error: message, message },
        'failed',
      );
    const row = await this.d.db.video.findUnique({
      where: { id: videoId },
      select: { title: true },
    });
    await this.d.notifications.create({
      kind: 'job',
      level: 'error',
      title: 'Clipping failed',
      body: `${row?.title ?? 'Video'}: ${message}`,
      href: `/library/video/?id=${videoId}`,
      os: true,
    });
    if (err instanceof BudgetExceededError) {
      await this.d.notifications.create({
        kind: 'system',
        level: 'warning',
        title: 'AI budget reached',
        body: message,
        href: '/settings/models/',
      });
    }
  }

  /* ------------------------------------------------------------------------ stages ----------- */

  private async stageIngest(
    videoId: string,
    options: PipelineOptions,
    dir: string,
    signal: AbortSignal,
  ): Promise<void> {
    const t = this.tracker;
    const video = await this.mustVideo(videoId);
    const cookies = this.d.cookiesFromBrowser();
    let info = parseJson<VideoMeta>(video.metadata, {}).info;
    if (!info) {
      await t.update(videoId, 'ingest', { message: 'Reading video details…' });
      info = await this.d.ingest.probe(video.sourceUrl, { cookiesFromBrowser: cookies, signal });
      if (info.isLive)
        throw new IngestError(
          'This is a live stream. Live Clipping arrives in a later version.',
          'live',
        );
      await this.d.db.video.update({
        where: { id: videoId },
        data: {
          title: info.title,
          channel: info.channel,
          durationSec: info.durationSec,
          thumbnail: info.thumbnail,
          metadata: JSON.stringify({ ...parseJson<VideoMeta>(video.metadata, {}), info }),
        },
      });
      await this.emitVideo(videoId);
    }
    const source = path.join(dir, 'source.mp4');
    if (fs.existsSync(source) && fs.statSync(source).size > 0) return;
    await this.downloadSource(
      video.sourceUrl,
      dir,
      options.maxResolution,
      cookies,
      signal,
      (f, msg) =>
        void t.update(videoId, 'ingest', {
          progress: f,
          message: 'Downloading',
          detail: msg ?? null,
        }),
    );
  }

  private async downloadSource(
    url: string,
    dir: string,
    maxResolution: number,
    cookies: string | undefined,
    signal: AbortSignal,
    onProgress: (f: number | null, msg?: string) => void,
  ): Promise<void> {
    const { filePath } = await this.d.ingest.download(url, dir, {
      maxResolution,
      cookiesFromBrowser: cookies,
      signal,
      onProgress,
    });
    const target = path.join(dir, 'source.mp4');
    if (path.resolve(filePath) !== path.resolve(target)) fs.renameSync(filePath, target);
  }

  /** Lazily guarantees the full-res source exists locally (re-downloading after cleanup). */
  async ensureSource(videoId: string, signal?: AbortSignal): Promise<string> {
    const dir = path.join(this.d.cacheDir, videoId);
    const target = path.join(dir, 'source.mp4');
    if (fs.existsSync(target) && fs.statSync(target).size > 0) return target;
    const existing = this.sourceLocks.get(videoId);
    if (existing) return existing;
    const p = (async () => {
      const video = await this.mustVideo(videoId);
      fs.mkdirSync(dir, { recursive: true });
      this.d.log(`re-downloading source for ${videoId}`);
      const options = readOptions(video.options);
      await this.downloadSource(
        video.sourceUrl,
        dir,
        options.maxResolution,
        this.d.cookiesFromBrowser(),
        signal ?? new AbortController().signal,
        () => {},
      );
      return target;
    })().finally(() => this.sourceLocks.delete(videoId));
    this.sourceLocks.set(videoId, p);
    return p;
  }

  private async stagePrepare(
    videoId: string,
    dir: string,
    source: string,
    signal: AbortSignal,
  ): Promise<void> {
    const t = this.tracker;
    const info = await this.d.media.probe(source);
    if (!info.hasVideo) throw new Error('The downloaded file has no video stream.');
    await this.d.db.video.update({
      where: { id: videoId },
      data: { durationSec: info.durationSec },
    });
    const wav = path.join(dir, 'audio.wav');
    const proxy = path.join(dir, 'proxy.mp4');
    if (!fs.existsSync(wav)) {
      await t.update(videoId, 'prepare', { message: 'Extracting audio' });
      await this.d.media.extractAudio16k(source, wav, {
        signal,
        onProgress: (f) =>
          void t.update(videoId, 'prepare', { progress: f === null ? null : f * 0.35 }),
      });
    }
    if (!fs.existsSync(proxy)) {
      await t.update(videoId, 'prepare', { message: 'Creating 480p proxy' });
      await this.d.media.makeProxy(source, proxy, {
        signal,
        onProgress: (f) =>
          void t.update(videoId, 'prepare', { progress: f === null ? null : 0.35 + f * 0.55 }),
      });
    }
    const scenesFile = path.join(dir, 'scenes.json');
    if (!fs.existsSync(scenesFile)) {
      await t.update(videoId, 'prepare', { message: 'Detecting shots', progress: 0.9 });
      await this.d.sidecar.start();
      try {
        const res = await this.d.sidecar.scenes({ video_path: proxy }, { signal });
        fs.writeFileSync(scenesFile, JSON.stringify({ cuts: res.cuts }));
      } catch (e) {
        if (signal.aborted) throw e;
        this.d.log(`scene detection failed (continuing without cuts): ${String(e)}`);
        fs.writeFileSync(scenesFile, JSON.stringify({ cuts: [] }));
      }
    }
  }

  /**
   * Streaming core: transcribe window k → rank moments in window k (while window k+1 transcribes) →
   * create clips → start rendering the strong ones immediately. `understand` runs once the whole
   * transcript exists, concurrently with the last ranking/render work.
   */
  private async stageTranscribeAndMoments(
    videoId: string,
    options: PipelineOptions,
    dir: string,
    signal: AbortSignal,
    log: (m: string) => void,
  ): Promise<void> {
    const t = this.tracker;
    const momentsStatus = await t.status(videoId, 'moments');
    const alreadyDone =
      (await t.status(videoId, 'transcribe')) === 'done' &&
      (momentsStatus === 'done' || momentsStatus === 'skipped');
    if (alreadyDone) {
      if ((await t.status(videoId, 'understand')) !== 'done')
        await this.stageUnderstand(videoId, signal);
      return;
    }
    const video = await this.mustVideo(videoId);
    const duration = video.durationSec ?? 0;
    if (duration <= 0) throw new Error('Could not determine the video duration.');
    const storage = this.mustStorage();
    const model = this.d.whisperModel();
    const sourceId = video.sourceId ?? videoId;
    const cacheBase = `cache/yt-${sourceId}/${model}`;

    await t.update(videoId, 'transcribe', {
      status: 'running',
      progress: 0,
      message: 'Starting transcription engine…',
      error: null,
    });
    await t.update(videoId, 'moments', {
      status: 'running',
      progress: 0,
      message: 'Waiting for the first transcript window…',
      error: null,
    });
    await this.d.sidecar.start();

    // Cross-run cache (BRIEF §4: "cache every intermediate keyed by content"): same video + model = no ASR.
    const cached = await this.loadTranscriptCache(storage, cacheBase);
    const wav = path.join(dir, 'audio.wav');
    const total = Math.max(1, Math.ceil(duration / WINDOW_SEC));
    const words: Word[] = [];
    const signalParts: { start: number; signals: AudioSignals }[] = [];
    const sceneCuts = parseJson<{ cuts: number[] }>(
      fs.readFileSync(path.join(dir, 'scenes.json'), 'utf8'),
      { cuts: [] },
    ).cuts;
    let language = 'en';
    let languageProbability = 1;
    let modelName = model;
    const { maxSec } = durationRange(options);
    const overlapSec = maxSec + 15;
    const wantedPerWindow =
      options.clipCount === null
        ? 6
        : Math.max(
            2,
            Math.ceil(((options.clipCount * WINDOW_SEC) / Math.max(duration, 1)) * 1.8) + 1,
          );

    let rankChain: Promise<void> = Promise.resolve();
    let rankError: unknown = null;

    for (let k = 0; k < total; k++) {
      if (signal.aborted) throw new Error('canceled');
      const wStart = k * WINDOW_SEC;
      const wEnd = Math.min((k + 1) * WINDOW_SEC, duration);
      let windowWords: Word[];
      let windowSignals: AudioSignals;
      if (cached) {
        windowWords = cached.transcript.words.filter(
          (w) => mid(w) >= wStart && mid(w) < (k === total - 1 ? Infinity : wEnd),
        );
        windowSignals = sliceSignals(cached.signals, wStart, wEnd);
        language = cached.transcript.language;
        languageProbability = cached.transcript.languageProbability;
        modelName = cached.transcript.model;
        await t.update(videoId, 'transcribe', {
          progress: (k + 1) / total,
          message: `Using cached transcript (window ${k + 1}/${total})`,
        });
      } else {
        const slice = path.join(dir, `win-${k}.wav`);
        const padStart = Math.max(0, wStart - TRANSCRIBE_PAD_SEC);
        const padEnd = Math.min(duration, wEnd + TRANSCRIBE_PAD_SEC);
        await this.d.media.extractAudio16k(wav, slice, {
          startSec: padStart,
          durSec: padEnd - padStart,
          signal,
        });
        await t.update(videoId, 'transcribe', {
          progress: k / total,
          message: `Transcribing window ${k + 1}/${total}`,
          detail: `${fmt(wStart)}–${fmt(wEnd)}`,
        });
        const res = await this.d.sidecar.transcribe(
          {
            audio_path: slice,
            model,
            language: options.language ?? undefined,
            vad_filter: true,
            condition_on_previous_text: false,
          },
          { signal },
        );
        fs.rmSync(slice, { force: true });
        if (k === 0) {
          language = res.language;
          languageProbability = res.language_probability;
          modelName = res.model;
        }
        windowWords = [];
        for (const seg of res.segments) {
          for (const w of seg.words) {
            const word: Word = {
              w: w.word,
              s: w.start + padStart,
              e: w.end + padStart,
              p: w.probability,
            };
            if (mid(word) >= wStart && mid(word) < wEnd) windowWords.push(word);
          }
        }
        // Exact (un-padded) slice for the audio signals of this window.
        const sigWav = path.join(dir, `sig-${k}.wav`);
        await this.d.media.extractAudio16k(wav, sigWav, {
          startSec: wStart,
          durSec: wEnd - wStart,
          signal,
        });
        windowSignals = await this.d.analysis.computeSignals({
          wavPath: sigWav,
          words: windowWords.map((w) => ({ ...w, s: w.s - wStart, e: w.e - wStart })),
          durationSec: wEnd - wStart,
          ffmpegPath: this.d.ffmpegPath(),
          signal,
        });
        fs.rmSync(sigWav, { force: true });
        await t.update(videoId, 'transcribe', { progress: (k + 1) / total });
      }
      words.push(...windowWords);
      signalParts.push({ start: wStart, signals: windowSignals });
      const signals = { ...mergeSignals(signalParts, wEnd), sceneCuts };
      const isLast = k === total - 1;
      const transcript = this.buildTranscript(
        words,
        signals,
        wEnd,
        language,
        languageProbability,
        modelName,
      );
      // Rolling copy so clips found in this window can already be captioned by the render worker.
      atomicWrite(path.join(dir, 'transcript.json'), JSON.stringify(transcript));

      // Rank this window while the next one transcribes.
      const snapshotWords = words.length;
      rankChain = rankChain
        .then(async () => {
          if (rankError || signal.aborted || options.mode === 'analysis') return;
          await t.update(videoId, 'moments', {
            message: `Finding moments in window ${k + 1}/${total}`,
            progress: k / total,
          });
          await this.rankWindow({
            videoId,
            options,
            transcript,
            signals,
            k,
            total,
            wStart,
            wEnd,
            isLast,
            overlapSec,
            maxPerWindow: wantedPerWindow,
            signal,
            log,
          });
          await t.update(videoId, 'moments', { progress: (k + 1) / total });
        })
        .catch((e) => {
          rankError = e;
        });
      void snapshotWords;
      if (rankError) break;
    }
    await rankChain;
    if (rankError) throw rankError;
    if (signal.aborted) throw new Error('canceled');

    const signals = { ...mergeSignals(signalParts, duration), sceneCuts };
    const transcript = this.buildTranscript(
      words,
      signals,
      duration,
      language,
      languageProbability,
      modelName,
    );
    await t.update(videoId, 'transcribe', {
      status: 'done',
      progress: 1,
      message: null,
      detail: `${transcript.words.length} words`,
    });
    // Persist artifacts (and the cross-run cache).
    const tJson = JSON.stringify(transcript);
    const sJson = JSON.stringify(signals);
    atomicWrite(path.join(dir, 'transcript.json'), tJson);
    fs.writeFileSync(path.join(dir, 'signals.json'), sJson);
    await Promise.all([
      storage.put(keys.transcript(videoId), tJson, { contentType: 'application/json' }),
      storage.put(keys.signals(videoId), sJson, { contentType: 'application/json' }),
      cached
        ? Promise.resolve()
        : storage.put(`${cacheBase}/transcript.json`, tJson, { contentType: 'application/json' }),
      cached
        ? Promise.resolve()
        : storage.put(`${cacheBase}/signals.json`, sJson, { contentType: 'application/json' }),
    ]);
    await t.update(
      videoId,
      'moments',
      options.mode === 'analysis'
        ? { status: 'skipped', progress: 1, message: 'Analysis only' }
        : { status: 'done', progress: 1, message: null },
    );
    await this.stageUnderstand(videoId, signal);
  }

  private async loadTranscriptCache(
    storage: StorageProvider,
    base: string,
  ): Promise<{ transcript: Transcript; signals: AudioSignals } | null> {
    try {
      const [th, sh] = await Promise.all([
        storage.head(`${base}/transcript.json`),
        storage.head(`${base}/signals.json`),
      ]);
      if (!th || !sh) return null;
      const transcript = transcriptSchema.parse(
        JSON.parse((await storage.get(`${base}/transcript.json`)).toString('utf8')),
      );
      const signals = audioSignalsSchema.parse(
        JSON.parse((await storage.get(`${base}/signals.json`)).toString('utf8')),
      );
      return { transcript, signals };
    } catch (e) {
      this.d.log(`transcript cache miss/invalid: ${String(e)}`);
      return null;
    }
  }

  private buildTranscript(
    words: Word[],
    signals: AudioSignals,
    durationSec: number,
    language: string,
    languageProbability: number,
    model: string,
  ): Transcript {
    return {
      language,
      languageProbability,
      durationSec,
      model,
      words,
      sentences: this.d.analysis.segmentSentences(words, signals),
    };
  }

  private async stageUnderstand(videoId: string, signal: AbortSignal): Promise<void> {
    const t = this.tracker;
    if ((await t.status(videoId, 'understand')) === 'done') return;
    await t.update(videoId, 'understand', {
      status: 'running',
      progress: null,
      message: 'Summarising, chaptering and taking notes…',
      error: null,
    });
    const video = await this.mustVideo(videoId);
    const dir = path.join(this.d.cacheDir, videoId);
    const storage = this.mustStorage();
    const transcript = transcriptSchema.parse(
      JSON.parse(fs.readFileSync(path.join(dir, 'transcript.json'), 'utf8')),
    );
    const info = parseJson<VideoMeta>(video.metadata, {}).info;
    const analysis = await this.d.llm.understand({
      info: {
        title: info?.title ?? video.title,
        channel: info?.channel ?? video.channel,
        description: info?.description ?? null,
        chapters: info?.chapters ?? [],
      },
      transcript,
      signal,
      onProgress: (f, m) =>
        void t.update(videoId, 'understand', {
          progress: f,
          message: m ?? 'Understanding the video…',
        }),
    });
    const json = JSON.stringify(analysis);
    fs.writeFileSync(path.join(dir, 'analysis.json'), json);
    await storage.put(keys.analysis(videoId), json, { contentType: 'application/json' });
    await t.update(videoId, 'understand', { status: 'done', progress: 1, message: null });
  }

  /** Window ranking → clip rows → eager rendering. */
  private async rankWindow(a: {
    videoId: string;
    options: PipelineOptions;
    transcript: Transcript;
    signals: AudioSignals;
    k: number;
    total: number;
    wStart: number;
    wEnd: number;
    isLast: boolean;
    overlapSec: number;
    maxPerWindow: number;
    signal: AbortSignal;
    log: (m: string) => void;
    runId?: string | null;
    analysis?: VideoAnalysis | null;
    /** Skip candidates overlapping existing clips? (steered runs keep them: the better-scored duplicate check happens in addMoment) */
  }): Promise<string[]> {
    const video = await this.mustVideo(a.videoId);
    const info = parseJson<VideoMeta>(video.metadata, {}).info;
    const ctxStart = Math.max(0, a.wStart - a.overlapSec);
    // The overlap context (before wStart) is only there so a story that began just before the window
    // can be read in full; moments that START in it belong to the previous window. Only hint at
    // candidates in the new region, and ask for a couple of spares since some picks may still be
    // discarded as belonging to the previous window.
    const candidates = this.d.moments
      .generateCandidates({
        transcript: a.transcript,
        signals: a.signals,
        options: a.options,
        window: { startSec: ctxStart, endSec: a.wEnd },
        maxCandidates: 40,
      })
      .filter((c) => c.s >= a.wStart - 1)
      .slice(0, 30);
    let sentences = a.transcript.sentences.filter((s) => s.e > ctxStart && s.s < a.wEnd);
    if (!a.isLast && sentences.length > 1) {
      const last = sentences[sentences.length - 1];
      if (last && !/[.!?…"”)]$/.test(last.text.trim())) sentences = sentences.slice(0, -1);
    }
    if (sentences.length === 0) return [];
    let ranked: RankedMoment[];
    try {
      ranked = await this.d.llm.rankMoments({
        videoId: a.videoId,
        info: { title: info?.title ?? video.title, channel: info?.channel ?? video.channel },
        analysis: a.analysis ?? null,
        options: a.options,
        window: { startSec: ctxStart, endSec: sentences[sentences.length - 1]?.e ?? a.wEnd },
        sentences,
        candidates,
        maxClips: a.maxPerWindow + (a.k > 0 ? 2 : 0),
        signal: a.signal,
      });
    } catch (e) {
      // A safety refusal on one window must not sink the whole video: skip that window and carry on.
      if (e instanceof LlmError && e.code === 'refusal') {
        a.log(`window ${a.k + 1}/${a.total}: model declined (refusal) — skipping this window`);
        return [];
      }
      throw e;
    }
    a.log(
      `window ${a.k + 1}/${a.total}: ${candidates.length} candidates → ${ranked.length} ranked`,
    );
    const created: string[] = [];
    for (const r of ranked) {
      const id = await this.addMoment(
        a.videoId,
        a.options,
        a.transcript,
        a.signals,
        r,
        a.wStart - 1,
        a.log,
        a.runId ?? null,
      );
      if (id) created.push(id);
    }
    return created;
  }

  private async addMoment(
    videoId: string,
    options: PipelineOptions,
    transcript: Transcript,
    signals: AudioSignals,
    r: RankedMoment,
    minStart: number,
    log: (m: string) => void,
    runId: string | null = null,
  ): Promise<string | null> {
    const snapped = this.d.moments.snap({
      startSec: r.startSec,
      endSec: r.endSec,
      transcript,
      signals,
      options,
    });
    const { minSec, maxSec } = durationRange(options);
    const dur = snapped.endSec - snapped.startSec;
    const tag = `"${r.title.slice(0, 40)}" ${fmt(snapped.startSec)}–${fmt(snapped.endSec)}`;
    if (dur < minSec * 0.8 || dur > maxSec * 1.15) {
      log(`skip ${tag}: ${Math.round(dur)} s is outside ${minSec}–${maxSec} s`);
      return null;
    }
    if (snapped.startSec < Math.max(0, minStart)) {
      log(`skip ${tag}: starts before this window (belongs to the previous one)`);
      return null;
    }
    const score = totalScore(r.breakdown);
    if (score < options.minScore) {
      log(`skip ${tag}: score ${score} < minimum ${options.minScore}`);
      return null;
    }
    const existing = await this.d.db.clip.findMany({ where: { videoId } });
    for (const e of existing) {
      const inter = Math.min(e.endSec, snapped.endSec) - Math.max(e.startSec, snapped.startSec);
      const union = Math.max(e.endSec, snapped.endSec) - Math.min(e.startSec, snapped.startSec);
      if (union > 0 && inter / union > 0.35) {
        if ((e.score ?? 0) >= score || e.status !== 'candidate') {
          log(
            `skip ${tag}: overlaps a better clip (${fmt(e.startSec)}–${fmt(e.endSec)}, score ${e.score})`,
          );
          return null;
        }
        await this.d.db.clip.delete({ where: { id: e.id } }); // replace a weaker un-rendered duplicate
      }
    }
    const row = await this.d.db.clip.create({
      data: {
        videoId,
        title: r.title,
        hook: r.hook,
        startSec: snapped.startSec,
        endSec: snapped.endSec,
        score,
        scoreDetail: JSON.stringify(r.breakdown),
        aspect: options.aspect,
        runId,
        captionStyleId: options.captionStyleId,
        reframeMode: options.reframeMode,
        metadata: JSON.stringify({
          whyItWorks: r.whyItWorks,
          confidence: r.confidence,
          keywords: r.keywords,
          captionStyle: r.captionStyle,
        }),
      },
    });
    await this.emitClip(row.id);
    await this.emitVideo(videoId);
    const rendering = await this.d.db.clip.count({
      where: { videoId, status: { in: ['queued', 'rendering', 'rendered'] } },
    });
    const budget = options.clipCount ?? Infinity;
    // Steered runs are rendered by the run itself (it knows how many the user asked for).
    if (!runId && score >= EAGER_RENDER_SCORE && rendering < budget)
      await this.queueRender(videoId, row.id);
    return row.id;
  }

  /** After every window: keep the best N (or all ≥ minScore), drop the rest, render what's left. */
  private async stageSelect(
    videoId: string,
    options: PipelineOptions,
    _signal: AbortSignal,
  ): Promise<void> {
    const t = this.tracker;
    if ((await t.status(videoId, 'render')) === 'done') return;
    if (options.mode === 'analysis') {
      await t.update(videoId, 'render', {
        status: 'skipped',
        message: 'Analysis only — no clips requested',
      });
      return;
    }
    await t.update(videoId, 'render', {
      status: 'running',
      progress: 0,
      message: 'Preparing clips…',
      error: null,
    });
    const all = await this.d.db.clip.findMany({
      where: { videoId },
      orderBy: [{ score: 'desc' }, { startSec: 'asc' }],
    });
    const eligible = all.filter((c) => (c.score ?? 0) >= options.minScore);
    const keep = options.clipCount === null ? eligible : eligible.slice(0, options.clipCount);
    const keepIds = new Set(keep.map((c) => c.id));
    const drop = all.filter((c) => !keepIds.has(c.id));
    if (drop.length) await this.deleteClips(drop.map((c) => c.id));
    for (let i = 0; i < keep.length; i++) {
      const c = keep[i];
      if (!c) continue;
      await this.d.db.clip.update({ where: { id: c.id }, data: { rank: i + 1 } });
      if (c.status === 'candidate') await this.queueRender(videoId, c.id);
    }
    if (keep.length === 0) {
      await t.update(videoId, 'render', {
        status: 'skipped',
        message: 'No moments scored high enough',
      });
    }
    await this.emitVideo(videoId);
  }

  async queueRender(videoId: string, clipId: string): Promise<void> {
    const clip = await this.d.db.clip.findUnique({ where: { id: clipId } });
    if (!clip || ['queued', 'rendering'].includes(clip.status)) return;
    await this.d.db.clip.update({
      where: { id: clipId },
      data: { status: 'queued', error: null, renderProgress: 0 },
    });
    await this.emitClip(clipId);
    await this.d.queue.enqueue({
      kind: JOB_RENDER,
      payload: { clipId, videoId },
      groupKey: videoId,
      priority: 1,
    });
  }

  /* ------------------------------------------------------------- steered moment runs ------- */

  /** "Find more like…" — re-runs moment finding on an already transcribed video with a free-text prompt (BRIEF §4.5). */
  async startMomentsRun(
    videoId: string,
    prompt: string,
    patch?: Partial<PipelineOptions>,
  ): Promise<{ runId: string }> {
    const notReady = await this.d.checkReady();
    if (notReady) throw new AppError('UNAVAILABLE', notReady);
    const video = await this.mustVideo(videoId);
    if (['new', 'ingesting', 'processing'].includes(video.status))
      throw new AppError('VALIDATION', 'Wait until this video has finished processing.');
    if (!(await this.loadTranscript(videoId)))
      throw new AppError('NOT_FOUND', 'This video has no transcript yet.');
    const clean = Object.fromEntries(Object.entries(patch ?? {}).filter(([, v]) => v !== undefined));
    const options = pipelineOptionsSchema.parse({
      ...readOptions(video.options),
      ...clean,
      prompt: prompt.trim(),
    });
    const row = await this.d.db.momentRun.create({
      data: { videoId, prompt: prompt.trim(), options: JSON.stringify(options) },
    });
    await this.d.queue.enqueue({
      kind: JOB_MOMENTS_RUN,
      payload: { runId: row.id, videoId },
      groupKey: videoId,
    });
    this.d.emitRun(toRunView(row));
    return { runId: row.id };
  }

  async listRuns(videoId: string): Promise<MomentRun[]> {
    const rows = await this.d.db.momentRun.findMany({
      where: { videoId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toRunView);
  }

  async cancelRun(runId: string): Promise<void> {
    const jobs = await this.d.db.job.findMany({
      where: { kind: JOB_MOMENTS_RUN, status: { in: ['queued', 'running'] }, payload: { contains: runId } },
    });
    for (const j of jobs) await this.d.queue.cancel(j.id);
    const row = await this.d.db.momentRun.updateMany({
      where: { id: runId, status: 'running' },
      data: { status: 'canceled', finishedAt: new Date() },
    });
    if (row.count > 0) {
      const fresh = await this.d.db.momentRun.findUnique({ where: { id: runId } });
      if (fresh) this.d.emitRun(toRunView(fresh));
    }
  }

  private async momentsRun(ctx: JobContext<{ runId: string; videoId: string }>): Promise<void> {
    const { runId, videoId } = ctx.payload;
    const run = await this.d.db.momentRun.findUnique({ where: { id: runId } });
    if (!run || run.status !== 'running') return;
    const log = (m: string) => this.d.log(`[${videoId.slice(-6)} run ${runId.slice(-5)}] ${m}`);
    const finish = async (data: { status: string; found?: number; error?: string | null }) => {
      const row = await this.d.db.momentRun
        .update({ where: { id: runId }, data: { ...data, finishedAt: new Date() } })
        .catch(() => null);
      if (row) this.d.emitRun(toRunView(row));
    };
    try {
      const options = pipelineOptionsSchema.parse(parseJson<unknown>(run.options, {}));
      const [transcript, signals, analysis, video] = await Promise.all([
        this.loadTranscript(videoId),
        this.loadSignals(videoId),
        this.loadAnalysis(videoId),
        this.mustVideo(videoId),
      ]);
      if (!transcript || !signals) throw new Error('The transcript of this video is not available.');
      const { maxSec } = durationRange(options);
      const overlapSec = maxSec + 15;
      const duration = transcript.durationSec;
      const total = Math.max(1, Math.ceil(duration / WINDOW_SEC));
      const wanted = options.clipCount ?? 6;
      const perWindow = Math.max(3, Math.ceil((wanted * 1.5) / total) + 1);
      const created: string[] = [];
      for (let k = 0; k < total; k++) {
        if (ctx.signal.aborted) throw new Error('canceled');
        await ctx.progress(k / total, `Window ${k + 1}/${total}`);
        const wStart = k * WINDOW_SEC;
        const wEnd = Math.min((k + 1) * WINDOW_SEC, duration);
        const ids = await this.rankWindow({
          videoId,
          options,
          transcript,
          signals,
          k,
          total,
          wStart,
          wEnd,
          isLast: k === total - 1,
          overlapSec,
          maxPerWindow: perWindow,
          signal: ctx.signal,
          log,
          runId,
          analysis,
        });
        created.push(...ids);
      }
      // Keep the best N of this run, drop the rest, render what is left.
      const rows = await this.d.db.clip.findMany({
        where: { id: { in: created } },
        orderBy: [{ score: 'desc' }, { startSec: 'asc' }],
      });
      const keep = rows.slice(0, wanted);
      const drop = rows.slice(wanted);
      if (drop.length) await this.deleteClips(drop.map((c) => c.id));
      for (const c of keep) await this.queueRender(videoId, c.id);
      await this.emitVideo(videoId);
      await finish({ status: 'done', found: keep.length });
      await this.d.notifications.create({
        kind: 'clips-ready',
        level: keep.length ? 'success' : 'warning',
        title: keep.length
          ? `${keep.length} new clip${keep.length === 1 ? '' : 's'} for “${run.prompt.slice(0, 40)}”`
          : 'No new moments found',
        body: keep.length
          ? video.title
          : `Nothing matched “${run.prompt.slice(0, 60)}” beyond the clips you already have.`,
        href: `/library/video/?id=${videoId}`,
        os: false,
      });
    } catch (err) {
      if (ctx.signal.aborted) {
        await finish({ status: 'canceled' });
        return;
      }
      log(`failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      await finish({ status: 'failed', error: userMessage(err) });
    }
  }

  /* ------------------------------------------------------------ completion / finalize -------- */

  async checkCompletion(videoId: string): Promise<void> {
    const video = await this.d.db.video.findUnique({ where: { id: videoId } });
    if (!video || ['canceled', 'failed'].includes(video.status)) return;
    const meta = parseJson<VideoMeta>(video.metadata, {});
    const clips = await this.d.db.clip.findMany({ where: { videoId } });
    const open = clips.filter((c) => c.status === 'queued' || c.status === 'rendering');
    const rendered = clips.filter((c) => c.status === 'rendered').length;
    const tracked = clips.filter((c) => c.status !== 'candidate').length;
    if (tracked > 0 && (await this.tracker.status(videoId, 'render')) === 'running') {
      await this.tracker.update(videoId, 'render', {
        progress: tracked ? (tracked - open.length) / tracked : 1,
        message: `${rendered}/${tracked} clips rendered`,
      });
    }
    if (!meta.mainDone || open.length > 0) return;
    if (this.finalizing.has(videoId)) return;
    this.finalizing.add(videoId);
    try {
      const failedClips = clips.filter((c) => c.status === 'failed').length;
      if ((await this.tracker.status(videoId, 'render')) !== 'skipped') {
        await this.tracker.update(
          videoId,
          'render',
          failedClips && !rendered
            ? {
                status: 'failed',
                error: 'Every clip failed to render. See the clip errors and press Retry.',
              }
            : {
                status: 'done',
                message: failedClips ? `${rendered} rendered, ${failedClips} failed` : null,
              },
        );
      }
      await this.finalize(videoId);
    } catch (e) {
      await this.fail(videoId, e);
    } finally {
      this.finalizing.delete(videoId);
    }
  }

  private async finalize(videoId: string): Promise<void> {
    const t = this.tracker;
    if ((await t.status(videoId, 'finalize')) === 'done') return;
    await t.update(videoId, 'finalize', {
      status: 'running',
      progress: 0,
      message: 'Uploading proxy…',
      error: null,
    });
    const settings = await this.d.settings.get();
    const storage = this.mustStorage();
    const dir = path.join(this.d.cacheDir, videoId);
    const proxy = path.join(dir, 'proxy.mp4');
    const keyMap: Record<string, string> = {};
    if (settings.keepSourceAs !== 'none' && fs.existsSync(proxy)) {
      await storage.putFile(keys.proxy(videoId), proxy, {
        contentType: 'video/mp4',
        onProgress: (l, tot) =>
          void t.update(videoId, 'finalize', { progress: tot ? (l / tot) * 0.9 : null }),
      });
      keyMap.proxy = keys.proxy(videoId);
    }
    const source = path.join(dir, 'source.mp4');
    if (settings.keepSourceAs === 'full' && fs.existsSync(source)) {
      await storage.putFile(keys.source(videoId), source, { contentType: 'video/mp4' });
      keyMap.source = keys.source(videoId);
    }
    keyMap.transcript = keys.transcript(videoId);
    keyMap.analysis = keys.analysis(videoId);
    keyMap.signals = keys.signals(videoId);
    const row = await this.mustVideo(videoId);
    await this.d.db.video.update({
      where: { id: videoId },
      data: {
        storageKeys: JSON.stringify({
          ...parseJson<Record<string, string>>(row.storageKeys, {}),
          ...keyMap,
        }),
      },
    });
    // The full-res source is NOT kept by default (BRIEF §3): free the local disk, keep transcript/analysis locally for speed.
    for (const f of ['source.mp4', 'audio.wav', 'proxy.mp4'])
      fs.rmSync(path.join(dir, f), { force: true });
    await t.update(videoId, 'finalize', { status: 'done', message: null, progress: 1 }, 'ready');
    const clips = await this.d.db.clip.findMany({ where: { videoId, status: 'rendered' } });
    const best = clips.reduce((m, c) => Math.max(m, c.score ?? 0), 0);
    await this.d.notifications.create({
      kind: 'clips-ready',
      level: clips.length ? 'success' : 'warning',
      title: clips.length
        ? `${clips.length} clip${clips.length === 1 ? '' : 's'} ready`
        : 'No clips found',
      body: clips.length
        ? `${row.title}${best ? ` · top score ${best}` : ''}`
        : `${row.title} — no moments scored high enough. Try a lower minimum score or a different clip length.`,
      href: `/library/video/?id=${videoId}`,
      os: true,
    });
    await this.emitVideo(videoId);
    this.tracker.forget(videoId);
  }

  /* ------------------------------------------------------------------------ helpers --------- */

  async notifyFirstClip(videoId: string, title: string): Promise<void> {
    if (this.firstClipNotified.has(videoId)) return;
    this.firstClipNotified.add(videoId);
    await this.d.notifications.create({
      kind: 'clips-ready',
      level: 'success',
      title: 'First clip ready',
      body: title,
      href: `/library/video/?id=${videoId}`,
      os: true,
    });
  }

  async deleteClips(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const storage = this.d.getStorage();
    const rows = await this.d.db.clip.findMany({ where: { id: { in: ids } } });
    await this.d.db.clip.deleteMany({ where: { id: { in: ids } } });
    if (storage) {
      const k: string[] = [];
      for (const c of rows) {
        k.push(keys.clip(c.id), keys.thumb(c.id), keys.ass(c.id), keys.srt(c.id), keys.vtt(c.id));
        // Candidate thumbnail frames (CP2) live under clips/<id>/thumbs/.
        for await (const o of storage.list(`clips/${c.id}/thumbs/`)) k.push(o.key);
      }
      await storage.delete(k).catch((e) => this.d.log(`storage delete failed: ${String(e)}`));
      this.d.invalidateStorage();
    }
    for (const c of rows)
      fs.rmSync(path.join(this.d.cacheDir, c.videoId, 'clips', c.id), {
        recursive: true,
        force: true,
      });
  }

  async cancelJob(jobId: string): Promise<void> {
    await this.d.queue.cancel(jobId);
  }

  private async cancelJobs(videoId: string): Promise<void> {
    const jobs = await this.d.db.job.findMany({
      where: { groupKey: videoId, status: { in: ['queued', 'running'] } },
    });
    for (const j of jobs) await this.d.queue.cancel(j.id);
  }

  private mustStorage(): StorageProvider {
    const s = this.d.getStorage();
    if (!s)
      throw new AppError(
        'UNAVAILABLE',
        'Object storage is not connected. Add your Cloudflare R2 (or Backblaze B2) details in Settings → Storage.',
      );
    return s;
  }

  private async mustVideo(id: string): Promise<VideoRow> {
    const v = await this.d.db.video.findUnique({ where: { id } });
    if (!v) throw new AppError('NOT_FOUND', 'Video not found.');
    return v;
  }

  async videoView(id: string): Promise<VideoView | null> {
    const v = await this.d.db.video.findUnique({ where: { id } });
    if (!v) return null;
    const clips = await this.d.db.clip.findMany({
      where: { videoId: id },
      select: { status: true, score: true },
    });
    return toVideoView(v, {
      clipCount: clips.length,
      renderedCount: clips.filter((c) => c.status === 'rendered').length,
      topScore: clips.reduce<number | null>(
        (m, c) => (c.score !== null && (m === null || c.score > m) ? c.score : m),
        null,
      ),
    });
  }

  async emitVideo(id: string): Promise<void> {
    const v = await this.videoView(id);
    if (v) this.d.emit.video(v);
  }

  async emitClip(id: string): Promise<void> {
    const c = await this.d.db.clip.findUnique({ where: { id } });
    if (!c) return;
    const v = await this.d.db.video.findUnique({
      where: { id: c.videoId },
      select: { title: true },
    });
    const run = c.runId
      ? await this.d.db.momentRun.findUnique({ where: { id: c.runId }, select: { prompt: true } })
      : null;
    this.d.emit.clip(toClipView(c as ClipRow, v?.title ?? null, run?.prompt ?? null));
    if (c.status === 'rendered') await this.notifyFirstClip(c.videoId, c.title);
  }

  /** Parsed analysis for the detail page (local cache first, then storage). */
  async loadAnalysis(videoId: string): Promise<VideoAnalysis | null> {
    const local = path.join(this.d.cacheDir, videoId, 'analysis.json');
    try {
      if (fs.existsSync(local))
        return videoAnalysisSchema.parse(JSON.parse(fs.readFileSync(local, 'utf8')));
      const storage = this.d.getStorage();
      if (!storage || !(await storage.head(keys.analysis(videoId)))) return null;
      return videoAnalysisSchema.parse(
        JSON.parse((await storage.get(keys.analysis(videoId))).toString('utf8')),
      );
    } catch {
      return null;
    }
  }

  async loadSignals(videoId: string): Promise<AudioSignals | null> {
    const local = path.join(this.d.cacheDir, videoId, 'signals.json');
    try {
      if (fs.existsSync(local))
        return audioSignalsSchema.parse(JSON.parse(fs.readFileSync(local, 'utf8')));
      const storage = this.d.getStorage();
      if (!storage || !(await storage.head(keys.signals(videoId)))) return null;
      return audioSignalsSchema.parse(
        JSON.parse((await storage.get(keys.signals(videoId))).toString('utf8')),
      );
    } catch {
      return null;
    }
  }

  async loadTranscript(videoId: string): Promise<Transcript | null> {
    const local = path.join(this.d.cacheDir, videoId, 'transcript.json');
    try {
      if (fs.existsSync(local))
        return transcriptSchema.parse(JSON.parse(fs.readFileSync(local, 'utf8')));
      const storage = this.d.getStorage();
      if (!storage || !(await storage.head(keys.transcript(videoId)))) return null;
      return transcriptSchema.parse(
        JSON.parse((await storage.get(keys.transcript(videoId))).toString('utf8')),
      );
    } catch {
      return null;
    }
  }
}

function atomicWrite(file: string, data: string): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export function toRunView(r: {
  id: string;
  videoId: string;
  prompt: string;
  status: string;
  found: number;
  error: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}): MomentRun {
  return {
    id: r.id,
    videoId: r.videoId,
    prompt: r.prompt,
    status: (['running', 'done', 'failed', 'canceled'] as const).find((x) => x === r.status) ?? 'failed',
    found: r.found,
    error: r.error,
    createdAt: r.createdAt.getTime(),
    finishedAt: r.finishedAt ? r.finishedAt.getTime() : null,
  };
}

const mid = (w: Word): number => (w.s + w.e) / 2;
const fmt = (s: number): string =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function userMessage(err: unknown): string {
  if (err instanceof IngestError || err instanceof BudgetExceededError || err instanceof AppError)
    return err.message;
  const m = err instanceof Error ? err.message : String(err);
  return m.length > 400 ? `${m.slice(0, 400)}…` : m;
}

/** Slice a signals object to [start,end) and re-base it to 0 (used when serving cached whole-video signals). */
export function sliceSignals(s: AudioSignals, start: number, end: number): AudioSignals {
  const i0 = Math.floor(start / s.hopSec);
  const i1 = Math.ceil(end / s.hopSec);
  return {
    hopSec: s.hopSec,
    durationSec: end - start,
    loudness: s.loudness.slice(i0, i1),
    speechRate: s.speechRate.slice(i0, i1),
    silences: s.silences
      .filter((x) => x.e > start && x.s < end)
      .map((x) => ({ s: Math.max(x.s, start) - start, e: Math.min(x.e, end) - start })),
    laughter: s.laughter
      .filter((x) => x.e > start && x.s < end)
      .map((x) => ({ ...x, s: Math.max(x.s, start) - start, e: Math.min(x.e, end) - start })),
    speakerChanges: s.speakerChanges.filter((x) => x >= start && x < end).map((x) => x - start),
    sceneCuts: [],
  };
}
