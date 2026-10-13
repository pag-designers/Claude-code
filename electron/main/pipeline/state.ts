import type { PipelineEvent, PipelineStage, StageState, StageStatus, VideoStatus } from '@shared/pipeline';
import type { Db } from '../db/client';
import { readStages } from './views';

export interface StageTrackerHooks {
  onEvent(e: PipelineEvent): void;
  /** Called after DB state changed so the caller can re-emit the VideoView. */
  onVideoChanged(videoId: string): void;
}

/**
 * Persists per-video stage state (Video.stages JSON + Video.stage/progress/status) and emits
 * PipelineEvents. DB writes for pure progress ticks are throttled; status changes are immediate.
 */
export class StageTracker {
  private cache = new Map<string, StageState[]>();
  private lastWrite = new Map<string, number>();
  private pending = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly db: Db,
    private readonly hooks: StageTrackerHooks,
    private readonly throttleMs = 400,
  ) {}

  async load(videoId: string): Promise<StageState[]> {
    const hit = this.cache.get(videoId);
    if (hit) return hit;
    const row = await this.db.video.findUnique({ where: { id: videoId }, select: { stages: true } });
    const st = readStages(row?.stages ?? '[]');
    this.cache.set(videoId, st);
    return st;
  }

  forget(videoId: string): void {
    this.cache.delete(videoId);
    const t = this.pending.get(videoId);
    if (t) clearTimeout(t);
    this.pending.delete(videoId);
  }

  async status(videoId: string, stage: PipelineStage): Promise<StageStatus> {
    const st = await this.load(videoId);
    return st.find((s) => s.stage === stage)?.status ?? 'pending';
  }

  async update(
    videoId: string,
    stage: PipelineStage,
    patch: Partial<Pick<StageState, 'status' | 'progress' | 'message' | 'detail' | 'error'>>,
    videoStatus?: VideoStatus,
  ): Promise<void> {
    const states = await this.load(videoId);
    const s = states.find((x) => x.stage === stage);
    if (!s) return;
    const statusChanged = patch.status !== undefined && patch.status !== s.status;
    if (patch.status === 'running' && s.status !== 'running') {
      s.startedAt = Date.now();
      s.finishedAt = null;
      s.error = null;
    }
    Object.assign(s, patch);
    if (patch.status && ['done', 'failed', 'skipped', 'canceled'].includes(patch.status)) {
      s.finishedAt = Date.now();
      if (patch.status === 'done') s.progress = 1;
    }
    this.hooks.onEvent({
      videoId,
      stage,
      status: s.status,
      progress: s.progress,
      message: s.message,
      detail: s.detail,
      at: Date.now(),
    });
    const immediate = statusChanged || videoStatus !== undefined || patch.error !== undefined;
    const last = this.lastWrite.get(videoId) ?? 0;
    if (immediate || Date.now() - last >= this.throttleMs) {
      await this.flush(videoId, stage, s.progress, videoStatus);
    } else if (!this.pending.has(videoId)) {
      this.pending.set(
        videoId,
        setTimeout(() => {
          this.pending.delete(videoId);
          void this.flush(videoId, stage, s.progress).catch(() => {});
        }, this.throttleMs),
      );
    }
  }

  async resetFrom(videoId: string, from: PipelineStage): Promise<void> {
    const states = await this.load(videoId);
    let reset = false;
    for (const s of states) {
      if (s.stage === from) reset = true;
      if (reset) {
        s.status = 'pending';
        s.progress = null;
        s.message = null;
        s.detail = null;
        s.error = null;
        s.startedAt = null;
        s.finishedAt = null;
      }
    }
    await this.flush(videoId, from, null, 'processing', true);
  }

  private async flush(
    videoId: string,
    stage: PipelineStage,
    progress: number | null,
    videoStatus?: VideoStatus,
    clearError = false,
  ): Promise<void> {
    const states = await this.load(videoId);
    this.lastWrite.set(videoId, Date.now());
    const failed = states.find((s) => s.status === 'failed');
    try {
      await this.db.video.update({
        where: { id: videoId },
        data: {
          stages: JSON.stringify(states),
          stage,
          progress,
          ...(videoStatus ? { status: videoStatus } : {}),
          ...(failed ? { error: failed.error } : clearError ? { error: null } : {}),
        },
      });
    } catch {
      return; // video was deleted while a late progress tick was in flight
    }
    this.hooks.onVideoChanged(videoId);
  }
}
