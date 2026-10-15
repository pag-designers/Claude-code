'use client';

/**
 * Query + mutation hooks for the Library's Edited / Exported tabs (editor projects and exported renders).
 * Pushed `editor:export` events are written straight into every cached `exports:list` query, so progress is live
 * without polling; deletions have no event, so mutations patch the cache.
 */
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { EditorProjectSummary, ExportJob } from '@shared/editor';
import { useIpcEvent, useIpcMutation, useIpcQuery, type IpcCallError } from '../ipc';

export const EXPORTS_PAYLOAD = { limit: 100 } as const;

export function useEditorProjects() {
  return useIpcQuery('editor:list', undefined, { staleTime: 5_000, refetchOnMount: 'always' });
}

const failToast = (title: string) => (e: IpcCallError) =>
  toast.error(title, { description: e.message });

export function useRenameProject() {
  return useIpcMutation('editor:rename', {
    invalidate: ['editor:list'],
    onError: failToast('Could not rename the project'),
  });
}

export function useDuplicateProject() {
  return useIpcMutation('editor:duplicate', {
    invalidate: ['editor:list'],
    onSuccess: (doc) => toast.success(`Duplicated as “${doc.name}”`),
    onError: failToast('Could not duplicate the project'),
  });
}

export function useDeleteProject() {
  const qc = useQueryClient();
  return useIpcMutation('editor:delete', {
    onSuccess: (_d, { id }) => {
      qc.setQueriesData<{ items: EditorProjectSummary[] }>({ queryKey: ['editor:list'] }, (old) =>
        old ? { items: old.items.filter((p) => p.id !== id) } : old,
      );
      void qc.invalidateQueries({ queryKey: ['storage:usage'] });
      toast.success('Project deleted');
    },
    onError: failToast('Could not delete the project'),
  });
}

export function useCreateProject() {
  return useIpcMutation('editor:create', {
    invalidate: ['editor:list'],
    onError: failToast('Could not create the project'),
  });
}

/** Inserts or replaces one export job in every cached `exports:list` (newest first). */
export function upsertExport(qc: QueryClient, job: ExportJob): void {
  qc.setQueriesData<{ items: ExportJob[] }>({ queryKey: ['exports:list'] }, (old) => {
    if (!old) return old;
    const i = old.items.findIndex((x) => x.id === job.id);
    if (i >= 0) return { items: old.items.map((x) => (x.id === job.id ? job : x)) };
    return { items: [job, ...old.items].sort((a, b) => b.createdAt - a.createdAt) };
  });
}

export function removeExports(qc: QueryClient, ids: readonly string[]): void {
  qc.setQueriesData<{ items: ExportJob[] }>({ queryKey: ['exports:list'] }, (old) =>
    old ? { items: old.items.filter((x) => !ids.includes(x.id)) } : old,
  );
}

/** Subscribes the cache to `editor:export` for as long as the calling component is mounted. */
export function useExportEvents(onJob?: (job: ExportJob) => void): void {
  const qc = useQueryClient();
  useIpcEvent('editor:export', (job) => {
    upsertExport(qc, job);
    if (job.status === 'done') void qc.invalidateQueries({ queryKey: ['storage:usage'] });
    onJob?.(job);
  });
}

export function useExports() {
  useExportEvents();
  return useIpcQuery('exports:list', EXPORTS_PAYLOAD, {
    staleTime: 10_000,
    refetchOnMount: 'always',
  });
}

export const isActiveExport = (j: Pick<ExportJob, 'status'>): boolean =>
  j.status === 'queued' || j.status === 'rendering';

/** Presigned media URL of an export (video or thumbnail), cached for 20 min like clip media. */
export function useExportUrl(id: string, kind: 'video' | 'thumb', enabled: boolean) {
  return useIpcQuery(
    'exports:url',
    { id, kind },
    {
      enabled,
      staleTime: 20 * 60_000,
      retry: 1,
    },
  );
}
