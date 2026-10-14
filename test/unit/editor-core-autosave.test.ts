import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@shared/editor';
import type { AutosaveDeps } from '../../renderer/lib/editor/core';
import { A, T, V, item, makeStore, proj, track } from './editor-core-fixtures';

const base = () => proj([track('v1', 'video', [V('a', 0, 5), V('b', 5, 5)]), track('m', 'audio', [A('m1', 0, 20)])]);

type SaveArgs = Parameters<AutosaveDeps['save']>[0];
function mockSave(impl?: (args: SaveArgs, n: number) => Promise<{ rev: number; updatedAt: number }>) {
  let n = 0;
  const calls: SaveArgs[] = [];
  const save = vi.fn(async (args: SaveArgs) => {
    calls.push(args);
    n++;
    if (impl) return impl(args, n);
    return { rev: args.baseRev + 1, updatedAt: 1000 + n };
  });
  return { save, calls };
}
const conflict = () => Object.assign(new Error('revision conflict'), { code: 'CONFLICT' });

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('autosave', () => {
  it('does nothing while the document is clean', async () => {
    const st = makeStore(base());
    const { save } = mockSave();
    const stop = st.getState().startAutosave({ save });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(save).not.toHaveBeenCalled();
    expect(st.getState().saveState).toBe('idle');
    stop();
  });

  it('saves 5 s after an edit with the baseRev and updates rev / lastSavedAt; idle → dirty → saving → saved', async () => {
    const st = makeStore(base(), { rev: 3 });
    const seen: string[] = [];
    st.subscribe((s, prev) => {
      if (s.saveState !== prev.saveState) seen.push(s.saveState);
    });
    const { save, calls } = mockSave();
    const stop = st.getState().startAutosave({ save });
    st.getState().deleteItems(['b']);
    expect(st.getState().saveState).toBe('dirty');
    await vi.advanceTimersByTimeAsync(4_900);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(save).toHaveBeenCalledTimes(1);
    expect(calls[0]).toMatchObject({ id: 'proj1', baseRev: 3 });
    expect(calls[0]?.project).toBe(st.getState().project);
    expect(seen).toEqual(['dirty', 'saving', 'saved']);
    expect(st.getState().rev).toBe(4);
    expect(st.getState().lastSavedAt).toBe(1001);
    expect(st.getState().saveError).toBeNull();
    // clean again → no more saves
    await vi.advanceTimersByTimeAsync(30_000);
    expect(save).toHaveBeenCalledTimes(1);
    stop();
  });

  it('uses the latest rev as baseRev for the next save', async () => {
    const st = makeStore(base(), { rev: 1 });
    const { save, calls } = mockSave();
    const stop = st.getState().startAutosave({ save });
    st.getState().deleteItems(['b']);
    await vi.advanceTimersByTimeAsync(5_000);
    st.getState().deleteItems(['a']);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls.map((c) => c.baseRev)).toEqual([1, 2]);
    stop();
  });

  it('respects intervalMs', async () => {
    const st = makeStore(base());
    const { save } = mockSave();
    const stop = st.getState().startAutosave({ save, intervalMs: 1000 });
    st.getState().deleteItems(['b']);
    await vi.advanceTimersByTimeAsync(1_050);
    expect(save).toHaveBeenCalledTimes(1);
    stop();
  });

  it('does not start a second save while one is in flight; edits made meanwhile leave it dirty', async () => {
    const st = makeStore(base());
    let release: () => void = () => undefined;
    const { save } = mockSave(
      (args) => new Promise((res) => (release = () => res({ rev: args.baseRev + 1, updatedAt: 5 }))),
    );
    const stop = st.getState().startAutosave({ save, intervalMs: 1000 });
    st.getState().deleteItems(['b']);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(st.getState().saveState).toBe('saving');
    st.getState().deleteItems(['a']); // edit during the save
    expect(st.getState().saveState).toBe('saving');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(save).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(st.getState().saveState).toBe('dirty');
    expect(st.getState().rev).toBe(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(save).toHaveBeenCalledTimes(2);
    stop();
  });

  it('a CONFLICT sets saveState "conflict", calls onConflict and stops autosaving', async () => {
    const st = makeStore(base());
    const onConflict = vi.fn();
    const { save } = mockSave(async () => {
      throw conflict();
    });
    const stop = st.getState().startAutosave({ save, onConflict, intervalMs: 1000 });
    st.getState().deleteItems(['b']);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(st.getState().saveState).toBe('conflict');
    expect(onConflict).toHaveBeenCalledTimes(1);
    expect(st.getState().saveError).toMatch(/conflict/i);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(save).toHaveBeenCalledTimes(1);
    st.getState().deleteItems(['a']); // further edits keep the state
    expect(st.getState().saveState).toBe('conflict');
    stop();
  });

  it('a CONFLICT is also recognised from the message', async () => {
    const st = makeStore(base());
    const { save } = mockSave(async () => {
      throw new Error('CONFLICT: stored revision is 9');
    });
    const stop = st.getState().startAutosave({ save, intervalMs: 1000 });
    st.getState().deleteItems(['b']);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(st.getState().saveState).toBe('conflict');
    stop();
  });

  it('resolveConflict adopts the server rev and autosave resumes', async () => {
    const st = makeStore(base(), { rev: 1 });
    let fail = true;
    const { save, calls } = mockSave(async (args) => {
      if (fail) throw conflict();
      return { rev: args.baseRev + 1, updatedAt: 9 };
    });
    const stop = st.getState().startAutosave({ save, intervalMs: 1000 });
    st.getState().deleteItems(['b']);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(st.getState().saveState).toBe('conflict');
    fail = false;
    st.getState().resolveConflict(7);
    expect(st.getState().saveState).toBe('dirty');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls.at(-1)?.baseRev).toBe(7);
    expect(st.getState().saveState).toBe('saved');
    expect(st.getState().rev).toBe(8);
    stop();
  });

  it('other errors → "error", then retries on the next tick and recovers', async () => {
    const st = makeStore(base());
    let fails = 2;
    const { save } = mockSave(async (args) => {
      if (fails-- > 0) throw new Error('network down');
      return { rev: args.baseRev + 1, updatedAt: 3 };
    });
    const stop = st.getState().startAutosave({ save, intervalMs: 1000 });
    st.getState().deleteItems(['b']);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(st.getState().saveState).toBe('error');
    expect(st.getState().saveError).toBe('network down');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(st.getState().saveState).toBe('error');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(st.getState().saveState).toBe('saved');
    expect(st.getState().saveError).toBeNull();
    expect(save).toHaveBeenCalledTimes(3);
    stop();
  });

  it('saveNow saves immediately, even between ticks, and returns after completion', async () => {
    const st = makeStore(base());
    const { save } = mockSave();
    const stop = st.getState().startAutosave({ save });
    st.getState().deleteItems(['b']);
    await st.getState().saveNow();
    expect(save).toHaveBeenCalledTimes(1);
    expect(st.getState().saveState).toBe('saved');
    await st.getState().saveNow(); // clean → nothing to do
    expect(save).toHaveBeenCalledTimes(1);
    stop();
  });

  it('saveNow waits for an in-flight save and then saves newer edits', async () => {
    const st = makeStore(base());
    const releases: (() => void)[] = [];
    const { save } = mockSave((args) => new Promise((res) => releases.push(() => res({ rev: args.baseRev + 1, updatedAt: 1 }))));
    const stop = st.getState().startAutosave({ save, intervalMs: 1000 });
    st.getState().deleteItems(['b']);
    await vi.advanceTimersByTimeAsync(1_000);
    st.getState().deleteItems(['a']);
    const p = st.getState().saveNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledTimes(1);
    releases[0]?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledTimes(2);
    releases[1]?.();
    await p;
    expect(st.getState().saveState).toBe('saved');
    stop();
  });

  it('undoing back to the saved state returns to "saved"', async () => {
    const st = makeStore(base());
    const { save } = mockSave();
    const stop = st.getState().startAutosave({ save, intervalMs: 1000 });
    st.getState().deleteItems(['b']);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(st.getState().saveState).toBe('saved');
    st.getState().deleteItems(['a']);
    expect(st.getState().saveState).toBe('dirty');
    st.getState().undo();
    expect(st.getState().saveState).toBe('saved');
    st.getState().undo(); // before the saved state
    expect(st.getState().saveState).toBe('dirty');
    stop();
  });

  it('stop() ends the loop', async () => {
    const st = makeStore(base());
    const { save } = mockSave();
    const stop = st.getState().startAutosave({ save, intervalMs: 1000 });
    stop();
    st.getState().deleteItems(['b']);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(save).not.toHaveBeenCalled();
  });

  it('load() while a save is in flight ignores the stale completion', async () => {
    const st = makeStore(base());
    let release: () => void = () => undefined;
    const { save } = mockSave((args) => new Promise((res) => (release = () => res({ rev: 99, updatedAt: 99 }))));
    const stop = st.getState().startAutosave({ save, intervalMs: 1000 });
    st.getState().deleteItems(['b']);
    await vi.advanceTimersByTimeAsync(1_000);
    st.getState().load({ id: 'other', name: 'o', rev: 2, project: proj([track('v1', 'video', [])]), updatedAt: 5 });
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(st.getState().rev).toBe(2);
    expect(st.getState().saveState).toBe('idle');
    stop();
  });

  it('does not save when no project is loaded', async () => {
    const { createEditorStore } = await import('../../renderer/lib/editor/core');
    const st = createEditorStore();
    const { save } = mockSave();
    const stop = st.getState().startAutosave({ save, intervalMs: 1000 });
    st.getState().addMarker(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(save).not.toHaveBeenCalled();
    stop();
  });

  it('saves exactly the project object it reports (what the server gets is what the UI had)', async () => {
    const st = makeStore(base());
    let sent: Project | null = null;
    const stop = st.getState().startAutosave({
      intervalMs: 1000,
      save: async (a) => {
        sent = a.project;
        return { rev: 2, updatedAt: 1 };
      },
    });
    st.getState().updateItem('a', { fit: 'native' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect((item(sent as unknown as Project, 'a') as { fit: string }).fit).toBe('native');
    stop();
    void T;
  });
});
