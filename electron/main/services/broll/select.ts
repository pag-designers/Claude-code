/**
 * Pure helpers: orientation classes and the choice of the file to download. Provider adapters turn their own
 * rendition lists into `Rendition[]` and share this logic.
 */
export type Orientation = 'any' | 'portrait' | 'landscape' | 'square';
export type ShapeClass = Exclude<Orientation, 'any'>;

/** width / height below this is portrait, above `SQUARE_MAX` landscape, in between square. */
const SQUARE_MIN = 0.9;
const SQUARE_MAX = 1.1;

export function shapeOf(width: number, height: number): ShapeClass {
  const r = width / height;
  if (r < SQUARE_MIN) return 'portrait';
  if (r > SQUARE_MAX) return 'landscape';
  return 'square';
}

export const matchesOrientation = (w: number, h: number, o: Orientation): boolean =>
  o === 'any' || (w > 0 && h > 0 && shapeOf(w, h) === o);

export interface Rendition {
  url: string;
  width: number;
  height: number;
  /** bytes, when the provider tells */
  size?: number | null;
}

/** "1080p class": short side <= 1080 and long side <= 1920. 4K and 1440p never pass. */
export const withinHd = (r: { width: number; height: number }): boolean =>
  Math.min(r.width, r.height) <= 1080 && Math.max(r.width, r.height) <= 1920;

/**
 * True for a plain https URL (http only when `allowHttp`, i.e. a test server) pointing at an mp4 file (query string
 * ignored); HLS/DASH playlists and WebM are not. `requireExt: false` for providers whose rendition fields are mp4 by definition.
 */
export function isMp4Url(url: string, allowHttp: boolean, requireExt = true): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) return false;
  if (/\.(m3u8|mpd|webm)$/i.test(u.pathname)) return false;
  return requireExt ? /\.mp4$/i.test(u.pathname) : true;
}

const ASPECT_TOLERANCE = 0.08; // |ln(a / a0)|: ~8 %

/**
 * Best rendition to download for a clip of aspect `ratio` (width / height): within 1080p, the aspect closest to the
 * clip's (so a portrait clip never resolves to a landscape crop), then the largest short side (1080 preferred),
 * then the bigger file. `null` when nothing is within 1080p.
 */
export function pickRendition(candidates: Rendition[], ratio: number): Rendition | null {
  const hd = candidates.filter(
    (c) => c.width > 0 && c.height > 0 && withinHd(c) && Number.isFinite(c.width / c.height),
  );
  if (hd.length === 0) return null;
  const dist = (c: Rendition) => Math.abs(Math.log(c.width / c.height / ratio));
  const best = Math.min(...hd.map(dist));
  const pool = hd.filter((c) => dist(c) <= Math.max(ASPECT_TOLERANCE, best + 0.02));
  return (
    [...pool].sort(
      (a, b) =>
        Math.min(b.width, b.height) - Math.min(a.width, a.height) ||
        (b.size ?? 0) - (a.size ?? 0) ||
        dist(a) - dist(b),
    )[0] ?? null
  );
}

/** The smallest rendition by pixel count (hover preview), ignoring tiny placeholders when a bigger one exists. */
export function pickPreview(candidates: Rendition[]): Rendition | null {
  const ok = candidates.filter((c) => c.width > 0 && c.height > 0);
  if (ok.length === 0) return null;
  const usable = ok.filter((c) => Math.min(c.width, c.height) >= 240);
  const pool = usable.length > 0 ? usable : ok;
  return [...pool].sort((a, b) => a.width * a.height - b.width * b.height)[0] ?? null;
}

/** "a-woman-running-on-the-beach-3015510" -> "A woman running on the beach". */
export function titleFromSlug(pageUrl: string | null | undefined, fallback: string): string {
  if (!pageUrl) return fallback;
  let seg: string;
  try {
    const parts = new URL(pageUrl).pathname.split('/').filter(Boolean);
    seg = decodeURIComponent(parts[parts.length - 1] ?? '');
  } catch {
    return fallback;
  }
  const words = seg.replace(/-\d+$/, '').split(/[-_]+/).filter(Boolean).join(' ').trim();
  if (!words || /^\d+$/.test(words)) return fallback;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Pixabay tags ("ocean, waves, beach") -> "Ocean, waves, beach" (first three). */
export function titleFromTags(tags: string | null | undefined, fallback: string): string {
  const list = (tags ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 3);
  if (list.length === 0) return fallback;
  const s = list.join(', ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}
