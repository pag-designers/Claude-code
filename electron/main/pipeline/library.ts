import fs from 'node:fs';
import path from 'node:path';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { keys, type ClipView, type StageState, type Transcript, type VideoAnalysis, type VideoView } from '@shared/pipeline';
import type { Db } from '../db/client';
import { AppError } from '../ipc/dispatch';
import type { StorageProvider } from '../services/storage/provider';
import type { PipelineOrchestrator } from './orchestrator';
import { parseJson, toClipView, type ClipRow } from './views';

export interface LibraryDeps {
  db: Db;
  orchestrator: PipelineOrchestrator;
  getStorage(): StorageProvider | null;
  invalidateStorage(): void;
  cacheDir: string;
  chooseDirectory(): Promise<string | null>;
  log: (m: string) => void;
}

const slug = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60)
    .toLowerCase() || 'clip';

export class LibraryService {
  constructor(private readonly d: LibraryDeps) {}

  async listVideos(opts: { favorite?: boolean; limit: number }): Promise<VideoView[]> {
    const rows = await this.d.db.video.findMany({
      where: opts.favorite === undefined ? {} : { favorite: opts.favorite },
      orderBy: { createdAt: 'desc' },
      take: opts.limit,
    });
    const views = await Promise.all(rows.map((r) => this.d.orchestrator.videoView(r.id)));
    return views.filter((v): v is VideoView => v !== null);
  }

  async getVideo(id: string): Promise<{ video: VideoView; analysis: VideoAnalysis | null; stages: StageState[] }> {
    const video = await this.d.orchestrator.videoView(id);
    if (!video) throw new AppError('NOT_FOUND', 'Video not found.');
    const [analysis, stages] = await Promise.all([this.d.orchestrator.loadAnalysis(id), this.d.orchestrator.tracker.load(id)]);
    return { video, analysis, stages };
  }

  transcript(id: string): Promise<Transcript | null> {
    return this.d.orchestrator.loadTranscript(id);
  }

  async setVideoFavorite(id: string, value: boolean): Promise<void> {
    await this.d.db.video.update({ where: { id }, data: { favorite: value } }).catch(() => {
      throw new AppError('NOT_FOUND', 'Video not found.');
    });
    await this.d.orchestrator.emitVideo(id);
  }

  async deleteVideo(id: string, deleteFromStorage: boolean): Promise<void> {
    await this.d.orchestrator.cancel(id).catch(() => {});
    const clips = await this.d.db.clip.findMany({ where: { videoId: id }, select: { id: true } });
    const storage = this.d.getStorage();
    if (deleteFromStorage && storage) {
      const doomed: string[] = [];
      for await (const o of storage.list(`videos/${id}/`)) doomed.push(o.key);
      for (const c of clips) doomed.push(keys.clip(c.id), keys.thumb(c.id), keys.ass(c.id), keys.srt(c.id), keys.vtt(c.id));
      await storage.delete(doomed).catch((e) => this.d.log(`storage delete failed: ${String(e)}`));
      this.d.invalidateStorage();
    }
    await this.d.db.video.delete({ where: { id } }).catch(() => {});
    this.d.orchestrator.tracker.forget(id);
    fs.rmSync(path.join(this.d.cacheDir, id), { recursive: true, force: true });
  }

  async proxyUrl(id: string): Promise<string | null> {
    const row = await this.d.db.video.findUnique({ where: { id }, select: { storageKeys: true } });
    const k = parseJson<Record<string, string>>(row?.storageKeys, {});
    const storage = this.d.getStorage();
    if (!storage || !k.proxy) return null;
    return storage.presignGet(k.proxy, 3600);
  }

  async listClips(opts: { videoId?: string; favorite?: boolean; minScore?: number; limit: number }): Promise<ClipView[]> {
    const rows = await this.d.db.clip.findMany({
      where: {
        ...(opts.videoId ? { videoId: opts.videoId } : {}),
        ...(opts.favorite === undefined ? {} : { favorite: opts.favorite }),
        ...(opts.minScore !== undefined ? { score: { gte: opts.minScore } } : {}),
      },
      orderBy: [{ score: 'desc' }, { createdAt: 'desc' }],
      take: opts.limit,
    });
    const titles = new Map<string, string>();
    for (const v of await this.d.db.video.findMany({ select: { id: true, title: true } })) titles.set(v.id, v.title);
    return rows.map((r) => toClipView(r as ClipRow, titles.get(r.videoId) ?? null));
  }

  async favoriteClips(ids: string[], value: boolean): Promise<void> {
    await this.d.db.clip.updateMany({ where: { id: { in: ids } }, data: { favorite: value } });
    for (const id of ids) await this.d.orchestrator.emitClip(id);
  }

  async deleteClips(ids: string[]): Promise<void> {
    const rows = await this.d.db.clip.findMany({ where: { id: { in: ids } }, select: { videoId: true } });
    for (const id of ids) {
      const job = await this.d.db.job.findFirst({ where: { kind: 'pipeline.render-clip', status: { in: ['queued', 'running'] }, payload: { contains: id } } });
      if (job) await this.d.orchestrator.cancelJob(job.id);
    }
    await this.d.orchestrator.deleteClips(ids);
    for (const v of new Set(rows.map((r) => r.videoId))) await this.d.orchestrator.emitVideo(v);
  }

  async mediaUrl(id: string, kind: 'render' | 'thumb'): Promise<string | null> {
    const row = await this.d.db.clip.findUnique({ where: { id }, select: { storageKeys: true } });
    const k = parseJson<Record<string, string>>(row?.storageKeys, {});
    const key = kind === 'render' ? k.render : k.thumb;
    const storage = this.d.getStorage();
    if (!storage || !key) return null;
    return storage.presignGet(key, 3600);
  }

  async download(ids: string[], withCaptions: boolean): Promise<{ saved: number; dir: string | null; canceled: boolean }> {
    const storage = this.d.getStorage();
    if (!storage) throw new AppError('UNAVAILABLE', 'Object storage is not connected (Settings → Storage).');
    const rows = await this.d.db.clip.findMany({ where: { id: { in: ids }, status: 'rendered' }, orderBy: { score: 'desc' } });
    if (rows.length === 0) throw new AppError('NOT_FOUND', 'None of the selected clips has finished rendering yet.');
    const dir = await this.d.chooseDirectory();
    if (!dir) return { saved: 0, dir: null, canceled: true };
    let saved = 0;
    for (const c of rows) {
      const base = `${String(c.score ?? 0).padStart(2, '0')}-${slug(c.title)}-${c.id.slice(-5)}`;
      const jobs: [string, string][] = [[keys.clip(c.id), `${base}.mp4`]];
      if (withCaptions) jobs.push([keys.srt(c.id), `${base}.srt`]);
      for (const [key, name] of jobs) {
        const tmp = path.join(dir, `${name}.part`);
        const body = await storage.getStream(key);
        await streamPipeline(body, fs.createWriteStream(tmp));
        fs.renameSync(tmp, path.join(dir, name));
      }
      saved++;
    }
    return { saved, dir, canceled: false };
  }
}
