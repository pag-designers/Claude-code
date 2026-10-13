import fs from 'node:fs';
import path from 'node:path';
import type { CaptionStyle, SubtitleEdits, Transition } from '@shared/cp2';
import { keys, transcriptSchema, type ReframePlan, type Transcript, type Word } from '@shared/pipeline';
import type { Db } from '../db/client';
import type { JobContext } from '../services/queue';
import type { SettingsService } from '../services/settings';
import type { StorageProvider } from '../services/storage/provider';
import type {
  CaptionService,
  FaceSample,
  MediaService,
  ReframeService,
  RenderService,
} from './contracts';
import type { SubtitleService, ThumbnailService } from './contracts2';
import type { StyleRegistry } from './styles';
import { parseJson, readOptions } from './views';
import type { StageTracker } from './state';

/** What the render worker keeps in `Clip.metadata` (JSON). Other keys (hooks, meta, thumbs) belong to the CP2 service. */
export interface ClipMetaJson {
  whyItWorks?: string;
  confidence?: number;
  keywords?: string[];
  captionStyle?: string;
  /** Hook text currently burned in (null/undefined => the clip's own hook). */
  appliedHookText?: string | null;
  /** true => title card removed by the user. */
  hookOff?: boolean;
  thumbs?: { chosenT: number | null; overlayText: string | null } & Record<string, unknown>;
  highlight?: {
    segments: { startSec: number; endSec: number; role: string }[];
    transition: Transition;
    title: string;
    hook: string;
  };
}

export interface RenderWorkerDeps {
  db: Db;
  settings: SettingsService;
  cacheDir: string;
  media: MediaService;
  reframe: ReframeService;
  captions: CaptionService;
  render: RenderService;
  sidecar: {
    start(): Promise<unknown>;
    faces(
      req: { video_path: string; fps?: number; start?: number; end?: number },
      opts?: { signal?: AbortSignal },
    ): Promise<unknown>;
  };
  /** Converts the sidecar /faces response to FaceSample[] (reframe module helper). */
  toFaceSamples(wire: unknown): FaceSample[];
  /** One sharp frame from the rendered clip → JPEG (render module helper). */
  thumbnail(
    ffmpegPath: string,
    clipPath: string,
    outJpg: string,
    opts?: { atSec?: number },
  ): Promise<void>;
  ffmpegPath(): string;
  fontsDir(): string | null;
  getStorage(): StorageProvider | null;
  invalidateStorage(): void;
  tracker: StageTracker;
  subtitles: SubtitleService;
  styles: StyleRegistry;
  thumbnails: ThumbnailService;
  /** Subtitle edits of a video (defaults when none were saved). */
  loadSubtitleEdits(videoId: string): Promise<SubtitleEdits>;
  ensureSource(videoId: string, signal?: AbortSignal): Promise<string>;
  onClipChanged(clipId: string): void;
  log: (m: string) => void;
}

const HOOK_SECONDS = 2.8;
const HIGHLIGHT_TRANSITION_SEC = 0.35;

type Faces = ReturnType<RenderWorkerDeps['toFaceSamples']>;
type Tick = (f: number | null) => void;

/** Renders one clip (or highlights reel): reframe → captions → hook → ffmpeg → thumbnail → upload (BRIEF §4.7–4.13). */
export class RenderWorker {
  constructor(private readonly d: RenderWorkerDeps) {}

  async run(ctx: JobContext<{ clipId: string; videoId: string }>): Promise<void> {
    const { clipId, videoId } = ctx.payload;
    const clip = await this.d.db.clip.findUnique({ where: { id: clipId } });
    const video = await this.d.db.video.findUnique({ where: { id: videoId } });
    if (!clip || !video) return;
    const storage = this.d.getStorage();
    const set = async (data: Record<string, unknown>) => {
      await this.d.db.clip.update({ where: { id: clipId }, data }).catch(() => {});
      this.d.onClipChanged(clipId);
    };
    try {
      if (!storage) throw new Error('Object storage is not connected (Settings → Storage).');
      await set({ status: 'rendering', renderProgress: 0, error: null });
      const options = readOptions(video.options);
      const dir = path.join(this.d.cacheDir, videoId);
      const outDir = path.join(dir, 'clips', clipId);
      fs.mkdirSync(outDir, { recursive: true });
      const source = await this.d.ensureSource(videoId, ctx.signal);
      const info = await this.d.media.probe(source);
      if (!info.width || !info.height) throw new Error('Could not read the source video size.');

      const transcript = this.readTranscript(dir);
      const edits = await this.d.loadSubtitleEdits(videoId);
      // Edits address words by their index in the ASR transcript, so apply them before windowing.
      const edited = this.d.subtitles.applyEdits(transcript.words, edits);
      const sceneCuts = parseJson<{ cuts: number[] }>(readIfExists(path.join(dir, 'scenes.json')), {
        cuts: [],
      }).cuts;
      const meta = parseJson<ClipMetaJson>(clip.metadata, {});
      const style = await this.d.styles.get(clip.captionStyleId);
      const hookText = meta.hookOff ? null : (meta.appliedHookText ?? clip.hook ?? null);
      const hook =
        options.hookCard && hookText ? { text: hookText, durationSec: HOOK_SECONDS } : null;
      const outPath = path.join(outDir, 'clip.mp4');
      let lastTick = 0;
      const tick: Tick = (f) => {
        const now = Date.now();
        if (f === null || now - lastTick < 500) return;
        lastTick = now;
        void ctx.progress(f, 'Rendering');
        void set({ renderProgress: f * 0.9 });
      };
      await this.d.sidecar.start();

      const common = {
        ctx,
        source,
        info: { width: info.width, height: info.height },
        sceneCuts,
        words: edited,
        style,
        keywords: meta.keywords,
        aspect: options.aspect,
        captions: options.captions,
        outDir,
        outPath,
        hook,
        tick,
      };
      const built =
        clip.kind === 'highlight' && meta.highlight
          ? await this.renderHighlightClip({
              ...common,
              segments: meta.highlight.segments,
              transition: meta.highlight.transition,
              reframeMode: clip.reframeMode as ReframeModeLite,
            })
          : await this.renderSingleClip({
              ...common,
              startSec: clip.startSec,
              endSec: clip.endSec,
              reframeMode: clip.reframeMode as ReframeModeLite,
            });
      this.d.log(
        `rendered clip ${clipId} with ${built.encoder} (${built.durationSec.toFixed(1)}s, layout ${built.layout})`,
      );

      const thumbPath = path.join(outDir, 'thumb.jpg');
      await this.makeThumb({
        outPath,
        thumbPath,
        meta,
        hookOn: hook !== null,
        durationSec: built.durationSec,
      });
      await set({ renderProgress: 0.93 });
      await storage.putFile(keys.clip(clipId), outPath, { contentType: 'video/mp4' });
      await storage.putFile(keys.thumb(clipId), thumbPath, { contentType: 'image/jpeg' });
      for (const [key, file, type] of [
        [keys.srt(clipId), 'captions.srt', 'application/x-subrip'],
        [keys.vtt(clipId), 'captions.vtt', 'text/vtt'],
        [keys.ass(clipId), 'captions.ass', 'text/x-ssa'],
      ] as const) {
        const p = path.join(outDir, file);
        if (fs.existsSync(p)) await storage.putFile(key, p, { contentType: type });
      }
      this.d.invalidateStorage();
      const fresh = parseJson<ClipMetaJson>(
        (await this.d.db.clip.findUnique({ where: { id: clipId }, select: { metadata: true } }))
          ?.metadata,
        meta,
      );
      await set({
        status: 'rendered',
        renderProgress: 1,
        error: null,
        layout: built.layout,
        subtitleRev: edits.rev,
        metadata: JSON.stringify({ ...fresh, appliedHookText: hookText }),
        storageKeys: JSON.stringify({
          render: keys.clip(clipId),
          thumb: keys.thumb(clipId),
          srt: keys.srt(clipId),
          vtt: keys.vtt(clipId),
        }),
      });
      fs.rmSync(outDir, { recursive: true, force: true });
    } catch (err) {
      if (ctx.signal.aborted) {
        await set({ status: 'candidate', renderProgress: null });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.d.log(
        `render ${clipId} failed: ${err instanceof Error ? (err.stack ?? message) : message}`,
      );
      await set({ status: 'failed', error: message.slice(0, 500), renderProgress: null });
    }
  }

  /** Faces → reframe plan (auto-detects screen-share layouts when the mode allows it). */
  private async planFor(a: {
    ctx: JobContext<{ clipId: string; videoId: string }>;
    source: string;
    info: { width: number; height: number };
    startSec: number;
    endSec: number;
    sceneCuts: number[];
    aspect: Parameters<ReframeService['plan']>[0]['aspect'];
    reframeMode: ReframeModeLite;
  }): Promise<ReframePlan> {
    const wire = await this.d.sidecar.faces(
      { video_path: a.source, fps: 4, start: a.startSec, end: a.endSec },
      { signal: a.ctx.signal },
    );
    const faces: Faces = this.d.toFaceSamples(wire);
    const wantsLayout = a.reframeMode === 'auto' || a.reframeMode === 'screen-face';
    const layoutHint = wantsLayout
      ? await this.d.reframe
          .analyzeLayout({
            ffmpegPath: this.d.ffmpegPath(),
            sourcePath: a.source,
            startSec: a.startSec,
            endSec: a.endSec,
            srcW: a.info.width,
            srcH: a.info.height,
            faces,
            signal: a.ctx.signal,
          })
          .catch((e) => {
            if (a.ctx.signal.aborted) throw e;
            this.d.log(`layout analysis failed (continuing without it): ${String(e)}`);
            return null;
          })
      : null;
    return this.d.reframe.plan({
      startSec: a.startSec,
      endSec: a.endSec,
      srcW: a.info.width,
      srcH: a.info.height,
      aspect: a.aspect,
      faces,
      sceneCuts: a.sceneCuts,
      mode: a.reframeMode,
      layoutHint,
    });
  }

  private async renderSingleClip(a: CommonRender & { startSec: number; endSec: number }) {
    const plan = await this.planFor({ ...a });
    const words = a.words.filter((w) => w.e > a.startSec - 0.05 && w.s < a.endSec + 0.05);
    const assPath = path.join(a.outDir, 'captions.ass');
    const withCaptions = a.captions && words.length > 0;
    if (withCaptions) {
      fs.writeFileSync(
        assPath,
        this.d.captions.buildAss({
          words,
          startSec: a.startSec,
          endSec: a.endSec,
          width: plan.outW,
          height: plan.outH,
          style: a.style,
          keywords: a.keywords,
          maskProfanity: false,
        }),
      );
    }
    fs.writeFileSync(
      path.join(a.outDir, 'captions.srt'),
      this.d.captions.buildSrt(words, a.startSec, a.endSec),
    );
    fs.writeFileSync(
      path.join(a.outDir, 'captions.vtt'),
      this.d.captions.buildVtt(words, a.startSec, a.endSec),
    );
    const result = await this.d.render.render({
      ffmpegPath: this.d.ffmpegPath(),
      sourcePath: a.source,
      outPath: a.outPath,
      startSec: a.startSec,
      endSec: a.endSec,
      plan,
      assPath: withCaptions ? assPath : null,
      fontsDir: this.d.fontsDir(),
      hook: a.hook,
      loudnessTarget: -14,
      encoder: 'auto',
      fps: null,
      signal: a.ctx.signal,
      onProgress: a.tick,
    });
    return { ...result, layout: plan.layout ?? 'single' };
  }

  /** Highlights reel: each segment is reframed + captioned on its own, then stitched with transitions. */
  private async renderHighlightClip(
    a: CommonRender & {
      segments: { startSec: number; endSec: number }[];
      transition: Transition;
    },
  ) {
    if (a.segments.length === 0) throw new Error('The highlights reel has no segments.');
    const segs: Parameters<RenderService['renderHighlight']>[0]['segments'] = [];
    const reelWords: Word[] = [];
    let offset = 0;
    let layout: 'single' | 'split' | 'screen-face' = 'single';
    for (let i = 0; i < a.segments.length; i++) {
      const seg = a.segments[i];
      if (!seg) continue;
      const plan = await this.planFor({ ...a, startSec: seg.startSec, endSec: seg.endSec });
      if (plan.layout && plan.layout !== 'single') layout = plan.layout;
      const words = a.words.filter((w) => w.e > seg.startSec - 0.05 && w.s < seg.endSec + 0.05);
      let assPath: string | null = null;
      if (a.captions && words.length > 0) {
        assPath = path.join(a.outDir, `seg-${i}.ass`);
        fs.writeFileSync(
          assPath,
          this.d.captions.buildAss({
            words,
            startSec: seg.startSec,
            endSec: seg.endSec,
            width: plan.outW,
            height: plan.outH,
            style: a.style,
            keywords: a.keywords,
            maskProfanity: false,
          }),
        );
      }
      segs.push({ startSec: seg.startSec, endSec: seg.endSec, plan, assPath });
      // Subtitle files for the whole reel live on the stitched timeline (transitions overlap, so this is approximate).
      for (const w of words)
        reelWords.push({ ...w, s: w.s - seg.startSec + offset, e: w.e - seg.startSec + offset });
      offset += seg.endSec - seg.startSec - (i < a.segments.length - 1 ? HIGHLIGHT_TRANSITION_SEC : 0);
    }
    fs.writeFileSync(path.join(a.outDir, 'captions.srt'), this.d.captions.buildSrt(reelWords, 0, offset));
    fs.writeFileSync(path.join(a.outDir, 'captions.vtt'), this.d.captions.buildVtt(reelWords, 0, offset));
    const result = await this.d.render.renderHighlight({
      ffmpegPath: this.d.ffmpegPath(),
      sourcePath: a.source,
      outPath: a.outPath,
      segments: segs,
      transition: a.transition,
      transitionSec: HIGHLIGHT_TRANSITION_SEC,
      fontsDir: this.d.fontsDir(),
      hook: a.hook,
      loudnessTarget: -14,
      encoder: 'auto',
      fps: null,
      signal: a.ctx.signal,
      onProgress: a.tick,
    });
    return { ...result, layout };
  }

  /** Thumbnail: the user's chosen frame (+ overlay text) when set, else a sharp frame after the hook card. */
  private async makeThumb(a: {
    outPath: string;
    thumbPath: string;
    meta: ClipMetaJson;
    hookOn: boolean;
    durationSec: number;
  }): Promise<void> {
    const ff = this.d.ffmpegPath();
    const chosen = a.meta.thumbs?.chosenT ?? null;
    if (chosen === null) {
      await this.d.thumbnail(ff, a.outPath, a.thumbPath, {
        atSec: a.hookOn && a.durationSec > 6 ? HOOK_SECONDS + 0.7 : undefined,
      });
      return;
    }
    const t = Math.min(Math.max(0, chosen), Math.max(0, a.durationSec - 0.1));
    const overlay = a.meta.thumbs?.overlayText ?? null;
    if (!overlay) {
      await this.d.thumbnail(ff, a.outPath, a.thumbPath, { atSec: t });
      return;
    }
    const raw = `${a.thumbPath}.raw.jpg`;
    await this.d.thumbnail(ff, a.outPath, raw, { atSec: t });
    await this.d.thumbnails.compose({
      ffmpegPath: ff,
      framePath: raw,
      overlayText: overlay,
      fontsDir: this.d.fontsDir(),
      outJpg: a.thumbPath,
    });
    fs.rmSync(raw, { force: true });
  }

  private readTranscript(dir: string): Transcript {
    const file = path.join(dir, 'transcript.json');
    if (!fs.existsSync(file)) throw new Error('Transcript is not available yet.');
    return transcriptSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  }
}

type ReframeModeLite = 'auto' | 'single-face' | 'multi-face' | 'screen-face' | 'center';

interface CommonRender {
  ctx: JobContext<{ clipId: string; videoId: string }>;
  source: string;
  info: { width: number; height: number };
  sceneCuts: number[];
  words: (Word & { origIndex: number })[];
  style: CaptionStyle;
  keywords: string[] | undefined;
  aspect: Parameters<ReframeService['plan']>[0]['aspect'];
  captions: boolean;
  outDir: string;
  outPath: string;
  hook: { text: string; durationSec: number } | null;
  tick: Tick;
  reframeMode: ReframeModeLite;
}

function readIfExists(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}
