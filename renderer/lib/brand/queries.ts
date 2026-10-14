'use client';

import { useIpcQuery } from '../ipc';

/** Brand Kit list (cards). Kept fresh by the `brand:changed` event (see providers.tsx). */
export function useBrandKits() {
  return useIpcQuery('brand:list', undefined, { staleTime: 30_000 });
}

/** One kit with its assets (assets carry short-lived URLs, so they are refetched every few minutes). */
export function useBrandKit(id: string | null | undefined) {
  return useIpcQuery('brand:get', { id: id ?? '' }, { enabled: Boolean(id), staleTime: 60_000 });
}

/** Id of the default kit, null when no kit exists. */
export function useDefaultBrandKitId(): string | null | undefined {
  return useIpcQuery('brand:defaultKit', undefined, { staleTime: 30_000 }).data?.id;
}
