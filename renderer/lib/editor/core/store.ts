'use client';

/**
 * The editor store: zustand state + actions implementing api.ts. Every mutating action runs ONE pure op from
 * ops/* and, if the project reference changed, records one undoable command (history.ts). A rejected edit (locked
 * track, invalid drop, no-op) returns the same project → no history entry, no dirty flag.
 */
import { create, createStore, type StoreApi, type UseBoundStore } from 'zustand';
import type { EditorProjectDoc, Item, ItemTransition, Project } from '@shared/editor';
import { itemEnd, projectDuration } from '@shared/editor-eval';
import type {
  AnimatedPath,
  AutosaveDeps,
  EditorActions,
  EditorState,
  EditorStore,
  MovePreview,
  SaveState,
  Selection,
  SnapOptions,
} from './api';
import { History, type Snapshot } from './history';
import { emptyProject, TRANSPORT_RATES } from './helpers';
import {
  addAssetOp,
  addAssetsOp,
  addItemOp,
  addKeyframeOp,
  addMarkerOp,
  addTrackOp,
  applyMovesOp,
  clamp,
  clearKeyframesOp,
  copyOp,
  deleteGapsOp,
  deleteItemsOp,
  duplicateOp,
  expandGroups,
  freezeFrameOp,
  groupOp,
  locate,
  mergeCueWithNextOp,
  moveKeyframeOp,
  moveTrackOp,
  pasteOp,
  previewMoveOp,
  removeKeyframeOp,
  removeMarkerOp,
  removeTrackOp,
  replaceCuesOp,
  retimeCueOp,
  setCanvasOp,
  setCueTextOp,
  setKeyframeEaseOp,
  setPropOp,
  setSpeedOp,
  setTransitionOp,
  splitCueOp,
  splitOp,
  trimOp,
  ungroupOp,
  updateAssetOp,
  updateItemsOp,
  updateMarkerOp,
  updateTrackOp,
  type ClipboardData,
  type RippleScope,
} from './ops';
import { baseSnapPoints, snapTime, type SnapKind } from './snap';

/* ------------------------------------------------------------------ extras beyond api.ts ------- */

/** Members added on top of the api.ts contract (the lead and UI agents may use them). */
export interface EditorExtras {
  /** Width in px of the timeline viewport (set by the timeline; used by the Shift+Z zoom-to-fit shortcut). */
  viewportPx: number;
  setViewportPx(px: number): void;
  /** After a CONFLICT: adopt the server revision so the next save overwrites it ("keep mine"). */
  resolveConflict(serverRev: number): void;
  /** Where a trim to `toSec` would land (snapping), without applying it. */
  previewTrim(
    itemId: string,
    edge: 'start' | 'end',
    toSec: number,
    opts?: SnapOptions & { roll?: boolean },
  ): { sec: number; snappedTo: number | null; snapKind: MovePreview['snapKind'] };
  /** Move the playhead to the previous (−1) / next (+1) edit point (item edge, marker, 0, end). */
  jumpToEdit(direction: -1 | 1): void;
  /** Trim the selected items (or the item under the playhead) so their start / end sits on the playhead. */
  trimToPlayhead(edge: 'start' | 'end', opts?: { ripple?: boolean }): void;
  /** Freeze the selected / under-playhead video item at the playhead for `holdSec` (default 2). */
  freezeAtPlayhead(holdSec?: number): void;
  /** Move the selection by whole frames (←/→ style nudge; ',' '.' shortcuts). */
  nudgeSelected(frames: number): void;
  /** Delete the selected keyframe if any, else the selected items. */
  deleteSelection(opts?: { ripple?: boolean }): void;
  /**
   * CP4: replace the whole project with a derived one as ONE undoable step (Apply Brand Kit computes the next project
   * with the pure `applyBrandToProject`). Returns false (and records nothing) when `next` is the same object.
   */
  replaceProject(label: string, next: Project): boolean;
}

export type FullEditorStore = EditorStore & EditorExtras;

export interface StoreOptions {
  /** Clock for the 600 ms coalesce window (tests). Default Date.now. */
  now?: () => number;
  historyLimit?: number;
}

const EPS = 1e-6;
const DEFAULT_ZOOM = 100;
const MIN_ZOOM = 1;
const MAX_ZOOM = 600;

const emptySelection = (): Selection => ({ itemIds: [], trackId: null, keyframe: null });

function pruneSelection(sel: Selection, project: Project): Selection {
  if (!sel.itemIds.length && !sel.trackId && !sel.keyframe) return sel;
  const ids = new Set<string>();
  for (const tr of project.tracks) for (const it of tr.items) ids.add(it.id);
  const itemIds = sel.itemIds.filter((id) => ids.has(id));
  const trackId =
    sel.trackId && project.tracks.some((t) => t.id === sel.trackId) ? sel.trackId : null;
  const keyframe = sel.keyframe && ids.has(sel.keyframe.itemId) ? sel.keyframe : null;
  if (itemIds.length === sel.itemIds.length && trackId === sel.trackId && keyframe === sel.keyframe)
    return sel;
  return { itemIds, trackId, keyframe };
}

function isConflict(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const o = e as { code?: unknown; message?: unknown; name?: unknown };
  return (
    o.code === 'CONFLICT' ||
    o.name === 'CONFLICT' ||
    (typeof o.message === 'string' && /\bCONFLICT\b/.test(o.message))
  );
}

const errMessage = (e: unknown): string =>
  e instanceof Error ? e.message : typeof e === 'string' ? e : 'Save failed';

/** An item "crosses" t when t is strictly inside it. */
const crosses = (it: Item, t: number): boolean => it.startSec < t - EPS && itemEnd(it) > t + EPS;

/* ------------------------------------------------------------------ the store ----------------- */

type SetFn = (
  partial: Partial<FullEditorStore> | ((s: FullEditorStore) => Partial<FullEditorStore>),
) => void;
type GetFn = () => FullEditorStore;

function initializer(opts: StoreOptions): (set: SetFn, get: GetFn) => FullEditorStore {
  return (set, get) => {
    const history = new History(opts.historyLimit);
    const clock = opts.now ?? (() => Date.now());
    let savedProject: Project | null = null;
    let generation = 0;
    let inflight: Promise<void> | null = null;
    let saveDeps: AutosaveDeps | null = null;

    const histFlags = () => ({
      canUndo: history.canUndo,
      canRedo: history.canRedo,
      undoLabel: history.undoLabel,
      redoLabel: history.redoLabel,
    });

    const nextSaveState = (s: EditorState, project: Project): SaveState => {
      if (s.saveState === 'conflict' || s.saveState === 'saving' || s.saveState === 'error')
        return s.saveState;
      if (project === savedProject) return s.lastSavedAt !== null ? 'saved' : 'idle';
      return 'dirty';
    };

    /** Record `project` as the result of an edit. Returns false when nothing changed. */
    const commit = (
      label: string,
      project: Project,
      o: { coalesceKey?: string; selection?: Selection } = {},
    ): boolean => {
      const s = get();
      if (project === s.project) return false;
      const before: Snapshot = { project: s.project, selection: s.selection };
      const selection = pruneSelection(o.selection ?? s.selection, project);
      history.push(label, before, { project, selection }, o.coalesceKey ?? null, clock());
      set({ project, selection, ...histFlags(), saveState: nextSaveState(s, project) });
      return true;
    };

    const scopeFor = (explicit?: boolean): RippleScope => {
      const s = get();
      const on = explicit ?? s.rippleEnabled;
      if (!on) return 'none';
      return s.rippleEnabled ? 'all' : 'track';
    };

    const snapCtx = (o?: SnapOptions) => {
      const s = get();
      return {
        enabled: o?.snap ?? s.snapEnabled,
        playhead: s.playheadSec,
        pxPerSec: o?.pxPerSec ?? s.pxPerSec,
        fps: s.project.canvas.fps,
      };
    };

    /** Items an editing shortcut should act on at the playhead: selected crossing it, else under it on the selected / any track. */
    const targetsAtPlayhead = (filter?: (it: Item) => boolean): string[] => {
      const s = get();
      const t = s.playheadSec;
      const ok = (it: Item) => crosses(it, t) && (!filter || filter(it));
      const sel = new Set(s.selection.itemIds);
      const chosen: string[] = [];
      for (const tr of s.project.tracks)
        if (!tr.locked) for (const it of tr.items) if (sel.has(it.id) && ok(it)) chosen.push(it.id);
      if (chosen.length) return chosen;
      const tracks = s.project.tracks.filter((tr) => !tr.locked);
      const preferred = tracks.find((tr) => tr.id === s.selection.trackId);
      for (const tr of preferred ? [preferred, ...tracks.filter((x) => x !== preferred)] : tracks) {
        const hit = tr.items.find(ok);
        if (hit) return [hit.id];
      }
      return [];
    };

    const selectIds = (ids: string[], project: Project, trackId?: string | null): Selection => {
      const s = get();
      let track = trackId ?? s.selection.trackId;
      if (trackId === undefined && ids.length) {
        const l = locate(project, ids[ids.length - 1] as string);
        if (l) track = l.track.id;
      }
      return { itemIds: ids, trackId: track, keyframe: null };
    };

    /* ---- autosave ---- */
    const doSave = async (): Promise<void> => {
      const deps = saveDeps;
      if (!deps) return;
      const gen = generation;
      if (inflight) await inflight;
      if (gen !== generation) return;
      const s = get();
      if (!s.projectId || s.project === savedProject) return;
      const sending = s.project;
      const args = { id: s.projectId, project: sending, baseRev: s.rev };
      set({ saveState: 'saving', saveError: null });
      const run = (async () => {
        try {
          const res = await deps.save(args);
          if (gen !== generation) return;
          savedProject = sending;
          set((cur) => ({
            rev: res.rev,
            lastSavedAt: res.updatedAt,
            saveError: null,
            saveState: cur.project === sending ? 'saved' : 'dirty',
          }));
        } catch (e) {
          if (gen !== generation) return;
          if (isConflict(e)) {
            set({ saveState: 'conflict', saveError: errMessage(e) });
            deps.onConflict?.();
          } else set({ saveState: 'error', saveError: errMessage(e) });
        }
      })();
      inflight = run;
      try {
        await run;
      } finally {
        if (inflight === run) inflight = null;
      }
    };

    const autosaveTick = (): void => {
      const s = get();
      if (!saveDeps || inflight || !s.projectId) return;
      if (s.saveState === 'conflict' || s.project === savedProject) return;
      void doSave();
    };

    /* ---- initial state ---- */
    const state: EditorState & Pick<EditorExtras, 'viewportPx'> = {
      projectId: null,
      name: 'Untitled',
      rev: 0,
      project: emptyProject('9:16'),
      saveState: 'idle',
      lastSavedAt: null,
      saveError: null,
      playheadSec: 0,
      playing: false,
      rate: 1,
      loop: false,
      pxPerSec: DEFAULT_ZOOM,
      scrollSec: 0,
      snapEnabled: true,
      rippleEnabled: false,
      safeArea: null,
      showGrid: false,
      selection: emptySelection(),
      clipboard: null,
      canUndo: false,
      canRedo: false,
      undoLabel: null,
      redoLabel: null,
      viewportPx: 1000,
    };
    savedProject = state.project;

    const actions: EditorActions & Omit<EditorExtras, 'viewportPx'> = {
      /* ---------------- lifecycle ---------------- */
      load(doc: EditorProjectDoc) {
        generation++;
        inflight = null;
        history.clear();
        savedProject = doc.project;
        set({
          projectId: doc.id,
          name: doc.name,
          rev: doc.rev,
          project: doc.project,
          saveState: 'idle',
          lastSavedAt: doc.updatedAt,
          saveError: null,
          playheadSec: 0,
          playing: false,
          rate: 1,
          scrollSec: 0,
          selection: emptySelection(),
          ...histFlags(),
        });
      },
      saveNow: () => doSave(),
      startAutosave(deps: AutosaveDeps) {
        saveDeps = deps;
        const timer = setInterval(autosaveTick, deps.intervalMs ?? 5000);
        return () => {
          clearInterval(timer);
          if (saveDeps === deps) saveDeps = null;
        };
      },
      rename(name: string) {
        set({ name });
      },
      resolveConflict(serverRev: number) {
        const s = get();
        set({
          rev: serverRev,
          saveError: null,
          saveState: s.project === savedProject ? 'saved' : 'dirty',
        });
      },

      /* ---------------- transport ---------------- */
      setPlayhead(sec: number) {
        if (!Number.isFinite(sec)) return;
        set({ playheadSec: Math.max(0, sec) });
      },
      play() {
        const s = get();
        const end = projectDuration(s.project);
        const t = end > 0 && s.playheadSec >= end - 1e-9 ? 0 : s.playheadSec;
        set({ playing: true, rate: s.rate > 0 ? s.rate : 1, playheadSec: t });
      },
      pause() {
        set({ playing: false, rate: 1 });
      },
      togglePlay() {
        if (get().playing) actions.pause();
        else actions.play();
      },
      stepFrames(frames: number) {
        const s = get();
        const fps = s.project.canvas.fps;
        const last = Math.max(0, Math.floor(projectDuration(s.project) * fps + 1e-6));
        const frame = clamp(Math.round(s.playheadSec * fps) + Math.round(frames), 0, last);
        set({ playheadSec: frame / fps, playing: false, rate: 1 });
      },
      shuttle(key: 'J' | 'K' | 'L') {
        const s = get();
        if (key === 'K') {
          set({ playing: false, rate: 1 });
          return;
        }
        const dir = key === 'L' ? 1 : -1;
        const faster = s.playing && Math.sign(s.rate) === dir;
        const mag = faster
          ? ((TRANSPORT_RATES.find((r) => r > Math.abs(s.rate)) ??
              TRANSPORT_RATES[TRANSPORT_RATES.length - 1]) as number)
          : 1;
        const end = projectDuration(s.project);
        const startOver = dir > 0 && end > 0 && s.playheadSec >= end - 1e-9;
        set({ playing: true, rate: dir * mag, ...(startOver ? { playheadSec: 0 } : {}) });
      },
      setRate(rate: number) {
        if (!Number.isFinite(rate)) return;
        if (rate === 0) {
          set({ playing: false, rate: 1 });
          return;
        }
        set({ rate: clamp(rate, -8, 8) });
      },
      setLoop(on: boolean) {
        set({ loop: on });
      },
      tick(dtSec: number) {
        const s = get();
        if (!s.playing || !(dtSec > 0)) return;
        const end = projectDuration(s.project);
        let t = s.playheadSec + dtSec * s.rate;
        let playing = true;
        if (end <= 0) {
          t = 0;
          playing = false;
        } else if (s.rate >= 0 && t >= end) {
          if (s.loop) t = t - end * Math.floor(t / end);
          else {
            t = end;
            playing = false;
          }
        } else if (s.rate < 0 && t <= 0) {
          if (s.loop) t = end + (t % end);
          else {
            t = 0;
            playing = false;
          }
        }
        set(playing ? { playheadSec: t } : { playheadSec: t, playing: false, rate: 1 });
      },
      setZoom(pxPerSec: number, anchorSec?: number) {
        if (!Number.isFinite(pxPerSec)) return;
        const s = get();
        const px = clamp(pxPerSec, MIN_ZOOM, MAX_ZOOM);
        let scroll = s.scrollSec;
        if (anchorSec !== undefined) {
          const screen = (anchorSec - s.scrollSec) * s.pxPerSec;
          scroll = Math.max(0, anchorSec - screen / px);
        }
        set({ pxPerSec: px, scrollSec: scroll });
      },
      zoomToFit(viewportPx: number) {
        const dur = Math.max(1, projectDuration(get().project));
        set({
          pxPerSec: clamp(viewportPx / (dur * 1.05), MIN_ZOOM, MAX_ZOOM),
          scrollSec: 0,
          viewportPx,
        });
      },
      setScroll(sec: number) {
        set({ scrollSec: Math.max(0, Number.isFinite(sec) ? sec : 0) });
      },
      toggleSnap() {
        set((s) => ({ snapEnabled: !s.snapEnabled }));
      },
      toggleRipple() {
        set((s) => ({ rippleEnabled: !s.rippleEnabled }));
      },
      setSafeArea(id: string | null) {
        set({ safeArea: id });
      },
      toggleGrid() {
        set((s) => ({ showGrid: !s.showGrid }));
      },
      setViewportPx(px: number) {
        if (px > 0) set({ viewportPx: px });
      },

      /* ---------------- selection ---------------- */
      select(ids: string[], mode: 'replace' | 'add' | 'toggle' = 'replace') {
        const s = get();
        const exp = expandGroups(s.project, ids);
        let next: string[];
        if (mode === 'replace') next = exp;
        else if (mode === 'add')
          next = [...s.selection.itemIds, ...exp.filter((id) => !s.selection.itemIds.includes(id))];
        else {
          const cur = new Set(s.selection.itemIds);
          const allIn = exp.length > 0 && exp.every((id) => cur.has(id));
          next = allIn
            ? s.selection.itemIds.filter((id) => !exp.includes(id))
            : [...s.selection.itemIds, ...exp.filter((id) => !cur.has(id))];
        }
        const clicked = exp[exp.length - 1];
        const loc = clicked ? locate(s.project, clicked) : null;
        const keyframe =
          s.selection.keyframe && next.includes(s.selection.keyframe.itemId)
            ? s.selection.keyframe
            : null;
        set({
          selection: { itemIds: next, trackId: loc ? loc.track.id : s.selection.trackId, keyframe },
        });
      },
      selectTrack(trackId: string | null) {
        set((s) => ({ selection: { ...s.selection, trackId } }));
      },
      selectAll(trackId?: string) {
        const s = get();
        const ids: string[] = [];
        for (const tr of s.project.tracks)
          if (!trackId || tr.id === trackId) for (const it of tr.items) ids.push(it.id);
        set({
          selection: { itemIds: ids, trackId: trackId ?? s.selection.trackId, keyframe: null },
        });
      },
      clearSelection() {
        set((s) => ({ selection: { itemIds: [], trackId: s.selection.trackId, keyframe: null } }));
      },
      selectKeyframe(sel: Selection['keyframe']) {
        set((s) => ({ selection: { ...s.selection, keyframe: sel } }));
      },

      /* ---------------- tracks ---------------- */
      addTrack(kind, o) {
        const r = addTrackOp(get().project, kind, o);
        commit('Add track', r.project, { selection: { ...get().selection, trackId: r.trackId } });
        return r.trackId;
      },
      removeTrack(trackId) {
        commit('Delete track', removeTrackOp(get().project, trackId));
      },
      moveTrack(trackId, toIndex) {
        commit('Move track', moveTrackOp(get().project, trackId, toIndex));
      },
      updateTrack(trackId, patch) {
        const keys = Object.keys(patch);
        const label =
          keys.length === 1 && keys[0] === 'locked'
            ? patch.locked
              ? 'Lock track'
              : 'Unlock track'
            : 'Edit track';
        commit(label, updateTrackOp(get().project, trackId, patch), {
          coalesceKey: keys.some((k) => k === 'gain') ? `track:${trackId}:gain` : undefined,
        });
      },

      /* ---------------- items ---------------- */
      addItem(item, o) {
        const s = get();
        const r = addItemOp(s.project, item, { trackId: o?.trackId });
        if (r.itemId)
          commit('Add item', r.project, { selection: selectIds([r.itemId], r.project, r.trackId) });
        return r.itemId ?? '';
      },
      addAsset(assetId, o) {
        const s = get();
        const r = addAssetOp(s.project, assetId, {
          trackId: o?.trackId,
          startSec: o?.startSec ?? s.playheadSec,
          scope: scopeFor(o?.ripple),
        });
        if (!r.itemId) return null;
        commit('Add clip', r.project, { selection: selectIds([r.itemId], r.project, r.trackId) });
        return r.itemId;
      },
      previewMove(itemIds, deltaSec, targetTrackId, o) {
        return previewMoveOp(get().project, itemIds, deltaSec, targetTrackId, snapCtx(o));
      },
      applyMoves(moves, o) {
        commit('Move', applyMovesOp(get().project, moves, { insert: o?.ripple === true }));
      },
      trim(itemId, edge, toSec, o) {
        const s = get();
        const loc = locate(s.project, itemId);
        if (!loc) return;
        const sec = actions.previewTrim(itemId, edge, toSec, o).sec;
        const next = trimOp(s.project, itemId, edge, sec, {
          ripple: scopeFor(o?.ripple),
          roll: o?.roll,
        });
        commit(o?.roll ? 'Roll edit' : edge === 'start' ? 'Trim start' : 'Trim end', next, {
          coalesceKey: `trim:${itemId}:${edge}`,
        });
      },
      previewTrim(itemId, edge, toSec, o) {
        const s = get();
        const none = { sec: toSec, snappedTo: null, snapKind: null as SnapKind | null };
        if (!(o?.snap ?? s.snapEnabled)) return none;
        const loc = locate(s.project, itemId);
        if (!loc) return none;
        const exclude = new Set([itemId]);
        if (o?.roll) {
          const nb = loc.track.items[edge === 'end' ? loc.i + 1 : loc.i - 1];
          if (nb) exclude.add(nb.id);
        }
        const hit = snapTime(s.project, toSec, {
          playhead: s.playheadSec,
          pxPerSec: o?.pxPerSec ?? s.pxPerSec,
          fps: s.project.canvas.fps,
          exclude,
        });
        return hit ? { sec: hit.t, snappedTo: hit.t, snapKind: hit.kind } : none;
      },
      split(itemId, atSec) {
        const s = get();
        const at = atSec ?? s.playheadSec;
        let targets: string[];
        if (itemId) {
          targets = expandGroups(s.project, [itemId]).filter((id) => {
            const l = locate(s.project, id);
            return l ? crosses(l.item, at) : false;
          });
        } else {
          const sel = new Set(expandGroups(s.project, s.selection.itemIds));
          targets = [];
          for (const tr of s.project.tracks)
            for (const it of tr.items) if (sel.has(it.id) && crosses(it, at)) targets.push(it.id);
          if (!targets.length) {
            const tracks = s.project.tracks.filter((t) => !t.locked);
            const preferred = tracks.find((t) => t.id === s.selection.trackId);
            for (const tr of preferred
              ? [preferred, ...tracks.filter((x) => x !== preferred)]
              : tracks) {
              const hit = tr.items.find((it) => crosses(it, at));
              if (hit) {
                targets = expandGroups(s.project, [hit.id]).filter((id) => {
                  const l = locate(s.project, id);
                  return l ? crosses(l.item, at) : false;
                });
                break;
              }
            }
          }
        }
        if (!targets.length) return [];
        const r = splitOp(s.project, targets, at);
        commit('Split', r.project);
        return r.newIds;
      },
      deleteItems(itemIds, o) {
        commit('Delete', deleteItemsOp(get().project, itemIds, scopeFor(o?.ripple)));
      },
      deleteGaps(trackId) {
        commit('Delete gaps', deleteGapsOp(get().project, trackId));
      },
      duplicateItems(itemIds) {
        const s = get();
        const r = duplicateOp(s.project, itemIds);
        if (!r.newIds.length) return [];
        commit('Duplicate', r.project, { selection: selectIds(r.newIds, r.project) });
        return r.newIds;
      },
      group(itemIds) {
        commit('Group', groupOp(get().project, itemIds));
      },
      ungroup(itemIds) {
        commit('Ungroup', ungroupOp(get().project, itemIds));
      },
      copy() {
        const s = get();
        const data = copyOp(s.project, s.selection.itemIds);
        if (data) set({ clipboard: data });
      },
      cut() {
        const s = get();
        const data = copyOp(s.project, s.selection.itemIds);
        if (!data) return;
        set({ clipboard: data });
        commit('Cut', deleteItemsOp(s.project, s.selection.itemIds, scopeFor(undefined)));
      },
      paste() {
        const s = get();
        if (!s.clipboard) return [];
        const r = pasteOp(
          s.project,
          s.clipboard as ClipboardData,
          s.playheadSec,
          s.selection.trackId,
        );
        if (!r.newIds.length) return [];
        commit('Paste', r.project, { selection: selectIds(r.newIds, r.project) });
        return r.newIds;
      },
      updateItem(itemId, patch, o) {
        const s = get();
        const raw = patch as Record<string, unknown>;
        let next = s.project;
        let rest = patch;
        if ('transitionIn' in raw) {
          const { transitionIn: _drop, ...others } = raw;
          rest = others as typeof patch;
        }
        next = updateItemsOp(next, [itemId], rest);
        if ('transitionIn' in raw) {
          const tin = raw.transitionIn as Partial<ItemTransition> | null | undefined;
          if (tin === null) next = setTransitionOp(next, itemId, null, s.rippleEnabled);
          else if (tin) {
            const l = locate(next, itemId);
            const cur = l && 'transitionIn' in l.item ? l.item.transitionIn : null;
            const merged = {
              type: 'crossfade',
              durationSec: 0.5,
              ...(cur ?? {}),
              ...tin,
            } as ItemTransition;
            next = setTransitionOp(next, itemId, merged, s.rippleEnabled);
          }
        }
        commit(o?.label ?? 'Edit', next, { coalesceKey: o?.coalesceKey });
      },
      setProp(itemId, path, value, o) {
        const s = get();
        const l = locate(s.project, itemId);
        if (!l) return;
        commit(
          'Edit property',
          setPropOp(s.project, itemId, path, value, s.playheadSec - l.item.startSec, {
            forceKeyframe: o?.forceKeyframe,
            ease: o?.ease,
          }),
          { coalesceKey: o?.coalesceKey },
        );
      },
      addKeyframe(itemId, path, tLocal, value, ease) {
        const s = get();
        const r = addKeyframeOp(s.project, itemId, path, tLocal, value, ease);
        if (r.index < 0) return;
        commit('Add keyframe', r.project, {
          selection: { ...s.selection, keyframe: { itemId, prop: path, index: r.index } },
        });
      },
      moveKeyframe(itemId, path, index, tLocal, value) {
        const s = get();
        const r = moveKeyframeOp(s.project, itemId, path, index, tLocal, value);
        const k = s.selection.keyframe;
        const same = k && k.itemId === itemId && k.prop === path && k.index === index;
        commit('Move keyframe', r.project, {
          coalesceKey: `mkf:${itemId}:${path}`,
          selection: same
            ? { ...s.selection, keyframe: { itemId, prop: path, index: r.index } }
            : undefined,
        });
      },
      setKeyframeEase(itemId, path, index, ease) {
        commit('Keyframe easing', setKeyframeEaseOp(get().project, itemId, path, index, ease));
      },
      removeKeyframe(itemId, path, index) {
        const s = get();
        const k = s.selection.keyframe;
        commit('Delete keyframe', removeKeyframeOp(s.project, itemId, path, index), {
          selection:
            k && k.itemId === itemId && k.prop === path
              ? { ...s.selection, keyframe: null }
              : undefined,
        });
      },
      clearKeyframes(itemId, path) {
        const s = get();
        const l = locate(s.project, itemId);
        if (!l) return;
        const k = s.selection.keyframe;
        commit(
          'Clear keyframes',
          clearKeyframesOp(s.project, itemId, path, s.playheadSec - l.item.startSec),
          {
            selection:
              k && k.itemId === itemId && k.prop === path
                ? { ...s.selection, keyframe: null }
                : undefined,
          },
        );
      },
      setTransition(itemId, transition) {
        const s = get();
        commit(
          transition ? 'Set transition' : 'Remove transition',
          setTransitionOp(s.project, itemId, transition, s.rippleEnabled),
        );
      },
      setSpeed(itemId, speed, o) {
        commit(
          'Change speed',
          setSpeedOp(get().project, itemId, speed, {
            keepDuration: o?.keepDuration,
            ripple: scopeFor(undefined),
          }),
          {
            coalesceKey: `speed:${itemId}`,
          },
        );
      },
      freezeFrame(itemId, atSec, holdSec) {
        const s = get();
        const r = freezeFrameOp(
          s.project,
          itemId,
          atSec,
          holdSec,
          s.rippleEnabled ? 'all' : 'track',
        );
        commit('Freeze frame', r.project);
      },
      updateItems(itemIds, patch, o) {
        commit(o?.label ?? 'Edit items', updateItemsOp(get().project, itemIds, patch));
      },

      /* ---------------- subtitles ---------------- */
      setCueText(itemId, text) {
        commit('Edit caption', setCueTextOp(get().project, itemId, text), {
          coalesceKey: `cue:${itemId}`,
        });
      },
      splitCue(itemId, atWordIndex) {
        const r = splitCueOp(get().project, itemId, atWordIndex);
        commit('Split caption', r.project);
        return r.newId;
      },
      mergeCueWithNext(itemId) {
        commit('Merge captions', mergeCueWithNextOp(get().project, itemId));
      },
      retimeCue(itemId, startSec, endSec) {
        commit('Retime caption', retimeCueOp(get().project, itemId, startSec, endSec), {
          coalesceKey: `retime:${itemId}`,
        });
      },
      replaceCues(trackId, cues) {
        commit('Replace captions', replaceCuesOp(get().project, trackId, cues));
      },

      /* ---------------- assets / canvas / markers ---------------- */
      addAssets(assets) {
        commit('Add media', addAssetsOp(get().project, assets));
      },
      updateAsset(assetId, patch) {
        commit('Edit media', updateAssetOp(get().project, assetId, patch));
      },
      setCanvas(patch) {
        commit('Canvas', setCanvasOp(get().project, patch));
      },
      addMarker(atSec, label) {
        const s = get();
        const half = 0.5 / s.project.canvas.fps;
        const r = addMarkerOp(s.project, atSec ?? s.playheadSec, label, half);
        commit('Add marker', r.project);
        return r.id;
      },
      updateMarker(id, patch) {
        commit('Edit marker', updateMarkerOp(get().project, id, patch), {
          coalesceKey: `marker:${id}`,
        });
      },
      removeMarker(id) {
        commit('Delete marker', removeMarkerOp(get().project, id));
      },

      /* ---------------- history ---------------- */
      undo() {
        const snap = history.undo();
        if (!snap) return;
        const s = get();
        set({
          project: snap.project,
          selection: pruneSelection(snap.selection, snap.project),
          ...histFlags(),
          saveState: nextSaveState(s, snap.project),
        });
      },
      redo() {
        const snap = history.redo();
        if (!snap) return;
        const s = get();
        set({
          project: snap.project,
          selection: pruneSelection(snap.selection, snap.project),
          ...histFlags(),
          saveState: nextSaveState(s, snap.project),
        });
      },

      /* ---------------- extras ---------------- */
      jumpToEdit(direction) {
        const s = get();
        const pts = baseSnapPoints(s.project);
        const end = projectDuration(s.project);
        const t = s.playheadSec;
        const eps = 0.5 / s.project.canvas.fps / 2;
        let best: number | null = null;
        const consider = (v: number) => {
          if (direction > 0 ? v > t + eps : v < t - eps) {
            if (best === null || (direction > 0 ? v < best : v > best)) best = v;
          }
        };
        for (const p of pts) consider(p.t);
        consider(end);
        if (best !== null) set({ playheadSec: best, playing: false, rate: 1 });
      },
      trimToPlayhead(edge, o) {
        const s = get();
        const targets = targetsAtPlayhead();
        if (!targets.length) return;
        const scope = scopeFor(o?.ripple);
        let next = s.project;
        for (const id of targets) next = trimOp(next, id, edge, s.playheadSec, { ripple: scope });
        commit(o?.ripple ? `Ripple trim ${edge}` : `Trim ${edge} to playhead`, next);
      },
      freezeAtPlayhead(holdSec = 2) {
        const s = get();
        const target = targetsAtPlayhead((it) => it.type === 'video')[0];
        if (!target) return;
        const r = freezeFrameOp(
          s.project,
          target,
          s.playheadSec,
          holdSec,
          s.rippleEnabled ? 'all' : 'track',
        );
        commit('Freeze frame', r.project);
      },
      nudgeSelected(frames) {
        const s = get();
        if (!s.selection.itemIds.length || !frames) return;
        const prev = previewMoveOp(
          s.project,
          s.selection.itemIds,
          frames / s.project.canvas.fps,
          null,
          {
            enabled: false,
            playhead: s.playheadSec,
            pxPerSec: s.pxPerSec,
            fps: s.project.canvas.fps,
          },
        );
        if (!prev.valid) return;
        commit('Nudge', applyMovesOp(s.project, prev.moves), { coalesceKey: 'nudge' });
      },
      deleteSelection(o) {
        const s = get();
        const k = s.selection.keyframe;
        if (k && s.selection.itemIds.includes(k.itemId)) {
          actions.removeKeyframe(k.itemId, k.prop as AnimatedPath, k.index);
          return;
        }
        if (s.selection.itemIds.length) actions.deleteItems(s.selection.itemIds, o);
      },
      replaceProject(label, next) {
        return commit(label, next);
      },
    };

    return { ...state, ...actions };
  };
}

/** A fresh, independent store instance (no React needed) — used by tests and by anything that wants a second editor. */
export function createEditorStore(opts: StoreOptions = {}): StoreApi<FullEditorStore> {
  return createStore<FullEditorStore>()(initializer(opts));
}

/** The app's editor store hook. */
export const useEditorStore: UseBoundStore<StoreApi<FullEditorStore>> = create<FullEditorStore>()(
  initializer({}),
);
