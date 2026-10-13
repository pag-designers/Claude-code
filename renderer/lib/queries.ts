'use client';

import { useIpcQuery } from './ipc';

export const STORAGE_PAYLOAD = { refresh: false } as const;
export const NOTIFS_PAYLOAD = { limit: 50 } as const;
export const JOBS_PAYLOAD = { limit: 50 } as const;

export function useStorageUsage() {
  return useIpcQuery('storage:usage', STORAGE_PAYLOAD, { staleTime: 30_000 });
}
export function useNotifications() {
  return useIpcQuery('notifications:list', NOTIFS_PAYLOAD, { staleTime: 15_000 });
}
export function useJobs() {
  return useIpcQuery('jobs:list', JOBS_PAYLOAD, { staleTime: 5_000 });
}
export function useSidecarStatus() {
  return useIpcQuery('sidecar:status', undefined, { staleTime: 5_000 });
}
export function useBinaries() {
  return useIpcQuery('binaries:status', undefined, { staleTime: 30_000 });
}
/** No push event exists for cost; EventBridge invalidates it when pipeline stages that call Claude run. */
export function useCost() {
  return useIpcQuery('cost:summary', undefined, { staleTime: 30_000 });
}
