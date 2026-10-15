/** Editor preview compositor (CP3). Contract: ./api.ts. */
export type {
  Compositor,
  CompositorExports,
  ComputeDrag,
  DragInput,
  DragResult,
  FrameRequest,
  FrameSource,
  HandleKind,
  Point,
  RenderStats,
  TransformHandles,
} from './api';
export {
  createCompositor,
  measureTextItem,
  compositorExports,
  type EditorCompositor,
  type CompositorOptions,
} from './compositor';
export { computeDrag } from './drag';
export { parseCube, MAX_LUT_SIZE } from './cube';
export {
  EDITOR_FONTS,
  ensureEditorFonts,
  refreshBrandFonts,
  editorFontsReady,
  onEditorFontsLoaded,
  resolveEditorFace,
  libassFontSize,
  cssFont,
  type EditorFont,
  type EditorFontFace,
  type EnsureFontsOptions,
} from './fonts';
export { BACKGROUND_BLUR_SIGMA, framesNeededAt } from './scene';
export {
  layoutText,
  setTextMeasurer,
  approxMeasurer,
  type TextLayout,
  type TextMeasurer,
} from './text-layout';
export { builtinCaptionStyles, resolveCaptionStyle } from './caption-presets';
