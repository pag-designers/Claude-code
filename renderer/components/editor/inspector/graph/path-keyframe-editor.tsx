'use client';

import * as React from 'react';
import type { Item, Keyframe } from '@shared/editor';
import { findItem } from '@shared/editor-eval';
import { useEditorStore, type AnimatedPath } from '../store';
import { GRAPH_BOUNDS, PATH_META, getAnimated, localTime } from '../lib/animated';
import { KeyframeEditor } from './keyframe-editor';

const PATHS = new Set<string>(Object.keys(PATH_META));
export const isAnimatedPath = (p: string): p is AnimatedPath => PATHS.has(p);

/**
 * The keyframe editor for the keyframe selected in the timeline (store.selection.keyframe): graph + details for one
 * animated property. Every edit is a store keyframe action (moveKeyframe / addKeyframe / removeKeyframe /
 * setKeyframeEase / clearKeyframes) — one undo step per gesture.
 */
export function SelectedKeyframeEditor() {
  const sel = useEditorStore((s) => s.selection.keyframe);
  const project = useEditorStore((s) => s.project);
  const playhead = useEditorStore((s) => s.playheadSec);
  if (!sel || !isAnimatedPath(sel.prop)) return null;
  const found = findItem(project, sel.itemId);
  if (!found) return null;
  return <PathEditor item={found.item} path={sel.prop} index={sel.index} playhead={playhead} />;
}

function PathEditor({
  item,
  path,
  index,
  playhead,
}: {
  item: Item;
  path: AnimatedPath;
  index: number;
  playhead: number;
}) {
  const a = getAnimated(item, path);
  const meta = PATH_META[path];
  const st = () => useEditorStore.getState();
  if (!a) return null;
  const lt = localTime(item, playhead);
  const select = (i: number | null) =>
    st().selectKeyframe(i === null ? null : { itemId: item.id, prop: path, index: i });
  const display = (v: number) => {
    const d = v * meta.mul;
    return String(Math.abs(d) >= 100 ? Math.round(d) : Math.round(d * 10) / 10);
  };
  const bounds = GRAPH_BOUNDS[path];
  return (
    <KeyframeEditor
      title={`${meta.label} keyframes`}
      label={`${meta.label} animation curve`}
      keyframes={a.kf as Keyframe[]}
      base={a.v}
      durationSec={item.durationSec}
      floor={bounds.floor}
      ceil={bounds.ceil}
      minSpan={bounds.minSpan}
      format={display}
      valueFormat={{
        mul: meta.mul,
        decimals: meta.decimals,
        unit: meta.unit,
        step: meta.step,
        min: meta.min,
        max: meta.max,
      }}
      playheadSec={lt.inside ? lt.t : null}
      selected={index}
      onSelect={select}
      onMove={(i, t, v) => st().moveKeyframe(item.id, path, i, t, v)}
      onAdd={(t, v) => {
        st().addKeyframe(item.id, path, t, v);
        const after = getAnimated(
          st()
            .project.tracks.flatMap((tr) => tr.items)
            .find((x) => x.id === item.id) ?? item,
          path,
        );
        const idx = after?.kf.findIndex((k) => Math.abs(k.t - t) < 1e-3) ?? -1;
        if (idx >= 0) select(idx);
      }}
      onRemove={(i) => {
        st().removeKeyframe(item.id, path, i);
        const left = a.kf.length - 1;
        select(left <= 0 ? null : Math.min(i, left - 1));
      }}
      onEase={(i, e) => st().setKeyframeEase(item.id, path, i, e)}
      onClear={() => {
        st().clearKeyframes(item.id, path);
        select(null);
      }}
      onClose={() => select(null)}
      testId="selected-keyframe-editor"
    />
  );
}
