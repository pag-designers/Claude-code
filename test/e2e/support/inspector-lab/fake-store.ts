/**
 * TEST-ONLY stand-in for the editor-core store (renderer/lib/editor/core), used by the inspector lab build until the
 * real store is present (build-lab.sh copies this file in only when core/index.ts does not exist).
 *
 * It implements the documented api.ts semantics the inspector relies on, nothing more: undo history where
 * `coalesceKey` edits within 600 ms merge into one step, `updateItem` deep-merge (arrays and null REPLACE), setProp /
 * keyframe actions, transitions (overlap shift), setSpeed, split, freeze, cue ops and track/asset/canvas edits.
 * Every call is appended to `__log` so tests can assert on exactly what the inspector asked the store to do.
 */
import { create } from 'zustand';
import type { Asset, Item, Keyframe, Project, SubtitleItem, SubtitleWord } from '@shared/editor';
import { animatedAt, makeSourceTime } from '@shared/editor-eval';

type Json = Record<string, unknown>;

interface HistoryEntry {
  label: string;
  key: string | null;
  at: number;
  before: Project;
}

export interface FakeState {
  projectId: string | null;
  name: string;
  rev: number;
  project: Project;
  playheadSec: number;
  playing: boolean;
  snapEnabled: boolean;
  safeArea: string | null;
  showGrid: boolean;
  selection: {
    itemIds: string[];
    trackId: string | null;
    keyframe: { itemId: string; prop: string; index: number } | null;
  };
  canUndo: boolean;
  canRedo: boolean;
  /** Number of undo steps on the stack (tests assert "one step per drag"). */
  undoDepth: number;
  __log: { fn: string; args: unknown[] }[];
  [k: string]: unknown;
}

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

export function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isObj(patch) || !isObj(base)) return patch;
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = k in base ? deepMerge(base[k], v) : v;
  return out;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
let counter = 0;
const newId = (p: string) =>
  `${p}_${(++counter).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

function mapItems(p: Project, fn: (it: Item) => Item | null | undefined): Project {
  return {
    ...p,
    tracks: p.tracks.map((t) => ({
      ...t,
      items: t.items.map((it) => fn(it) ?? it),
    })),
  };
}

function getByPath(item: Item, path: string): { v: number; kf: Keyframe[] } | null {
  let cur: unknown = item;
  for (const part of path.split('.')) {
    if (!isObj(cur)) return null;
    cur = cur[part];
  }
  return isObj(cur) && 'kf' in cur ? (cur as { v: number; kf: Keyframe[] }) : null;
}

function nest(path: string, value: unknown): Json {
  const parts = path.split('.');
  let out: unknown = value;
  for (let i = parts.length - 1; i >= 0; i--) out = { [parts[i] as string]: out };
  return out as Json;
}

export const useFakeEditorStore = create<FakeState>()((set, get) => {
  const past: HistoryEntry[] = [];
  const future: Project[] = [];
  const log = (fn: string, ...args: unknown[]) =>
    set((s) => ({ __log: [...s.__log, { fn, args }] }));

  const commit = (label: string, next: Project, key?: string | null) => {
    const s = get();
    const now = Date.now();
    const top = past[past.length - 1];
    if (key && top && top.key === key && now - top.at < 600) {
      top.at = now;
    } else {
      past.push({ label, key: key ?? null, at: now, before: s.project });
    }
    future.length = 0;
    set({ project: next, canUndo: true, canRedo: false, undoDepth: past.length });
  };

  const edit = (id: string, fn: (it: Item) => Item, label: string, key?: string | null) => {
    commit(
      label,
      mapItems(get().project, (it) => (it.id === id ? fn(it) : null)),
      key,
    );
  };

  const sortedKf = (kf: Keyframe[]) => [...kf].sort((a, b) => a.t - b.t);
  const localT = (it: Item) =>
    Math.min(it.durationSec, Math.max(0, get().playheadSec - it.startSec));

  const actions = {
    load: (doc: { id: string; name: string; rev: number; project: Project }) => {
      past.length = 0;
      future.length = 0;
      set({
        projectId: doc.id,
        name: doc.name,
        rev: doc.rev,
        project: doc.project,
        playheadSec: 0,
        selection: { itemIds: [], trackId: null, keyframe: null },
        canUndo: false,
        canRedo: false,
        undoDepth: 0,
        __log: [],
      });
    },
    setPlayhead: (sec: number) => set({ playheadSec: Math.max(0, sec) }),
    play: () => set({ playing: true }),
    pause: () => set({ playing: false }),
    togglePlay: () => set((s) => ({ playing: !s.playing })),
    toggleSnap: () => {
      log('toggleSnap');
      set((s) => ({ snapEnabled: !s.snapEnabled }));
    },
    setSafeArea: (id: string | null) => {
      log('setSafeArea', id);
      set({ safeArea: id });
    },
    toggleGrid: () => set((s) => ({ showGrid: !s.showGrid })),
    select: (ids: string[]) =>
      set((s) => ({ selection: { ...s.selection, itemIds: ids, keyframe: null } })),
    selectTrack: (trackId: string | null) =>
      set((s) => ({ selection: { ...s.selection, trackId, itemIds: [], keyframe: null } })),
    clearSelection: () =>
      set((s) => ({ selection: { ...s.selection, itemIds: [], keyframe: null } })),
    selectKeyframe: (kf: FakeState['selection']['keyframe']) => {
      log('selectKeyframe', kf);
      set((s) => ({ selection: { ...s.selection, keyframe: kf } }));
    },

    updateItem: (id: string, patch: Json, opts?: { label?: string; coalesceKey?: string }) => {
      log('updateItem', id, patch, opts);
      edit(id, (it) => deepMerge(it, patch) as Item, opts?.label ?? 'Edit', opts?.coalesceKey);
    },
    updateItems: (ids: string[], patch: Json, opts?: { label?: string }) => {
      log('updateItems', ids, patch, opts);
      commit(
        opts?.label ?? 'Edit',
        mapItems(get().project, (it) =>
          ids.includes(it.id) ? (deepMerge(it, patch) as Item) : null,
        ),
      );
    },
    setProp: (
      id: string,
      path: string,
      value: number,
      opts?: { forceKeyframe?: boolean; ease?: Keyframe['ease']; coalesceKey?: string },
    ) => {
      log('setProp', id, path, value, opts);
      edit(
        id,
        (it) => {
          const a = getByPath(it, path);
          if (!a) return it;
          const useKf = a.kf.length > 0 || opts?.forceKeyframe;
          if (!useKf) return deepMerge(it, nest(path, { v: value })) as Item;
          const t = Math.round(localT(it) * 1000) / 1000;
          const idx = a.kf.findIndex((k) => Math.abs(k.t - t) < 1 / 60);
          const kf =
            idx >= 0
              ? a.kf.map((k, i) => (i === idx ? { ...k, v: value } : k))
              : sortedKf([...a.kf, { t, v: value, ease: opts?.ease ?? 'linear' }]);
          return deepMerge(it, nest(path, { kf })) as Item;
        },
        'Set value',
        opts?.coalesceKey,
      );
    },
    addKeyframe: (id: string, path: string, t: number, value?: number, ease?: Keyframe['ease']) => {
      log('addKeyframe', id, path, t, value, ease);
      edit(
        id,
        (it) => {
          const a = getByPath(it, path);
          if (!a) return it;
          const v = value ?? animatedAt(a, t);
          return deepMerge(
            it,
            nest(path, { kf: sortedKf([...a.kf, { t, v, ease: ease ?? 'linear' }]) }),
          ) as Item;
        },
        'Add keyframe',
      );
    },
    moveKeyframe: (id: string, path: string, index: number, t: number, value: number) => {
      log('moveKeyframe', id, path, index, t, value);
      edit(
        id,
        (it) => {
          const a = getByPath(it, path);
          if (!a || !a.kf[index]) return it;
          const kf = sortedKf(a.kf.map((k, i) => (i === index ? { ...k, t, v: value } : k)));
          return deepMerge(it, nest(path, { kf })) as Item;
        },
        'Move keyframe',
      );
    },
    setKeyframeEase: (id: string, path: string, index: number, ease: Keyframe['ease']) => {
      log('setKeyframeEase', id, path, index, ease);
      edit(
        id,
        (it) => {
          const a = getByPath(it, path);
          if (!a || !a.kf[index]) return it;
          return deepMerge(
            it,
            nest(path, { kf: a.kf.map((k, i) => (i === index ? { ...k, ease } : k)) }),
          ) as Item;
        },
        'Keyframe easing',
      );
    },
    removeKeyframe: (id: string, path: string, index: number) => {
      log('removeKeyframe', id, path, index);
      edit(
        id,
        (it) => {
          const a = getByPath(it, path);
          if (!a) return it;
          return deepMerge(it, nest(path, { kf: a.kf.filter((_, i) => i !== index) })) as Item;
        },
        'Remove keyframe',
      );
    },
    clearKeyframes: (id: string, path: string) => {
      log('clearKeyframes', id, path);
      edit(id, (it) => deepMerge(it, nest(path, { kf: [] })) as Item, 'Clear keyframes');
    },
    setTransition: (id: string, t: { type: string; durationSec: number } | null) => {
      log('setTransition', id, t);
      edit(
        id,
        (it) => {
          const old =
            (it as { transitionIn?: { durationSec: number } | null }).transitionIn?.durationSec ??
            0;
          const next = t?.durationSec ?? 0;
          return {
            ...it,
            transitionIn: t,
            startSec: Math.max(0, it.startSec + old - next),
          } as Item;
        },
        'Transition',
      );
    },
    setSpeed: (id: string, speed: number, opts?: { keepDuration?: boolean }) => {
      log('setSpeed', id, speed, opts);
      edit(
        id,
        (it) => {
          if (it.type !== 'video' && it.type !== 'audio') return it;
          const span = it.speed * it.durationSec;
          return {
            ...it,
            speed,
            speedCurve: [],
            durationSec: opts?.keepDuration
              ? it.durationSec
              : Math.round((span / speed) * 1000) / 1000,
          };
        },
        'Speed',
      );
    },
    split: (id: string | null, atSec?: number): string[] => {
      log('split', id, atSec);
      const at = atSec ?? get().playheadSec;
      const ids: string[] = [];
      commit('Split', {
        ...get().project,
        tracks: get().project.tracks.map((t) => ({
          ...t,
          items: t.items.flatMap((it) => {
            if (
              it.id !== id ||
              at <= it.startSec + 0.01 ||
              at >= it.startSec + it.durationSec - 0.01
            )
              return [it];
            const left = it.durationSec - (it.startSec + it.durationSec - at);
            const right = it.durationSec - left;
            const nid = newId('it');
            ids.push(nid);
            const rightItem: Item =
              it.type === 'video' || it.type === 'audio'
                ? ({
                    ...it,
                    id: nid,
                    startSec: at,
                    durationSec: right,
                    inSec: makeSourceTime(it)(left),
                    transitionIn: null,
                  } as Item)
                : ({
                    ...it,
                    id: nid,
                    startSec: at,
                    durationSec: right,
                    transitionIn: null,
                  } as Item);
            return [{ ...it, durationSec: left }, rightItem];
          }),
        })),
      });
      return ids;
    },
    freezeFrame: (id: string, atSec: number, holdSec: number) => {
      log('freezeFrame', id, atSec, holdSec);
      commit('Freeze frame', {
        ...get().project,
        tracks: get().project.tracks.map((t) => ({
          ...t,
          items: t.items.flatMap((it) => {
            if (it.id !== id || it.type !== 'video') return [it];
            const left = atSec - it.startSec;
            const right = it.durationSec - left;
            const src = makeSourceTime(it)(left);
            const freeze = {
              ...it,
              id: newId('it'),
              startSec: atSec,
              durationSec: holdSec,
              freezeAtSec: src,
              transitionIn: null,
            };
            const tail = {
              ...it,
              id: newId('it'),
              startSec: atSec + holdSec,
              durationSec: right,
              inSec: src,
              transitionIn: null,
            };
            return [{ ...it, durationSec: left }, freeze, tail] as Item[];
          }),
        })),
      });
    },

    splitCue: (id: string, atWord: number): string | null => {
      log('splitCue', id, atWord);
      let created: string | null = null;
      commit('Split caption', {
        ...get().project,
        tracks: get().project.tracks.map((t) => ({
          ...t,
          items: t.items.flatMap((it) => {
            if (it.id !== id || it.type !== 'subtitle' || atWord <= 0 || atWord >= it.words.length)
              return [it];
            const cut = it.words[atWord]!.s;
            const first = it.words.slice(0, atWord);
            const rest = it.words.slice(atWord).map((w) => ({ ...w, s: w.s - cut, e: w.e - cut }));
            created = newId('it');
            return [
              { ...it, words: first, durationSec: Math.max(0.1, first[first.length - 1]!.e) },
              {
                ...it,
                id: created,
                words: rest,
                startSec: it.startSec + cut,
                durationSec: it.durationSec - cut,
              },
            ] as Item[];
          }),
        })),
      });
      return created;
    },
    mergeCueWithNext: (id: string) => {
      log('mergeCueWithNext', id);
      commit('Merge captions', {
        ...get().project,
        tracks: get().project.tracks.map((t) => {
          const i = t.items.findIndex((x) => x.id === id);
          const a = t.items[i];
          const b = t.items[i + 1];
          if (i < 0 || !a || !b || a.type !== 'subtitle' || b.type !== 'subtitle') return t;
          const shift = b.startSec - a.startSec;
          const merged: SubtitleItem = {
            ...a,
            durationSec: b.startSec + b.durationSec - a.startSec,
            words: [
              ...a.words,
              ...b.words.map((w: SubtitleWord) => ({ ...w, s: w.s + shift, e: w.e + shift })),
            ],
          };
          return { ...t, items: [...t.items.slice(0, i), merged, ...t.items.slice(i + 2)] };
        }),
      });
    },
    retimeCue: (id: string, startSec: number, endSec: number) => {
      log('retimeCue', id, startSec, endSec);
      edit(
        id,
        (it) => {
          if (it.type !== 'subtitle') return it;
          const dur = Math.max(0.1, endSec - startSec);
          const k = dur / it.durationSec;
          return {
            ...it,
            startSec,
            durationSec: dur,
            words:
              Math.abs(k - 1) < 1e-9
                ? it.words
                : it.words.map((w) => ({ ...w, s: w.s * k, e: w.e * k })),
          };
        },
        'Retime caption',
      );
    },
    replaceCues: (trackId: string, cues: Item[]) => {
      log('replaceCues', trackId, cues);
      commit('Replace captions', {
        ...get().project,
        tracks: get().project.tracks.map((t) => (t.id === trackId ? { ...t, items: cues } : t)),
      });
    },
    setCueText: (id: string, text: string) => {
      log('setCueText', id, text);
    },

    updateTrack: (trackId: string, patch: Json) => {
      log('updateTrack', trackId, patch);
      commit('Track', {
        ...get().project,
        tracks: get().project.tracks.map((t) =>
          t.id === trackId ? ({ ...t, ...patch } as typeof t) : t,
        ),
      });
    },
    addAssets: (assets: Asset[]) => {
      log('addAssets', assets);
      commit('Add assets', { ...get().project, assets: [...get().project.assets, ...assets] });
    },
    updateAsset: (assetId: string, patch: Partial<Asset>) => {
      log('updateAsset', assetId, patch);
      commit('Update asset', {
        ...get().project,
        assets: get().project.assets.map((a) => (a.id === assetId ? { ...a, ...patch } : a)),
      });
    },
    setCanvas: (patch: Partial<Project['canvas']>) => {
      log('setCanvas', patch);
      commit('Canvas', { ...get().project, canvas: { ...get().project.canvas, ...patch } });
    },
    undo: () => {
      const e = past.pop();
      if (!e) return;
      future.push(get().project);
      set({ project: e.before, canUndo: past.length > 0, canRedo: true, undoDepth: past.length });
    },
    redo: () => {
      const p = future.pop();
      if (!p) return;
      past.push({ label: 'Redo', key: null, at: 0, before: get().project });
      set({ project: p, canUndo: true, canRedo: future.length > 0, undoDepth: past.length });
    },
  };

  return {
    projectId: null,
    name: '',
    rev: 0,
    project: {
      version: 1,
      canvas: { aspect: '9:16', width: 1080, height: 1920, fps: 30, background: '#000000' },
      tracks: [],
      assets: [],
      markers: [],
      origin: { clipId: null, videoId: null },
    },
    playheadSec: 0,
    playing: false,
    snapEnabled: true,
    safeArea: null,
    showGrid: false,
    selection: { itemIds: [], trackId: null, keyframe: null },
    canUndo: false,
    canRedo: false,
    undoDepth: 0,
    __log: [],
    ...actions,
  } as FakeState;
});

export { clone };
