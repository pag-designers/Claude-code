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

/** Uploaded Brand Kit faces with their metrics, measured by `refreshBrandFonts`. */
let brandFaces: { family: string; face: EditorFontFace }[] = [];

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
  const consider = (fam: string, fc: EditorFontFace): void => {
    if (norm(fam) !== q && norm(fc.assName) !== q) return;
    const score = Math.abs(fc.weight - weight);
    if (score < bestScore) {
      best = { ...fc, family: fam };
      bestScore = score;
    }
  };
  for (const f of EDITOR_FONTS) for (const fc of f.faces) consider(f.family, fc);
  // Brand Kit faces (measured in the browser once registered) after the shipped ones, so ties go to the shipped face
  for (const b of brandFaces) consider(b.family, b.face);
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
    // Brand Kit fonts are fetched in parallel; the first render waits for them only briefly (BRAND_FONTS_WAIT_MS)
    const brand = refreshBrandFonts();
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
    await Promise.race([brand, new Promise<void>((r) => setTimeout(r, BRAND_FONTS_WAIT_MS))]);
    ready = true;
    epoch++;
    for (const l of [...listeners]) l();
  })();
  return loadPromise;
}

/* ------------------------------------------------------------------ Brand Kit fonts ------------- */

/** How long the first render waits for the Brand Kit fonts before drawing with what it has (they redraw when they arrive). */
const BRAND_FONTS_WAIT_MS = 2500;
let brandSignature = '';
let brandInflight: Promise<void> | null = null;

/**
 * Ascent / descent / cap height (em fractions) of an sfnt (TTF/OTF) file, by the exporter's rule
 * (`electron/main/services/captions/fontmeta.ts`): the Windows cell `usWinAscent` / `usWinDescent` of OS/2 when present,
 * else hhea; cap height from OS/2 (version >= 2) else 0.7 em. This is what libass sizes and places text by, so the
 * preview must use the very same numbers for an uploaded font. Null when the file is not a readable sfnt.
 */
export function readFaceMetrics(
  buf: ArrayBuffer,
): { ascent: number; descent: number; capHeight: number } | null {
  try {
    const v = new DataView(buf);
    const tag = v.getUint32(0);
    if (tag !== 0x00010000 && tag !== 0x4f54544f && tag !== 0x74727565) return null; // TrueType, 'OTTO', 'true'
    const n = v.getUint16(4);
    const tables = new Map<string, { offset: number; length: number }>();
    for (let i = 0; i < n; i++) {
      const o = 12 + i * 16;
      const name = String.fromCharCode(
        v.getUint8(o),
        v.getUint8(o + 1),
        v.getUint8(o + 2),
        v.getUint8(o + 3),
      );
      tables.set(name, { offset: v.getUint32(o + 8), length: v.getUint32(o + 12) });
    }
    const head = tables.get('head');
    const hhea = tables.get('hhea');
    if (!head || !hhea || head.length < 20 || hhea.length < 8) return null;
    const upm = v.getUint16(head.offset + 18) || 1000;
    let ascent = v.getInt16(hhea.offset + 4);
    let descent = -v.getInt16(hhea.offset + 6);
    let cap = 0.7 * upm;
    const os2 = tables.get('OS/2');
    if (os2 && os2.length >= 78) {
      const winA = v.getUint16(os2.offset + 74);
      const winD = v.getUint16(os2.offset + 76);
      if (winA + winD > 0) {
        ascent = winA;
        descent = winD;
      }
      if (os2.length >= 90 && v.getUint16(os2.offset) >= 2)
        cap = v.getInt16(os2.offset + 88) || cap;
    }
    if (!(ascent > 0) || !(descent >= 0)) return null;
    return { ascent: ascent / upm, descent: descent / upm, capHeight: cap / upm };
  } catch {
    return null;
  }
}

const metricsCache = new Map<string, Promise<ReturnType<typeof readFaceMetrics>>>();

/** Metrics of an uploaded font, read from its file once per asset (the presigned URL changes, the asset does not). */
function brandFaceMetrics(
  assetId: string,
  url: string,
): Promise<ReturnType<typeof readFaceMetrics>> {
  let p = metricsCache.get(assetId);
  if (!p) {
    p = fetch(url)
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .then((b) => (b ? readFaceMetrics(b) : null))
      .catch(() => null);
    metricsCache.set(assetId, p);
    void p.then((m) => {
      if (!m) metricsCache.delete(assetId); // retry next time
    });
  }
  return p;
}

/** True when a FontFace of this family finished loading (a face that failed would draw with the fallback font). */
function isLoadedFamily(family: string): boolean {
  let loaded = false;
  document.fonts.forEach((ff) => {
    if (ff.status === 'loaded' && ff.family.replace(/["']/g, '') === family) loaded = true;
  });
  return loaded;
}

/**
 * Registers the Brand Kit's uploaded fonts (`brand:fonts` → `FontFace`, idempotent per asset) so text items whose
 * `fontFamily` is a brand family are drawn with the real font on the canvas, exactly like the pickers show it. When the
 * set of registered brand fonts changed, the font epoch moves and `onEditorFontsLoaded` listeners run (text caches
 * re-measure, rasters re-draw). Never rejects: no bridge / no fonts / a broken file just means nothing to add.
 */
export function refreshBrandFonts(): Promise<void> {
  if (typeof document === 'undefined' || typeof FontFace === 'undefined') return Promise.resolve();
  const run = async (): Promise<void> => {
    try {
      const { registerBrandFonts } = await import('../../brand/fonts');
      const refs = await registerBrandFonts();
      brandFaces = (
        await Promise.all(
          refs.map(async (f) => {
            if (!isLoadedFamily(f.family)) return null;
            const m = await brandFaceMetrics(f.assetId, f.url);
            return m
              ? {
                  family: f.family,
                  face: { weight: f.weight, file: '', assName: f.family, ...m },
                }
              : null;
          }),
        )
      ).filter((x): x is { family: string; face: EditorFontFace } => x !== null);
      const sig = refs
        .map((f) => {
          const m = brandFaces.find((b) => b.family === f.family && b.face.weight === f.weight);
          return `${f.assetId}:${f.family}:${f.weight}:${f.italic ? 'i' : 'n'}:${m ? `${m.face.ascent}/${m.face.descent}` : '-'}`;
        })
        .sort()
        .join('|');
      if (sig === brandSignature) return;
      brandSignature = sig;
      if (ready) {
        epoch++;
        for (const l of [...listeners]) l();
      }
    } catch {
      /* no bridge (tests, reference pages) or the list could not be read: shipped fonts only */
    }
  };
  brandInflight = (brandInflight ?? Promise.resolve()).then(run, run);
  return brandInflight;
}
