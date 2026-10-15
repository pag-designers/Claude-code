import { describe, expect, it, vi } from 'vitest';
import type { VideoItem } from '@shared/editor';
import {
  SHORTCUTS,
  handleKey,
  matchShortcut,
  useEditorStore,
  type KeyEventLike,
} from '../../renderer/lib/editor/core';
import { BOUND_SHORTCUT_IDS } from '../../renderer/lib/editor/core/shortcuts';
import { A, T, V, item, items, makeStore, proj, spans, track } from './editor-core-fixtures';

const base = () =>
  proj([
    track('v1', 'video', [V('a', 0, 5), V('b', 5, 5, { inSec: 10 })]),
    track('m', 'audio', [A('m1', 0, 20)]),
    track('t', 'text', [T('t1', 1, 2)]),
  ]);

const key = (k: string, o: Partial<KeyEventLike> = {}): KeyEventLike & { prevented: boolean } => {
  const e = {
    key: k,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    prevented: false,
    preventDefault() {
      e.prevented = true;
    },
    ...o,
  };
  return e;
};
const press = (st: ReturnType<typeof makeStore>, k: string, o: Partial<KeyEventLike> = {}) => {
  const e = key(k, o);
  const handled = handleKey(e, st.getState());
  return { handled, e };
};

describe('SHORTCUTS table', () => {
  it('ids are unique, every shortcut is bound, every binding is documented', () => {
    const ids = SHORTCUTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...BOUND_SHORTCUT_IDS].sort()).toEqual([...ids].sort());
  });

  it('has the required groups and the help entry', () => {
    const groups = new Set(SHORTCUTS.map((s) => s.group));
    for (const g of ['Transport', 'Edit', 'Selection', 'Timeline', 'View', 'Project'])
      expect(groups.has(g as never)).toBe(true);
    expect(SHORTCUTS.find((s) => s.id === 'help')?.keys).toEqual(['?']);
    for (const s of SHORTCUTS) {
      expect(s.keys.length).toBeGreaterThan(0);
      expect(s.label.length).toBeGreaterThan(2);
    }
  });

  it('documents the required keys', () => {
    const k = (id: string) => SHORTCUTS.find((s) => s.id === id)?.keys.join('+');
    expect(k('play-pause')).toBe('Space');
    expect(k('split')).toBe('S');
    expect(k('undo')).toBe('⌘+Z');
    expect(k('redo')).toBe('⌘+Shift+Z');
    expect(k('ripple-delete')).toBe('Shift+Delete');
    expect(k('group')).toBe('⌘+G');
    expect(k('ungroup')).toBe('⌘+Shift+G');
    expect(k('zoom-fit')).toBe('Shift+Z');
    expect(k('save')).toBe('⌘+S');
  });
});

describe('handleKey — transport', () => {
  it('Space toggles play', () => {
    const st = makeStore(base());
    expect(press(st, ' ').handled).toBe(true);
    expect(st.getState().playing).toBe(true);
    expect(press(st, ' ', { code: 'Space' }).e.prevented).toBe(true);
    expect(st.getState().playing).toBe(false);
  });

  it('J / K / L shuttle', () => {
    const st = makeStore(base());
    st.getState().setPlayhead(5);
    press(st, 'l');
    press(st, 'L');
    expect(st.getState().rate).toBe(2);
    press(st, 'k');
    expect(st.getState().playing).toBe(false);
    press(st, 'j');
    expect(st.getState().rate).toBe(-1);
  });

  it('arrows step frames, Shift steps 10', () => {
    const st = makeStore(base());
    press(st, 'ArrowRight');
    expect(st.getState().playheadSec).toBeCloseTo(1 / 30);
    press(st, 'ArrowRight', { shiftKey: true });
    expect(st.getState().playheadSec).toBeCloseTo(11 / 30);
    press(st, 'ArrowLeft');
    expect(st.getState().playheadSec).toBeCloseTo(10 / 30);
    press(st, 'ArrowLeft', { shiftKey: true });
    expect(st.getState().playheadSec).toBe(0);
  });

  it('Home / End', () => {
    const st = makeStore(base());
    press(st, 'End');
    expect(st.getState().playheadSec).toBe(20);
    press(st, 'Home');
    expect(st.getState().playheadSec).toBe(0);
  });

  it('↑ / ↓ jump between edit points', () => {
    const st = makeStore(base());
    press(st, 'ArrowDown');
    expect(st.getState().playheadSec).toBe(1);
    press(st, 'ArrowUp');
    expect(st.getState().playheadSec).toBe(0);
  });

  it('held keys: arrows repeat, toggles do not', () => {
    const st = makeStore(base());
    press(st, 'ArrowRight', { repeat: true });
    press(st, 'ArrowRight', { repeat: true });
    expect(st.getState().playheadSec).toBeCloseTo(2 / 30);
    press(st, ' ', { repeat: true });
    expect(st.getState().playing).toBe(false);
  });
});

describe('handleKey — editing', () => {
  it('S splits at the playhead', () => {
    const st = makeStore(base());
    st.getState().setPlayhead(2);
    st.getState().select(['a']);
    press(st, 's');
    expect(spans(st.getState().project, 'v1')).toEqual([
      [0, 2],
      [2, 5],
      [5, 10],
    ]);
  });

  it('Delete / Backspace delete; Shift+Delete ripple deletes', () => {
    const st = makeStore(base());
    st.getState().select(['a']);
    press(st, 'Delete');
    expect(items(st.getState().project, 'v1').map((i) => i.id)).toEqual(['b']);
    expect(item(st.getState().project, 'b').startSec).toBe(5);
    st.getState().undo();
    st.getState().select(['a']);
    press(st, 'Delete', { shiftKey: true });
    expect(item(st.getState().project, 'b').startSec).toBe(0);
    st.getState().undo();
    st.getState().select(['b']);
    press(st, 'Backspace');
    expect(items(st.getState().project, 'v1').length).toBe(1);
  });

  it('Ctrl/⌘ + Z undoes, Ctrl/⌘ + Shift + Z (and Ctrl+Y) redo', () => {
    const st = makeStore(base());
    st.getState().select(['a']);
    press(st, 'Delete');
    press(st, 'z', { ctrlKey: true });
    expect(items(st.getState().project, 'v1').length).toBe(2);
    press(st, 'Z', { metaKey: true, shiftKey: true });
    expect(items(st.getState().project, 'v1').length).toBe(1);
    press(st, 'z', { metaKey: true });
    press(st, 'y', { ctrlKey: true });
    expect(items(st.getState().project, 'v1').length).toBe(1);
  });

  it('copy / cut / paste / duplicate', () => {
    const st = makeStore(base());
    st.getState().select(['b']);
    press(st, 'c', { ctrlKey: true });
    expect(st.getState().clipboard?.items[0]?.id).toBe('b');
    st.getState().setPlayhead(30);
    press(st, 'v', { ctrlKey: true });
    expect(items(st.getState().project, 'v1').length).toBe(3);
    st.getState().select(['a']);
    press(st, 'x', { metaKey: true });
    expect(st.getState().clipboard?.items[0]?.id).toBe('a');
    expect(items(st.getState().project, 'v1').length).toBe(2);
    st.getState().select(['b']);
    press(st, 'd', { ctrlKey: true });
    expect(items(st.getState().project, 'v1').length).toBe(3);
  });

  it('Ctrl+G groups, Ctrl+Shift+G ungroups', () => {
    const st = makeStore(base());
    st.getState().select(['a', 'b']);
    press(st, 'g', { ctrlKey: true });
    expect(item(st.getState().project, 'a').groupId).toBeTruthy();
    press(st, 'G', { ctrlKey: true, shiftKey: true });
    expect(item(st.getState().project, 'a').groupId).toBeNull();
  });

  it('M adds a marker, N toggles snap, R toggles ripple, Ctrl+A selects all, Esc clears', () => {
    const st = makeStore(base());
    st.getState().setPlayhead(3);
    press(st, 'm');
    expect(st.getState().project.markers[0]?.atSec).toBe(3);
    press(st, 'n');
    expect(st.getState().snapEnabled).toBe(false);
    press(st, 'r');
    expect(st.getState().rippleEnabled).toBe(true);
    press(st, 'a', { ctrlKey: true });
    expect(st.getState().selection.itemIds.length).toBe(4);
    press(st, 'Escape');
    expect(st.getState().selection.itemIds.length).toBe(0);
  });

  it('[ and ] trim to the playhead; Q / W ripple trim', () => {
    const st = makeStore(base());
    st.getState().setPlayhead(2);
    st.getState().select(['a']);
    press(st, '[');
    expect(item(st.getState().project, 'a').startSec).toBe(2);
    st.getState().setPlayhead(4);
    press(st, ']');
    expect(item(st.getState().project, 'a').durationSec).toBe(2);
    st.getState().setPlayhead(3);
    st.getState().select(['b']);
    st.getState().setPlayhead(7);
    press(st, 'w');
    expect(spans(st.getState().project, 'v1').at(-1)).toEqual([5, 7]);
    press(st, 'z', { ctrlKey: true });
    st.getState().setPlayhead(7);
    press(st, 'q');
    expect(item(st.getState().project, 'b').startSec).toBe(5);
    expect(item(st.getState().project, 'b').durationSec).toBe(3);
  });

  it('F freezes the frame at the playhead', () => {
    const st = makeStore(base());
    st.getState().setPlayhead(2);
    st.getState().select(['a']);
    press(st, 'f');
    const still = items(st.getState().project, 'v1').find(
      (i) => (i as VideoItem).freezeAtSec !== null,
    );
    expect(still).toBeTruthy();
  });

  it(', and . nudge by a frame; Shift by ten', () => {
    const st = makeStore(base());
    st.getState().select(['b']);
    press(st, '.');
    expect(item(st.getState().project, 'b').startSec).toBeCloseTo(5 + 1 / 30);
    press(st, '>', { shiftKey: true, code: 'Period' });
    expect(item(st.getState().project, 'b').startSec).toBeCloseTo(5 + 11 / 30);
    press(st, ',');
    expect(item(st.getState().project, 'b').startSec).toBeCloseTo(5 + 10 / 30);
    press(st, '<', { shiftKey: true, code: 'Comma' });
    expect(item(st.getState().project, 'b').startSec).toBeCloseTo(5);
  });

  it('Delete removes a selected keyframe before the item', () => {
    const st = makeStore(base());
    st.getState().addKeyframe('a', 'transform.x', 1, 5);
    st.getState().select(['a']);
    st.getState().selectKeyframe({ itemId: 'a', prop: 'transform.x', index: 0 });
    press(st, 'Delete');
    expect(items(st.getState().project, 'v1').length).toBe(2);
  });
});

describe('handleKey — view & project', () => {
  it('+ / - zoom around the playhead; Shift+Z fits', () => {
    const st = makeStore(base());
    const z0 = st.getState().pxPerSec;
    press(st, '+');
    expect(st.getState().pxPerSec).toBeCloseTo(z0 * 1.25);
    press(st, '=');
    press(st, '-');
    expect(st.getState().pxPerSec).toBeCloseTo(z0 * 1.25);
    st.getState().setViewportPx(800);
    press(st, 'Z', { shiftKey: true });
    expect(st.getState().pxPerSec).toBeCloseTo(800 / (20 * 1.05));
  });

  it('Ctrl+S saves now', async () => {
    const st = makeStore(base());
    const save = vi.fn(async () => ({ rev: 2, updatedAt: 1 }));
    const stop = st.getState().startAutosave({ save });
    st.getState().deleteItems(['b']);
    expect(press(st, 's', { ctrlKey: true }).handled).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(save).toHaveBeenCalledTimes(1);
    stop();
  });

  it('? is not handled by the store but matchShortcut identifies it as "help"', () => {
    const st = makeStore(base());
    const e = key('?', { shiftKey: true });
    expect(handleKey(e, st.getState())).toBe(false);
    expect(e.prevented).toBe(false);
    expect(matchShortcut(e)?.id).toBe('help');
  });
});

describe('handleKey — what it must ignore', () => {
  const field = (tag: string, extra: Record<string, unknown> = {}) => ({ tagName: tag, ...extra });

  it('ignores events from inputs, textareas, selects and contenteditable', () => {
    const st = makeStore(base());
    for (const target of [
      field('INPUT'),
      field('TEXTAREA'),
      field('SELECT'),
      field('DIV', { isContentEditable: true }),
      field('SPAN', { getAttribute: (n: string) => (n === 'contenteditable' ? 'true' : null) }),
    ]) {
      const e = key(' ', { target });
      expect(handleKey(e, st.getState())).toBe(false);
      expect(e.prevented).toBe(false);
      expect(matchShortcut(e)).toBeNull();
    }
    expect(st.getState().playing).toBe(false);
    expect(handleKey(key(' ', { target: field('DIV') }), st.getState())).toBe(true);
  });

  it('ignores Alt combinations and unknown keys', () => {
    const st = makeStore(base());
    expect(handleKey(key('s', { altKey: true }), st.getState())).toBe(false);
    expect(handleKey(key('q', { ctrlKey: true }), st.getState())).toBe(false);
    expect(handleKey(key('F5'), st.getState())).toBe(false);
    expect(handleKey(key('s', { ctrlKey: true, shiftKey: true }), st.getState())).toBe(false);
  });

  it('plain letter shortcuts do not fire with Ctrl (Ctrl+S is save, not split)', () => {
    const st = makeStore(base());
    st.getState().select(['a']);
    st.getState().setPlayhead(2);
    press(st, 's', { ctrlKey: true });
    expect(items(st.getState().project, 'v1').length).toBe(2);
  });

  it('accepts either the state object or anything with getState (the store API)', () => {
    const st = makeStore(base());
    expect(handleKey(key(' '), st)).toBe(true);
    expect(st.getState().playing).toBe(true);
    expect(typeof useEditorStore.getState().togglePlay).toBe('function');
  });
});
