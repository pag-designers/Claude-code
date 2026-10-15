'use client';

/** Query + mutation hooks for videos, clips and the pipeline. Cache updates live in pipeline-cache.ts. */
import { useCallback, useMemo } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { ClipView, PipelineOptionsInput, PipelineStage, VideoView } from '@shared/pipeline';
import { useNow } from './clock';
import { invoke, ipcKey, useIpcQuery, type IpcCallError } from './ipc';
import {
  CLIPS_ALL_PAYLOAD,
  VIDEOS_PAYLOAD,
  clipsOfVideoPayload,
  patchClipsInCache,
  removeClipsFromCache,
  removeVideoFromCache,
  upsertVideoInCache,
} from './pipeline-cache';

const MEDIA_STALE = 20 * 60_000; // presigned URLs live ~1 h; refresh well before expiry

export function useVideos() {
  return useIpcQuery('videos:list', VIDEOS_PAYLOAD, { staleTime: 30_000 });
}
export function useVideo(id: string | null) {
  return useIpcQuery(
    'videos:get',
    { id: id ?? '' },
    { enabled: !!id, staleTime: 15_000, retry: false },
  );
}
export function useTranscript(id: string | null, enabled = true) {
  return useIpcQuery(
    'videos:transcript',
    { id: id ?? '' },
    { enabled: !!id && enabled, staleTime: 5 * 60_000 },
  );
}
export function useAllClips() {
  return useIpcQuery('clips:list', CLIPS_ALL_PAYLOAD, { staleTime: 30_000 });
}
export function useVideoClips(videoId: string | null) {
  return useIpcQuery('clips:list', clipsOfVideoPayload(videoId ?? ''), {
    enabled: !!videoId,
    staleTime: 15_000,
  });
}
export function useProxyUrl(id: string | null, enabled = true) {
  return useIpcQuery(
    'videos:proxyUrl',
    { id: id ?? '' },
    { enabled: !!id && enabled, staleTime: MEDIA_STALE },
  );
}
export function useClipMediaUrl(id: string, kind: 'render' | 'thumb', enabled: boolean) {
  return useIpcQuery('clips:mediaUrl', { id, kind }, { enabled, staleTime: MEDIA_STALE, retry: 1 });
}

/** Fetches (and caches) a presigned URL on demand, e.g. when the pointer enters a card. */
export function useFetchMediaUrl() {
  const qc = useQueryClient();
  return useCallback(
    async (id: string, kind: 'render' | 'thumb'): Promise<string | null> => {
      const out = await qc.fetchQuery({
        queryKey: ipcKey('clips:mediaUrl', { id, kind }),
        queryFn: () => invoke('clips:mediaUrl', { id, kind }),
        staleTime: MEDIA_STALE,
      });
      return out.url;
    },
    [qc],
  );
}

/* ----------------------------------------------- pipeline control ---------------------------------------------- */

const fail = (title: string) => (e: IpcCallError) => toast.error(title, { description: e.message });

export function useStartPipeline() {
  const qc = useQueryClient();
  return useMutation<
    { videoId: string },
    IpcCallError,
    { url: string; options: PipelineOptionsInput }
  >({
    mutationFn: ({ url, options }) => invoke('pipeline:start', { url, options }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['videos:list'] }),
    onError: fail('Could not start clipping'),
  });
}

export function useCancelPipeline() {
  const qc = useQueryClient();
  return useMutation<unknown, IpcCallError, { videoId: string }>({
    mutationFn: (p) => invoke('pipeline:cancel', p),
    onSuccess: (_d, { videoId }) => {
      void qc.invalidateQueries({ queryKey: ['videos:list'] });
      void qc.invalidateQueries({ queryKey: ipcKey('videos:get', { id: videoId }) });
      toast.info('Clipping canceled', {
        description: 'Everything finished so far is kept. You can resume any time.',
      });
    },
    onError: fail('Could not cancel'),
  });
}

export function useRetryStage() {
  const qc = useQueryClient();
  return useMutation<unknown, IpcCallError, { videoId: string; stage: PipelineStage }>({
    mutationFn: (p) => invoke('pipeline:retryStage', p),
    onSuccess: (_d, { videoId }) => {
      void qc.invalidateQueries({ queryKey: ['videos:list'] });
      void qc.invalidateQueries({ queryKey: ipcKey('videos:get', { id: videoId }) });
    },
    onError: fail('Could not retry that stage'),
  });
}

/* ------------------------------------------------- favorites ---------------------------------------------------- */

export function useSetVideoFavorite() {
  const qc = useQueryClient();
  return useMutation<
    unknown,
    IpcCallError,
    { id: string; value: boolean },
    { prev: VideoView | undefined }
  >({
    mutationFn: (p) => invoke('videos:favorite', p),
    onMutate: async ({ id, value }) => {
      const prev = qc
        .getQueriesData<{ items: VideoView[] }>({ queryKey: ['videos:list'] })
        .flatMap(([, d]) => d?.items ?? [])
        .find((v) => v.id === id);
      const base =
        prev ?? qc.getQueryData<{ video: VideoView }>(ipcKey('videos:get', { id }))?.video;
      if (base) upsertVideoInCache(qc, { ...base, favorite: value });
      return { prev: base };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) upsertVideoInCache(qc, ctx.prev);
      fail('Could not update favorite')(e);
    },
  });
}

export function useSetClipFavorite() {
  const qc = useQueryClient();
  return useMutation<
    unknown,
    IpcCallError,
    { ids: string[]; value: boolean },
    { prev: Map<string, boolean> }
  >({
    mutationFn: (p) => invoke('clips:favorite', p),
    onMutate: async ({ ids, value }) => {
      const prev = new Map<string, boolean>();
      for (const [, d] of qc.getQueriesData<{ items: ClipView[] }>({ queryKey: ['clips:list'] }))
        for (const c of d?.items ?? []) if (ids.includes(c.id)) prev.set(c.id, c.favorite);
      patchClipsInCache(qc, ids, { favorite: value });
      return { prev };
    },
    onError: (e, _vars, ctx) => {
      ctx?.prev.forEach((v, id) => patchClipsInCache(qc, [id], { favorite: v }));
      fail('Could not update favorites')(e);
    },
  });
}

/* ------------------------------------------------- deletes ------------------------------------------------------ */

export function useDeleteVideo() {
  const qc = useQueryClient();
  return useMutation<
    unknown,
    IpcCallError,
    { id: string; deleteFromStorage: boolean; title?: string }
  >({
    mutationFn: ({ id, deleteFromStorage }) => invoke('videos:delete', { id, deleteFromStorage }),
    onSuccess: (_d, { id, title, deleteFromStorage }) => {
      removeVideoFromCache(qc, id);
      void qc.invalidateQueries({ queryKey: ['storage:usage'] });
      toast.success(title ? `Deleted “${title}”` : 'Video deleted', {
        description: deleteFromStorage
          ? 'Its files were removed from your cloud storage too.'
          : 'Cloud files were kept.',
      });
    },
    onError: fail('Could not delete the video'),
  });
}

export function useDeleteClips() {
  const qc = useQueryClient();
  return useMutation<unknown, IpcCallError, { ids: string[] }>({
    mutationFn: (p) => invoke('clips:delete', p),
    onSuccess: (_d, { ids }) => {
      removeClipsFromCache(qc, ids);
      void qc.invalidateQueries({ queryKey: ['videos:list'] });
      void qc.invalidateQueries({ queryKey: ['storage:usage'] });
      toast.success(ids.length === 1 ? 'Clip deleted' : `${ids.length} clips deleted`);
    },
    onError: fail('Could not delete'),
  });
}

export function useRerenderClip() {
  const qc = useQueryClient();
  return useMutation<unknown, IpcCallError, { id: string }>({
    mutationFn: (p) => invoke('clips:rerender', p),
    onMutate: ({ id }) =>
      patchClipsInCache(qc, [id], { status: 'queued', renderProgress: null, error: null }),
    onError: fail('Could not re-render'),
  });
}

export function useDownloadClips() {
  return useMutation<
    { saved: number; dir: string | null; canceled: boolean },
    IpcCallError,
    { ids: string[]; withCaptions?: boolean }
  >({
    mutationFn: ({ ids, withCaptions }) =>
      invoke('clips:download', { ids, withCaptions: withCaptions ?? false }),
    onSuccess: (r, { ids }) => {
      if (r.canceled) return;
      if (r.saved > 0)
        toast.success(`Saved ${r.saved} ${r.saved === 1 ? 'clip' : 'clips'}`, {
          description: r.dir ?? undefined,
        });
      else
        toast.error('Nothing was downloaded', {
          description:
            ids.length === 1
              ? 'This clip has no finished render yet.'
              : 'None of the selected clips have a finished render yet.',
        });
    },
    onError: fail('Download failed'),
  });
}

/* ----------------------------------------------- derived stats -------------------------------------------------- */

const WEEK = 7 * 86_400_000;
export function useClipsThisWeek() {
  const q = useAllClips();
  const now = useNow();
  const count = useMemo(() => {
    const since = (now?.getTime() ?? 0) - WEEK;
    return (q.data?.items ?? []).filter((c) => c.createdAt >= since && c.status !== 'failed')
      .length;
  }, [q.data, now]);
  return { count, loading: q.isPending, error: q.isError };
}
