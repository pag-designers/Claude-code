/**
 * CaptionService implementation: style-driven ASS (libass) captions, SRT/VTT, live preview and the hook
 * title card. Fonts: the shipped OFL fonts live in `electron/main/assets/fonts`; pass that directory as
 * `fontsDir` to the render service (libass `fontsdir=`), `preview()` and `fonts()`.
 */
import type { CaptionService } from '../../pipeline/contracts';
import { buildAssDocument } from './ass';
import { fontBook } from './fontbook';
import { renderPreview } from './preview';
import { builtinStyles } from './styles';
import { buildSrt, buildVtt } from './subs';

export { buildAssDocument, assTime, captionLayout, roundedRectPath } from './ass';
export { appendHookToAss, buildHookEvent, wrapHook } from './hook';
export type { HookEvent } from './hook';
export { buildCues, buildSrt, buildVtt } from './subs';
export { applyCase, escapeAssText, isProfane, maskWord } from './text';
export { chunkBlocks, chunkWords } from './chunk';
export { CLEAN_POP, FONT_FAMILY, FONT_FILE, builtinStyles, resolveStyle } from './styles';
export { fontBook, measureText } from './fontbook';
export { buildPreviewAss, escapeFilterValue, gradientSource, renderPreview } from './preview';
export type { CaptionStyle } from './styles';
export { createSubtitleService } from '../subtitles';

export interface CaptionServiceOptions {
  /** Directory with the shipped (and user-uploaded) fonts; its fonts are measured for layout. */
  fontsDir?: string | null;
}

export function createCaptionService(opts: CaptionServiceOptions = {}): CaptionService {
  fontBook.addDir(opts.fontsDir ?? null);
  return {
    builtinStyles,
    buildAss: (args) => buildAssDocument(args),
    buildSrt,
    buildVtt,
    preview: (args) => {
      fontBook.addDir(args.fontsDir);
      return renderPreview(args);
    },
    fonts: (fontsDir) => {
      fontBook.addDir(fontsDir);
      return fontBook.listFamilies();
    },
  };
}
