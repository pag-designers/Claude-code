'use client';

/**
 * React side of the editor's Brand Kit surfaces: which kit the left dock is showing, and the kit's data.
 * The choice is shared by every tab (Media, Audio, Text, Stickers) and remembered per viewer.
 */
import { create } from 'zustand';
import type { BrandAssetView, BrandKit, BrandKitSummary } from '@shared/brand';
import { useBrandKit, useBrandKits, useDefaultBrandKitId } from '@/lib/brand/queries';
import { useEditorStore } from '@/lib/editor/core';

const KEY = 'clipfern.editor.brandKit';

function read(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

interface PanelState {
  /** The kit the person picked in a dock section (null = follow the project / default kit). */
  kitId: string | null;
  setKitId(id: string | null): void;
}

export const useBrandPanelState = create<PanelState>((set) => ({
  kitId: null,
  setKitId: (id) => {
    set({ kitId: id });
    try {
      if (id) localStorage.setItem(KEY, id);
      else localStorage.removeItem(KEY);
    } catch {
      /* not remembered */
    }
  },
}));

export interface BrandPanelKit {
  /** Resolved kit id (null = no kits at all). */
  kitId: string | null;
  kits: BrandKitSummary[];
  kit: BrandKit | null;
  assets: BrandAssetView[];
  loading: boolean;
  error: string | null;
  setKitId(id: string): void;
}

/**
 * The kit to show: the person's pick (if it still exists), else the kit this project was branded with, else the default
 * kit, else the first one. Assets come with short-lived URLs (thumbnails, previews).
 */
export function useBrandPanelKit(): BrandPanelKit {
  const picked = useBrandPanelState((s) => s.kitId) ?? read();
  const setKitId = useBrandPanelState((s) => s.setKitId);
  const projectKit = useEditorStore((s) => s.project.brandKitId);
  const defaultId = useDefaultBrandKitId();
  const list = useBrandKits();
  const items = list.data?.items;
  const exists = (id: string | null | undefined): id is string =>
    !!id && (!items || items.some((k) => k.id === id));
  const kitId =
    [picked, projectKit, defaultId].find(exists) ?? (items && items.length ? items[0]!.id : null);
  const q = useBrandKit(kitId);
  return {
    kitId,
    kits: items ?? [],
    kit: q.data?.kit ?? null,
    assets: q.data?.assets ?? [],
    loading: list.isPending || (kitId !== null && q.isPending),
    error: list.error?.message ?? q.error?.message ?? null,
    setKitId,
  };
}
