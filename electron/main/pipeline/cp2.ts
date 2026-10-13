import fs from 'node:fs';
import path from 'node:path';
import { pipeline as streamPipeline } from 'node:stream/promises';
import {
  keys2,
  subtitleEditsSchema,
  type CaptionStyle,
  type ClipHooks,
  type ClipMeta,
  type ClipThumbnails,
  type Cue,
  type HighlightPlan,
  type Marker,
  type Platform,
  type PlatformMeta,
  type ReframeMode,
  type SubtitleEdits,
} from '@shared/cp2';
import {
  keys,
  transcriptSchema,
  type PipelineOptions,
  type Transcript,
  type UrlInfo,
  type Word,
} from '@shared/pipeline';
import type { Db } from '../db/client';
import { AppError } from '../ipc/dispatch';
import type { JobContext, JobQueue } from '../services/queue';
import type { StorageProvider } from '../services/storage/provider';
import type { CaptionService, MomentService } from './contracts';
import type {
  ClipContext,
  FrameScorer,
  HighlightCandidate,
  LlmServiceV2,
  SubtitleService,
  ThumbnailService,
} from './contracts2';
import { JOB_RENDER, type PipelineOrchestrator } from './orchestrator';
import type { StyleRegistry } from './styles';
import type { ClipMetaJson } from './render-worker';
import { parseJson, readOptions } from './views';

export const JOB_HIGHLIGHT = 'pipeline.highlight';
const PREVIEW_SIZES: Record<string, { w: number; h: number }> = {
  '9:16': { w: 540, h: 960 },
  '1:1': { w: 720, h: 720 },
  '4:5': { w: 648, h: 810 },
  '16:9': { w: 960, h: 540 },
};
const THUMB_CANDIDATES = 8;

/** Everything `Clip.metadata` may hold (render-worker keys + the CP2 artifacts). */
type ClipMetaAll = ClipMetaJson & {
  hooks?: ClipHooks | null;
  meta?: ClipMeta | null;
  thumbs?: (ClipThumbnails & Record<string, unknown>) | null;
};

export interface Cp2Deps {
  db: Db;
  queue: JobQueue;
  orchestrator: PipelineOrchestrator;
  styles: StyleRegistry;
  captions: CaptionService;
  subtitles: SubtitleService;
  thumbnails: ThumbnailService;
  moments: MomentService;
  llm: LlmServiceV2;
  frameScorer: FrameScorer;
  getStorage(): StorageProvider | null;
  invalidateStorage(): void;
  cacheDir: string;
  ffmpegPath(): string;
  fontsDir(): string | null;
  /** Save dialog + write; null when the user canceled. */
  saveText(opts: { title: string; defaultName: string; extension: string }, content: string): Promise<string | null>;
  emit: { markers(videoId: string): void };
  log: (m: string) => void;
}

/** CP2 features that sit on top of the pipeline: styles, subtitles, highlights, hooks, metadata, thumbnails, markers. */
export class Cp2Service {
  constructor(private readonly d: Cp2Deps) {}

  registerJobs(): void {
    this.d.queue.register<{ clipId: string; videoId: string; prompt: string }>(
      JOB_HIGHLIGHT,
      async (ctx) => this.composeHighlight(ctx),
      { concurrency: 1, maxAttempts: 1 },
    );
  }

  /* ---------------------------------------------------------------- caption styles ---------- */

  async previewStyle(a: {
    style: CaptionStyle;
    text?: string;
    clipId?: string;
    aspect: string;
    activeWord: number;
  }): Promise<{ dataUrl: string; width: number; height: number }> {
    const size = PREVIEW_SIZES[a.aspect] ?? { w: 540, h: 960 };
    const tmp = path.join(this.d.cacheDir, '_preview');
    fs.mkdirSync(tmp, { recursive: true });
    let background: string | null = null;
    if (a.clipId) {
      const storage = this.d.getStorage();
      const bg = path.join(tmp, `bg-${a.clipId}.jpg`);
      try {
        if (storage && (await storage.head(keys.thumb(a.clipId)))) {
          fs.writeFileSync(bg, await storage.get(keys.thumb(a.clipId)));
          background = bg;
        }
      } catch (e) {
        this.d.log(`preview background unavailable: ${String(e)}`);
      }
    }
    const png = await this.d.captions.preview({
      ffmpegPath: this.d.ffmpegPath(),
      fontsDir: this.d.fontsDir(),
      style: a.style,
      text: a.text?.trim() || 'This is how your captions will look',
      activeWord: a.activeWord,
      width: size.w,
      height: size.h,
      backgroundPath: background,
    });
    if (background) fs.rmSync(background, { force: true });
    return { dataUrl: `data:image/png;base64,${png.toString('base64')}`, width: size.w, height: size.h };
  }

  /** Re-render clips with another caption style and/or reframe mode. */
  async restyle(ids: string[], patch: { styleId?: string; reframeMode?: ReframeMode }): Promise<void> {
    if (patch.styleId) {
      const all = await this.d.styles.list();
      if (!all.some((s) => s.id === patch.styleId))
        throw new AppError('NOT_FOUND', 'That caption style no longer exists.');
    }
    await this.d.db.clip.updateMany({
      where: { id: { in: ids } },
      data: {
        ...(patch.styleId ? { captionStyleId: patch.styleId } : {}),
        ...(patch.reframeMode ? { reframeMode: patch.reframeMode } : {}),
      },
    });
    for (const id of ids) await this.d.orchestrator.rerenderClip(id);
  }

  async setVideoCaptionStyle(videoId: string, styleId: string): Promise<void> {
    const all = await this.d.styles.list();
    if (!all.some((s) => s.id === styleId))
      throw new AppError('NOT_FOUND', 'That caption style does not exist.');
    const video = await this.mustVideo(videoId);
    const options = { ...readOptions(video.options), captionStyleId: styleId };
    await this.d.db.video.update({ where: { id: videoId }, data: { options: JSON.stringify(options) } });
    // Clips that are not rendered yet pick the new style up; rendered ones change via clips:restyle.
    await this.d.db.clip.updateMany({
      where: { videoId, status: { in: ['candidate', 'queued'] } },
      data: { captionStyleId: styleId },
    });
    await this.d.orchestrator.emitVideo(videoId);
  }

  /* ------------------------------------------------------------------- subtitles ------------ */

  async loadEdits(videoId: string): Promise<SubtitleEdits> {
    const local = path.join(this.d.cacheDir, videoId, 'subtitle-edits.json');
    try {
      if (fs.existsSync(local)) return subtitleEditsSchema.parse(JSON.parse(fs.readFileSync(local, 'utf8')));
      const storage = this.d.getStorage();
      if (storage && (await storage.head(keys2.subtitleEdits(videoId)))) {
        return subtitleEditsSchema.parse(
          JSON.parse((await storage.get(keys2.subtitleEdits(videoId))).toString('utf8')),
        );
      }
    } catch (e) {
      this.d.log(`subtitle edits unreadable (ignored): ${String(e)}`);
    }
    return subtitleEditsSchema.parse({});
  }

  private async outdatedClips(videoId: string, rev: number): Promise<number> {
    return this.d.db.clip.count({
      where: { videoId, status: 'rendered', subtitleRev: { lt: rev } },
    });
  }

  async subtitlesGet(videoId: string): Promise<{
    cues: Cue[];
    edits: SubtitleEdits;
    language: string;
    outdatedClips: number;
  }> {
    const video = await this.mustVideo(videoId);
    const transcript = await this.mustTranscript(videoId);
    const edits = await this.loadEdits(videoId);
    return {
      cues: this.d.subtitles.cues(transcript.words, edits),
      edits,
      language: transcript.language,
      outdatedClips: await this.outdatedClips(videoId, video.subtitleRev),
    };
  }

  async subtitlesSave(
    videoId: string,
    incoming: SubtitleEdits,
  ): Promise<{ cues: Cue[]; edits: SubtitleEdits; outdatedClips: number }> {
    const video = await this.mustVideo(videoId);
    const transcript = await this.mustTranscript(videoId);
    const edits = subtitleEditsSchema.parse({ ...incoming, rev: video.subtitleRev + 1 });
    const json = JSON.stringify(edits);
    const dir = path.join(this.d.cacheDir, videoId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'subtitle-edits.json'), json);
    const storage = this.d.getStorage();
    if (storage) {
      await storage.put(keys2.subtitleEdits(videoId), json, { contentType: 'application/json' });
      this.d.invalidateStorage();
    }
    await this.d.db.video.update({ where: { id: videoId }, data: { subtitleRev: edits.rev } });
    await this.d.orchestrator.emitVideo(videoId);
    return {
      cues: this.d.subtitles.cues(transcript.words, edits),
      edits,
      outdatedClips: await this.outdatedClips(videoId, edits.rev),
    };
  }

  async subtitlesExport(a: {
    videoId: string;
    clipId?: string;
    format: 'srt' | 'vtt';
  }): Promise<{ saved: boolean; path: string | null }> {
    const video = await this.mustVideo(a.videoId);
    const transcript = await this.mustTranscript(a.videoId);
    const edits = await this.loadEdits(a.videoId);
    const cues = this.d.subtitles.cues(transcript.words, edits);
    let range: { startSec: number; endSec: number } | undefined;
    let base = video.title;
    if (a.clipId) {
      const clip = await this.mustClip(a.clipId);
      if (clip.kind === 'highlight')
        throw new AppError('VALIDATION', 'Highlights reels have their own captions file (download the clip with captions).');
      range = { startSec: clip.startSec, endSec: clip.endSec };
      base = clip.title;
    }
    const text = a.format === 'srt' ? this.d.subtitles.toSrt(cues, range) : this.d.subtitles.toVtt(cues, range);
    const file = await this.d.saveText(
      { title: 'Export subtitles', defaultName: `${slug(base)}.${a.format}`, extension: a.format },
      text,
    );
    return { saved: file !== null, path: file };
  }

  /* ------------------------------------------------------------ one-click highlights -------- */

  async createHighlights(videoId: string, prompt?: string): Promise<{ clipId: string }> {
    const video = await this.mustVideo(videoId);
    if (['new', 'ingesting', 'processing'].includes(video.status))
      throw new AppError('VALIDATION', 'Wait until this video has finished processing.');
    if (!(await this.d.orchestrator.loadTranscript(videoId)))
      throw new AppError('NOT_FOUND', 'This video has no transcript yet.');
    const options = readOptions(video.options);
    const row = await this.d.db.clip.create({
      data: {
        videoId,
        kind: 'highlight',
        title: 'Highlights reel',
        startSec: 0,
        endSec: 0,
        status: 'queued',
        renderProgress: 0,
        aspect: options.aspect,
        captionStyleId: options.captionStyleId,
        reframeMode: options.reframeMode,
        metadata: JSON.stringify({ composing: true }),
      },
    });
    await this.d.orchestrator.emitClip(row.id);
    await this.d.queue.enqueue({
      kind: JOB_HIGHLIGHT,
      payload: { clipId: row.id, videoId, prompt: prompt?.trim() ?? '' },
      groupKey: videoId,
    });
    return { clipId: row.id };
  }

  private async composeHighlight(
    ctx: JobContext<{ clipId: string; videoId: string; prompt: string }>,
  ): Promise<void> {
    const { clipId, videoId, prompt } = ctx.payload;
    const fail = async (message: string) => {
      await this.d.db.clip
        .update({ where: { id: clipId }, data: { status: 'failed', error: message.slice(0, 400), renderProgress: null } })
        .catch(() => {});
      await this.d.orchestrator.emitClip(clipId);
    };
    try {
      const video = await this.mustVideo(videoId);
      const options = readOptions(video.options);
      const [transcript, signals, analysis] = await Promise.all([
        this.mustTranscript(videoId),
        this.d.orchestrator.loadSignals(videoId),
        this.d.orchestrator.loadAnalysis(videoId),
      ]);
      const info = this.infoOf(video);
      const candidates = await this.highlightCandidates(videoId, transcript, signals, options);
      if (candidates.length < 2)
        throw new Error('Not enough strong moments in this video to build a highlights reel.');
      const plan: HighlightPlan = await this.d.llm.composeHighlights({
        info,
        analysis,
        candidates,
        prompt: prompt || 'The best moments of this video as one tight story.',
        minSec: 30,
        maxSec: 90,
        signal: ctx.signal,
      });
      const segments = plan.segments
        .map((s) => ({ ...alignToWords(transcript.words, s.startSec, s.endSec), role: s.role }))
        .filter((s): s is { startSec: number; endSec: number; role: string } => s.startSec !== null);
      if (segments.length < 2) throw new Error('The model did not return usable highlight segments.');
      const total = segments.reduce((t, s) => t + (s.endSec - s.startSec), 0);
      const first = segments[0];
      await this.d.db.clip.update({
        where: { id: clipId },
        data: {
          title: plan.title.slice(0, 120),
          hook: plan.hook,
          startSec: first?.startSec ?? 0,
          endSec: (first?.startSec ?? 0) + total,
          metadata: JSON.stringify({
            whyItWorks: plan.whyItWorks,
            keywords: [],
            highlight: { segments, transition: plan.transition, title: plan.title, hook: plan.hook },
          } satisfies ClipMetaJson),
        },
      });
      await this.d.orchestrator.emitClip(clipId);
      await this.d.queue.enqueue({
        kind: JOB_RENDER,
        payload: { clipId, videoId },
        groupKey: videoId,
        priority: 1,
      });
    } catch (err) {
      if (ctx.signal.aborted) {
        await this.d.db.clip.delete({ where: { id: clipId } }).catch(() => {});
        return;
      }
      this.d.log(`highlights ${clipId} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      await fail(err instanceof Error ? err.message : String(err));
    }
  }

  private async highlightCandidates(
    videoId: string,
    transcript: Transcript,
    signals: Awaited<ReturnType<PipelineOrchestrator['loadSignals']>>,
    options: PipelineOptions,
  ): Promise<HighlightCandidate[]> {
    const clips = await this.d.db.clip.findMany({
      where: { videoId, kind: 'clip' },
      orderBy: [{ score: 'desc' }],
      take: 10,
    });
    const out: HighlightCandidate[] = clips.map((c) => {
      const m = parseJson<ClipMetaJson>(c.metadata, {});
      return {
        ...this.contextOf(c, transcript),
        whyItWorks: m.whyItWorks ?? null,
        id: c.id,
        sentences: transcript.sentences.filter((s) => s.e > c.startSec && s.s < c.endSec),
      };
    });
    if (out.length < 4 && signals) {
      const gen = this.d.moments.generateCandidates({
        transcript,
        signals,
        options,
        window: { startSec: 0, endSec: transcript.durationSec },
        maxCandidates: 12,
      });
      for (const c of gen) {
        if (out.length >= 10) break;
        if (out.some((o) => Math.min(o.endSec, c.e) - Math.max(o.startSec, c.s) > 0)) continue;
        out.push({
          id: c.id,
          title: c.text.slice(0, 60),
          hook: null,
          startSec: c.s,
          endSec: c.e,
          text: c.text,
          whyItWorks: null,
          score: null,
          sentences: transcript.sentences.filter((s) => s.e > c.s && s.s < c.e),
        });
      }
    }
    return out;
  }

  /* ----------------------------------------------------------------------- hooks ------------ */

  async hooksGet(clipId: string): Promise<ClipHooks | null> {
    const clip = await this.mustClip(clipId);
    return parseJson<ClipMetaAll>(clip.metadata, {}).hooks ?? null;
  }

  async hooksGenerate(clipId: string): Promise<ClipHooks> {
    const { video, ctx } = await this.clipEnv(clipId);
    const res = await this.d.llm.writeHooks({ info: this.infoOf(video), clip: ctx });
    const hooks: ClipHooks = { ...res, applied: null, generatedAt: Date.now() };
    await this.patchMeta(clipId, { hooks });
    return hooks;
  }

  /** Burns a variant in as the title card (or removes the card) and re-renders. */
  async hooksApply(clipId: string, choice: { platform: Platform; index: number } | null): Promise<void> {
    const clip = await this.mustClip(clipId);
    const meta = parseJson<ClipMetaAll>(clip.metadata, {});
    const hooks = meta.hooks;
    if (choice === null) {
      await this.patchMeta(clipId, {
        hookOff: true,
        appliedHookText: null,
        hooks: hooks ? { ...hooks, applied: null } : hooks,
      });
    } else {
      const variant = hooks?.[choice.platform]?.[choice.index];
      if (!hooks || !variant) throw new AppError('NOT_FOUND', 'That hook variant does not exist. Generate hooks first.');
      await this.patchMeta(clipId, {
        hookOff: false,
        appliedHookText: variant.text,
        hooks: { ...hooks, applied: choice },
      });
    }
    await this.d.orchestrator.rerenderClip(clipId);
  }

  /* -------------------------------------------------------------------- metadata ------------ */

  async metaGet(clipId: string): Promise<ClipMeta | null> {
    const clip = await this.mustClip(clipId);
    return parseJson<ClipMetaAll>(clip.metadata, {}).meta ?? null;
  }

  async metaGenerate(clipId: string): Promise<ClipMeta> {
    const { clip, video, ctx } = await this.clipEnv(clipId);
    const meta = parseJson<ClipMetaAll>(clip.metadata, {});
    const res = await this.d.llm.writeMeta({
      info: this.infoOf(video),
      clip: ctx,
      hook: meta.hookOff ? null : (meta.appliedHookText ?? clip.hook ?? null),
    });
    const out: ClipMeta = { ...res, generatedAt: Date.now() };
    await this.patchMeta(clipId, { meta: out });
    return out;
  }

  async metaSave(clipId: string, platform: Platform, value: PlatformMeta): Promise<void> {
    const clip = await this.mustClip(clipId);
    const current = parseJson<ClipMetaAll>(clip.metadata, {}).meta;
    if (!current) throw new AppError('NOT_FOUND', 'Generate the metadata first.');
    await this.patchMeta(clipId, { meta: { ...current, [platform]: value } });
  }

  /* ------------------------------------------------------------------- thumbnails ----------- */

  async thumbsGet(clipId: string): Promise<ClipThumbnails | null> {
    const clip = await this.mustClip(clipId);
    const t = parseJson<ClipMetaAll>(clip.metadata, {}).thumbs;
    return t ?? null;
  }

  async thumbsGenerate(clipId: string, signal?: AbortSignal): Promise<ClipThumbnails> {
    const { clip, ctx } = await this.clipEnv(clipId);
    const storage = this.mustStorage();
    if (clip.status !== 'rendered') throw new AppError('VALIDATION', 'Render the clip first, then pick a thumbnail.');
    const work = path.join(this.d.cacheDir, clip.videoId, 'thumbwork', clipId);
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    try {
      const clipPath = path.join(work, 'clip.mp4');
      await downloadTo(storage, keys.clip(clipId), clipPath);
      const meta = parseJson<ClipMetaAll>(clip.metadata, {});
      const duration = Math.max(1, clip.endSec - clip.startSec);
      const frames = await this.d.thumbnails.sample({
        ffmpegPath: this.d.ffmpegPath(),
        clipPath,
        durationSec: duration,
        hookSeconds: meta.hookOff ? 0 : 2.8,
        count: THUMB_CANDIDATES,
        outDir: work,
        signal,
      });
      const scored = await this.d.thumbnails.score(frames, this.d.frameScorer, signal);
      // The vision model re-ranks; if it is unavailable the heuristic order stands.
      let ranking = new Map<number, { rank: number; note: string }>();
      let overlayText: string | null = null;
      const byTotal = [...scored].sort((a, b) => b.total - a.total);
      try {
        const res = await this.d.llm.rankThumbnails({
          clip: ctx,
          frames: byTotal.map((f, index) => ({ index, file: f.file })),
          signal,
        });
        ranking = new Map(res.ranking.map((r) => [r.index, { rank: r.rank, note: r.note }]));
        overlayText = res.overlayText || null;
      } catch (e) {
        if (signal?.aborted) throw e;
        this.d.log(`thumbnail vision ranking skipped: ${e instanceof Error ? e.message : String(e)}`);
      }
      const ordered = byTotal
        .map((f, i) => ({ f, llm: ranking.get(i) ?? null }))
        .sort((a, b) => (a.llm?.rank ?? 99) - (b.llm?.rank ?? 99) || b.f.total - a.f.total);
      const candidates: ClipThumbnails['candidates'] = [];
      for (let i = 0; i < ordered.length; i++) {
        const o = ordered[i];
        if (!o) continue;
        const key = keys2.thumbCandidate(clipId, i);
        await storage.putFile(key, o.f.file, { contentType: 'image/jpeg' });
        candidates.push({
          t: o.f.t,
          key,
          scores: { sharpness: o.f.sharpness, face: o.f.face, composition: o.f.composition, total: o.f.total },
          llmRank: o.llm?.rank ?? null,
          llmNote: o.llm?.note ?? null,
        });
      }
      this.d.invalidateStorage();
      const prev = meta.thumbs;
      const out: ClipThumbnails = {
        candidates,
        chosenT: prev?.chosenT ?? null,
        overlayText: prev?.overlayText ?? overlayText,
        generatedAt: Date.now(),
      };
      await this.patchMeta(clipId, { thumbs: out });
      return out;
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  async thumbsChoose(clipId: string, t: number, overlayText: string | null, signal?: AbortSignal): Promise<void> {
    const clip = await this.mustClip(clipId);
    const storage = this.mustStorage();
    if (clip.status !== 'rendered') throw new AppError('VALIDATION', 'Render the clip first, then pick a thumbnail.');
    const meta = parseJson<ClipMetaAll>(clip.metadata, {});
    const cand = meta.thumbs?.candidates.find((c) => Math.abs(c.t - t) < 0.001) ?? null;
    const work = path.join(this.d.cacheDir, clip.videoId, 'thumbwork', `${clipId}-choose`);
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    try {
      const frame = path.join(work, 'frame.jpg');
      if (cand && (await storage.head(cand.key))) {
        fs.writeFileSync(frame, await storage.get(cand.key));
      } else {
        const clipPath = path.join(work, 'clip.mp4');
        await downloadTo(storage, keys.clip(clipId), clipPath);
        await this.d.thumbnails
          .sample({
            ffmpegPath: this.d.ffmpegPath(),
            clipPath,
            durationSec: Math.max(1, clip.endSec - clip.startSec),
            hookSeconds: 0,
            count: 1,
            outDir: work,
            signal,
          })
          .then((r) => r[0] && fs.copyFileSync(r[0].file, frame));
      }
      const out = path.join(work, 'thumb.jpg');
      await this.d.thumbnails.compose({
        ffmpegPath: this.d.ffmpegPath(),
        framePath: frame,
        overlayText: overlayText?.trim() || null,
        fontsDir: this.d.fontsDir(),
        outJpg: out,
        signal,
      });
      await storage.putFile(keys.thumb(clipId), out, { contentType: 'image/jpeg' });
      this.d.invalidateStorage();
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
    const thumbs = meta.thumbs ?? { candidates: [], chosenT: null, overlayText: null, generatedAt: Date.now() };
    await this.patchMeta(clipId, { thumbs: { ...thumbs, chosenT: t, overlayText: overlayText?.trim() || null } });
  }

  async thumbUrl(clipId: string, index: number): Promise<string | null> {
    const clip = await this.mustClip(clipId);
    const t = parseJson<ClipMetaAll>(clip.metadata, {}).thumbs;
    const key = t?.candidates[index]?.key;
    const storage = this.d.getStorage();
    if (!key || !storage) return null;
    return storage.presignGet(key, 3600);
  }

  /* ------------------------------------------------------------------------ markers --------- */

  async listMarkers(videoId: string): Promise<Marker[]> {
    const rows = await this.d.db.marker.findMany({ where: { videoId }, orderBy: { atSec: 'asc' } });
    return rows.map(toMarker);
  }

  async addMarker(videoId: string, atSec: number, label: string): Promise<Marker> {
    await this.mustVideo(videoId);
    const row = await this.d.db.marker.create({ data: { videoId, atSec, label } });
    this.d.emit.markers(videoId);
    return toMarker(row);
  }

  async deleteMarker(id: string): Promise<void> {
    const row = await this.d.db.marker.findUnique({ where: { id } });
    if (!row) return;
    await this.d.db.marker.delete({ where: { id } });
    this.d.emit.markers(row.videoId);
  }

  /* ------------------------------------------------------------------------ helpers --------- */

  /** Used by chat tools: hooks/meta context. */
  async clipEnv(clipId: string) {
    const clip = await this.mustClip(clipId);
    const video = await this.mustVideo(clip.videoId);
    const transcript = await this.mustTranscript(clip.videoId);
    return { clip, video, transcript, ctx: this.contextOf(clip, transcript) };
  }

  contextOf(
    clip: { title: string; hook: string | null; startSec: number; endSec: number; score: number | null; metadata: string; kind?: string },
    transcript: Transcript,
  ): ClipContext {
    const meta = parseJson<ClipMetaAll>(clip.metadata, {});
    const segs =
      clip.kind === 'highlight' && meta.highlight
        ? meta.highlight.segments
        : [{ startSec: clip.startSec, endSec: clip.endSec }];
    const text = segs
      .map((s) =>
        transcript.sentences
          .filter((x) => x.e > s.startSec && x.s < s.endSec)
          .map((x) => x.text.trim())
          .join(' '),
      )
      .join(' … ');
    return {
      title: clip.title,
      hook: clip.hook,
      startSec: clip.startSec,
      endSec: clip.endSec,
      text,
      whyItWorks: meta.whyItWorks ?? null,
      score: clip.score,
    };
  }

  infoOf(video: { title: string; channel: string | null; metadata: string }): Pick<UrlInfo, 'title' | 'channel' | 'description'> {
    const info = parseJson<{ info?: UrlInfo }>(video.metadata, {}).info;
    return {
      title: info?.title ?? video.title,
      channel: info?.channel ?? video.channel,
      description: info?.description ?? null,
    };
  }

  /** Read-modify-write of Clip.metadata (one writer at a time per call; the render worker re-reads before its own write). */
  async patchMeta(clipId: string, patch: Partial<ClipMetaAll>): Promise<void> {
    const row = await this.d.db.clip.findUnique({ where: { id: clipId }, select: { metadata: true } });
    if (!row) throw new AppError('NOT_FOUND', 'Clip not found.');
    const next = { ...parseJson<ClipMetaAll>(row.metadata, {}), ...patch };
    await this.d.db.clip.update({ where: { id: clipId }, data: { metadata: JSON.stringify(next) } });
    await this.d.orchestrator.emitClip(clipId);
  }

  private mustStorage(): StorageProvider {
    const s = this.d.getStorage();
    if (!s) throw new AppError('UNAVAILABLE', 'Object storage is not connected (Settings → Storage).');
    return s;
  }

  async mustVideo(id: string) {
    const v = await this.d.db.video.findUnique({ where: { id } });
    if (!v) throw new AppError('NOT_FOUND', 'Video not found.');
    return v;
  }

  async mustClip(id: string) {
    const c = await this.d.db.clip.findUnique({ where: { id } });
    if (!c) throw new AppError('NOT_FOUND', 'Clip not found.');
    return c;
  }

  async mustTranscript(videoId: string): Promise<Transcript> {
    const t = await this.d.orchestrator.loadTranscript(videoId);
    if (!t) throw new AppError('NOT_FOUND', 'This video has no transcript yet.');
    return transcriptSchema.parse(t);
  }
}

function toMarker(r: { id: string; videoId: string; atSec: number; label: string; createdAt: Date }): Marker {
  return { id: r.id, videoId: r.videoId, atSec: r.atSec, label: r.label, createdAt: r.createdAt.getTime() };
}

export async function downloadTo(storage: StorageProvider, key: string, file: string): Promise<void> {
  const tmp = `${file}.part`;
  await streamPipeline(await storage.getStream(key), fs.createWriteStream(tmp));
  fs.renameSync(tmp, file);
}

const slug = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60)
    .toLowerCase() || 'subtitles';

/**
 * Snaps an LLM-proposed span to word boundaries (start on the first word whose midpoint is inside,
 * end on the last) with a little padding. Returns nulls when fewer than ~3 s of speech remain.
 */
export function alignToWords(
  words: Word[],
  startSec: number,
  endSec: number,
): { startSec: number; endSec: number } | { startSec: null; endSec: null } {
  const inside = words.filter((w) => (w.s + w.e) / 2 >= startSec && (w.s + w.e) / 2 <= endSec);
  const first = inside[0];
  const last = inside[inside.length - 1];
  if (!first || !last || last.e - first.s < 3) return { startSec: null, endSec: null };
  return { startSec: Math.max(0, first.s - 0.12), endSec: last.e + 0.2 };
}

