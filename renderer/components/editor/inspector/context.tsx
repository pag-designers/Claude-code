'use client';

import * as React from 'react';
import type { Asset, Item, Project } from '@shared/editor';
import { animatedAt } from '@shared/editor-eval';
import { useEditorStore, type AnimatedPath, type DeepPartial } from './store';
import { PATH_META, getAnimated, keyframeToggle, localTime, nestPatch } from './lib/animated';

export type EditPatch = Record<string, unknown>;

export interface Handlers<T> {
  /** Live edit (every scrub tick / slider move / discrete change). Single selection only. */
  onChange: (v: T) => void;
  /** End of a gesture (and after every discrete change). Applies the edit to a multi-selection in ONE undo step. */
  onCommit: (v: T) => void;
}

export interface InspectorCtx {
  /** Selected items, all of one type (the group the panels edit). */
  items: Item[];
  primary: Item;
  multi: boolean;
  project: Project;
  projectId: string | null;
  fps: number;
  assetOf(item: Item): Asset | undefined;
  /** Discrete edit of a plain property: one undo step, applied to every selected item. */
  set(patch: EditPatch, label?: string): void;
  /** Continuous edit (slider / scrub / colour well): single selection coalesces by `key`, multi applies on commit. */
  bind<T>(toPatch: (v: T) => EditPatch, key: string, label?: string): Handlers<T>;
  /** Handlers of an animated property (store.setProp at the playhead). Values are STORED units. */
  animated(path: AnimatedPath): Handlers<number>;
  /** Keyframe diamond: add a keyframe at the playhead (capturing the current value) or remove the one under it. */
  toggleKeyframe(path: AnimatedPath): void;
  /** Back to the neutral value, keyframes cleared (one undo step). */
  resetAnimated(path: AnimatedPath): void;
  /** Values shown by a field: the primary's value and whether the selection disagrees. */
  read<T>(get: (item: Item) => T): { value: T; mixed: boolean };
}

const Ctx = React.createContext<InspectorCtx | null>(null);

export function useInspector(): InspectorCtx {
  const c = React.useContext(Ctx);
  if (!c) throw new Error('useInspector must be used inside <InspectorProvider>');
  return c;
}

/** Patches are built as plain objects per item type; the store takes the union-wide DeepPartial. */
export const asPatch = (p: EditPatch): DeepPartial<Item> => p as DeepPartial<Item>;
const sameJson = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

export function InspectorProvider({
  items,
  project,
  projectId,
  children,
}: {
  items: Item[];
  project: Project;
  projectId: string | null;
  children: React.ReactNode;
}) {
  const primary = items[0] as Item;
  const ids = React.useMemo(() => items.map((i) => i.id), [items]);
  const multi = items.length > 1;
  const fps = project.canvas.fps;

  const value = React.useMemo<InspectorCtx>(() => {
    const st = () => useEditorStore.getState();
    const first = ids[0] as string;
    return {
      items,
      primary,
      multi,
      project,
      projectId,
      fps,
      assetOf: (item) =>
        'assetId' in item ? project.assets.find((a) => a.id === item.assetId) : undefined,
      set: (patch, label) => {
        if (ids.length === 1) st().updateItem(first, asPatch(patch), { label });
        else st().updateItems(ids, asPatch(patch), { label });
      },
      bind: (toPatch, key, label) => ({
        onChange: (v) => {
          if (ids.length === 1)
            st().updateItem(first, asPatch(toPatch(v)), { label, coalesceKey: `${first}:${key}` });
        },
        onCommit: (v) => {
          if (ids.length > 1) st().updateItems(ids, asPatch(toPatch(v)), { label });
        },
      }),
      animated: (path) => ({
        onChange: (v) => {
          if (ids.length === 1) st().setProp(first, path, v, { coalesceKey: `${first}:${path}` });
        },
        onCommit: (v) => {
          if (ids.length < 2) return;
          // items without keyframes take the base value in ONE bulk edit; keyframed ones get a keyframe at the playhead
          const plain: string[] = [];
          for (const it of items) {
            if (getAnimated(it, path)?.kf.length) st().setProp(it.id, path, v);
            else plain.push(it.id);
          }
          if (plain.length)
            st().updateItems(plain, asPatch(nestPatch(path, { v })), {
              label: PATH_META[path].label,
            });
        },
      }),
      toggleKeyframe: (path) => {
        if (ids.length !== 1) return;
        const s = st();
        const item = s.project.tracks.flatMap((t) => t.items).find((i) => i.id === first);
        if (!item) return;
        const act = keyframeToggle(item, path, s.playheadSec, fps);
        if (act.type === 'add') s.addKeyframe(first, path, act.t, act.v);
        else if (act.type === 'remove') s.removeKeyframe(first, path, act.index);
      },
      resetAnimated: (path) => {
        const patch = asPatch(nestPatch(path, { v: PATH_META[path].neutral, kf: [] }));
        if (ids.length === 1)
          st().updateItem(first, patch, { label: `Reset ${PATH_META[path].label}` });
        else st().updateItems(ids, patch, { label: `Reset ${PATH_META[path].label}` });
      },
      read: (get) => {
        const v = get(primary);
        return { value: v, mixed: items.some((i) => !sameJson(get(i), v)) };
      },
    };
  }, [items, ids, primary, multi, project, projectId, fps]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Value of an animated property at the playhead for every selected item (each at its own local time). */
export function useAnimatedValue(path: AnimatedPath): {
  value: number | null;
  mixed: boolean;
  animated: boolean;
  playhead: number;
} {
  const ctx = useInspector();
  const playhead = useEditorStore((s) => s.playheadSec);
  let first: number | null = null;
  let mixed = false;
  let animated = false;
  for (const it of ctx.items) {
    const a = getAnimated(it, path);
    if (!a) continue;
    if (a.kf.length) animated = true;
    const v = animatedAt(a, localTime(it, playhead).t);
    if (first === null) first = v;
    else if (Math.abs(v - first) > 1e-6) mixed = true;
  }
  return { value: first, mixed, animated, playhead };
}
