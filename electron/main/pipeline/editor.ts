import fs from 'node:fs';
import path from 'node:path';
import { pipeline as streamPipeline } from 'node:stream/promises';
import {
  editorProjectDocSchema,
  exportSettingsSchema,
  keysEditor,
  projectSchema,
  resolveExportSettings,
  type Asset,
  type EditorProjectDoc,
  type EditorProjectSummary,
  type ExportJob,
  type ExportSettings,
  type Project,
  type ProjectVersion,
  type Waveform,
} from '@shared/editor';
import { projectDuration } from '@shared/editor-eval';
import { keys, type Word } from '@shared/pipeline';
import type { Db } from '../db/client';
import { AppError } from '../ipc/dispatch';
import type { NotificationService } from '../services/notifications';
import type { JobContext, JobQueue } from '../services/queue';
import type { StorageProvider } from '../services/storage/provider';
import type { CaptionService, FaceSample, ReframeService } from './contracts';
import type { EditorAssetFile, EditorMediaService, ExportCompiler } from './contracts3';
import type { SubtitleService } from './contracts2';
import {
  blankProject,
  canvasFor,
  cuesToItems,
  hookTextItem,
  mainVideoItem,
  newId,
  videoAsset,
  withItems,
} from './editor-projects';
import type { PipelineOrchestrator } from './orchestrator';
import type { StyleRegistry } from './styles';
import { parseJson } from './views';
import { subtitleEditsSchema, type CaptionStyle, type SubtitleEdits } from '@shared/cp2';

export const JOB_EDITOR_EXPORT = 'editor.export';
/** Auto snapshots: at most one per this interval, keep the newest N. */
const AUTO_VERSION_INTERVAL_MS = 5 * 60_000;
const AUTO_VERSION_KEEP = 40;
const BACKUP_INTERVAL_MS = 30_000;

export interface EditorDeps {
  db: Db;
  queue: JobQueue;
  notifications: NotificationService;
  getStorage(): StorageProvider | null;
  invalidateStorage(): void;
  cacheDir: string;
  ffmpegPath(): string;
  fontsDir(): string | null;
  orchestrator: Pick<PipelineOrchestrator, 'ensureSource' | 'loadTranscript' | 'emitVideo'>;
  loadSubtitleEdits(videoId: string): Promise<SubtitleEdits>;
  subtitles: SubtitleService;
  styles: StyleRegistry;
  captions: Pick<CaptionService, 'buildAss' | 'buildSrt' | 'buildVtt'>;
  reframe: Pick<ReframeService, 'plan'>;
  toFaceSamples(wire: unknown): FaceSample[];
  sidecar: {
    start(): Promise<unknown>;
    faces(
      req: {
        video_path: string;
        fps?: number;
        start?: number;
        end?: number;
        min_confidence?: number;
      },
      opts?: { signal?: AbortSignal },
    ): Promise<unknown>;
    transcribe(
      req: {
        audio_path: string;
        model?: string;
        vad_filter?: boolean;
        condition_on_previous_text?: boolean;
      },
      opts?: { signal?: AbortSignal },
    ): Promise<{ segments: { words: { word: string; start: number; end: number }[] }[] }>;
  };
  media: EditorMediaService;
  compiler: ExportCompiler;
  detectEncoder(ffmpegPath: string): Promise<'libx264' | 'h264_nvenc' | 'h264_videotoolbox'>;
  /** Poster frame of a media file (existing helper from the render module). */
  thumbnail(
    ffmpegPath: string,
    file: string,
    outJpg: string,
    opts?: { atSec?: number },
  ): Promise<void>;
  whisperModel(): string;
  chooseFiles(opts: {
    title: string;
    extensions: { name: string; extensions: string[] }[];
  }): Promise<string[]>;
  chooseDirectory(): Promise<string | null>;
  emit: { export(job: ExportJob): void };
  log: (m: string) => void;
}

type ProjectRow = {
  id: string;
  name: string;
  clipId: string | null;
  videoId: string | null;
  data: string;
  rev: number;
  durationSec: number;
  aspect: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Stored export settings, tolerant of rows written by older/partial versions. */
function readSettings(raw: string): ExportSettings {
  const parsed = exportSettingsSchema.safeParse(parseJson<unknown>(raw, {}));
  if (parsed.success) return parsed.data;
  return resolveExportSettings(parseJson<Partial<ExportSettings>>(raw, {}), {
    width: 1080,
    height: 1920,
    fps: 30,
  });
}

const EXT_KIND: Record<string, Asset['kind']> = {
  mp4: 'video',
  mov: 'video',
  mkv: 'video',
  webm: 'video',
  m4v: 'video',
  avi: 'video',
  mp3: 'audio',
  wav: 'audio',
  m4a: 'audio',
  aac: 'audio',
  ogg: 'audio',
  flac: 'audio',
  opus: 'audio',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  gif: 'image',
  cube: 'lut',
};

/** The editor: projects (CRUD, versions, backup), media services for the timeline, and exports. */
export class EditorService {
  private lastBackup = new Map<string, number>();

  constructor(private readonly d: EditorDeps) {}

  registerJobs(): void {
    this.d.queue.register<{ exportId: string; project: Project }>(
      JOB_EDITOR_EXPORT,
      (ctx) => this.runExport(ctx),
      {
        concurrency: 1,
        maxAttempts: 1,
      },
    );
  }

  /** Marks exports that were running when the app died as failed (the queue does not retry exports). */
  async reconcileOnStart(): Promise<void> {
    await this.d.db.editorExport.updateMany({
      where: { status: { in: ['queued', 'rendering'] } },
      data: {
        status: 'failed',
        error: 'Interrupted by a restart. Export again.',
        finishedAt: new Date(),
      },
    });
  }

  /* ------------------------------------------------------------------ projects --------------- */

  private toDoc(row: ProjectRow): EditorProjectDoc {
    return editorProjectDocSchema.parse({
      id: row.id,
      name: row.name,
      rev: row.rev,
      project: projectSchema.parse(parseJson<unknown>(row.data, {})),
      updatedAt: row.updatedAt.getTime(),
    });
  }

  private async must(id: string): Promise<ProjectRow> {
    const row = await this.d.db.editorProject.findUnique({ where: { id } });
    if (!row) throw new AppError('NOT_FOUND', 'Project not found.');
    return row;
  }

  async list(): Promise<EditorProjectSummary[]> {
    const rows = await this.d.db.editorProject.findMany({
      orderBy: { updatedAt: 'desc' },
      take: 500,
    });
    const storage = this.d.getStorage();
    const out: EditorProjectSummary[] = [];
    for (const r of rows) {
      let thumbUrl: string | null = null;
      if (storage) {
        try {
          if (await storage.head(keysEditor.projectThumb(r.id)))
            thumbUrl = await storage.presignGet(keysEditor.projectThumb(r.id), 3600);
        } catch {
          thumbUrl = null;
        }
      }
      out.push({
        id: r.id,
        name: r.name,
        rev: r.rev,
        clipId: r.clipId,
        videoId: r.videoId,
        durationSec: r.durationSec,
        aspect:
          (['9:16', '1:1', '16:9', '4:5', 'custom'] as const).find((a) => a === r.aspect) ?? '9:16',
        thumbUrl,
        updatedAt: r.updatedAt.getTime(),
        createdAt: r.createdAt.getTime(),
      });
    }
    return out;
  }

  async get(id: string): Promise<EditorProjectDoc> {
    return this.toDoc(await this.must(id));
  }

  async create(
    name: string | undefined,
    from:
      | { clipId: string }
      | { videoId: string }
      | { blank: true; aspect: '9:16' | '1:1' | '16:9' | '4:5' },
  ): Promise<EditorProjectDoc> {
    let project: Project;
    let title = name;
    let clipId: string | null = null;
    let videoId: string | null = null;
    if ('clipId' in from) {
      const r = await this.buildFromClip(from.clipId);
      project = r.project;
      title ??= r.title;
      clipId = from.clipId;
      videoId = r.videoId;
    } else if ('videoId' in from) {
      const r = await this.buildFromVideo(from.videoId);
      project = r.project;
      title ??= r.title;
      videoId = from.videoId;
    } else {
      project = blankProject(from.aspect);
      title ??= 'Untitled project';
    }
    const row = await this.d.db.editorProject.create({
      data: {
        name: title,
        clipId,
        videoId,
        data: JSON.stringify(project),
        rev: 1,
        durationSec: projectDuration(project),
        aspect: project.canvas.aspect,
      },
    });
    void this.backup(row.id, project, true);
    return this.toDoc(row);
  }

  /** Optimistic save. A stale `baseRev` means another window saved in between: CONFLICT. */
  async save(
    id: string,
    project: Project,
    baseRev: number,
  ): Promise<{ rev: number; updatedAt: number }> {
    const row = await this.must(id);
    if (row.rev !== baseRev)
      throw new AppError(
        'CONFLICT',
        'This project was changed somewhere else. Reload it to see the latest version.',
      );
    const parsed = projectSchema.parse(project);
    const rev = row.rev + 1;
    const updated = await this.d.db.editorProject.update({
      where: { id },
      data: {
        data: JSON.stringify(parsed),
        rev,
        durationSec: projectDuration(parsed),
        aspect: parsed.canvas.aspect,
      },
    });
    await this.maybeAutoVersion(id, rev, JSON.stringify(parsed));
    void this.backup(id, parsed, false);
    return { rev, updatedAt: updated.updatedAt.getTime() };
  }

  async rename(id: string, name: string): Promise<void> {
    await this.must(id);
    await this.d.db.editorProject.update({ where: { id }, data: { name } });
  }

  async duplicate(id: string): Promise<EditorProjectDoc> {
    const row = await this.must(id);
    const copy = await this.d.db.editorProject.create({
      data: {
        name: `${row.name} copy`,
        clipId: row.clipId,
        videoId: row.videoId,
        data: row.data,
        rev: 1,
        durationSec: row.durationSec,
        aspect: row.aspect,
      },
    });
    return this.toDoc(copy);
  }

  async delete(id: string): Promise<void> {
    await this.must(id);
    await this.d.db.editorProject.delete({ where: { id } });
    await this.d.db.editorExport.updateMany({
      where: { projectId: id },
      data: { projectId: null },
    });
    const storage = this.d.getStorage();
    if (storage) {
      try {
        const doomed: string[] = [];
        for await (const o of storage.list(`projects/${id}/`)) doomed.push(o.key);
        for await (const o of storage.list(`editor/${id}/`)) doomed.push(o.key);
        await storage.delete(doomed);
        this.d.invalidateStorage();
      } catch (e) {
        this.d.log(`editor delete: storage cleanup failed: ${String(e)}`);
      }
    }
    fs.rmSync(path.join(this.d.cacheDir, 'editor', id), { recursive: true, force: true });
  }

  /* ------------------------------------------------------------------ versions --------------- */

  private async snapshot(
    id: string,
    rev: number,
    data: string,
    kind: 'auto' | 'manual' | 'restore',
    label: string | null,
  ) {
    const v = await this.d.db.editorVersion.create({
      data: { projectId: id, rev, data, kind, label },
    });
    const storage = this.d.getStorage();
    if (storage)
      void storage
        .put(keysEditor.versionBackup(id, rev), data, { contentType: 'application/json' })
        .catch(() => {});
    return v;
  }

  private async maybeAutoVersion(id: string, rev: number, data: string): Promise<void> {
    const last = await this.d.db.editorVersion.findFirst({
      where: { projectId: id },
      orderBy: { createdAt: 'desc' },
    });
    if (last && Date.now() - last.createdAt.getTime() < AUTO_VERSION_INTERVAL_MS) return;
    await this.snapshot(id, rev, data, 'auto', null);
    const autos = await this.d.db.editorVersion.findMany({
      where: { projectId: id, kind: 'auto' },
      orderBy: { createdAt: 'desc' },
      skip: AUTO_VERSION_KEEP,
    });
    if (autos.length)
      await this.d.db.editorVersion.deleteMany({ where: { id: { in: autos.map((a) => a.id) } } });
  }

  private toVersion(v: {
    id: string;
    projectId: string;
    rev: number;
    label: string | null;
    kind: string;
    createdAt: Date;
  }): ProjectVersion {
    return {
      id: v.id,
      projectId: v.projectId,
      rev: v.rev,
      label: v.label,
      kind: (['auto', 'manual', 'restore'] as const).find((k) => k === v.kind) ?? 'auto',
      createdAt: v.createdAt.getTime(),
    };
  }

  async versions(id: string): Promise<ProjectVersion[]> {
    await this.must(id);
    const rows = await this.d.db.editorVersion.findMany({
      where: { projectId: id },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return rows.map((r) => this.toVersion(r));
  }

  async saveVersion(id: string, label?: string): Promise<ProjectVersion> {
    const row = await this.must(id);
    return this.toVersion(
      await this.snapshot(id, row.rev, row.data, 'manual', label?.trim() || null),
    );
  }

  async restoreVersion(id: string, versionId: string): Promise<EditorProjectDoc> {
    const row = await this.must(id);
    const v = await this.d.db.editorVersion.findFirst({ where: { id: versionId, projectId: id } });
    if (!v) throw new AppError('NOT_FOUND', 'Version not found.');
    await this.snapshot(id, row.rev, row.data, 'restore', 'Before restoring a version');
    const project = projectSchema.parse(parseJson<unknown>(v.data, {}));
    const updated = await this.d.db.editorProject.update({
      where: { id },
      data: {
        data: JSON.stringify(project),
        rev: row.rev + 1,
        durationSec: projectDuration(project),
        aspect: project.canvas.aspect,
      },
    });
    void this.backup(id, project, true);
    return this.toDoc(updated);
  }

  /** Best-effort mirror of the project to object storage (BRIEF §5: "back up to R2"); throttled. */
  private async backup(id: string, project: Project, force: boolean): Promise<void> {
    const storage = this.d.getStorage();
    if (!storage) return;
    const now = Date.now();
    if (!force && now - (this.lastBackup.get(id) ?? 0) < BACKUP_INTERVAL_MS) return;
    this.lastBackup.set(id, now);
    try {
      await storage.put(keysEditor.projectBackup(id), JSON.stringify(project), {
        contentType: 'application/json',
      });
    } catch (e) {
      this.d.log(`editor backup failed: ${String(e)}`);
    }
  }

  /* ------------------------------------------------------------------ open from library ------ */

  private thin(kfs: { t: number; x: number; y: number; w: number; h: number }[]): typeof kfs {
    const out: typeof kfs = [];
    let last: (typeof kfs)[number] | undefined;
    for (const k of kfs) {
      const moved =
        !last ||
        Math.abs(k.x - last.x) > 0.004 ||
        Math.abs(k.y - last.y) > 0.004 ||
        Math.abs(k.w - last.w) > 0.004;
      if (!last || moved) {
        out.push({ ...k, t: Math.round(k.t * 1000) / 1000 });
        last = k;
      }
    }
    const end = kfs[kfs.length - 1];
    if (
      end &&
      out[out.length - 1] !== undefined &&
      (out[out.length - 1] as { t: number }).t < end.t - 1e-3
    )
      out.push({ ...end, t: Math.round(end.t * 1000) / 1000 });
    return out;
  }

  /** Face-track a window of a local media file (a 480p proxy is plenty for faces) → normalised crop keyframes. */
  private async reframeFile(
    file: string,
    startSec: number,
    endSec: number,
    aspect: '9:16' | '1:1' | '16:9' | '4:5',
    mode: 'auto' | 'single-face' | 'center',
    signal?: AbortSignal,
  ): Promise<{
    keyframes: { t: number; x: number; y: number; w: number; h: number }[];
    faceCoverage: number;
    srcW: number;
    srcH: number;
  }> {
    const info = await this.d.media.probe(file);
    const srcW = info.width ?? 854;
    const srcH = info.height ?? 480;
    let faces: FaceSample[] = [];
    if (mode !== 'center') {
      await this.d.sidecar.start();
      const wire = await this.d.sidecar.faces(
        { video_path: file, fps: 4, start: startSec, end: endSec, min_confidence: 0.3 },
        { signal },
      );
      faces = this.d.toFaceSamples(wire);
    }
    const plan = this.d.reframe.plan({
      startSec,
      endSec,
      srcW,
      srcH,
      aspect,
      faces,
      sceneCuts: [],
      mode: mode === 'center' ? 'center' : 'single-face',
    });
    const keyframes = this.thin(
      plan.keyframes.map((k) => ({
        t: k.t,
        x: k.x / srcW,
        y: k.y / srcH,
        w: k.w / srcW,
        h: k.h / srcH,
      })),
    );
    return { keyframes, faceCoverage: plan.faceCoverage, srcW, srcH };
  }

  /** The editor's Reframe tool: re-run face tracking for a project asset's source range. */
  async reframeAsset(a: {
    projectId: string;
    assetId: string;
    startSec: number;
    endSec: number;
    aspect: '9:16' | '1:1' | '16:9' | '4:5';
    mode: 'auto' | 'single-face' | 'center';
  }) {
    const { asset } = await this.assetOf(a.projectId, a.assetId);
    if (asset.kind !== 'video') throw new AppError('VALIDATION', 'Only video can be reframed.');
    const file = await this.localPreviewFile(a.projectId, asset);
    const r = await this.reframeFile(file, a.startSec, a.endSec, a.aspect, a.mode);
    return { keyframes: r.keyframes, faceCoverage: r.faceCoverage };
  }

  private async videoRow(videoId: string) {
    const v = await this.d.db.video.findUnique({ where: { id: videoId } });
    if (!v) throw new AppError('NOT_FOUND', 'Video not found.');
    return v;
  }

  private async buildFromClip(
    clipId: string,
  ): Promise<{ project: Project; title: string; videoId: string }> {
    const clip = await this.d.db.clip.findUnique({ where: { id: clipId } });
    if (!clip) throw new AppError('NOT_FOUND', 'Clip not found.');
    const video = await this.videoRow(clip.videoId);
    const aspect =
      (['9:16', '1:1', '16:9', '4:5'] as const).find((a) => a === clip.aspect) ?? '9:16';
    const transcript = await this.d.orchestrator.loadTranscript(clip.videoId);
    let project = blankProject(aspect);
    const dur = clip.endSec - clip.startSec;
    const meta = parseJson<{
      appliedHookText?: string | null;
      hookOff?: boolean;
      highlight?: { segments: { startSec: number; endSec: number }[] };
    }>(clip.metadata, {});

    // Picture: the source video (proxy in the preview, full-res at export) trimmed to the clip, with the face-tracking path as crop keyframes.
    let crop: { t: number; x: number; y: number; w: number; h: number }[] | undefined;
    let dims: { w: number; h: number } = { w: 1920, h: 1080 };
    try {
      const r = await this.reframeFile(
        await this.localProxy(clip.videoId),
        clip.startSec,
        clip.endSec,
        aspect,
        'auto',
      );
      crop = r.keyframes;
      dims = { w: r.srcW, h: r.srcH };
    } catch (e) {
      this.d.log(`editor: reframe for ${clipId} failed, using centre crop: ${String(e)}`);
    }
    const asset = videoAsset({
      name: video.title,
      videoId: clip.videoId,
      durationSec: video.durationSec,
      width: dims.w,
      height: dims.h,
    });
    project = { ...project, assets: [asset] };
    const item = mainVideoItem({
      assetId: asset.id,
      inSec: clip.startSec,
      durationSec: dur,
      crop,
      fit: 'cover',
    });
    project = withItems(project, 'video', [item]);

    if (transcript) {
      const edits = subtitleEditsSchema.parse(
        await this.d.loadSubtitleEdits(clip.videoId).catch(() => ({})),
      );
      const edited = this.d.subtitles.applyEdits(transcript.words, edits);
      const words: Word[] = edited.map((w) => ({ w: w.w, s: w.s, e: w.e, p: w.p }));
      const cues = this.d.subtitles.cues(transcript.words, edits);
      const items = cuesToItems(cues, words, {
        from: clip.startSec,
        to: clip.endSec,
        offsetSec: clip.startSec,
        styleId: clip.captionStyleId,
      });
      project = withItems(project, 'subtitle', items);
    }
    const hook = meta.hookOff ? null : (meta.appliedHookText ?? clip.hook);
    if (hook)
      project = withItems(project, 'text', [
        hookTextItem(hook, project.canvas.width, project.canvas.height, 2.8),
      ]);
    return { project, title: clip.title, videoId: clip.videoId };
  }

  private async buildFromVideo(videoId: string): Promise<{ project: Project; title: string }> {
    const video = await this.videoRow(videoId);
    const proxy = await this.localProxy(videoId).catch(() => null);
    let dims = { w: 1920, h: 1080 };
    if (proxy) {
      const info = await this.d.media.probe(proxy).catch(() => null);
      if (info?.width && info.height) dims = { w: info.width, h: info.height };
    }
    const canvas = canvasFor(dims.w, dims.h);
    let project: Project = {
      ...blankProject('16:9'),
      canvas: { ...blankProject('16:9').canvas, ...canvas },
    };
    const asset = videoAsset({
      name: video.title,
      videoId,
      durationSec: video.durationSec,
      width: dims.w,
      height: dims.h,
    });
    project = { ...project, assets: [asset] };
    const dur = video.durationSec ?? 0;
    if (dur <= 0)
      throw new AppError(
        'VALIDATION',
        'This video has no duration yet. Wait for processing to finish.',
      );
    project = withItems(project, 'video', [
      mainVideoItem({ assetId: asset.id, inSec: 0, durationSec: dur, fit: 'contain' }),
    ]);
    const transcript = await this.d.orchestrator.loadTranscript(videoId);
    if (transcript) {
      const edits = subtitleEditsSchema.parse(
        await this.d.loadSubtitleEdits(videoId).catch(() => ({})),
      );
      const edited = this.d.subtitles.applyEdits(transcript.words, edits);
      const words: Word[] = edited.map((w) => ({ w: w.w, s: w.s, e: w.e, p: w.p }));
      const cues = this.d.subtitles.cues(transcript.words, edits);
      project = withItems(
        project,
        'subtitle',
        cuesToItems(cues, words, { from: 0, to: dur, offsetSec: 0, styleId: 'clean-pop' }),
      );
    }
    // Markers: the clips found in this video + the user's own markers.
    const [clips, markers] = await Promise.all([
      this.d.db.clip.findMany({
        where: { videoId, kind: 'clip' },
        orderBy: { startSec: 'asc' },
        take: 60,
      }),
      this.d.db.marker.findMany({ where: { videoId }, orderBy: { atSec: 'asc' } }),
    ]);
    project = {
      ...project,
      markers: [
        ...clips.map((c) => ({
          id: newId('mk'),
          atSec: c.startSec,
          label: c.title.slice(0, 60),
          color: '#7C6CF0',
        })),
        ...markers.map((m) => ({
          id: newId('mk'),
          atSec: m.atSec,
          label: m.label.slice(0, 60),
          color: '#F5A524',
        })),
      ],
    };
    return { project, title: video.title };
  }

  /* ------------------------------------------------------------------ media ------------------- */

  private async assetOf(
    projectId: string,
    assetId: string,
  ): Promise<{ asset: Asset; project: Project }> {
    const project = (await this.get(projectId)).project;
    const asset = project.assets.find((a) => a.id === assetId);
    if (!asset) throw new AppError('NOT_FOUND', 'Asset not found in this project.');
    return { asset, project };
  }

  private async download(key: string, file: string): Promise<string> {
    if (fs.existsSync(file) && fs.statSync(file).size > 0) return file;
    const storage = this.d.getStorage();
    if (!storage)
      throw new AppError('UNAVAILABLE', 'Object storage is not connected (Settings → Storage).');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.part`;
    await streamPipeline(await storage.getStream(key), fs.createWriteStream(tmp));
    fs.renameSync(tmp, file);
    return file;
  }

  private async localProxy(videoId: string): Promise<string> {
    const v = await this.videoRow(videoId);
    const k = parseJson<Record<string, string>>(v.storageKeys, {});
    if (!k.proxy)
      throw new AppError(
        'UNAVAILABLE',
        'This video has no 480p proxy in storage (Settings → Storage → keep the 480p proxy).',
      );
    return this.download(
      k.proxy,
      path.join(this.d.cacheDir, 'editor', '_proxies', `${videoId}.mp4`),
    );
  }

  /** Storage key + extension of the file the PREVIEW plays for an asset (null reason = why not). */
  private async previewKey(asset: Asset): Promise<{ key: string | null; reason: string | null }> {
    const s = asset.source;
    if (s.kind === 'video') {
      const v = await this.d.db.video.findUnique({ where: { id: s.videoId } });
      const k = parseJson<Record<string, string>>(v?.storageKeys, {});
      return k.proxy
        ? { key: k.proxy, reason: null }
        : {
            key: null,
            reason:
              'Preview unavailable: this video has no 480p proxy (Settings → Storage → keep the 480p proxy).',
          };
    }
    if (s.kind === 'clip') {
      const c = await this.d.db.clip.findUnique({ where: { id: s.clipId } });
      const k = parseJson<Record<string, string>>(c?.storageKeys, {});
      return k.render
        ? { key: k.render, reason: null }
        : { key: null, reason: 'This clip has not finished rendering yet.' };
    }
    const preview = `${s.key}.preview.mp4`;
    const storage = this.d.getStorage();
    if (asset.kind === 'video' && storage && (await storage.head(preview)))
      return { key: preview, reason: null };
    return { key: s.key, reason: null };
  }

  async previewUrl(
    projectId: string,
    assetId: string,
  ): Promise<{ url: string | null; reason: string | null }> {
    const { asset } = await this.assetOf(projectId, assetId);
    const storage = this.d.getStorage();
    if (!storage) return { url: null, reason: 'Object storage is not connected.' };
    const { key, reason } = await this.previewKey(asset);
    if (!key) return { url: null, reason };
    return { url: await storage.presignGet(key, 3600), reason: null };
  }

  private async localPreviewFile(projectId: string, asset: Asset): Promise<string> {
    const { key, reason } = await this.previewKey(asset);
    if (!key) throw new AppError('UNAVAILABLE', reason ?? 'Media unavailable.');
    return this.download(
      key,
      path.join(this.d.cacheDir, 'editor', projectId, `${asset.id}${path.extname(key) || '.bin'}`),
    );
  }

  async importAssets(
    projectId: string,
    kinds: Asset['kind'][],
  ): Promise<{ assets: Asset[]; canceled: boolean }> {
    await this.must(projectId);
    const storage = this.d.getStorage();
    if (!storage)
      throw new AppError('UNAVAILABLE', 'Object storage is not connected (Settings → Storage).');
    const filters = [
      {
        name: 'Media',
        extensions: Object.entries(EXT_KIND)
          .filter(([, k]) => kinds.includes(k))
          .map(([e]) => e),
      },
    ];
    const files = await this.d.chooseFiles({ title: 'Import media', extensions: filters });
    if (files.length === 0) return { assets: [], canceled: true };
    const out: Asset[] = [];
    for (const file of files) {
      const asset = await this.addFileAsset(storage, projectId, file, kinds);
      if (asset) out.push(asset);
    }
    this.d.invalidateStorage();
    return { assets: out, canceled: false };
  }

  /** Uploads one local media file into a project's asset storage (probe + 480p preview copy) and returns the asset. null = kind not wanted. */
  private async addFileAsset(
    storage: StorageProvider,
    projectId: string,
    file: string,
    kinds: Asset['kind'][],
    name?: string,
  ): Promise<Asset | null> {
    const ext = path.extname(file).slice(1).toLowerCase();
    const kind = EXT_KIND[ext];
    if (!kind || !kinds.includes(kind)) return null;
    const id = newId('as');
    const key = keysEditor.asset(projectId, id, ext);
    let meta: {
      durationSec: number | null;
      width: number | null;
      height: number | null;
      fps: number | null;
      hasAudio: boolean;
    } = { durationSec: null, width: null, height: null, fps: null, hasAudio: false };
    if (kind !== 'lut') {
      const p = await this.d.media.probe(file).catch(() => null);
      if (!p)
        throw new AppError(
          'VALIDATION',
          `Clipfern could not read “${path.basename(file)}”. Is it a valid media file?`,
        );
      meta = {
        durationSec: p.durationSec,
        width: p.width,
        height: p.height,
        fps: p.fps,
        hasAudio: p.hasAudio,
      };
    }
    await storage.putFile(key, file);
    if (kind === 'video') {
      const tmp = path.join(this.d.cacheDir, 'editor', projectId, `${id}.preview.mp4`);
      fs.mkdirSync(path.dirname(tmp), { recursive: true });
      try {
        await this.d.media.makePreview(file, tmp);
        await storage.putFile(`${key}.preview.mp4`, tmp, { contentType: 'video/mp4' });
      } catch (e) {
        this.d.log(`editor: preview copy failed for ${file}: ${String(e)}`);
      }
    }
    const fileName = name ?? path.basename(file);
    return {
      id,
      kind,
      name: fileName,
      source: { kind: 'upload', key, fileName },
      durationSec: meta.durationSec,
      width: meta.width,
      height: meta.height,
      fps: meta.fps,
      hasAudio: meta.hasAudio,
      beats: null,
    };
  }

  /** A stock clip (or any local video) downloaded by the B-roll flow becomes a project asset. */
  async importLocalVideo(projectId: string, file: string, name: string): Promise<Asset> {
    await this.must(projectId);
    const storage = this.d.getStorage();
    if (!storage)
      throw new AppError('UNAVAILABLE', 'Object storage is not connected (Settings → Storage).');
    const asset = await this.addFileAsset(storage, projectId, file, ['video'], name);
    if (!asset) throw new AppError('VALIDATION', 'That file is not a video.');
    this.d.invalidateStorage();
    return asset;
  }

  async waveform(projectId: string, assetId: string): Promise<Waveform | null> {
    const { asset } = await this.assetOf(projectId, assetId);
    if (asset.kind === 'image' || asset.kind === 'lut' || !asset.hasAudio) return null;
    const cacheFile = path.join(this.d.cacheDir, 'editor', projectId, `${assetId}.waveform.json`);
    try {
      if (fs.existsSync(cacheFile))
        return JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as Waveform;
      const file = await this.localPreviewFile(projectId, asset);
      const w = await this.d.media.waveform(file, 50);
      fs.writeFileSync(cacheFile, JSON.stringify(w));
      return w;
    } catch (e) {
      this.d.log(`editor waveform failed: ${String(e)}`);
      return null;
    }
  }

  async beats(projectId: string, assetId: string): Promise<number[]> {
    const { asset } = await this.assetOf(projectId, assetId);
    if (asset.beats) return asset.beats;
    const cacheFile = path.join(this.d.cacheDir, 'editor', projectId, `${assetId}.beats.json`);
    if (fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as number[];
    const file = await this.localPreviewFile(projectId, asset);
    const beats = await this.d.media.beats(file);
    fs.writeFileSync(cacheFile, JSON.stringify(beats));
    return beats;
  }

  async thumbStrip(a: {
    projectId: string;
    assetId: string;
    startSec: number;
    endSec: number;
    count: number;
    height: number;
  }) {
    const { asset } = await this.assetOf(a.projectId, a.assetId);
    const none = { dataUrl: null, tileW: 0, tileH: 0, cols: 0, times: [] as number[] };
    if (asset.kind !== 'video') return none;
    try {
      const file = await this.localPreviewFile(a.projectId, asset);
      const out = path.join(
        this.d.cacheDir,
        'editor',
        a.projectId,
        `strip-${asset.id}-${Math.round(a.startSec * 10)}-${Math.round(a.endSec * 10)}-${a.count}-${a.height}.jpg`,
      );
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const g = await this.d.media.thumbStrip({
        file,
        startSec: a.startSec,
        endSec: Math.max(a.endSec, a.startSec + 0.1),
        count: a.count,
        height: a.height,
        outJpg: out,
      });
      return {
        dataUrl: `data:image/jpeg;base64,${fs.readFileSync(out).toString('base64')}`,
        tileW: g.tileW,
        tileH: g.tileH,
        cols: g.cols,
        times: g.times,
      };
    } catch (e) {
      this.d.log(`editor thumbStrip failed: ${String(e)}`);
      return none;
    }
  }

  /** Re-transcribe [srcStart, srcEnd) of an asset's audio; returns words in SOURCE time. */
  async resyncSubtitles(
    projectId: string,
    assetId: string,
    srcStartSec: number,
    srcEndSec: number,
  ): Promise<{ words: { w: string; s: number; e: number }[] }> {
    const { asset } = await this.assetOf(projectId, assetId);
    if (srcEndSec - srcStartSec < 0.3)
      throw new AppError('VALIDATION', 'Select a longer range to re-sync.');
    const file = await this.localPreviewFile(projectId, asset);
    const wav = path.join(this.d.cacheDir, 'editor', projectId, `resync-${Date.now()}.wav`);
    try {
      await this.extractWav(file, wav, srcStartSec, srcEndSec - srcStartSec);
      await this.d.sidecar.start();
      const res = await this.d.sidecar.transcribe({
        audio_path: wav,
        model: this.d.whisperModel(),
        vad_filter: true,
        condition_on_previous_text: false,
      });
      const words = res.segments
        .flatMap((s) => s.words)
        .map((w) => ({ w: w.word.trim(), s: w.start + srcStartSec, e: w.end + srcStartSec }))
        .filter((w) => w.w);
      return { words };
    } finally {
      fs.rmSync(wav, { force: true });
    }
  }

  private async extractWav(
    src: string,
    out: string,
    startSec: number,
    durSec: number,
  ): Promise<void> {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await this.d.media.runFfmpeg({
      ffmpegPath: this.d.ffmpegPath(),
      args: [
        '-y',
        '-v',
        'error',
        '-ss',
        String(startSec),
        '-t',
        String(durSec),
        '-i',
        src,
        '-vn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-c:a',
        'pcm_s16le',
        out,
      ],
      durationSec: durSec,
    });
  }

  /* ------------------------------------------------------------------ exports ----------------- */

  private toExportJob(r: {
    id: string;
    projectId: string | null;
    name: string;
    status: string;
    progress: number | null;
    message: string | null;
    error: string | null;
    settings: string;
    durationSec: number | null;
    sizeBytes: number | null;
    storageKeys: string;
    createdAt: Date;
    finishedAt: Date | null;
  }): ExportJob {
    const k = parseJson<Record<string, string>>(r.storageKeys, {});
    return {
      id: r.id,
      projectId: r.projectId,
      name: r.name,
      status:
        (['queued', 'rendering', 'done', 'failed', 'canceled'] as const).find(
          (s) => s === r.status,
        ) ?? 'failed',
      progress: r.progress,
      message: r.message,
      error: r.error,
      settings: readSettings(r.settings),
      durationSec: r.durationSec,
      sizeBytes: r.sizeBytes,
      hasFile: Boolean(k.video),
      hasThumb: Boolean(k.thumb),
      createdAt: r.createdAt.getTime(),
      finishedAt: r.finishedAt ? r.finishedAt.getTime() : null,
    };
  }

  async listExports(limit: number): Promise<ExportJob[]> {
    const rows = await this.d.db.editorExport.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map((r) => this.toExportJob(r));
  }

  private async emitExport(id: string): Promise<void> {
    const r = await this.d.db.editorExport.findUnique({ where: { id } });
    if (r) this.d.emit.export(this.toExportJob(r));
  }

  async startExport(
    projectId: string,
    req: Partial<ExportSettings>,
  ): Promise<{ exportId: string }> {
    const doc = await this.get(projectId);
    const settings = resolveExportSettings(req, doc.project.canvas);
    if (projectDuration(doc.project) <= 0)
      throw new AppError('VALIDATION', 'The timeline is empty. Add something before exporting.');
    const row = await this.d.db.editorExport.create({
      data: {
        projectId,
        name: doc.name,
        status: 'queued',
        settings: JSON.stringify(settings),
        durationSec: projectDuration(doc.project),
        message: 'Queued',
      },
    });
    await this.d.queue.enqueue({
      kind: JOB_EDITOR_EXPORT,
      payload: { exportId: row.id, project: doc.project },
      groupKey: `export-${row.id}`,
    });
    await this.emitExport(row.id);
    return { exportId: row.id };
  }

  async cancelExport(id: string): Promise<void> {
    const jobs = await this.d.db.job.findMany({
      where: {
        kind: JOB_EDITOR_EXPORT,
        status: { in: ['queued', 'running'] },
        payload: { contains: id },
      },
    });
    for (const j of jobs) await this.d.queue.cancel(j.id);
    await this.d.db.editorExport.updateMany({
      where: { id, status: { in: ['queued', 'rendering'] } },
      data: { status: 'canceled', finishedAt: new Date(), message: 'Canceled' },
    });
    await this.emitExport(id);
  }

  /** Resolve every asset the project uses to a local full-resolution file. */
  private async resolveFiles(
    project: Project,
    workDir: string,
    signal: AbortSignal,
    onStep: (m: string) => void,
  ): Promise<Record<string, EditorAssetFile>> {
    const used = new Set<string>();
    for (const t of project.tracks)
      for (const it of t.items) {
        if ('assetId' in it) used.add(it.assetId);
        if (it.type === 'video' || it.type === 'image')
          if (it.color.lutAssetId) used.add(it.color.lutAssetId);
      }
    const out: Record<string, EditorAssetFile> = {};
    for (const asset of project.assets) {
      if (!used.has(asset.id)) continue;
      onStep(`Preparing ${asset.name}`);
      const s = asset.source;
      let file: string;
      if (s.kind === 'video') file = await this.d.orchestrator.ensureSource(s.videoId, signal);
      else if (s.kind === 'clip')
        file = await this.download(keys.clip(s.clipId), path.join(workDir, `${asset.id}.mp4`));
      else
        file = await this.download(
          s.key,
          path.join(workDir, `${asset.id}${path.extname(s.fileName) || ''}`),
        );
      const p = asset.kind === 'lut' ? null : await this.d.media.probe(file);
      out[asset.id] = {
        assetId: asset.id,
        kind: asset.kind,
        path: file,
        width: p?.width ?? asset.width,
        height: p?.height ?? asset.height,
        fps: p?.fps ?? asset.fps,
        durationSec: p?.durationSec ?? asset.durationSec,
        hasAudio: p?.hasAudio ?? asset.hasAudio,
      };
    }
    return out;
  }

  private async runExport(ctx: JobContext<{ exportId: string; project: Project }>): Promise<void> {
    const { exportId } = ctx.payload;
    const project = projectSchema.parse(ctx.payload.project);
    const row = await this.d.db.editorExport.findUnique({ where: { id: exportId } });
    if (!row || row.status === 'canceled') return;
    const settings = readSettings(row.settings);
    const storage = this.d.getStorage();
    const workDir = path.join(this.d.cacheDir, 'exports', exportId);
    let lastEmit = 0;
    const set = async (data: Record<string, unknown>, force = true) => {
      await this.d.db.editorExport.update({ where: { id: exportId }, data }).catch(() => {});
      const now = Date.now();
      if (force || now - lastEmit > 400) {
        lastEmit = now;
        await this.emitExport(exportId);
      }
    };
    try {
      if (!storage) throw new Error('Object storage is not connected (Settings → Storage).');
      fs.mkdirSync(workDir, { recursive: true });
      await set({ status: 'rendering', progress: 0, message: 'Preparing media…', error: null });
      const files = await this.resolveFiles(
        project,
        workDir,
        ctx.signal,
        (m) => void set({ message: m }, false),
      );
      const ffmpegPath = this.d.ffmpegPath();
      const encoder = await this.d.detectEncoder(ffmpegPath);
      const safeName =
        (row.name || 'export')
          .replace(/[^\w\- ]+/g, '')
          .trim()
          .slice(0, 60) || 'export';
      const outPath = path.join(workDir, `${safeName}.mp4`);
      const compiled = await this.d.compiler.compile({
        project,
        settings,
        files,
        workDir,
        outPath,
        fontsDir: this.d.fontsDir(),
        encoder,
        getStyle: (id) => {
          const s = this.styleCache.get(id);
          if (!s) throw new Error(`Caption style “${id}” is not loaded`);
          return s;
        },
        captions: this.d.captions,
      });
      await set({ message: 'Rendering…', durationSec: compiled.durationSec });
      await this.d.media.runFfmpeg({
        ffmpegPath,
        args: compiled.args,
        durationSec: compiled.durationSec,
        signal: ctx.signal,
        onProgress: (f) => {
          if (f !== null) void set({ progress: Math.min(0.97, f * 0.97) }, false);
        },
      });
      if (ctx.signal.aborted) throw new Error('canceled');
      await set({ message: 'Uploading…', progress: 0.98 });
      const thumb = path.join(workDir, 'thumb.jpg');
      await this.d
        .thumbnail(ffmpegPath, outPath, thumb, { atSec: Math.min(1, compiled.durationSec / 3) })
        .catch(() => {});
      await storage.putFile(keysEditor.exportFile(exportId), outPath, { contentType: 'video/mp4' });
      const k: Record<string, string> = { video: keysEditor.exportFile(exportId) };
      if (fs.existsSync(thumb)) {
        await storage.putFile(keysEditor.exportThumb(exportId), thumb, {
          contentType: 'image/jpeg',
        });
        k.thumb = keysEditor.exportThumb(exportId);
      }
      if (settings.sidecarSrt && compiled.srt) {
        await storage.put(keysEditor.exportSrt(exportId), compiled.srt, {
          contentType: 'application/x-subrip',
        });
        k.srt = keysEditor.exportSrt(exportId);
      }
      if (settings.sidecarVtt && compiled.vtt) {
        await storage.put(keysEditor.exportVtt(exportId), compiled.vtt, {
          contentType: 'text/vtt',
        });
        k.vtt = keysEditor.exportVtt(exportId);
      }
      this.d.invalidateStorage();
      await set({
        status: 'done',
        progress: 1,
        message: null,
        sizeBytes: fs.statSync(outPath).size,
        storageKeys: JSON.stringify(k),
        finishedAt: new Date(),
      });
      await this.d.notifications.create({
        kind: 'job',
        level: 'success',
        title: 'Export ready',
        body: row.name,
        href: '/library/?tab=exported',
        os: true,
      });
    } catch (err) {
      if (ctx.signal.aborted) {
        await set({ status: 'canceled', message: 'Canceled', finishedAt: new Date() });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.d.log(
        `export ${exportId} failed: ${err instanceof Error ? (err.stack ?? message) : message}`,
      );
      await set({
        status: 'failed',
        error: message.slice(0, 500),
        message: null,
        finishedAt: new Date(),
      });
      await this.d.notifications.create({
        kind: 'job',
        level: 'error',
        title: 'Export failed',
        body: `${row.name}: ${message.slice(0, 200)}`,
        href: '/library/?tab=exported',
        os: true,
      });
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }

  /** Caption styles the compiler may need synchronously (`getStyle`) — loaded before each export. */
  private styleCache = new Map<string, CaptionStyle>();
  async primeStyles(): Promise<void> {
    for (const s of await this.d.styles.list()) this.styleCache.set(s.id, s);
  }

  async exportUrl(id: string, kind: 'video' | 'thumb'): Promise<string | null> {
    const r = await this.d.db.editorExport.findUnique({ where: { id } });
    const k = parseJson<Record<string, string>>(r?.storageKeys, {});
    const key = kind === 'video' ? k.video : k.thumb;
    const storage = this.d.getStorage();
    return storage && key ? storage.presignGet(key, 3600) : null;
  }

  async deleteExports(ids: string[]): Promise<void> {
    const rows = await this.d.db.editorExport.findMany({ where: { id: { in: ids } } });
    for (const r of rows)
      if (r.status === 'queued' || r.status === 'rendering') await this.cancelExport(r.id);
    const storage = this.d.getStorage();
    if (storage) {
      const doomed = rows.flatMap((r) =>
        Object.values(parseJson<Record<string, string>>(r.storageKeys, {})),
      );
      await storage.delete(doomed).catch((e) => this.d.log(`export delete: ${String(e)}`));
      this.d.invalidateStorage();
    }
    await this.d.db.editorExport.deleteMany({ where: { id: { in: ids } } });
  }

  async downloadExports(
    ids: string[],
  ): Promise<{ saved: number; dir: string | null; canceled: boolean }> {
    const storage = this.d.getStorage();
    if (!storage)
      throw new AppError('UNAVAILABLE', 'Object storage is not connected (Settings → Storage).');
    const rows = await this.d.db.editorExport.findMany({
      where: { id: { in: ids }, status: 'done' },
    });
    if (rows.length === 0)
      throw new AppError('NOT_FOUND', 'None of the selected exports has finished.');
    const dir = await this.d.chooseDirectory();
    if (!dir) return { saved: 0, dir: null, canceled: true };
    let saved = 0;
    for (const r of rows) {
      const k = parseJson<Record<string, string>>(r.storageKeys, {});
      const settings = readSettings(r.settings);
      const base =
        settings.filenameTemplate
          .replace('{title}', r.name)
          .replace('{preset}', settings.preset)
          .replace('{date}', new Date(r.createdAt).toISOString().slice(0, 10))
          .replace('{n}', String(saved + 1))
          .replace(/[^\w\- ]+/g, '')
          .trim()
          .slice(0, 100) || 'export';
      for (const [key, ext] of [
        [k.video, 'mp4'],
        [k.srt, 'srt'],
        [k.vtt, 'vtt'],
      ] as const) {
        if (!key) continue;
        const target = path.join(dir, `${base}.${ext}`);
        await streamPipeline(await storage.getStream(key), fs.createWriteStream(`${target}.part`));
        fs.renameSync(`${target}.part`, target);
      }
      saved++;
    }
    return { saved, dir, canceled: false };
  }
}
