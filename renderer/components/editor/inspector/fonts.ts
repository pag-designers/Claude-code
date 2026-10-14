/**
 * The ONE place the inspector reads the editor font list. The compositor exports it from its index; until that index
 * exists the module file is imported directly (same symbol).
 */
export { EDITOR_FONTS } from '@/lib/editor/compositor/fonts';
export type { EditorFont } from '@/lib/editor/compositor/fonts';
