/** Standard synthetic assets + reference sources shared by the parity tests (160x284 portrait canvas). */
import path from 'node:path';
import { ff, flatClip, quadClip, tmp, type AssetSpec } from './helpers';
import { flat, quad, type RefSource } from './reference';

const BT709 = [
  '-colorspace',
  'bt709',
  '-color_primaries',
  'bt709',
  '-color_trc',
  'bt709',
  '-color_range',
  'tv',
];

let wideCache: string | null = null;
/** 320x180 quadrant clip (landscape). */
export function wideQuad(): string {
  if (wideCache) return wideCache;
  const out = path.join(tmp('media'), 'quadwide.mp4');
  ff([
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=320x180:r=30:d=3',
    '-vf',
    'drawbox=x=0:y=0:w=160:h=90:color=0xFF0000:t=fill,drawbox=x=160:y=0:w=160:h=90:color=0x00FF00:t=fill,drawbox=x=0:y=90:w=160:h=90:color=0x0000FF:t=fill,drawbox=x=160:y=90:w=160:h=90:color=0xFFFF00:t=fill,format=rgb24,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
    ...BT709,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '10',
    out,
  ]);
  wideCache = out;
  return out;
}

export interface Std {
  specs: AssetSpec[];
  sources: Record<string, RefSource>;
}

/** q = portrait quadrants, w = wide quadrants, r/g/b/o/y = flat colours, all 3 s long. */
export function std(): Std {
  const mk = (id: string, p: string, w: number, h: number, dur = 3): AssetSpec => ({
    id,
    kind: 'video',
    path: p,
    w,
    h,
    fps: 30,
    dur,
  });
  const specs: AssetSpec[] = [
    mk('q', quadClip(3), 160, 284),
    mk('w', wideQuad(), 320, 180),
    mk('r', flatClip('FF0000', 3), 160, 284),
    mk('g', flatClip('00FF00', 3), 160, 284),
    mk('b', flatClip('0000FF', 3), 160, 284),
    mk('y', flatClip('FFFF00', 3), 160, 284),
    mk('o', flatClip('FF8030', 3), 160, 284),
    mk('m', flatClip('808080', 3), 160, 284),
  ];
  const sources: Record<string, RefSource> = {
    q: { sampler: quad, w: 160, h: 284 },
    w: { sampler: quad, w: 320, h: 180 },
    r: { sampler: flat('#FF0000'), w: 160, h: 284 },
    g: { sampler: flat('#00FF00'), w: 160, h: 284 },
    b: { sampler: flat('#0000FF'), w: 160, h: 284 },
    y: { sampler: flat('#FFFF00'), w: 160, h: 284 },
    o: { sampler: flat('#FF8030'), w: 160, h: 284 },
    m: { sampler: flat('#808080'), w: 160, h: 284 },
  };
  return { specs, sources };
}

export const A = (v: number, k: { t: number; v: number; ease?: string }[] = []) => ({
  v,
  kf: k.map((x) => ({ ease: 'linear', ...x })),
});

export const TR = (o: Record<string, unknown> = {}) => ({
  x: A(0),
  y: A(0),
  scale: A(1),
  rotation: A(0),
  opacity: A(1),
  ...o,
});
