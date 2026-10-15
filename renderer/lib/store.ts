'use client';

import { create } from 'zustand';

interface UiState {
  paletteOpen: boolean;
  storageDialogOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  togglePalette: () => void;
  setStorageDialogOpen: (open: boolean) => void;
}

export const useUi = create<UiState>((set) => ({
  paletteOpen: false,
  storageDialogOpen: false,
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  togglePalette: () => set((s) => ({ paletteOpen: !s.paletteOpen })),
  setStorageDialogOpen: (storageDialogOpen) => set({ storageDialogOpen }),
}));
