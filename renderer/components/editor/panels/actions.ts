'use client';

/**
 * Store-facing actions of the bin. Every one reads the store at call time (`getState()`), so click handlers never
 * close over stale playhead / selection values and components subscribe only to what they render.
 */
import { toast } from 'sonner';
import {
  shapeItemSchema,
  textItemSchema,
  type Asset,
  type ShapeKind,
  type TransitionType,
} from '@shared/editor';
import { makeShapeItem, makeTextItem, newId, useEditorStore } from '@/lib/editor/core';
import {
  assetFromClip,
  assetFromVideo,
  findAssetBySource,
  type LibraryRow,
} from '@/lib/editor-panels/library-assets';
import { ctaPatch, shapePatch, textPatch, type TextPresetDef } from '@/lib/editor-panels/presets';
import {
  resolveTransitionTarget,
  selectedVisualItems,
  transitionFor,
} from '@/lib/editor-panels/edit-targets';
import { transitionLabel } from '@/lib/editor-panels/presets';
import { remainingSec } from '@/lib/editor-panels/edit-targets';

const store = () => useEditorStore.getState();

/** Drops an existing project asset on the timeline at the playhead and selects the new item. */
export function addAssetToTimeline(assetId: string): string | null {
  const st = store();
  const id = st.addAsset(assetId, { startSec: st.playheadSec });
  if (id) st.select([id]);
  else
    toast.error('Could not place that on the timeline', {
      description: 'No unlocked track accepts it at the playhead. Unlock a track or add a new one.',
    });
  return id;
}

/** Makes sure a Library row exists as a project asset (reusing one added earlier) and returns it. */
export function ensureLibraryAsset(row: LibraryRow): Asset {
  const st = store();
  const source = row.clip
    ? ({ kind: 'clip', clipId: row.clip.id } as const)
    : ({ kind: 'video', videoId: row.video!.id } as const);
  const existing = findAssetBySource(st.project.assets, source);
  if (existing) return existing;
  const asset = row.clip
    ? assetFromClip(row.clip, newId('as'))
    : assetFromVideo(row.video!, newId('as'));
  st.addAssets([asset]);
  return asset;
}

export function addText(preset: TextPresetDef): string {
  const st = store();
  const canvas = st.project.canvas;
  const patch = textPatch(preset, canvas);
  const base = makeTextItem(patch.text, st.playheadSec);
  const item = textItemSchema.parse({
    ...base,
    name: patch.name,
    text: patch.text,
    style: { ...base.style, ...patch.style },
    transform: { ...base.transform, y: { v: patch.y, kf: [] } },
    ...(patch.animIn ? { animIn: patch.animIn } : {}),
    ...(patch.animOut ? { animOut: patch.animOut } : {}),
  });
  const id = st.addItem(item);
  st.select([id]);
  return id;
}

export function addShape(kind: ShapeKind): string {
  const st = store();
  const canvas = st.project.canvas;
  const patch = shapePatch(kind, canvas);
  const base = makeShapeItem(kind, st.playheadSec);
  const item = shapeItemSchema.parse({
    ...base,
    name: patch.name,
    width: patch.width,
    height: patch.height,
    fill: patch.fill,
    radius: patch.radius,
    durationSec: patch.spansProject ? remainingSec(st.project, st.playheadSec) : base.durationSec,
    transform: { ...base.transform, y: { v: patch.y, kf: [] } },
  });
  const id = st.addItem(item);
  st.select([id]);
  return id;
}

/** CTA sticker = rounded pill (shape) + label (text) added together and grouped so they move as one. */
export function addCta(label: string): string[] {
  const st = store();
  const canvas = st.project.canvas;
  const p = ctaPatch(label, canvas);
  const at = st.playheadSec;
  const pillBase = makeShapeItem('rect', at);
  const pill = shapeItemSchema.parse({
    ...pillBase,
    name: `${label} (shape)`,
    width: p.pill.width,
    height: p.pill.height,
    radius: p.pill.radius,
    fill: p.pill.fill,
    durationSec: 3,
    transform: { ...pillBase.transform, y: { v: p.y, kf: [] } },
  });
  const textBase = makeTextItem(label, at);
  const text = textItemSchema.parse({
    ...textBase,
    name: label,
    durationSec: 3,
    style: { ...textBase.style, ...p.text.style },
    transform: { ...textBase.transform, y: { v: p.y, kf: [] } },
    animIn: p.text.animIn,
  });
  const a = st.addItem(pill);
  const b = st.addItem(text);
  st.group([a, b]);
  st.select([a, b]);
  return [a, b];
}

export type ApplyResult = { ok: true; label: string } | { ok: false; reason: string };

/** Applies a transition to the selected clip (or the one under the playhead). */
export function applyTransition(type: TransitionType, durationSec: number): ApplyResult {
  const st = store();
  const target = resolveTransitionTarget(st.project, st.selection.itemIds, st.playheadSec);
  if (!target.ok) return target;
  const t = transitionFor(type, durationSec, target.maxSec);
  st.setTransition(target.item.id, t);
  st.select([target.item.id]);
  return {
    ok: true,
    label: t ? `${transitionLabel(type)} · ${t.durationSec}s` : 'Transition removed',
  };
}

/** Sets (or clears with null) the colour filter on every selected video / image item. */
export function applyFilter(filter: string | null): ApplyResult {
  const st = store();
  const items = selectedVisualItems(st.project, st.selection.itemIds);
  if (!items.length)
    return { ok: false, reason: 'Select a video or image clip on the timeline first.' };
  st.updateItems(
    items.map((i) => i.id),
    { color: { filter } },
    { label: filter ? 'Apply filter' : 'Remove filter' },
  );
  return { ok: true, label: filter ?? 'none' };
}

export function applyLut(lutAssetId: string | null): ApplyResult {
  const st = store();
  const items = selectedVisualItems(st.project, st.selection.itemIds);
  if (!items.length)
    return { ok: false, reason: 'Select a video or image clip on the timeline first.' };
  st.updateItems(
    items.map((i) => i.id),
    { color: lutAssetId ? { lutAssetId, lutAmount: 1 } : { lutAssetId: null } },
    { label: lutAssetId ? 'Apply LUT' : 'Remove LUT' },
  );
  return { ok: true, label: lutAssetId ?? 'none' };
}

export function setLutAmount(amount: number): void {
  const st = store();
  for (const i of selectedVisualItems(st.project, st.selection.itemIds))
    st.updateItem(i.id, { color: { lutAmount: amount } }, { coalesceKey: 'lutAmount' });
}
