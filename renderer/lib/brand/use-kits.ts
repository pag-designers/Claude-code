'use client';

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { BrandKitSummary } from '@shared/brand';
import { invoke } from '../ipc';

const KEY = 'clipfern.brandKit';

function readStored(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}
function writeStored(id: string | null) {
  try {
    if (id) localStorage.setItem(KEY, id);
    else localStorage.removeItem(KEY);
  } catch {
    /* storage blocked: the selection simply is not remembered */
  }
}

/**
 * Which kit the page shows: `?kit=<id>` (deep links from the editor), else the one used last, else the default kit,
 * else the first. Always one of `kits` (or null when there are none).
 */
export function useSelectedKit(kits: BrandKitSummary[] | undefined) {
  // read once on the client; the value only matters after the kit list has loaded, so it never affects hydration
  const [wanted, setWanted] = React.useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    let fromUrl: string | null = null;
    try {
      fromUrl = new URLSearchParams(window.location.search).get('kit');
    } catch {
      /* no location */
    }
    return fromUrl ?? readStored();
  });
  const id = React.useMemo(() => {
    if (!kits?.length) return null;
    return (
      kits.find((k) => k.id === wanted)?.id ?? kits.find((k) => k.isDefault)?.id ?? kits[0]!.id
    );
  }, [kits, wanted]);
  const select = React.useCallback((next: string | null) => {
    setWanted(next);
    writeStored(next);
  }, []);
  return [id, select] as const;
}

/** Create / duplicate / delete / default, each refreshing every `brand:*` query. */
export function useKitActions(onSelect: (id: string | null) => void) {
  const qc = useQueryClient();
  const [creating, setCreating] = React.useState(false);
  const [createError, setCreateError] = React.useState<string | null>(null);
  const refresh = React.useCallback(
    () =>
      qc.invalidateQueries({
        predicate: (q) => typeof q.queryKey[0] === 'string' && q.queryKey[0].startsWith('brand:'),
      }),
    [qc],
  );

  const create = React.useCallback(
    async (name: string, copyFrom?: string): Promise<boolean> => {
      setCreating(true);
      setCreateError(null);
      try {
        const kit = await invoke('brand:create', { name, ...(copyFrom ? { copyFrom } : {}) });
        await refresh();
        onSelect(kit.id);
        toast.success(`Created “${kit.name}”`);
        return true;
      } catch (e) {
        setCreateError(e instanceof Error ? e.message : 'Could not create the kit.');
        return false;
      } finally {
        setCreating(false);
      }
    },
    [refresh, onSelect],
  );

  const duplicate = React.useCallback(
    async (id: string) => {
      try {
        const kit = await invoke('brand:duplicate', { id });
        await refresh();
        onSelect(kit.id);
        toast.success(`Duplicated as “${kit.name}”`);
      } catch (e) {
        toast.error('Could not duplicate the kit', { description: (e as Error).message });
      }
    },
    [refresh, onSelect],
  );

  const remove = React.useCallback(
    async (id: string, name: string): Promise<boolean> => {
      try {
        await invoke('brand:delete', { id });
        onSelect(null);
        await refresh();
        toast.success(`Deleted “${name}”`);
        return true;
      } catch (e) {
        toast.error('Could not delete the kit', { description: (e as Error).message });
        return false;
      }
    },
    [refresh, onSelect],
  );

  const makeDefault = React.useCallback(
    async (id: string, name: string) => {
      try {
        await invoke('brand:setDefault', { id });
        await refresh();
        toast.success(`“${name}” is now the default kit`);
      } catch (e) {
        toast.error('Could not change the default kit', { description: (e as Error).message });
      }
    },
    [refresh],
  );

  return { create, creating, createError, setCreateError, duplicate, remove, makeDefault };
}
