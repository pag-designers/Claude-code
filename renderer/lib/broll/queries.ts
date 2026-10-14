'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import type { BrollProvider } from '@shared/brand';
import { invoke, useIpcQuery } from '@/lib/ipc';
import { mergePages, type Orientation } from './model';

/** Which providers have a key. Re-read on every mount / window focus so a key added in Settings shows up at once. */
export function useBrollStatus() {
  return useIpcQuery('broll:status', undefined, {
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
  });
}

/**
 * Paged search. Not refetched on focus/reconnect (every page would be asked again and quota is 200/h on Pexels);
 * identical searches are also cached for 60 s in main.
 */
export function useBrollSearch(args: {
  provider: BrollProvider;
  query: string;
  orientation: Orientation;
  enabled: boolean;
}) {
  const q = useInfiniteQuery({
    queryKey: ['broll:search', args.provider, args.orientation, args.query],
    enabled: args.enabled && args.query.length > 0,
    initialPageParam: 1,
    queryFn: ({ pageParam }) =>
      invoke('broll:search', {
        provider: args.provider,
        query: args.query,
        orientation: args.orientation,
        page: pageParam,
      }),
    getNextPageParam: (last) => last.nextPage ?? undefined,
    retry: false,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  return { ...q, items: mergePages(q.data?.pages ?? []) };
}
