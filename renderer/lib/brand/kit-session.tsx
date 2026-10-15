'use client';

/**
 * The editing session of ONE Brand Kit: the optimistic/debounced saver (kit-saver.ts), the kit's assets, the upload
 * list and every asset action, shared with all sections through context.
 */
import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type {
  BrandAssetKind,
  BrandAssetView,
  BrandKit,
  BrandKitPatch,
  BrandKitSpec,
} from '@shared/brand';
import { getApi, invoke, ipcKey, useIpcEvent } from '../ipc';
import { useBrandKit } from './queries';
import { KitSaver, type SaveStatus } from './kit-saver';
import { KIND_NOUN, baseName, clearRefs, groupByKind, validateDrop } from './helpers';
import { emptyUploads, uploadReducer, type UploadState } from './uploads';

export interface KitSession {
  kit: BrandKit;
  spec: BrandKitSpec;
  assets: BrandAssetView[];
  byKind: Record<BrandAssetKind, BrandAssetView[]>;
  assetById: (id: string | null | undefined) => BrandAssetView | undefined;
  status: SaveStatus;
  saveError: string | null;
  savedAt: number | null;
  /** True when another window/process saved a newer revision while this one had unsaved edits. */
  conflict: boolean;
  /** Replace whole top-level spec keys. */
  edit: (patch: Partial<BrandKitSpec>, opts?: { immediate?: boolean }) => void;
  /** Update one top-level spec key from its CURRENT value (safe for rapid slider/typing edits). */
  update: <K extends keyof BrandKitSpec>(
    key: K,
    fn: (cur: BrandKitSpec[K]) => BrandKitSpec[K],
    opts?: { immediate?: boolean },
  ) => void;
  rename: (name: string) => void;
  retry: () => void;
  reload: () => Promise<void>;
  keepMine: () => Promise<void>;
  flush: () => Promise<void>;
  /* ------------------------------------------------------------------------------------ assets */
  uploads: UploadState;
  /** Ids of assets that arrived in the last couple of seconds (card highlight). */
  freshIds: ReadonlySet<string>;
  addFiles: (kind: BrandAssetKind, files: File[]) => Promise<void>;
  browse: (kind: BrandAssetKind) => Promise<void>;
  dismissUpload: (id: string) => void;
  renameAsset: (id: string, name: string) => Promise<boolean>;
  /** Deletes assets; resolves with the kit references that were cleared. */
  deleteAssets: (ids: string[]) => Promise<string[] | null>;
  refreshAssets: () => void;
  /** An asset URL failed to load (probably expired): refetch the kit so the URLs are fresh (throttled). */
  reportAssetError: () => void;
}

const Ctx = React.createContext<KitSession | null>(null);

export function useKitSession(): KitSession {
  const v = React.useContext(Ctx);
  if (!v) throw new Error('useKitSession must be used inside <KitSessionProvider>');
  return v;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');

type GetData = { kit: BrandKit; assets: BrandAssetView[] };

export function KitSessionProvider({
  kitId,
  loading,
  error,
  children,
}: {
  kitId: string;
  /** Rendered while the kit loads. */
  loading: React.ReactNode;
  /** Rendered with a retry callback when it cannot be loaded. */
  error: (message: string, retry: () => void) => React.ReactNode;
  children: React.ReactNode;
}) {
  const q = useBrandKit(kitId);
  // a failed BACKGROUND refetch keeps the data on screen; only "no data at all" is an error state
  if (q.data) {
    return (
      <SessionInner kitId={kitId} data={q.data}>
        {children}
      </SessionInner>
    );
  }
  if (q.isError)
    return <>{error(q.error?.message ?? 'This kit could not be found.', () => void q.refetch())}</>;
  return <>{loading}</>;
}

function SessionInner({
  kitId,
  data,
  children,
}: {
  kitId: string;
  data: GetData;
  children: React.ReactNode;
}) {
  const qc = useQueryClient();
  const getKey = React.useMemo(() => ipcKey('brand:get', { id: kitId }), [kitId]);

  const [saver] = React.useState(
    () =>
      new KitSaver(data.kit, {
        update: async (input) => {
          const saved = await invoke('brand:update', {
            id: input.id,
            patch: input.patch,
            baseRev: input.baseRev,
          });
          qc.setQueryData<GetData>(getKey, (old) => (old ? { ...old, kit: saved } : old));
          void qc.invalidateQueries({ queryKey: ['brand:list'] });
          return saved;
        },
      }),
  );
  const snap = React.useSyncExternalStore(saver.subscribe, saver.getSnapshot, saver.getSnapshot);

  // adopt newer server copies (other windows, default-star changes) while nothing is pending
  React.useEffect(() => {
    saver.adopt(data.kit);
  }, [saver, data.kit]);
  // an unmount (switching kits, leaving the page) must not lose edits
  React.useEffect(() => {
    const onHide = () => void saver.flush();
    window.addEventListener('beforeunload', onHide);
    return () => {
      window.removeEventListener('beforeunload', onHide);
      saver.dispose();
    };
  }, [saver]);

  /* ---- conflicts: the event says someone else changed the kit; the CONFLICT error says it mattered ---- */
  const reload = React.useCallback(async () => {
    const latest = await invoke('brand:get', { id: kitId });
    saver.reload(latest.kit);
    qc.setQueryData(getKey, latest);
  }, [kitId, saver, qc, getKey]);
  const keepMine = React.useCallback(async () => {
    const latest = await invoke('brand:get', { id: kitId });
    qc.setQueryData(getKey, latest);
    await saver.keepMine(latest.kit);
  }, [kitId, saver, qc, getKey]);

  /* ---- assets ---- */
  const [uploads, dispatch] = React.useReducer(uploadReducer, emptyUploads);
  const [freshIds, setFreshIds] = React.useState<ReadonlySet<string>>(new Set());
  const knownIds = React.useRef(new Set(data.assets.map((a) => a.id)));
  const seeded = React.useRef(false);
  React.useEffect(() => {
    // highlight assets that appear after the first render (uploads, stock imports), never the initial list
    const now = data.assets.map((a) => a.id);
    if (!seeded.current) {
      seeded.current = true;
      knownIds.current = new Set(now);
      return;
    }
    const added = now.filter((id) => !knownIds.current.has(id));
    knownIds.current = new Set(now);
    if (!added.length) return;
    setFreshIds((s) => new Set([...s, ...added]));
    window.setTimeout(
      () =>
        setFreshIds((s) => {
          const n = new Set(s);
          for (const id of added) n.delete(id);
          return n;
        }),
      1600,
    );
  }, [data.assets]);

  useIpcEvent('brand:progress', (ev) => {
    if (ev.kitId !== kitId) return;
    dispatch({
      type: 'progress',
      name: ev.name,
      fraction: ev.fraction,
      stage: ev.stage,
      done: ev.done,
    });
  });
  const refreshAssets = React.useCallback(() => {
    void qc.invalidateQueries({ queryKey: getKey });
    void qc.invalidateQueries({ queryKey: ['brand:list'] });
    void qc.invalidateQueries({ queryKey: ['brand:fonts'] });
  }, [qc, getKey]);

  const lastRefresh = React.useRef(0);
  const reportAssetError = React.useCallback(() => {
    const now = performance.now();
    if (now - lastRefresh.current < 20_000) return;
    lastRefresh.current = now;
    void qc.invalidateQueries({ queryKey: getKey });
    void qc.invalidateQueries({ queryKey: ['brand:fonts'] });
  }, [qc, getKey]);

  const callSeq = React.useRef(0);
  const finish = React.useCallback(
    (
      kind: BrandAssetKind,
      callId: string,
      res: { assets: BrandAssetView[]; errors: { name: string; message: string }[] },
    ) => {
      dispatch({ type: 'settle', callId, errors: res.errors });
      refreshAssets();
      if (res.assets.length) {
        const n = res.assets.length;
        toast.success(
          `Added ${n} ${n === 1 ? KIND_NOUN[kind].one : KIND_NOUN[kind].many}`,
          res.errors.length ? { description: `${res.errors.length} could not be added.` } : {},
        );
      }
    },
    [refreshAssets],
  );

  const addFiles = React.useCallback(
    async (kind: BrandAssetKind, files: File[]) => {
      const { accepted, rejected } = validateDrop(files, kind);
      if (rejected.length) dispatch({ type: 'reject', kind, errors: rejected });
      if (!accepted.length) return;
      const api = getApi();
      const withPath: { name: string; path: string }[] = [];
      const unreadable: { name: string; message: string }[] = [];
      for (const f of accepted) {
        const path = api?.pathForFile(f) ?? '';
        if (path) withPath.push({ name: f.name, path });
        else
          unreadable.push({
            name: f.name,
            message:
              'Could not read this file’s location. Drag it from your file manager, or use browse.',
          });
      }
      if (unreadable.length) dispatch({ type: 'reject', kind, errors: unreadable });
      for (let i = 0; i < withPath.length; i += 50) {
        const chunk = withPath.slice(i, i + 50);
        const callId = `c${++callSeq.current}`;
        dispatch({ type: 'start', callId, kind, names: chunk.map((c) => baseName(c.path)) });
        try {
          const res = await invoke('brand:addFiles', {
            kitId,
            kind,
            paths: chunk.map((c) => c.path),
          });
          finish(kind, callId, res);
        } catch (e) {
          dispatch({
            type: 'settle',
            callId,
            errors: chunk.map((c) => ({ name: c.name, message: errMsg(e) })),
          });
        }
      }
    },
    [kitId, finish],
  );

  const browse = React.useCallback(
    async (kind: BrandAssetKind) => {
      const callId = `c${++callSeq.current}`;
      dispatch({ type: 'start', callId, kind, names: [] });
      try {
        const res = await invoke('brand:browse', { kitId, kind });
        if (res.canceled) dispatch({ type: 'settle', callId, errors: [] });
        else finish(kind, callId, res);
      } catch (e) {
        dispatch({
          type: 'settle',
          callId,
          errors: [{ name: KIND_NOUN[kind].section, message: errMsg(e) }],
        });
      }
    },
    [kitId, finish],
  );

  const renameAsset = React.useCallback(
    async (id: string, name: string) => {
      const prev = qc.getQueryData<GetData>(getKey);
      qc.setQueryData<GetData>(getKey, (old) =>
        old ? { ...old, assets: old.assets.map((a) => (a.id === id ? { ...a, name } : a)) } : old,
      );
      try {
        await invoke('brand:renameAsset', { id, name });
        return true;
      } catch (e) {
        if (prev) qc.setQueryData(getKey, prev);
        toast.error('Could not rename the file', { description: errMsg(e) });
        return false;
      }
    },
    [qc, getKey],
  );

  const deleteAssets = React.useCallback(
    async (ids: string[]) => {
      if (!ids.length) return [];
      await saver.flush(); // pending edits go out first, so reloading the kit below cannot drop them
      const prev = qc.getQueryData<GetData>(getKey);
      const gone = new Set(ids);
      const cur = saver.getSnapshot().kit.spec;
      const optimisticClears = clearRefs(cur, ids);
      qc.setQueryData<GetData>(getKey, (old) =>
        old ? { ...old, assets: old.assets.filter((a) => !gone.has(a.id)) } : old,
      );
      try {
        const res = await invoke('brand:deleteAssets', { ids });
        // main already cleared the references in the stored kit: take its copy (unless edits are still pending)
        if (Object.keys(optimisticClears).length || res.clearedRefs.length) {
          const latest = await invoke('brand:get', { id: kitId });
          if (!saver.hasPending()) saver.reload(latest.kit);
          qc.setQueryData(getKey, latest);
        }
        refreshAssets();
        return res.clearedRefs;
      } catch (e) {
        if (prev) qc.setQueryData(getKey, prev);
        toast.error('Could not delete', { description: errMsg(e) });
        return null;
      }
    },
    [qc, getKey, saver, kitId, refreshAssets],
  );

  /* ---- context value ---- */
  const assets = data.assets;
  const byKind = React.useMemo(() => groupByKind(assets), [assets]);
  const assetMap = React.useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);
  const assetById = React.useCallback(
    (id: string | null | undefined) => (id ? assetMap.get(id) : undefined),
    [assetMap],
  );

  const value = React.useMemo<KitSession>(
    () => ({
      kit: snap.kit,
      spec: snap.kit.spec,
      assets,
      byKind,
      assetById,
      status: snap.status,
      saveError: snap.error,
      savedAt: snap.savedAt,
      conflict: snap.status === 'conflict',
      edit: (patch, opts) => saver.edit({ spec: patch } satisfies BrandKitPatch, opts),
      update: (key, fn, opts) => {
        const cur = saver.getSnapshot().kit.spec[key];
        saver.edit({ spec: { [key]: fn(cur) } as Partial<BrandKitSpec> }, opts);
      },
      rename: (name) => saver.edit({ name }),
      retry: () => void saver.retry(),
      reload,
      keepMine,
      flush: () => saver.flush(),
      uploads,
      freshIds,
      addFiles,
      browse,
      dismissUpload: (id) => dispatch({ type: 'dismiss', id }),
      renameAsset,
      deleteAssets,
      refreshAssets,
      reportAssetError,
    }),
    [
      snap,
      assets,
      byKind,
      assetById,
      saver,
      reload,
      keepMine,
      uploads,
      freshIds,
      addFiles,
      browse,
      renameAsset,
      deleteAssets,
      refreshAssets,
      reportAssetError,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
