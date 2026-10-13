/**
 * CaptionService implementation: ASS (libass) word-pop captions, SRT/VTT and the hook title card.
 *
 * Fonts: the default style uses "Montserrat ExtraBold" (OFL), shipped as
 * `electron/main/assets/fonts/Montserrat-ExtraBold.ttf`. Pass the directory as `fontsDir` to the
 * render service (libass `fontsdir=`); without it libass falls back to a bold system sans.
 */
import type { CaptionService } from '../../pipeline/contracts';
import { buildAssDocument } from './ass';
import { buildSrt, buildVtt } from './subs';

export { buildAssDocument, assTime, captionLayout } from './ass';
export { appendHookToAss, buildHookEvent, wrapHook } from './hook';
export type { HookEvent } from './hook';
export { buildCues, buildSrt, buildVtt } from './subs';
export { escapeAssText, isProfane, maskWord } from './text';
export { chunkWords } from './chunk';
export { CLEAN_POP, FONT_FAMILY, FONT_FILE, resolveStyle } from './styles';
export type { CaptionStyle } from './styles';

export function createCaptionService(): CaptionService {
  return {
    buildAss: (args) => buildAssDocument(args),
    buildSrt,
    buildVtt,
  };
}
