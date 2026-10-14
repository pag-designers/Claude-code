/**
 * The ONLY place the playback layer reaches into the sibling modules' runtime exports (core store + shortcuts, the
 * compositor). Everything else in this folder takes them as injected dependencies, which is what keeps the scheduling
 * logic unit-testable in node.
 */
import { handleKey, useEditorStore } from '@/lib/editor/core';

export { useEditorStore };
export { createCompositor, computeDrag, parseCube } from '@/lib/editor/compositor';

/** Forwards a keyboard event to the editor's shortcut map. Returns true when it was handled. */
export function forwardKey(event: KeyboardEvent): boolean {
  return handleKey(event, useEditorStore.getState());
}
