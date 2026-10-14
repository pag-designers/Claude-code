'use client';

/**
 * Store-facing Brand Kit actions of the bin and the inspector. Like actions.ts they read the store at call time.
 */
import { toast } from 'sonner';
import type { Asset } from '@shared/editor';
import type { BrandAssetView, BrandKit, BrandTextStyle } from '@shared/brand';
import { applyBrandToProject } from '@shared/brand-apply';
import { newId, useEditorStore } from '@/lib/editor/core';
import {
  brandRestylePatch,
  brandStickerItem,
  brandTextItem,
  projectAssetFor,
} from '@/lib/editor-panels/brand';
import { addAssetToTimeline } from './actions';

const store = () => useEditorStore.getState();

/**
 * Makes sure a kit asset exists as a project asset (id `ba_<assetId>`, reused when present) and returns it.
 * `defer` postpones the store write to the next task: Chromium cancels a drag whose `dragstart` handler changes the DOM
 * synchronously, and the drop target only needs the asset id.
 */
export function ensureBrandAsset(view: BrandAssetView, opts: { defer?: boolean } = {}): Asset {
  const st = store();
  const { asset, exists } = projectAssetFor(st.project, view);
  if (exists) return asset;
  if (opts.defer) setTimeout(() => store().addAssets([asset]), 0);
  else st.addAssets([asset]);
  return asset;
}

/** A kit image / logo as a sticker-sized image item at the playhead. */
export function addBrandImage(view: BrandAssetView): string | null {
  const asset = ensureBrandAsset(view);
  const st = store();
  const item = brandStickerItem(asset, st.project.canvas, st.playheadSec, newId('it'));
  const id = st.addItem(item);
  if (!id) {
    toast.error('Could not place that on the timeline', {
      description: 'No unlocked track accepts it at the playhead. Unlock a track or add a new one.',
    });
    return null;
  }
  st.select([id]);
  return id;
}

/** A kit video / audio clip on the timeline at the playhead (same placement rules as any project asset). */
export function addBrandClip(view: BrandAssetView): string | null {
  const asset = ensureBrandAsset(view);
  return addAssetToTimeline(asset.id);
}

/**
 * "Add as music with ducking": the clip becomes the project's music bed (looped / trimmed to the programme, fades and
 * level from the kit, ducking on under speech) as ONE undoable step. Uses the same pure operation as Apply Brand Kit.
 */
export function setAsMusicBed(
  kit: BrandKit,
  assets: readonly BrandAssetView[],
  view: BrandAssetView,
) {
  const st = store();
  const withBed: BrandKit = {
    ...kit,
    spec: {
      ...kit.spec,
      musicBed: { ...kit.spec.musicBed, assetId: view.id, duckEnabled: true },
    },
  };
  const r = applyBrandToProject({
    project: st.project,
    kit: withBed,
    assets,
    parts: ['music'],
    newId,
    previousKit: null,
  });
  const reason = r.skipped.find((s) => s.part === 'music')?.reason;
  if (reason) return { ok: false as const, reason };
  // the project's kit stays whatever it was: only the music bed came from this kit
  const next = { ...r.project, brandKitId: st.project.brandKitId };
  st.replaceProject('Add brand music', next);
  return { ok: true as const, detail: r.details.music ?? 'Music bed added' };
}

/** A new text layer in the look of a kit text style, at the playhead. */
export function addBrandText(kit: BrandKit, ts: BrandTextStyle): string {
  const st = store();
  const item = brandTextItem(kit, ts, st.project.canvas, st.playheadSec, newId('it'));
  const id = st.addItem(item);
  st.select([id]);
  return id;
}

/** Restyles the given text items with a kit text style (one undo step; text and timing are kept). */
export function restyleWithBrandText(itemIds: string[], kit: BrandKit, ts: BrandTextStyle): void {
  const st = store();
  st.updateItems(itemIds, brandRestylePatch(kit, ts, st.project.canvas) as never, {
    label: `Apply “${ts.name}”`,
  });
}
