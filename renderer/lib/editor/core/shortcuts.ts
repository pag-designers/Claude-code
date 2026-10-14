/**
 * The keyboard map (CapCut / Premiere style). `SHORTCUTS` is the display table for the `?` overlay; `handleKey`
 * dispatches a KeyboardEvent to store actions using the same table (one source of truth: every SHORTCUTS id has a
 * binding below, enforced by a test).
 *
 * `?` (id 'help') opens a UI overlay, so `handleKey` does NOT treat it as handled — call `matchShortcut(e)` and
 * check `id === 'help'`. Events from text fields (input / textarea / select / contenteditable) are ignored.
 */
import type { EditorStore, ShortcutDef } from './api';
import type { EditorExtras } from './store';

export type KeyStore = EditorStore & Partial<EditorExtras>;

/** The subset of KeyboardEvent the handler reads (so tests need no DOM). */
export interface KeyEventLike {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
  target?: unknown;
  preventDefault?(): void;
}

export const SHORTCUTS: ShortcutDef[] = [
  { id: 'play-pause', keys: ['Space'], label: 'Play / pause', group: 'Transport' },
  {
    id: 'shuttle-reverse',
    keys: ['J'],
    label: 'Play backward (tap again: 2×, 4×, 8×)',
    group: 'Transport',
  },
  { id: 'shuttle-stop', keys: ['K'], label: 'Pause', group: 'Transport' },
  {
    id: 'shuttle-forward',
    keys: ['L'],
    label: 'Play forward (tap again: 2×, 4×, 8×)',
    group: 'Transport',
  },
  { id: 'frame-back', keys: ['←'], label: 'Back one frame', group: 'Transport' },
  { id: 'frame-forward', keys: ['→'], label: 'Forward one frame', group: 'Transport' },
  { id: 'frames-back-10', keys: ['Shift', '←'], label: 'Back 10 frames', group: 'Transport' },
  { id: 'frames-forward-10', keys: ['Shift', '→'], label: 'Forward 10 frames', group: 'Transport' },
  { id: 'edit-prev', keys: ['↑'], label: 'Previous edit point', group: 'Transport' },
  { id: 'edit-next', keys: ['↓'], label: 'Next edit point', group: 'Transport' },
  { id: 'go-start', keys: ['Home'], label: 'Go to start', group: 'Transport' },
  { id: 'go-end', keys: ['End'], label: 'Go to end', group: 'Transport' },

  { id: 'split', keys: ['S'], label: 'Split at playhead', group: 'Edit' },
  { id: 'delete', keys: ['Delete'], label: 'Delete', group: 'Edit' },
  { id: 'ripple-delete', keys: ['Shift', 'Delete'], label: 'Ripple delete', group: 'Edit' },
  { id: 'undo', keys: ['⌘', 'Z'], label: 'Undo', group: 'Edit' },
  { id: 'redo', keys: ['⌘', 'Shift', 'Z'], label: 'Redo', group: 'Edit' },
  { id: 'copy', keys: ['⌘', 'C'], label: 'Copy', group: 'Edit' },
  { id: 'cut', keys: ['⌘', 'X'], label: 'Cut', group: 'Edit' },
  { id: 'paste', keys: ['⌘', 'V'], label: 'Paste at playhead', group: 'Edit' },
  { id: 'duplicate', keys: ['⌘', 'D'], label: 'Duplicate', group: 'Edit' },
  { id: 'group', keys: ['⌘', 'G'], label: 'Group', group: 'Edit' },
  { id: 'ungroup', keys: ['⌘', 'Shift', 'G'], label: 'Ungroup', group: 'Edit' },
  { id: 'trim-start', keys: ['['], label: 'Trim start to playhead', group: 'Edit' },
  { id: 'trim-end', keys: [']'], label: 'Trim end to playhead', group: 'Edit' },
  { id: 'ripple-trim-start', keys: ['Q'], label: 'Ripple trim start to playhead', group: 'Edit' },
  { id: 'ripple-trim-end', keys: ['W'], label: 'Ripple trim end to playhead', group: 'Edit' },
  { id: 'freeze', keys: ['F'], label: 'Freeze frame at playhead', group: 'Edit' },
  { id: 'nudge-back', keys: [','], label: 'Nudge selection back one frame', group: 'Edit' },
  { id: 'nudge-forward', keys: ['.'], label: 'Nudge selection forward one frame', group: 'Edit' },
  {
    id: 'nudge-back-10',
    keys: ['Shift', ','],
    label: 'Nudge selection back 10 frames',
    group: 'Edit',
  },
  {
    id: 'nudge-forward-10',
    keys: ['Shift', '.'],
    label: 'Nudge selection forward 10 frames',
    group: 'Edit',
  },

  { id: 'select-all', keys: ['⌘', 'A'], label: 'Select all', group: 'Selection' },
  { id: 'deselect', keys: ['Esc'], label: 'Clear selection', group: 'Selection' },

  { id: 'marker', keys: ['M'], label: 'Add marker at playhead', group: 'Timeline' },
  { id: 'snap', keys: ['N'], label: 'Toggle snapping', group: 'Timeline' },
  { id: 'ripple', keys: ['R'], label: 'Toggle ripple editing', group: 'Timeline' },

  { id: 'zoom-in', keys: ['+'], label: 'Zoom in', group: 'View' },
  { id: 'zoom-out', keys: ['-'], label: 'Zoom out', group: 'View' },
  { id: 'zoom-fit', keys: ['Shift', 'Z'], label: 'Zoom to fit', group: 'View' },
  { id: 'help', keys: ['?'], label: 'Keyboard shortcuts', group: 'View' },

  { id: 'save', keys: ['⌘', 'S'], label: 'Save now', group: 'Project' },
];

/* ------------------------------------------------------------------ matching ------------------ */

const lower = (e: KeyEventLike): string => e.key.toLowerCase();
const mod = (e: KeyEventLike): boolean => !!(e.ctrlKey || e.metaKey);
const shift = (e: KeyEventLike): boolean => !!e.shiftKey;

/** Key by character(s) or physical code (shifted symbols change `key`, not `code`). */
const sym = (e: KeyEventLike, chars: string[], code?: string): boolean =>
  chars.includes(e.key) || (code !== undefined && e.code === code);

interface Binding {
  id: string;
  match(e: KeyEventLike): boolean;
  run(s: KeyStore): void;
  /** Auto-repeat (held key) is allowed. */
  repeat?: boolean;
}

const plain = (e: KeyEventLike): boolean => !mod(e) && !e.altKey;
const letter =
  (k: string) =>
  (e: KeyEventLike): boolean =>
    plain(e) && !shift(e) && lower(e) === k;
const modLetter =
  (k: string, withShift: boolean) =>
  (e: KeyEventLike): boolean =>
    mod(e) && !e.altKey && shift(e) === withShift && lower(e) === k;

const BINDINGS: Binding[] = [
  {
    id: 'play-pause',
    match: (e) => plain(e) && (e.key === ' ' || e.code === 'Space'),
    run: (s) => s.togglePlay(),
  },
  { id: 'shuttle-reverse', match: letter('j'), run: (s) => s.shuttle('J') },
  { id: 'shuttle-stop', match: letter('k'), run: (s) => s.shuttle('K') },
  { id: 'shuttle-forward', match: letter('l'), run: (s) => s.shuttle('L') },
  {
    id: 'frame-back',
    match: (e) => plain(e) && !shift(e) && e.key === 'ArrowLeft',
    run: (s) => s.stepFrames(-1),
    repeat: true,
  },
  {
    id: 'frame-forward',
    match: (e) => plain(e) && !shift(e) && e.key === 'ArrowRight',
    run: (s) => s.stepFrames(1),
    repeat: true,
  },
  {
    id: 'frames-back-10',
    match: (e) => plain(e) && shift(e) && e.key === 'ArrowLeft',
    run: (s) => s.stepFrames(-10),
    repeat: true,
  },
  {
    id: 'frames-forward-10',
    match: (e) => plain(e) && shift(e) && e.key === 'ArrowRight',
    run: (s) => s.stepFrames(10),
    repeat: true,
  },
  {
    id: 'edit-prev',
    match: (e) => plain(e) && !shift(e) && e.key === 'ArrowUp',
    run: (s) => s.jumpToEdit?.(-1),
  },
  {
    id: 'edit-next',
    match: (e) => plain(e) && !shift(e) && e.key === 'ArrowDown',
    run: (s) => s.jumpToEdit?.(1),
  },
  { id: 'go-start', match: (e) => plain(e) && e.key === 'Home', run: (s) => s.setPlayhead(0) },
  {
    id: 'go-end',
    match: (e) => plain(e) && e.key === 'End',
    run: (s) => {
      let end = 0;
      for (const tr of s.project.tracks)
        for (const it of tr.items) end = Math.max(end, it.startSec + it.durationSec);
      s.setPlayhead(end);
    },
  },

  { id: 'split', match: letter('s'), run: (s) => void s.split(null) },
  {
    id: 'delete',
    match: (e) => plain(e) && !shift(e) && (e.key === 'Delete' || e.key === 'Backspace'),
    run: (s) => (s.deleteSelection ? s.deleteSelection() : s.deleteItems(s.selection.itemIds)),
  },
  {
    id: 'ripple-delete',
    match: (e) => plain(e) && shift(e) && (e.key === 'Delete' || e.key === 'Backspace'),
    run: (s) =>
      s.deleteSelection
        ? s.deleteSelection({ ripple: true })
        : s.deleteItems(s.selection.itemIds, { ripple: true }),
  },
  {
    id: 'undo',
    match: (e) => mod(e) && !e.altKey && !shift(e) && lower(e) === 'z',
    run: (s) => s.undo(),
    repeat: true,
  },
  {
    id: 'redo',
    match: (e) =>
      mod(e) && !e.altKey && ((shift(e) && lower(e) === 'z') || (!shift(e) && lower(e) === 'y')),
    run: (s) => s.redo(),
    repeat: true,
  },
  { id: 'copy', match: modLetter('c', false), run: (s) => s.copy() },
  { id: 'cut', match: modLetter('x', false), run: (s) => s.cut() },
  { id: 'paste', match: modLetter('v', false), run: (s) => void s.paste() },
  {
    id: 'duplicate',
    match: modLetter('d', false),
    run: (s) => void s.duplicateItems(s.selection.itemIds),
  },
  { id: 'group', match: modLetter('g', false), run: (s) => s.group(s.selection.itemIds) },
  { id: 'ungroup', match: modLetter('g', true), run: (s) => s.ungroup(s.selection.itemIds) },
  {
    id: 'trim-start',
    match: (e) => plain(e) && sym(e, ['[', '{'], 'BracketLeft') && !shift(e),
    run: (s) => s.trimToPlayhead?.('start'),
  },
  {
    id: 'trim-end',
    match: (e) => plain(e) && sym(e, [']', '}'], 'BracketRight') && !shift(e),
    run: (s) => s.trimToPlayhead?.('end'),
  },
  {
    id: 'ripple-trim-start',
    match: letter('q'),
    run: (s) => s.trimToPlayhead?.('start', { ripple: true }),
  },
  {
    id: 'ripple-trim-end',
    match: letter('w'),
    run: (s) => s.trimToPlayhead?.('end', { ripple: true }),
  },
  { id: 'freeze', match: letter('f'), run: (s) => s.freezeAtPlayhead?.() },
  {
    id: 'nudge-back',
    match: (e) => plain(e) && !shift(e) && sym(e, [','], 'Comma'),
    run: (s) => s.nudgeSelected?.(-1),
    repeat: true,
  },
  {
    id: 'nudge-forward',
    match: (e) => plain(e) && !shift(e) && sym(e, ['.'], 'Period'),
    run: (s) => s.nudgeSelected?.(1),
    repeat: true,
  },
  {
    id: 'nudge-back-10',
    match: (e) => plain(e) && shift(e) && sym(e, ['<'], 'Comma'),
    run: (s) => s.nudgeSelected?.(-10),
    repeat: true,
  },
  {
    id: 'nudge-forward-10',
    match: (e) => plain(e) && shift(e) && sym(e, ['>'], 'Period'),
    run: (s) => s.nudgeSelected?.(10),
    repeat: true,
  },

  { id: 'select-all', match: modLetter('a', false), run: (s) => s.selectAll() },
  { id: 'deselect', match: (e) => plain(e) && e.key === 'Escape', run: (s) => s.clearSelection() },

  { id: 'marker', match: letter('m'), run: (s) => void s.addMarker() },
  { id: 'snap', match: letter('n'), run: (s) => s.toggleSnap() },
  { id: 'ripple', match: letter('r'), run: (s) => s.toggleRipple() },

  {
    id: 'zoom-in',
    match: (e) => plain(e) && (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd'),
    run: (s) => s.setZoom(s.pxPerSec * 1.25, s.playheadSec),
    repeat: true,
  },
  {
    id: 'zoom-out',
    match: (e) => plain(e) && (e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract'),
    run: (s) => s.setZoom(s.pxPerSec / 1.25, s.playheadSec),
    repeat: true,
  },
  {
    id: 'zoom-fit',
    match: (e) => plain(e) && shift(e) && lower(e) === 'z',
    run: (s) => s.zoomToFit(s.viewportPx ?? 1000),
  },
  { id: 'help', match: (e) => plain(e) && e.key === '?', run: () => undefined },

  { id: 'save', match: modLetter('s', false), run: (s) => void s.saveNow() },
];

/** Is the event coming from something the user is typing into? */
export function isTextTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const t = target as {
    tagName?: unknown;
    isContentEditable?: unknown;
    getAttribute?: (n: string) => string | null;
  };
  const tag = typeof t.tagName === 'string' ? t.tagName.toUpperCase() : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (t.isContentEditable === true) return true;
  const ce = typeof t.getAttribute === 'function' ? t.getAttribute('contenteditable') : null;
  return ce !== null && ce !== undefined && ce !== 'false';
}

/** The shortcut an event corresponds to (ignores text fields), or null. Lets the UI handle 'help'. */
export function matchShortcut(e: KeyEventLike): ShortcutDef | null {
  if (isTextTarget(e.target)) return null;
  const b = BINDINGS.find((x) => x.match(e));
  return b ? (SHORTCUTS.find((d) => d.id === b.id) ?? null) : null;
}

/**
 * Dispatch a keyboard event to the store. Returns true (and calls preventDefault) when it ran a shortcut.
 * `store` may be the state object (`useEditorStore.getState()`) or anything exposing `getState()`.
 */
export function handleKey(e: KeyEventLike, store: KeyStore | { getState(): KeyStore }): boolean {
  if (isTextTarget(e.target) || e.altKey) return false;
  const b = BINDINGS.find((x) => x.match(e));
  if (!b || b.id === 'help') return false;
  if (e.repeat && !b.repeat) {
    e.preventDefault?.();
    return true;
  }
  const s: KeyStore =
    'getState' in store && typeof store.getState === 'function'
      ? store.getState()
      : (store as KeyStore);
  b.run(s);
  e.preventDefault?.();
  return true;
}

/** Ids bound in the handler (for the consistency test). */
export const BOUND_SHORTCUT_IDS: readonly string[] = BINDINGS.map((b) => b.id);
