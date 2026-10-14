'use client';

import * as React from 'react';
import { handleKey, useEditorStore } from '@/lib/editor/core';
import { getEngine } from '@/lib/editor/playback';
import { IpcCallError, ipc } from '@/lib/ipc';
import { useTimelineUi } from '@/components/editor/timeline/timeline-ui';

export type SessionStatus =
  { phase: 'loading' } | { phase: 'ready' } | { phase: 'error'; message: string; code: string };

/** Anything that is not safely on disk. */
const UNSAFE = new Set(['error', 'conflict']);
const PENDING = new Set(['dirty', 'saving', 'error', 'conflict']);

declare global {
  interface Window {
    /** Test hook: when a test sets this flag the editor store is exposed for state assertions. Never set in production. */
    __CLIPFERN_E2E__?: boolean;
    __clipfernEditorStore?: typeof useEditorStore;
  }
}

/**
 * Loads a project (`editor:get` -> store.load), runs the 5 s autosave, warms the playback engine, and guards leaving:
 * the pending state is flushed on unmount, and the window is blocked from closing silently only when a save has FAILED.
 */
export function useEditorSession(projectId: string) {
  const [status, setStatus] = React.useState<SessionStatus>({ phase: 'loading' });
  const [conflict, setConflict] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);

  /* ---- load + autosave --------------------------------------------------------------- */
  React.useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | null = null;
    (async () => {
      try {
        const doc = await ipc.invoke('editor:get', { id: projectId });
        if (cancelled) return;
        const s = useEditorStore.getState();
        s.load(doc);
        useTimelineUi.getState().clearInteraction();
        stop = s.startAutosave({
          save: async (args) => {
            try {
              return await ipc.invoke('editor:save', args);
            } catch (e) {
              if (e instanceof IpcCallError && e.code === 'CONFLICT') setConflict(true);
              throw e;
            }
          },
          onConflict: () => setConflict(true),
        });
        if (window.__CLIPFERN_E2E__) window.__clipfernEditorStore = useEditorStore;
        setStatus({ phase: 'ready' });
      } catch (e) {
        if (cancelled) return;
        const err =
          e instanceof IpcCallError
            ? e
            : new IpcCallError(
                'FAILED',
                e instanceof Error ? e.message : 'Could not open the project.',
              );
        setStatus({ phase: 'error', message: err.message, code: err.code });
      }
    })();
    return () => {
      cancelled = true;
      const st = useEditorStore.getState();
      if (st.projectId === projectId) {
        st.pause();
        // flush on leave, BEFORE the autosave loop is stopped (stopping drops the save dependency); the IPC call
        // outlives the unmounted page
        if (PENDING.has(st.saveState) && st.saveState !== 'conflict')
          void st.saveNow().catch(() => {});
      }
      stop?.();
    };
  }, [projectId, attempt]);

  const reload = React.useCallback(() => {
    setStatus({ phase: 'loading' });
    setConflict(false);
    setAttempt((n) => n + 1);
  }, []);

  /* ---- playback engine ---------------------------------------------------------------- */
  // The preview panel creates + attaches the engine when it mounts; the shell only makes sure media is warming up
  // (idempotent), retrying for a moment because the panel mounts a frame after the project loads.
  React.useEffect(() => {
    if (status.phase !== 'ready') return;
    let tries = 0;
    let timer = 0;
    const kick = () => {
      const engine = getEngine();
      if (engine) engine.warmup();
      else if (tries++ < 40) timer = window.setTimeout(kick, 50);
    };
    kick();
    return () => window.clearTimeout(timer);
  }, [status.phase, projectId]);

  /* ---- unsaved-changes guard ---------------------------------------------------------- */
  React.useEffect(() => {
    if (status.phase !== 'ready') return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const st = useEditorStore.getState();
      if (!PENDING.has(st.saveState)) return;
      // try to get the latest edits to disk right now; only block closing when that cannot work (failed save / conflict)
      if (!UNSAFE.has(st.saveState)) void st.saveNow().catch(() => {});
      else {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [status.phase]);

  /* ---- conflict resolution ------------------------------------------------------------ */
  const resolveConflict = React.useCallback(
    async (choice: 'reload' | 'keep-mine') => {
      const s = useEditorStore.getState();
      const doc = await ipc.invoke('editor:get', { id: projectId });
      if (choice === 'reload') {
        s.load(doc);
      } else {
        // adopt the other window's revision, then save our version on top of it
        s.resolveConflict(doc.rev);
        await useEditorStore.getState().saveNow();
        if (useEditorStore.getState().saveState === 'error')
          throw new Error(useEditorStore.getState().saveError ?? 'Could not save.');
      }
      setConflict(false);
    },
    [projectId],
  );

  return { status, conflict, reload, resolveConflict };
}

/** Global key handling for the editor: core's SHORTCUTS map, plus `?` (overlay) and the tool keys. */
export function useEditorKeys(opts: { toggleShortcuts: () => void }) {
  const { toggleShortcuts } = opts;
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      if (typing) return;
      // dialogs, menus, popovers and selects own the keyboard while open (Esc is theirs too)
      if (
        document.querySelector(
          '[role=dialog][data-state=open], [role=alertdialog], [role=menu], [data-slot=popover-content][data-state=open], [data-radix-select-content]',
        )
      )
        return;
      const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
      if (e.key === '?' && plain) {
        e.preventDefault();
        toggleShortcuts();
        return;
      }
      // Space / Enter on a focused control activate THAT control (never play / pause)
      const control = t?.closest(
        'button, [role=button], [role=switch], [role=menuitem], [role=checkbox], [role=tab], [role=radio], a[href]',
      );
      if (control && (e.key === ' ' || e.key === 'Enter')) return;
      if (handleKey(e, useEditorStore.getState())) {
        e.preventDefault();
        return;
      }
      if (plain && !e.shiftKey) {
        const k = e.key.toLowerCase();
        const ui = useTimelineUi.getState();
        if (k === 'c') {
          e.preventDefault();
          ui.set({ tool: ui.tool === 'razor' ? 'select' : 'razor', razor: null });
        } else if (k === 'v') {
          e.preventDefault();
          ui.set({ tool: 'select', razor: null });
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleShortcuts]);
}
