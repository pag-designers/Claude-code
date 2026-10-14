/**
 * Editor fonts. The preview must use the SAME font files the exporter hands to libass
 * (`electron/main/assets/fonts/*.ttf`, copied byte-for-byte into `renderer/public/fonts/editor/`, all SIL OFL —
 * the licence texts sit next to them). `TextStyle.fontFamily` / a caption style's `font.family` are resolved to a
 * face with `resolveEditorFace()`; the exporter must use the same rule (nearest weight in the family, same tie-break)
 * so both sides pick the same file. Metrics (em fractions) are those of `electron/main/services/captions/font-metrics.ts`
 * (hhea ascent / descent, OS/2 cap height); a drift test lives in test/unit/editor-compositor-fonts.test.ts.
 *
 * FONT SIZE CONVENTION: the editor's `TextStyle.size` is the CSS em size in canvas px. libass treats `\fs` as the
 * height of the line CELL (ascent + descent), so an exporter that uses libass must emit `\fs = size × (ascent + descent)`
 * of the resolved face (see `libassFontSize()`).
 */

export interface EditorFontFace {
  weight: number;
  file: string;
  /** The name libass / fontconfig match (name ID 1). */
  assName: string;
  /** Em fractions. */
  ascent: number;
  descent: number;
  capHeight: number;
}

export interface EditorFont {
  /** CSS / libass family. */
  family: string;
  /** Weights actually shipped (a request for another weight is snapped to the nearest one). */
  weights: number[];
  /** File of the primary (first) face, relative to the fonts directory. */
  file: string;
  faces: EditorFontFace[];
  category: 'sans' | 'display' | 'serif' | 'mono';
}

const face = (
  weight: number,
  file: string,
  assName: string,
  ascent: number,
  descent: number,
  capHeight: number,
): EditorFontFace => ({
  weight,
  file,
  assName,
  ascent: ascent / 1000,
  descent: descent / 1000,
  capHeight: capHeight / 1000,
});

const font = (
  family: string,
  category: EditorFont['category'],
  faces: EditorFontFace[],
): EditorFont => ({
  family,
  category,
  faces,
  weights: faces.map((f) => f.weight),
  file: (faces[0] as EditorFontFace).file,
});

export const EDITOR_FONTS: readonly EditorFont[] = [
  font('Montserrat', 'sans', [
    face(800, 'Montserrat-ExtraBold.ttf', 'Montserrat ExtraBold', 1109, 453, 700),
  ]),
  font('Anton', 'display', [face(400, 'Anton-Regular.ttf', 'Anton', 1404, 329, 859)]),
  font('Bebas Neue', 'display', [face(400, 'BebasNeue-Regular.ttf', 'Bebas Neue', 950, 350, 700)]),
  font('Poppins', 'sans', [
    face(600, 'Poppins-SemiBold.ttf', 'Poppins SemiBold', 1135, 627, 701),
    face(700, 'Poppins-Bold.ttf', 'Poppins', 1135, 627, 705),
    face(800, 'Poppins-ExtraBold.ttf', 'Poppins ExtraBold', 1135, 627, 709),
  ]),
  font('DM Serif Display', 'serif', [
    face(400, 'DMSerifDisplay-Regular.ttf', 'DM Serif Display', 1036, 335, 660),
  ]),
  font('IBM Plex Mono', 'mono', [
    face(600, 'IBMPlexMono-SemiBold.ttf', 'IBM Plex Mono SemiBold', 1025, 275, 698),
  ]),
];

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

export interface ResolvedFace extends EditorFontFace {
  family: string;
}

/**
 * The face used for (family, weight): same family (case-insensitive; also matches the libass name), nearest weight,
 * ties go to the first listed (lighter) face — the exporter's `fontBook.resolve` rule. Unknown family → null (the
 * browser / libass then substitute a system font by name).
 */
export function resolveEditorFace(family: string, weight: number): ResolvedFace | null {
  const q = norm(family);
  let best: ResolvedFace | null = null;
  let bestScore = Infinity;
  for (const f of EDITOR_FONTS) {
    for (const fc of f.faces) {
      if (norm(f.family) !== q && norm(fc.assName) !== q) continue;
      const score = Math.abs(fc.weight - weight);
      if (score < bestScore) {
        best = { ...fc, family: f.family };
        bestScore = score;
      }
    }
  }
  return best;
}

/** ASS `\fs` that makes libass draw an `emPx` em: libass' size is the ascent + descent cell. */
export function libassFontSize(
  emPx: number,
  f: Pick<EditorFontFace, 'ascent' | 'descent'> | null,
): number {
  return emPx * (f ? f.ascent + f.descent : 1.4);
}

/** CSS `font` shorthand fragment for a (family, weight): resolves the weight, quotes the family. */
export function cssFont(
  family: string,
  weight: number,
  italic: boolean,
  emPx: number,
): { font: string; face: ResolvedFace | null } {
  const f = resolveEditorFace(family, weight);
  const w = f ? f.weight : weight;
  const fam = f ? f.family : family;
  return {
    font: `${italic ? 'italic ' : ''}${w} ${emPx}px "${fam.replace(/"/g, '')}", sans-serif`,
    face: f,
  };
}

/* ------------------------------------------------------------------ loading ---------------------- */

let loadPromise: Promise<void> | null = null;
let ready = false;
let epoch = 0;
const listeners = new Set<() => void>();

/** True once `ensureEditorFonts()` has finished. */
export const editorFontsReady = (): boolean => ready;
/** Increments whenever new fonts become available (text caches key on it). */
export const editorFontsEpoch = (): number => epoch;
export function onEditorFontsLoaded(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export interface EnsureFontsOptions {
  /** Where the TTFs are served from (default `/fonts/editor/`). */
  baseUrl?: string;
  /** Font set to register into (default `document.fonts` / `self.fonts`). */
  fontSet?: FontFaceSet;
}

/**
 * Registers every editor font with the FontFace API and waits for it. Idempotent (one load per page); call and await
 * it before the first `render()`. Resolves even if a file fails to load (text then falls back to a system font) — the
 * failure is logged once.
 */
export function ensureEditorFonts(opts: EnsureFontsOptions = {}): Promise<void> {
  if (loadPromise) return loadPromise;
  const set: FontFaceSet | undefined =
    opts.fontSet ??
    (typeof document !== 'undefined'
      ? document.fonts
      : (globalThis as { fonts?: FontFaceSet }).fonts);
  if (!set || typeof FontFace === 'undefined') {
    ready = true;
    loadPromise = Promise.resolve();
    return loadPromise;
  }
  const base = (opts.baseUrl ?? '/fonts/editor/').replace(/\/?$/, '/');
  loadPromise = (async () => {
    await Promise.all(
      EDITOR_FONTS.flatMap((f) =>
        f.faces.map(async (fc) => {
          try {
            const ff = new FontFace(f.family, `url("${base}${fc.file}")`, {
              weight: String(fc.weight),
              style: 'normal',
              display: 'block',
            });
            (set as unknown as { add(f: FontFace): void }).add(ff);
            await ff.load();
          } catch (err) {
            console.warn(`editor font ${fc.file} failed to load`, err);
          }
        }),
      ),
    );
    ready = true;
    epoch++;
    for (const l of [...listeners]) l();
  })();
  return loadPromise;
}
