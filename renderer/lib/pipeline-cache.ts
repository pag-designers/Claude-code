'use client';

/**
 * Cache glue for the pipeline domain. Main pushes `videos:updated`, `clips:updated` and `pipeline:event`; there is
 * no "deleted" event, so deletions are applied here (optimistically) by the mutation hooks. Every list query that
 * is already cached is patched in place (no refetch, no polling); queries that were never opened are left alone.
 */
import type { QueryClient } from '@tanstack/react-query';
import type { ClipView, PipelineEvent, StageState, VideoView } from '@shared/pipeline';
import { ipcKey } from './ipc';
import { applyEventToStages } from './pipeline-ui';
import { usePipelineLog } from './pipeline-log';

export const VIDEOS_PAYLOAD = { limit: 500 } as const;
export const CLIPS_ALL_PAYLOAD = { limit: 1000 } as const;
export const clipsOfVideoPayload = (videoId: string) => ({ videoId, limit: 500 }) as const;

interface VideosList {
  items: VideoView[];
}
interface ClipsList {
  items: ClipView[];
}
interface VideoDetail {
  video: VideoView;
  analysis: unknown;
  stages: StageState[];
}

/** Replace-or-prepend by id. Returns the same array reference when nothing changed. */
export function upsertById<T extends { id: string }>(list: readonly T[], item: T): T[] {
  const at = list.findIndex((x) => x.id === item.id);
  if (at < 0) return [item, ...list];
  const next = list.slice();
  next[at] = item;
  return next;
}

export function removeByIds<T extends { id: string }>(
  list: readonly T[],
  ids: readonly string[],
): T[] {
  const set = new Set(ids);
  return list.filter((x) => !set.has(x.id));
}

interface ClipListFilter {
  videoId?: string;
  favorite?: boolean;
  minScore?: number;
}
export function clipMatchesListFilter(c: ClipView, f: ClipListFilter | undefined): boolean {
  if (!f) return true;
  if (f.videoId !== undefined && c.videoId !== f.videoId) return false;
  if (f.favorite !== undefined && c.favorite !== f.favorite) return false;
  if (f.minScore !== undefined && (c.score ?? 0) < f.minScore) return false;
  return true;
}

export function upsertVideoInCache(qc: QueryClient, v: VideoView): void {
  qc.setQueriesData<VideosList>({ queryKey: ['videos:list'] }, (old) => {
    if (!old) return old;
    return { items: upsertById(old.items, v) };
  });
  // favorites-filtered lists: drop when no longer matching
  for (const [key, data] of qc.getQueriesData<VideosList>({ queryKey: ['videos:list'] })) {
    const f = key[1] as { favorite?: boolean } | undefined;
    if (data && f?.favorite !== undefined && v.favorite !== f.favorite)
      qc.setQueryData<VideosList>(key, { items: removeByIds(data.items, [v.id]) });
  }
  qc.setQueryData<VideoDetail>(ipcKey('videos:get', { id: v.id }), (old) =>
    old ? { ...old, video: v } : old,
  );
}

export function upsertClipInCache(qc: QueryClient, c: ClipView): void {
  for (const [key, data] of qc.getQueriesData<ClipsList>({ queryKey: ['clips:list'] })) {
    if (!data) continue;
    const f = key[1] as ClipListFilter | undefined;
    const next = clipMatchesListFilter(c, f)
      ? upsertById(data.items, c)
      : removeByIds(data.items, [c.id]);
    if (next !== data.items) qc.setQueryData<ClipsList>(key, { items: next });
  }
}

export function patchClipsInCache(
  qc: QueryClient,
  ids: readonly string[],
  patch: Partial<ClipView>,
): void {
  const set = new Set(ids);
  for (const [key, data] of qc.getQueriesData<ClipsList>({ queryKey: ['clips:list'] })) {
    if (!data) continue;
    const f = key[1] as ClipListFilter | undefined;
    let items = data.items.map((c) => (set.has(c.id) ? { ...c, ...patch } : c));
    items = items.filter((c) => !set.has(c.id) || clipMatchesListFilter(c, f));
    qc.setQueryData<ClipsList>(key, { items });
  }
}

export function removeClipsFromCache(qc: QueryClient, ids: readonly string[]): void {
  for (const [key, data] of qc.getQueriesData<ClipsList>({ queryKey: ['clips:list'] })) {
    if (data) qc.setQueryData<ClipsList>(key, { items: removeByIds(data.items, ids) });
  }
}

export function removeVideoFromCache(qc: QueryClient, id: string): void {
  for (const [key, data] of qc.getQueriesData<VideosList>({ queryKey: ['videos:list'] })) {
    if (data) qc.setQueryData<VideosList>(key, { items: removeByIds(data.items, [id]) });
  }
  for (const [key, data] of qc.getQueriesData<ClipsList>({ queryKey: ['clips:list'] })) {
    if (data)
      qc.setQueryData<ClipsList>(key, { items: data.items.filter((c) => c.videoId !== id) });
  }
  qc.removeQueries({ queryKey: ipcKey('videos:get', { id }) });
  qc.removeQueries({ queryKey: ipcKey('videos:transcript', { id }) });
  qc.removeQueries({ queryKey: ipcKey('videos:proxyUrl', { id }) });
}

let lastCostInvalidate = 0;
/** Cost has no push event; pipeline activity is what changes it, so refresh (throttled) when it happens. */
export function refreshCostSoon(qc: QueryClient, force = false): void {
  const now = Date.now();
  if (!force && now - lastCostInvalidate < 4000) return;
  lastCostInvalidate = now;
  void qc.invalidateQueries({ queryKey: ['cost:summary'] });
}

export function applyPipelineEvent(qc: QueryClient, e: PipelineEvent): void {
  const detailKey = ipcKey('videos:get', { id: e.videoId });
  qc.setQueryData<VideoDetail>(detailKey, (old) =>
    old ? { ...old, stages: applyEventToStages(old.stages, e) } : old,
  );

  // Keep list rows moving even if main only emits `videos:updated` on status changes.
  const patchRow = (v: VideoView): VideoView => {
    if (e.status === 'running')
      return {
        ...v,
        status: e.stage === 'ingest' ? 'ingesting' : 'processing',
        stage: e.stage,
        progress: e.progress,
        error: null,
      };
    if (e.status === 'failed')
      return { ...v, status: 'failed', stage: e.stage, error: e.message ?? v.error };
    if (e.status === 'canceled') return { ...v, status: 'canceled', stage: e.stage };
    return v;
  };
  for (const [key, data] of qc.getQueriesData<VideosList>({ queryKey: ['videos:list'] })) {
    if (!data || !data.items.some((v) => v.id === e.videoId)) continue;
    qc.setQueryData<VideosList>(key, {
      items: data.items.map((v) => (v.id === e.videoId ? patchRow(v) : v)),
    });
  }
  qc.setQueryData<VideoDetail>(detailKey, (old) =>
    old ? { ...old, video: patchRow(old.video) } : old,
  );

  usePipelineLog.getState().record(e);

  if (e.status === 'done') {
    if (e.stage === 'transcribe')
      void qc.invalidateQueries({ queryKey: ipcKey('videos:transcript', { id: e.videoId }) });
    if (e.stage === 'understand' || e.stage === 'prepare' || e.stage === 'finalize') {
      void qc.invalidateQueries({ queryKey: detailKey });
      if (e.stage === 'prepare' || e.stage === 'finalize')
        void qc.invalidateQueries({ queryKey: ipcKey('videos:proxyUrl', { id: e.videoId }) });
    }
  }
  if (e.stage === 'understand' || e.stage === 'moments' || e.status === 'failed')
    refreshCostSoon(qc, e.status !== 'running');
}
