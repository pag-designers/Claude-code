/**
 * Dominant-colour extraction: median cut in CIELAB over the exact colours of a downsampled image, representative =
 * the dominant exact colour of a cluster (so a flat logo colour comes back as its real hex), then a perceptual merge
 * of near-duplicates. Fully deterministic (no random init, stable tie-breaks).
 */

export interface Lab {
  l: number;
  a: number;
  b: number;
}

const srgbToLinear = (c: number): number => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const linearToSrgb = (v: number): number => {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.min(255, Math.max(0, Math.round(c * 255)));
};

const WHITE = { x: 0.95047, y: 1, z: 1.08883 };
const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
const finv = (t: number): number => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));

export function rgbToLab(r: number, g: number, b: number): Lab {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const x = 0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb;
  const y = 0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb;
  const z = 0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb;
  const fx = f(x / WHITE.x);
  const fy = f(y / WHITE.y);
  const fz = f(z / WHITE.z);
  return { l: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

export function labToRgb(c: Lab): [number, number, number] {
  const fy = (c.l + 16) / 116;
  const x = WHITE.x * finv(fy + c.a / 500);
  const y = WHITE.y * finv(fy);
  const z = WHITE.z * finv(fy - c.b / 200);
  return [
    linearToSrgb(3.2404542 * x - 1.5371385 * y - 0.4985314 * z),
    linearToSrgb(-0.969266 * x + 1.8760108 * y + 0.041556 * z),
    linearToSrgb(0.0556434 * x - 0.2040259 * y + 1.0572252 * z),
  ];
}

/** CIE76 colour difference (Euclidean in Lab); ~2.3 is a just-noticeable difference. */
export const deltaE = (p: Lab, q: Lab): number => Math.hypot(p.l - q.l, p.a - q.a, p.b - q.b);

export const toHex = (r: number, g: number, b: number): string =>
  `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`.toUpperCase();

interface Entry {
  /** 0xRRGGBB */
  rgb: number;
  lab: Lab;
  weight: number;
}

interface Box {
  entries: Entry[];
  weight: number;
  /** weighted sum of squared Lab distances to the weighted mean: how much the box is worth splitting */
  sse: number;
  mean: Lab;
}

function makeBox(entries: Entry[]): Box {
  let weight = 0;
  let l = 0;
  let a = 0;
  let b = 0;
  for (const e of entries) {
    weight += e.weight;
    l += e.lab.l * e.weight;
    a += e.lab.a * e.weight;
    b += e.lab.b * e.weight;
  }
  const mean = { l: l / weight, a: a / weight, b: b / weight };
  let sse = 0;
  for (const e of entries) {
    const d = deltaE(e.lab, mean);
    sse += e.weight * d * d;
  }
  return { entries, weight, sse, mean };
}

function splitBox(box: Box): [Box, Box] | null {
  if (box.entries.length < 2) return null;
  // split along the Lab axis with the widest spread
  const spread = (k: 'l' | 'a' | 'b'): number => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const e of box.entries) {
      lo = Math.min(lo, e.lab[k]);
      hi = Math.max(hi, e.lab[k]);
    }
    return hi - lo;
  };
  const axes: ('l' | 'a' | 'b')[] = ['l', 'a', 'b'];
  let axis: 'l' | 'a' | 'b' = 'l';
  let best = -1;
  for (const k of axes) {
    const s = spread(k);
    if (s > best) {
      best = s;
      axis = k;
    }
  }
  const sorted = [...box.entries].sort((p, q) => p.lab[axis] - q.lab[axis] || p.rgb - q.rgb);
  // weighted median, but never leave a side empty
  let acc = 0;
  let cut = 1;
  for (let i = 0; i < sorted.length - 1; i++) {
    acc += (sorted[i] as Entry).weight;
    cut = i + 1;
    if (acc >= box.weight / 2) break;
  }
  return [makeBox(sorted.slice(0, cut)), makeBox(sorted.slice(cut))];
}

export interface ExtractOptions {
  /** Pixels with alpha below this (0..255) are ignored. */
  alphaCutoff?: number;
  /** Colours closer than this (ΔE76) are the same swatch. */
  minDistance?: number;
  /** Swatches covering less than this share of the opaque pixels are dropped (anti-aliasing fringes). */
  minShare?: number;
}

/** `rgba`: tightly packed 8-bit RGBA. Returns `#RRGGBB`, most prominent first (fewer than `count` if the image has fewer). */
export function extractPalette(
  rgba: Uint8Array,
  count: number,
  opts: ExtractOptions = {},
): string[] {
  const want = Math.max(0, Math.floor(count));
  if (want === 0) return [];
  const alphaCutoff = opts.alphaCutoff ?? 128;
  const minDistance = opts.minDistance ?? 12;
  const minShare = opts.minShare ?? 0.005;

  const counts = new Map<number, number>();
  let total = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if ((rgba[i + 3] as number) < alphaCutoff) continue;
    const rgb =
      ((rgba[i] as number) << 16) | ((rgba[i + 1] as number) << 8) | (rgba[i + 2] as number);
    counts.set(rgb, (counts.get(rgb) ?? 0) + 1);
    total++;
  }
  if (total === 0) return [];

  const entries: Entry[] = [...counts.entries()]
    .sort((p, q) => p[0] - q[0])
    .map(([rgb, weight]) => ({
      rgb,
      weight,
      lab: rgbToLab((rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255),
    }));

  // median cut into more boxes than asked for, merged perceptually below
  const target = Math.min(64, Math.max(16, want * 4));
  const boxes: Box[] = [makeBox(entries)];
  while (boxes.length < target) {
    let idx = -1;
    let worst = 1e-9;
    boxes.forEach((b, i) => {
      if (b.entries.length > 1 && b.sse > worst) {
        worst = b.sse;
        idx = i;
      }
    });
    if (idx < 0) break;
    const parts = splitBox(boxes[idx] as Box);
    if (!parts) break;
    boxes.splice(idx, 1, parts[0], parts[1]);
  }

  interface Swatch {
    rgb: number;
    lab: Lab;
    weight: number;
  }
  const swatches: Swatch[] = boxes.map((b) => {
    // dominant exact colour wins when it carries at least half of the box; otherwise the (Lab) mean
    const top = b.entries.reduce((m, e) =>
      e.weight > m.weight || (e.weight === m.weight && e.rgb < m.rgb) ? e : m,
    );
    if (top.weight * 2 >= b.weight) return { rgb: top.rgb, lab: top.lab, weight: b.weight };
    const [r, g, bl] = labToRgb(b.mean);
    const rgb = (r << 16) | (g << 8) | bl;
    return { rgb, lab: rgbToLab(r, g, bl), weight: b.weight };
  });

  swatches.sort((p, q) => q.weight - p.weight || p.rgb - q.rgb);
  const kept: Swatch[] = [];
  for (const s of swatches) {
    let nearest: Swatch | null = null;
    let nd = Infinity;
    for (const k of kept) {
      const d = deltaE(k.lab, s.lab);
      if (d < nd) {
        nd = d;
        nearest = k;
      }
    }
    if (nearest && nd < minDistance) nearest.weight += s.weight;
    else kept.push({ ...s });
  }
  kept.sort((p, q) => q.weight - p.weight || p.rgb - q.rgb);
  const significant = kept.filter((k, i) => i === 0 || k.weight / total >= minShare);
  return significant
    .slice(0, want)
    .map((k) => toHex((k.rgb >> 16) & 255, (k.rgb >> 8) & 255, k.rgb & 255));
}
