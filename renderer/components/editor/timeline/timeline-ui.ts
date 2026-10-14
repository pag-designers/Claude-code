'use client';

/**
 * Transient, timeline-local interaction state (ghosts, guides, marquee, previews). It is NOT part of the project and is
 * never persisted or undoable; the editor store (`useEditorStore`) stays the single source of truth for the document.
 */
import { create } from 'zustand';
import type { Item } from '@shared/editor';
import type { ContentRect, SnapKind } from './geometry';

export type Tool = 'select' | 'razor';

export interface GhostRect {
  itemId: string;
  trackId: string;
  startSec: number;
  durationSec: number;
  type: Item['type'];
}

export interface SnapGuide {
  t: number;
  kind: SnapKind | 'grid' | null;
}

export interface TimelineUiState {
  /** Width of the lane viewport (the scroller minus the sticky header column), px. */
  viewportPx: number;
  viewportH: number;
  tool: Tool;

  /** Move preview (ghosts) while dragging items. */
  ghosts: GhostRect[] | null;
  ghostValid: boolean;
  /** Pointer-following label for a drag (timecode). */
  dragLabel: { x: number; y: number; text: string } | null;
  guide: SnapGuide | null;
  marquee: ContentRect | null;
  /** The item being trimmed (shows the resulting span). */
  trim: { itemId: string; edge: 'start' | 'end'; startSec: number; durationSec: number } | null;
  /** Keyframe being dragged. */
  kfDrag: { itemId: string; path: string; index: number; t: number } | null;
  /** Marker being dragged. */
  markerDrag: { id: string; atSec: number } | null;
  /** Where an asset from the media bin would land. */
  drop: { sec: number; trackId: string | null; newTrack: boolean } | null;
  /** A transition tile hovering over a clip: the clip that would receive it. */
  dropTransition: { itemId: string; trackId: string; startSec: number; durationSec: number } | null;
  /** Razor hairline. */
  razor: { trackId: string; sec: number } | null;
  /** Track reorder: id being dragged and the row it is hovering. */
  reorder: { trackId: string; overTrackId: string | null; valid: boolean } | null;
  scrubbing: boolean;
  /** Subtitle cue / marker / track currently being renamed inline. */
  editingCueId: string | null;
  editingMarkerId: string | null;
  editingTrackId: string | null;

  set: (patch: Partial<Omit<TimelineUiState, 'set' | 'clearInteraction'>>) => void;
  clearInteraction: () => void;
}

const IDLE = {
  ghosts: null,
  ghostValid: true,
  dragLabel: null,
  guide: null,
  marquee: null,
  trim: null,
  kfDrag: null,
  markerDrag: null,
  drop: null,
  dropTransition: null,
  razor: null,
  reorder: null,
  scrubbing: false,
} satisfies Partial<TimelineUiState>;

export const useTimelineUi = create<TimelineUiState>((set) => ({
  viewportPx: 900,
  viewportH: 300,
  tool: 'select',
  ...IDLE,
  editingCueId: null,
  editingMarkerId: null,
  editingTrackId: null,
  set: (patch) => set(patch),
  clearInteraction: () => set({ ...IDLE }),
}));
