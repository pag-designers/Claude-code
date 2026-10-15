'use client';

/**
 * Query + mutation hooks for accounts, posts and the scheduler. Posts live in ONE cached list (`posts:list`, everything
 * from the last 2000) that `posts:updated` events patch in place, so the calendar, queue, drawer and top-bar indicator
 * all read the same data without refetching.
 */
import * as React from 'react';
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { Platform } from '@shared/cp2';
import type { InvokeInput, InvokeOutput } from '@shared/ipc';
import type { PostSource, PostView, SchedulerStatus, SocialAccount } from '@shared/publish';
import { invoke, ipcKey, useIpcEvent, useIpcQuery, type IpcCallError } from '../ipc';
import { upsertPost } from './model';

export const POSTS_PAYLOAD = { limit: 2000 } as const;
const POSTS_KEY = ipcKey('posts:list', POSTS_PAYLOAD);
const STATUS_KEY = ipcKey('scheduler:status');

export function useAccounts() {
  return useIpcQuery('accounts:list', undefined, { staleTime: 15_000 });
}

export function usePosts() {
  return useIpcQuery('posts:list', POSTS_PAYLOAD, { staleTime: 15_000 });
}

export function useSchedulerStatus() {
  return useIpcQuery('scheduler:status', undefined, {
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export function usePost(id: string | null) {
  const list = usePosts();
  return list.data?.items.find((p) => p.id === id) ?? null;
}

/** Everything one clip/export is scheduled for (published or not). */
export function usePostsOfClip(clipId: string | null) {
  const list = usePosts();
  return React.useMemo(
    () => (clipId ? (list.data?.items ?? []).filter((p) => p.clipId === clipId) : []),
    [list.data, clipId],
  );
}

export function usePrefill(source: PostSource | null, platform: Platform, enabled = true) {
  return useIpcQuery(
    'publish:prefill',
    source ? { source, platform } : undefined,
    { enabled: enabled && !!source, staleTime: 60_000, retry: 1 },
  );
}

export function useValidate(
  source: PostSource | null,
  platform: Platform,
  fields: InvokeInput<'publish:validate'>['fields'],
  enabled = true,
) {
  return useIpcQuery(
    'publish:validate',
    source ? { source, platform, ...(fields ? { fields } : {}) } : undefined,
    { enabled: enabled && !!source, staleTime: 30_000, retry: 0, placeholderData: (prev) => prev },
  );
}

/* ----------------------------------------------------------------------------------- cache ----- */

export function upsertPostInCache(qc: QueryClient, post: PostView): void {
  qc.setQueryData<InvokeOutput<'posts:list'>>(POSTS_KEY, (old) =>
    old ? { items: upsertPost(old.items, post) } : { items: [post] },
  );
}

export function removePostsFromCache(qc: QueryClient, ids: readonly string[]): void {
  qc.setQueryData<InvokeOutput<'posts:list'>>(POSTS_KEY, (old) =>
    old ? { items: old.items.filter((p) => !ids.includes(p.id)) } : old,
  );
}

/** Subscribes the cache to main's push events. Mounted once (top bar). */
export function useSchedulerLive(): void {
  const qc = useQueryClient();
  useIpcEvent('posts:updated', (p) => upsertPostInCache(qc, p));
  useIpcEvent('accounts:changed', () => {
    void qc.invalidateQueries({ queryKey: ['accounts:list'] });
    void qc.invalidateQueries({ queryKey: ['scheduler:status'] });
  });
  useIpcEvent('scheduler:status', (s) => qc.setQueryData<SchedulerStatus>(STATUS_KEY, s));
}

/* ------------------------------------------------------------------------------- mutations ----- */

const fail = (title: string) => (e: IpcCallError) => toast.error(title, { description: e.message });

function usePostMutation<C extends 'posts:postNow' | 'posts:cancel' | 'posts:retry' | 'posts:update'>(
  channel: C,
  errorTitle: string,
  onDone?: (post: PostView) => void,
) {
  const qc = useQueryClient();
  return useMutation<InvokeOutput<C>, IpcCallError, InvokeInput<C>>({
    mutationFn: (p) => invoke(channel, p),
    onSuccess: (post) => {
      upsertPostInCache(qc, post as PostView);
      onDone?.(post as PostView);
      void qc.invalidateQueries({ queryKey: ['scheduler:status'] });
    },
    onError: fail(errorTitle),
  });
}

export const useUpdatePost = (onDone?: (p: PostView) => void) =>
  usePostMutation('posts:update', 'Could not save the post', onDone);
export const usePostNow = (onDone?: (p: PostView) => void) =>
  usePostMutation('posts:postNow', 'Could not start posting', onDone);
export const useCancelPost = (onDone?: (p: PostView) => void) =>
  usePostMutation('posts:cancel', 'Could not cancel the post', onDone);
export const useRetryPost = (onDone?: (p: PostView) => void) =>
  usePostMutation('posts:retry', 'Could not retry the post', onDone);

/** Drag-to-reschedule: the calendar moves immediately and snaps back if main refuses. */
export function useReschedulePost() {
  const qc = useQueryClient();
  return useMutation<PostView, IpcCallError, { post: PostView; at: number }, { previous: PostView }>({
    mutationFn: ({ post, at }) => invoke('posts:update', { id: post.id, scheduledAt: at }),
    onMutate: ({ post, at }) => {
      upsertPostInCache(qc, { ...post, scheduledAt: at });
      return { previous: post };
    },
    onError: (e, _v, ctx) => {
      if (ctx) upsertPostInCache(qc, ctx.previous);
      toast.error('Could not reschedule', { description: e.message });
    },
    onSuccess: (post) => {
      upsertPostInCache(qc, post);
      void qc.invalidateQueries({ queryKey: ['scheduler:status'] });
    },
  });
}

export function useDeletePosts(onDone?: () => void) {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, IpcCallError, { ids: string[] }>({
    mutationFn: ({ ids }) => invoke('posts:delete', { ids }),
    onSuccess: (_r, { ids }) => {
      removePostsFromCache(qc, ids);
      void qc.invalidateQueries({ queryKey: ['scheduler:status'] });
      onDone?.();
    },
    onError: fail('Could not delete the post'),
  });
}

export function useRefreshStats() {
  const qc = useQueryClient();
  return useMutation<InvokeOutput<'posts:refreshStats'>, IpcCallError, { ids: string[] }>({
    mutationFn: ({ ids }) => invoke('posts:refreshStats', { ids }),
    onSuccess: (r) => r.items.forEach((p) => upsertPostInCache(qc, p)),
    onError: fail('Could not refresh the stats'),
  });
}

export function useSetPaused() {
  const qc = useQueryClient();
  return useMutation<SchedulerStatus, IpcCallError, boolean>({
    mutationFn: (paused) => invoke('scheduler:setPaused', { paused }),
    onSuccess: (s) => qc.setQueryData(STATUS_KEY, s),
    onError: fail('Could not change the scheduler'),
  });
}

export function useCreatePosts() {
  const qc = useQueryClient();
  return useMutation<
    InvokeOutput<'posts:create'>,
    IpcCallError,
    InvokeInput<'posts:create'>
  >({
    mutationFn: (p) => invoke('posts:create', p),
    onSuccess: (r) => {
      r.posts.forEach((p) => upsertPostInCache(qc, p));
      void qc.invalidateQueries({ queryKey: ['scheduler:status'] });
      void qc.invalidateQueries({ queryKey: ['accounts:list'] });
    },
  });
}

/* ---------------------------------------------------------------------------- account connect ----- */

export type ConnectState =
  | { phase: 'idle' }
  | { phase: 'waiting' }
  | { phase: 'error'; message: string };

/**
 * One platform's "Connect account" flow. `accounts:connect` blocks until the browser consent finishes, so the UI shows
 * a waiting state with Cancel; cancelling rejects the pending call, which is NOT an error to show.
 */
export function useConnect(platform: Platform, onConnected?: (a: SocialAccount) => void) {
  const qc = useQueryClient();
  const [state, setState] = React.useState<ConnectState>({ phase: 'idle' });
  const canceled = React.useRef(false);

  const connect = React.useCallback(async () => {
    canceled.current = false;
    setState({ phase: 'waiting' });
    try {
      const r = await invoke('accounts:connect', { platform });
      setState({ phase: 'idle' });
      await qc.invalidateQueries({ queryKey: ['accounts:list'] });
      void qc.invalidateQueries({ queryKey: ['scheduler:status'] });
      onConnected?.(r.account);
    } catch (e) {
      if (canceled.current) setState({ phase: 'idle' });
      else setState({ phase: 'error', message: e instanceof Error ? e.message : 'Could not connect.' });
    }
  }, [platform, qc, onConnected]);

  const cancel = React.useCallback(async () => {
    canceled.current = true;
    setState({ phase: 'idle' });
    try {
      await invoke('accounts:cancelConnect', { platform });
    } catch {
      /* nothing was pending any more */
    }
  }, [platform]);

  const dismiss = React.useCallback(() => setState({ phase: 'idle' }), []);
  return { state, connect, cancel, dismiss };
}
