'use client';

/**
 * Typed renderer-side IPC layer (ADR-009).
 * - `ipc.invoke` wraps `window.clipfern.invoke` and always rejects with an `IpcCallError`.
 * - `useIpcQuery` / `useIpcMutation` bind channels to TanStack Query.
 * - `useIpcEvent` subscribes to push events with automatic cleanup.
 * The renderer never sees secrets: only the contract in shared/ipc.ts crosses the bridge.
 */
import { useEffect, useRef } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
  type UseMutationOptions,
  type UseQueryOptions,
} from '@tanstack/react-query';
import {
  decodeIpcError,
  IpcCallError,
  type ClipfernApi,
  type EventChannel,
  type EventPayload,
  type InvokeChannel,
  type InvokeInput,
  type InvokeOutput,
} from '@shared/ipc';

declare global {
  interface Window {
    clipfern?: ClipfernApi;
  }
}

export { IpcCallError };

export function getApi(): ClipfernApi | null {
  if (typeof window === 'undefined') return null;
  return window.clipfern ?? null;
}

function toIpcError(e: unknown): IpcCallError {
  return decodeIpcError(e);
}

export async function invoke<C extends InvokeChannel>(
  channel: C,
  payload?: InvokeInput<C>,
): Promise<InvokeOutput<C>> {
  const api = getApi();
  if (!api) throw new IpcCallError('UNAVAILABLE', 'The Clipfern desktop bridge is not available.');
  try {
    return await api.invoke(channel, payload);
  } catch (e) {
    throw toIpcError(e);
  }
}

export function on<E extends EventChannel>(
  event: E,
  cb: (payload: EventPayload<E>) => void,
): () => void {
  const api = getApi();
  if (!api) return () => {};
  return api.on(event, cb);
}

export const ipc = { invoke, on };

export function ipcKey<C extends InvokeChannel>(channel: C, payload?: InvokeInput<C>): QueryKey {
  return payload === undefined ? [channel] : [channel, payload];
}

type QueryOpts<C extends InvokeChannel, TData> = Omit<
  UseQueryOptions<InvokeOutput<C>, IpcCallError, TData>,
  'queryKey' | 'queryFn'
>;

export function useIpcQuery<C extends InvokeChannel, TData = InvokeOutput<C>>(
  channel: C,
  payload?: InvokeInput<C>,
  options?: QueryOpts<C, TData>,
) {
  return useQuery<InvokeOutput<C>, IpcCallError, TData>({
    queryKey: ipcKey(channel, payload),
    queryFn: () => invoke(channel, payload),
    ...options,
  });
}

export function useIpcMutation<C extends InvokeChannel>(
  channel: C,
  options?: Omit<
    UseMutationOptions<InvokeOutput<C>, IpcCallError, InvokeInput<C>>,
    'mutationFn'
  > & {
    /** Channels whose cached queries are invalidated after success. */
    invalidate?: InvokeChannel[];
  },
) {
  const qc = useQueryClient();
  const { invalidate, onSuccess, ...rest } = options ?? {};
  return useMutation<InvokeOutput<C>, IpcCallError, InvokeInput<C>>({
    mutationFn: (payload) => invoke(channel, payload),
    ...rest,
    onSuccess: async (...args: Parameters<NonNullable<typeof onSuccess>>) => {
      if (invalidate?.length) {
        await Promise.all(invalidate.map((c) => qc.invalidateQueries({ queryKey: [c] })));
      }
      return onSuccess?.(...args);
    },
  });
}

export function useIpcEvent<E extends EventChannel>(
  event: E,
  cb: (payload: EventPayload<E>) => void,
): void {
  const ref = useRef(cb);
  useEffect(() => {
    ref.current = cb;
  });
  useEffect(() => on(event, (p) => ref.current(p)), [event]);
}
