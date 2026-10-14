/**
 * Public surface of the editor state engine. UI modules import ONLY from '@/lib/editor/core'.
 */
export * from './api';
export * from './helpers';
export { useEditorStore, createEditorStore } from './store';
export type { FullEditorStore, EditorExtras, StoreOptions } from './store';
export { SHORTCUTS, handleKey, matchShortcut, isTextTarget, type KeyEventLike } from './shortcuts';
export {
  snapCandidates,
  snapThreshold,
  snapTime,
  SNAP_PX,
  type SnapPoint,
  type SnapKind,
} from './snap';
export { projectProblems, layoutProblem, normalizeItems } from './ops';
export { History } from './history';
