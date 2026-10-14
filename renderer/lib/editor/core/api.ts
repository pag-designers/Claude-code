/**
 * CP3 EDITOR STORE CONTRACT — the surface every editor UI module codes against.
 * Owned by the lead. The `editor-core` agent implements it (renderer/lib/editor/core/store.ts exports `useEditorStore`
 * typed `UseBoundStore<StoreApi<EditorStore>>`, plus the pure helpers listed at the bottom). UI agents import ONLY from
 * '@/lib/editor/core' (the index) — never from internals. Members may be ADDED by the core agent (tell the lead and
 * the UI agents via the lead); existing ones may not change shape.
 *
 * Every mutating action = ONE undoable command (command pattern, 200 levels). Property edits through `updateItem`
 * with the same `coalesceKey` within 600 ms merge into one undo step (so dragging a slider is one step).
 */
import type {
  Asset,
  Item,
  ItemType,
  Keyframe,
  Project,
  ProjectMarker,
  Track,
  TrackKind,
  ItemTransition,
  EditorProjectDoc,
  Easing,
} from '@shared/editor';

export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error' | 'conflict';

export interface Selection {
  itemIds: string[];
  /** Last clicked track (target for paste / add / split-all). */
  trackId: string | null;
  /** Selected keyframe, if any (inspector / keyframe editor). */
  keyframe: { itemId: string; prop: string; index: number } | null;
}

export interface SnapOptions {
  /** Override the store's snap toggle for this call. */
  snap?: boolean;
  /** Pixels per second at call time (threshold = 8 px). Defaults to the store zoom. */
  pxPerSec?: number;
}

/** Result of computing an edit without applying it (drag previews, ghost rects, snap guides). */
export interface MovePreview {
  moves: { itemId: string; trackId: string; startSec: number }[];
  /** Timeline time the primary item snapped to, for the guide line, or null. */
  snappedTo: number | null;
  snapKind: 'item' | 'playhead' | 'marker' | 'beat' | 'grid' | 'start' | null;
  /** False when the drop would overlap something it may not overlap or the track is locked / wrong kind. */
  valid: boolean;
}

export interface EditorState {
  /* ---- document ---- */
  projectId: string | null;
  name: string;
  /** Server revision the local copy is based on (for `editor:save` baseRev). */
  rev: number;
  project: Project;
  saveState: SaveState;
  lastSavedAt: number | null;
  saveError: string | null;

  /* ---- transport / view ---- */
  playheadSec: number;
  playing: boolean;
  /** Playback rate: 1 normal; J/K/L shuttle uses −8…8 (negative = reverse). */
  rate: number;
  loop: boolean;
  /** Timeline zoom: pixels per second (1…600). */
  pxPerSec: number;
  /** Left edge of the visible timeline, seconds. */
  scrollSec: number;
  snapEnabled: boolean;
  /** Ripple trims/deletes (close gaps) when true. */
  rippleEnabled: boolean;
  /** Show safe-area guides for this platform id (key of SAFE_AREAS) or null. */
  safeArea: string | null;
  showGrid: boolean;

  /* ---- selection / clipboard ---- */
  selection: Selection;
  clipboard: { items: Item[]; trackKinds: TrackKind[] } | null;

  /* ---- history ---- */
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
}

export interface EditorActions {
  /* ---- lifecycle ---- */
  /** Replace the whole editor state with a loaded document (clears history, selection; playhead 0). */
  load(doc: EditorProjectDoc): void;
  /** Immediately persist (editor:save). Also called every 5 s while dirty by the autosave loop started with `startAutosave`. */
  saveNow(): Promise<void>;
  /** Starts the 5 s autosave loop; returns a stop function. The IPC `save` function is injected so tests need no bridge. */
  startAutosave(deps: AutosaveDeps): () => void;
  rename(name: string): void;

  /* ---- transport ---- */
  setPlayhead(sec: number): void;
  play(): void;
  pause(): void;
  togglePlay(): void;
  /** ±1 frame at the project fps (frame-accurate stepping; ←/→). `frames` may be larger (shift = 10). */
  stepFrames(frames: number): void;
  /** J = reverse / faster reverse, K = pause, L = forward / faster forward (taps ramp 1→2→4→8×). */
  shuttle(key: 'J' | 'K' | 'L'): void;
  setRate(rate: number): void;
  setLoop(on: boolean): void;
  /** Advance the playhead by dt seconds of wall time (called by the preview's rAF loop; clamps at project end / loops). */
  tick(dtSec: number): void;
  setZoom(pxPerSec: number, anchorSec?: number): void;
  zoomToFit(viewportPx: number): void;
  setScroll(sec: number): void;
  toggleSnap(): void;
  toggleRipple(): void;
  setSafeArea(id: string | null): void;
  toggleGrid(): void;

  /* ---- selection ---- */
  select(ids: string[], mode?: 'replace' | 'add' | 'toggle'): void;
  selectTrack(trackId: string | null): void;
  selectAll(trackId?: string): void;
  clearSelection(): void;
  selectKeyframe(sel: Selection['keyframe']): void;

  /* ---- tracks ---- */
  addTrack(kind: TrackKind, opts?: { index?: number; name?: string }): string;
  removeTrack(trackId: string): void;
  moveTrack(trackId: string, toIndex: number): void;
  updateTrack(trackId: string, patch: Partial<Pick<Track, 'name' | 'locked' | 'muted' | 'hidden' | 'gain' | 'speech' | 'ducking'>>): void;

  /* ---- items ---- */
  /** Adds an item (keeps the transition overlap invariant, creates a track of the right kind when `trackId` is null). */
  addItem(item: Item, opts?: { trackId?: string | null }): string;
  /** Drops an asset on the timeline at `startSec` (default: playhead) on `trackId` (default: first compatible track, else a new one). */
  addAsset(assetId: string, opts?: { trackId?: string | null; startSec?: number; ripple?: boolean }): string | null;
  /** Compute (no mutation) where moving `itemIds` by drag would land: snapping, track retargeting, validity. */
  previewMove(itemIds: string[], deltaSec: number, targetTrackId: string | null, opts?: SnapOptions): MovePreview;
  /** Apply a MovePreview (or any moves). One undo step. Respects locked tracks / groups. */
  applyMoves(moves: MovePreview['moves'], opts?: { ripple?: boolean }): void;
  /**
   * Trim one edge to timeline time `toSec`. Start trims adjust inSec (media) so content stays in place; end trims
   * change duration. Ripple (store flag or opts) shifts everything after; `roll` moves the shared edge of two
   * adjacent items together. Cannot extend past the available source (asset duration) for media items.
   */
  trim(itemId: string, edge: 'start' | 'end', toSec: number, opts?: SnapOptions & { ripple?: boolean; roll?: boolean }): void;
  /** Split the item at timeline time (default playhead) — all selected items crossing it (or the item under the playhead on the selected/any track). Returns the new item ids. */
  split(itemId: string | null, atSec?: number): string[];
  deleteItems(itemIds: string[], opts?: { ripple?: boolean }): void;
  /** Remove the empty space on a track (or all unlocked tracks) by shifting later items left. */
  deleteGaps(trackId?: string): void;
  duplicateItems(itemIds: string[]): string[];
  group(itemIds: string[]): void;
  ungroup(itemIds: string[]): void;
  copy(): void;
  cut(): void;
  paste(): string[];
  /** Generic property edit. `patch` is deep-merged into the item. `coalesceKey` merges rapid edits into one undo step. */
  updateItem(itemId: string, patch: DeepPartial<Item>, opts?: { label?: string; coalesceKey?: string }): void;
  /** Convenience for sliders etc.: set one animated property at the playhead — adds/updates a keyframe when the property already has keyframes (or `forceKeyframe`), else sets the base value. */
  setProp(itemId: string, path: AnimatedPath, value: number, opts?: { forceKeyframe?: boolean; ease?: Easing; coalesceKey?: string }): void;
  addKeyframe(itemId: string, path: AnimatedPath, tLocal: number, value?: number, ease?: Easing): void;
  moveKeyframe(itemId: string, path: AnimatedPath, index: number, tLocal: number, value: number): void;
  setKeyframeEase(itemId: string, path: AnimatedPath, index: number, ease: Easing): void;
  removeKeyframe(itemId: string, path: AnimatedPath, index: number): void;
  clearKeyframes(itemId: string, path: AnimatedPath): void;
  /** Applies/removes a transition on the later item of an adjacent pair; adjusts the overlap (moves the item earlier by durationSec; falls back to clamping when there is no room). */
  setTransition(itemId: string, transition: ItemTransition | null): void;
  /** Speed (constant) with duration adjusted to keep the same source span unless `keepDuration`. */
  setSpeed(itemId: string, speed: number, opts?: { keepDuration?: boolean }): void;
  /** Splits at `atSec` and turns a hold of `holdSec` into a freeze-frame item between the halves. */
  freezeFrame(itemId: string, atSec: number, holdSec: number): void;
  /** Apply the same style/preset to many items (bulk apply, e.g. caption preset for all subtitle cues). */
  updateItems(itemIds: string[], patch: DeepPartial<Item>, opts?: { label?: string }): void;

  /* ---- subtitles (the subtitle track is first-class) ---- */
  setCueText(itemId: string, text: string): void;
  /** Splits a cue at word index (words before stay, rest become a new cue right after). */
  splitCue(itemId: string, atWordIndex: number): string | null;
  mergeCueWithNext(itemId: string): void;
  /** Retime a cue's edges (drag): moves startSec/duration and rescales word times. */
  retimeCue(itemId: string, startSec: number, endSec: number): void;
  /** Replace all cues of a subtitle track (e.g. after "Re-sync with AI"). */
  replaceCues(trackId: string, cues: Item[]): void;

  /* ---- assets / canvas / markers ---- */
  addAssets(assets: Asset[]): void;
  updateAsset(assetId: string, patch: Partial<Asset>): void;
  setCanvas(patch: Partial<Project['canvas']>): void;
  addMarker(atSec?: number, label?: string): string;
  updateMarker(id: string, patch: Partial<Pick<ProjectMarker, 'atSec' | 'label' | 'color'>>): void;
  removeMarker(id: string): void;

  /* ---- history ---- */
  undo(): void;
  redo(): void;
}

export type EditorStore = EditorState & EditorActions;

export interface AutosaveDeps {
  save(args: { id: string; project: Project; baseRev: number }): Promise<{ rev: number; updatedAt: number }>;
  /** Called when the server rejects with a revision conflict. */
  onConflict?(): void;
  intervalMs?: number;
}

/** Dotted paths of every animated number, e.g. 'transform.x', 'crop.w', 'volume', 'color.exposure', 'blur'. */
export type AnimatedPath =
  | 'transform.x'
  | 'transform.y'
  | 'transform.scale'
  | 'transform.rotation'
  | 'transform.opacity'
  | 'crop.x'
  | 'crop.y'
  | 'crop.w'
  | 'crop.h'
  | 'volume'
  | 'blur'
  | 'color.exposure'
  | 'color.contrast'
  | 'color.saturation'
  | 'color.temperature';

export type DeepPartial<T> = T extends (infer U)[] ? U[] : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

/* ------------------------------------------------------------------------------------------------
 * PURE HELPERS the core module also exports (no store needed; used by UI + tests):
 *   newId(prefix)                         — short unique ids ('it_…', 'tr_…', 'as_…', 'mk_…')
 *   emptyProject(aspect)                  — project with default tracks: Video (speech), Subtitles, Text, Music
 *   makeVideoItem(asset, startSec, opts?) / makeAudioItem / makeImageItem / makeTextItem(text, startSec) /
 *   makeShapeItem(kind, startSec) / makeSubtitleItem(words, startSec)  — complete valid items with defaults
 *   timeToPx(t, pxPerSec, scrollSec) / pxToTime(px, pxPerSec, scrollSec) / snapCandidates(project, playhead, opts)
 *   frameDuration(fps) / snapToFrame(t, fps)
 *   trackAccepts(track, itemType) / firstCompatibleTrack(project, itemType)
 *   TRANSPORT_RATES = [1, 2, 4, 8]
 *   SHORTCUTS: ShortcutDef[] — the full keyboard map (id, keys, label, group) used by the `?` overlay AND the key handler
 *   handleKey(event, store): boolean       — dispatches a KeyboardEvent to store actions per SHORTCUTS (ignores text fields)
 * ---------------------------------------------------------------------------------------------- */
export interface ShortcutDef {
  id: string;
  /** Display, e.g. ['Space'], ['⌘','Z'] (⌘ shown as Ctrl on non-mac by the UI). */
  keys: string[];
  label: string;
  group: 'Transport' | 'Edit' | 'Selection' | 'Timeline' | 'View' | 'Project';
}
export type { ItemType };
export type { Keyframe };
