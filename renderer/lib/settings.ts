'use client';

import { useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { DEFAULT_SETTINGS, type Settings, type SettingsPatch } from '@shared/settings';
import type { SecretKey } from '@shared/secrets';
import { invoke, ipcKey, useIpcQuery, type IpcCallError } from './ipc';

const SETTINGS_KEY = ipcKey('settings:get');

export function useSettings() {
  const q = useIpcQuery('settings:get', undefined, { staleTime: Infinity });
  return { settings: (q.data ?? DEFAULT_SETTINGS) as Settings, ready: q.isSuccess, query: q };
}

interface UpdateOptions {
  /** Toast message on success; `false` (default) stays silent. */
  successMessage?: string | false;
  silentError?: boolean;
}

/**
 * Optimistic settings writer: the cache flips immediately, rolls back on failure, and is
 * reconciled with the (validated) full settings object main returns.
 */
export function useUpdateSettings() {
  const qc = useQueryClient();
  const mutation = useMutation<
    Settings,
    IpcCallError,
    { patch: SettingsPatch; options?: UpdateOptions },
    { previous: Settings | undefined }
  >({
    mutationFn: ({ patch }) => invoke('settings:set', patch),
    onMutate: async ({ patch }) => {
      await qc.cancelQueries({ queryKey: SETTINGS_KEY });
      const previous = qc.getQueryData<Settings>(SETTINGS_KEY);
      qc.setQueryData<Settings>(SETTINGS_KEY, {
        ...(previous ?? DEFAULT_SETTINGS),
        ...stripUndefined(patch),
      });
      return { previous };
    },
    onError: (err, { options }, ctx) => {
      if (ctx?.previous) qc.setQueryData(SETTINGS_KEY, ctx.previous);
      if (!options?.silentError)
        toast.error('Could not save setting', { description: err.message });
    },
    onSuccess: (data, { options }) => {
      qc.setQueryData(SETTINGS_KEY, data);
      if (options?.successMessage) toast.success(options.successMessage);
    },
  });

  const update = useCallback(
    (patch: SettingsPatch, options?: UpdateOptions) =>
      mutation.mutateAsync({ patch, options }).catch(() => undefined),
    [mutation],
  );
  return { update, saving: mutation.isPending };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/* ───────── secrets ───────── */

export function useSecrets() {
  const q = useIpcQuery('secrets:status', undefined, { staleTime: 15_000 });
  return {
    backend: q.data?.backend,
    keys: q.data?.keys,
    loading: q.isPending,
    error: q.error,
    refetch: q.refetch,
  };
}

export function useSecretActions() {
  const qc = useQueryClient();
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['secrets:status'] });
    await qc.invalidateQueries({ queryKey: ['storage:usage'] });
  };
  return {
    save: async (key: SecretKey, value: string) => {
      await invoke('secrets:set', { key, value });
      await refresh();
    },
    clear: async (key: SecretKey) => {
      await invoke('secrets:clear', { key });
      await refresh();
    },
  };
}
