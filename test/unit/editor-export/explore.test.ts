import { describe, expect, it } from 'vitest';
import { flatClip, quadClip, haveFfmpeg, makeProject, track, vitem, kf, ff, tmp } from './helpers';
import { parity } from './parity';
import { flat, quad } from './reference';
import path from 'node:path';

const TR = (o: Record<string, unknown>) => ({ x: { v: 0, kf: [] }, y: { v: 0, kf: [] }, scale: { v: 1, kf: [] }, rotation: { v: 0, kf: [] }, opacity: { v: 1, kf: [] }, ...o });
const A = (v: number, k: { t: number; v: number; ease?: string }[] = []) => ({ v, kf: k.map((x) => ({ ease: 'linear', ...x })) });

function wideQuad(): string {
  const out = path.join(tmp('media'), 'quadwide.mp4');
  ff(['-f','lavfi','-i','color=c=black:s=320x180:r=30:d=2','-vf','drawbox=x=0:y=0:w=160:h=90:color=0xFF0000:t=fill,drawbox=x=160:y=0:w=160:h=90:color=0x00FF00:t=fill,drawbox=x=0:y=90:w=160:h=90:color=0x0000FF:t=fill,drawbox=x=160:y=90:w=160:h=90:color=0xFFFF00:t=fill,format=rgb24,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p','-colorspace','bt709','-color_primaries','bt709','-color_trc','bt709','-color_range','tv','-c:v','libx264','-preset','ultrafast','-crf','10',out]);
  return out;
}

describe.skipIf(!haveFfmpeg)('explore', () => {
  const portrait = quadClip(2);
  const wide = wideQuad();
  const specs = [
    { id: 'q', kind: 'video' as const, path: portrait, w: 160, h: 284, fps: 30, dur: 2 },
    { id: 'w', kind: 'video' as const, path: wide, w: 320, h: 180, fps: 30, dur: 2 },
    { id: 'r', kind: 'video' as const, path: flatClip('FF0000', 2), w: 160, h: 284, fps: 30, dur: 2 },
    { id: 'b', kind: 'video' as const, path: flatClip('0000FF', 2), w: 160, h: 284, fps: 30, dur: 2 },
  ];
  const sources = { q: { sampler: quad, w: 160, h: 284 }, w: { sampler: quad, w: 320, h: 180 }, r: { sampler: flat('#FF0000'), w: 160, h: 284 }, b: { sampler: flat('#0000FF'), w: 160, h: 284 } };
  const run = async (name: string, items: Record<string, unknown>[], frames: number[], extraTracks: ReturnType<typeof track>[] = [], over: Partial<Parameters<typeof parity>[3]> = {}) => {
    const p = makeProject([track('video', items), ...extraTracks], specs);
    const r = await parity(p, specs, sources, { frames, name, ...over });
    const bad = r.rows.filter((x) => Number(x.split("err ")[1]) > 5);
    console.log(`[${name}] max ${r.maxErr} ${r.rows.length} pts`, bad.slice(0, 4).join(' | '));
    return r;
  };
  it('fit', async () => {
    for (const fit of ['cover', 'contain', 'native']) await run(`fit-${fit}`, [vitem('i', 'w', 0, 1, { fit })], [0, 10]);
  });
  it('crop', async () => {
    await run('crop-static', [vitem('i', 'q', 0, 1, { crop: { x: A(0.25), y: A(0.25), w: A(0.5), h: A(0.5) } })], [0, 10]);
    await run('crop-wide-static', [vitem('i', 'w', 0, 1, { crop: { x: A(0.2), y: A(0), w: A(0.5), h: A(1) } })], [0, 10]);
    await run('crop-pan', [vitem('i', 'w', 0, 1, { crop: { x: A(0, [{ t: 0, v: 0 }, { t: 1, v: 0.5 }]), y: A(0), w: A(0.5), h: A(1) } })], [0, 5, 15, 29]);
    await run('crop-zoom', [vitem('i', 'w', 0, 1, { crop: { x: A(0, [{ t: 0, v: 0 }, { t: 1, v: 0.25 }]), y: A(0), w: A(1, [{ t: 0, v: 1 }, { t: 1, v: 0.5 }]), h: A(1, [{ t: 0, v: 1 }, { t: 1, v: 0.5 }]) } })], [0, 15, 29]);
  });
  it('mirror/opacity/scale', async () => {
    await run('mirror', [vitem('i', 'q', 0, 1, { mirror: true })], [0]);
    await run('opacity', [vitem('i', 'r', 0, 1, { transform: TR({ opacity: A(0.4) }) })], [0], [track('video', [vitem('u', 'b', 0, 1)])].slice(0, 0));
    await run('scale-anim', [vitem('i', 'q', 0, 1, { transform: TR({ scale: A(1, [{ t: 0, v: 0.5 }, { t: 1, v: 1.5 }]) }) })], [0, 15, 29]);
    await run('rot-anim', [vitem('i', 'q', 0, 1, { transform: TR({ scale: A(0.5), rotation: A(0, [{ t: 0, v: 0 }, { t: 1, v: 90 }]) }) })], [0, 15, 29]);
  });
  it('stack', async () => {
    const top = track('overlay', [vitem('o', 'q', 0, 1, { transform: TR({ opacity: A(0.5), scale: A(0.5), x: A(20) }) })]);
    await run('opacity-over', [vitem('i', 'b', 0, 1)], [0, 15], [top]);
    for (const blend of ['multiply', 'screen', 'overlay', 'add', 'darken', 'lighten']) {
      const t = track('overlay', [vitem('o', 'q', 0, 1, { blend, transform: TR({ scale: A(0.8) }) })]);
      const r = await run(`blend-${blend}`, [vitem('i', 'b', 0, 1, { transform: TR({ scale: A(1) }) })], [3], [t]);
      void r;
    }
  });
});

describe.skipIf(!haveFfmpeg)('explore2', () => {
  const specs = [
    { id: 'r', kind: 'video' as const, path: flatClip('FF0000', 3), w: 160, h: 284, fps: 30, dur: 3 },
    { id: 'b', kind: 'video' as const, path: flatClip('0000FF', 3), w: 160, h: 284, fps: 30, dur: 3 },
    { id: 'q', kind: 'video' as const, path: quadClip(3), w: 160, h: 284, fps: 30, dur: 3 },
  ];
  const sources = { r: { sampler: flat('#FF0000'), w: 160, h: 284 }, b: { sampler: flat('#0000FF'), w: 160, h: 284 }, q: { sampler: quad, w: 160, h: 284 } };
  it('transitions', async () => {
    const types = ['crossfade', 'dip-black', 'dip-white', 'slide-left', 'slide-right', 'slide-up', 'slide-down', 'zoom', 'blur', 'whip-pan', 'glitch', 'cut'];
    for (const type of types) {
      // from: q 0..1.0 ; to: b 0.5..1.5 with transitionIn dur 0.5 (overlap)
      const p = makeProject([track('video', [vitem('a', 'q', 0, 1.0), vitem('b', 'r', 0.5, 1.0, { transitionIn: { type, durationSec: 0.5 } })])], specs);
      const r = await parity(p, specs, sources, { frames: [14, 15, 18, 21, 24, 27, 29, 30, 35], name: `tr-${type}`, edge: 5 });
      const bad = r.rows.filter((x) => Number(x.split('err ')[1]) > 12);
      console.log(`[tr-${type}] max ${r.maxErr} ${r.rows.length} pts`, bad.slice(0, 3).join(' | '));
    }
  });
});

import { indexClip, frameLevels, exportProject, files, settingsFor } from './helpers';
import { makeSourceTime } from '../../../shared/editor-eval';
import { projectSchema } from '../../../shared/editor';

describe.skipIf(!haveFfmpeg)('explore3', () => {
  const idx = indexClip(100, 30, 64, 64);
  const specs = [{ id: 'x', kind: 'video' as const, path: idx, w: 64, h: 64, fps: 30, dur: 3.33 }];
  const cases: [string, Record<string, unknown>, number, number][] = [
    ['speed1', {}, 0, 1],
    ['speed2-in1', { inSec: 1.0, speed: 2 }, 0, 1],
    ['speed.5', { inSec: 0.5, speed: 0.5 }, 0, 1],
    ['reverse', { inSec: 1.0, reverse: true }, 0, 1],
    ['reverse-speed2', { inSec: 0.5, speed: 2, reverse: true }, 0, 1],
    ['freeze', { freezeAtSec: 1.0 }, 0, 1],
    ['offset.41', { inSec: 0.2 }, 0.41, 1],
    ['ramp', { inSec: 0.2, speedCurve: [{ t: 0, v: 1, ease: 'linear' }, { t: 1, v: 3, ease: 'linear' }] }, 0, 1],
    ['ramp-reverse', { inSec: 0.2, reverse: true, speedCurve: [{ t: 0, v: 1, ease: 'linear' }, { t: 1, v: 2.5, ease: 'ease-in-out' }] }, 0, 1],
  ];
  for (const [name, over, start, dur] of cases) {
    it(name, async () => {
      const p = makeProject([track('video', [vitem('i', 'x', start, dur, over)])], specs, { width: 64, height: 64 });
      const r = await exportProject(p, files(specs), settingsFor(64, 64), { name });
      const lv = frameLevels(r.out);
      const it0 = p.tracks[0]!.items[0] as never;
      const f = makeSourceTime(it0);
      const total = Math.round((start + dur) * 30);
      const exp: (number | null)[] = [];
      for (let k = 0; k < total; k++) {
        const T = k / 30;
        if (T < start - 1e-6) exp.push(null);
        else exp.push(Math.floor(f(T - start) * 30 + 1e-6));
      }
      const diffs = lv.map((v, k) => (exp[k] === null ? 0 : v - (exp[k] as number)));
      console.log(`[${name}] frames ${lv.length}/${total}`, 'maxdiff', Math.max(...diffs.map(Math.abs)), 'got', lv.slice(start ? 12 : 0, (start ? 12 : 0) + 8).join(','), 'exp', exp.slice(start ? 12 : 0, (start ? 12 : 0) + 8).join(','));
    });
  }
});
