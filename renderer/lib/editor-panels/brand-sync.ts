'use client';

/**
 * Main resolves an asset's preview from the SAVED project document, so a brand asset (or stock clip) that was just added
 * to the store is "unknown" to it until the next autosave. After adding assets, save now and re-request the previews
 * that failed in the meantime, so the canvas shows the new clip within a moment instead of an error until the next
 * 5 s autosave and a manual retry.
 */
import { useEditorStore } from '@/lib/editor/core';
import { getEngine } from '@/lib/editor/playback';

export function syncNewAssets(assetIds: readonly string[]): Promise<void> {
  const st = useEditorStore.getState();
  if (!st.projectId || assetIds.length === 0) return Promise.resolve();
  return st
    .saveNow()
    .catch(() => undefined)
    .then(() => {
      const engine = getEngine();
      if (!engine) return;
      for (const id of assetIds) {
        if (engine.assetStatus(id).state === 'error') engine.retryAsset(id);
      }
    });
}
