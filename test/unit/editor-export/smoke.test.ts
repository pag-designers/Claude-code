import { describe, expect, it } from 'vitest';
import { flatClip, quadClip, haveFfmpeg, makeProject, track, vitem, kf } from './helpers';
import { parity, refPng } from './parity';
import { savePng, tmp } from './helpers';
import path from 'node:path';
import { flat, quad } from './reference';

describe.skipIf(!haveFfmpeg)('smoke', () => {
  it('transform quad', async () => {
    const q = quadClip(2);
    const specs = [{ id: 'q', kind: 'video' as const, path: q, w: 160, h: 284, fps: 30, dur: 2 }];
    const p = makeProject(
      [track('video', [vitem('i1', 'q', 0, 1.5, { transform: { x: { v: 10, kf: [] }, y: { v: -20, kf: [] }, scale: { v: 0.6, kf: [] }, rotation: { v: 0, kf: [kf(0, 0), kf(1.5, 45)] }, opacity: { v: 1, kf: [] } } })])],
      specs,
    );
    const r = await parity(p, specs, { q: { sampler: quad, w: 160, h: 284 } }, { frames: [0, 15, 30, 44] });
    const d = tmp('shots');
    savePng(r.out, 30, path.join(d, 'exp30.png'));
    console.log('REF', refPng(p, { q: { sampler: quad, w: 160, h: 284 } }, 1.0, 160, 284, 'ref30'), d);
    console.log(r.rows.filter((x) => Number(x.split('err ')[1]) > 8).join('\n'));
    console.log('MAX', r.maxErr, r.worst);
    expect(r.maxErr).toBeLessThan(12);
  });
});
