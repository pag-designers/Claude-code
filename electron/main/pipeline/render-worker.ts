import fs from 'node:fs';
import path from 'node:path';
import { keys, transcriptSchema, type Transcript, type Word } from '@shared/pipeline';
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
import { parseJson, readOptions } from './views';
import type { StageTracker } from './state';

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
  ensureSource(videoId: string, signal?: AbortSignal): Promise<string>;
  onClipChanged(clipId: string): void;
  log: (m: string) => void;
}

const HOOK_SECONDS = 2.8;

/** Renders one clip: reframe → captions → hook → ffmpeg → thumbnail → upload (BRIEF §4.7–4.13). */
export class RenderWorker {
  private detected: Promise<'libx264' | 'h264_nvenc' | 'h264_videotoolbox'> | null = null;

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
      const words: Word[] = transcript.words.filter(
        (w) => w.e > clip.startSec - 0.05 && w.s < clip.endSec + 0.05,
      );
      const sceneCuts = parseJson<{ cuts: number[] }>(readIfExists(path.join(dir, 'scenes.json')), {
        cuts: [],
      }).cuts;

      await this.d.sidecar.start();
      const faces = await this.d.sidecar.faces(
        { video_path: source, fps: 4, start: clip.startSec, end: clip.endSec },
        { signal: ctx.signal },
      );
      const plan = this.d.reframe.plan({
        startSec: clip.startSec,
        endSec: clip.endSec,
        srcW: info.width,
        srcH: info.height,
        aspect: options.aspect,
        faces: this.d.toFaceSamples(faces),
        sceneCuts,
      });

      const meta = parseJson<{ keywords?: string[]; captionStyle?: string }>(clip.metadata, {});
      const assPath = path.join(outDir, 'captions.ass');
      const withCaptions = options.captions && words.length > 0;
      if (withCaptions) {
        fs.writeFileSync(
          assPath,
          this.d.captions.buildAss({
            words,
            startSec: clip.startSec,
            endSec: clip.endSec,
            width: plan.outW,
            height: plan.outH,
            styleId: meta.captionStyle ?? 'clean-pop',
            keywords: meta.keywords,
            maskProfanity: false,
          }),
        );
      }
      fs.writeFileSync(
        path.join(outDir, 'captions.srt'),
        this.d.captions.buildSrt(words, clip.startSec, clip.endSec),
      );
      fs.writeFileSync(
        path.join(outDir, 'captions.vtt'),
        this.d.captions.buildVtt(words, clip.startSec, clip.endSec),
      );

      const outPath = path.join(outDir, 'clip.mp4');
      let lastTick = 0;
      const result = await this.d.render.render({
        ffmpegPath: this.d.ffmpegPath(),
        sourcePath: source,
        outPath,
        startSec: clip.startSec,
        endSec: clip.endSec,
        plan,
        assPath: withCaptions ? assPath : null,
        fontsDir: this.d.fontsDir(),
        hook: options.hookCard && clip.hook ? { text: clip.hook, durationSec: HOOK_SECONDS } : null,
        loudnessTarget: -14,
        encoder: 'auto',
        fps: null,
        signal: ctx.signal,
        onProgress: (f) => {
          const now = Date.now();
          if (f === null || now - lastTick < 500) return;
          lastTick = now;
          void ctx.progress(f, 'Rendering');
          void set({ renderProgress: f * 0.9 });
        },
      });
      this.d.log(
        `rendered clip ${clipId} with ${result.encoder} (${result.durationSec.toFixed(1)}s)`,
      );

      const thumbPath = path.join(outDir, 'thumb.jpg');
      // Take the thumbnail after the hook card has faded so it never covers a face.
      const hookOn = options.hookCard && clip.hook;
      await this.d.thumbnail(this.d.ffmpegPath(), outPath, thumbPath, {
        atSec: hookOn && clip.endSec - clip.startSec > 6 ? HOOK_SECONDS + 0.7 : undefined,
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
      await set({
        status: 'rendered',
        renderProgress: 1,
        error: null,
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

  private readTranscript(dir: string): Transcript {
    const file = path.join(dir, 'transcript.json');
    if (!fs.existsSync(file)) throw new Error('Transcript is not available yet.');
    return transcriptSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  }
}

function readIfExists(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}
