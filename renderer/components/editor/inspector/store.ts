/**
 * The ONE place the inspector touches the editor store (api.ts contract). Everything else goes through these hooks, so a
 * change to the store module's location is a one-line edit here.
 */
export { useEditorStore } from '@/lib/editor/core';
export type { AnimatedPath, DeepPartial, EditorStore, Selection } from '@/lib/editor/core';
