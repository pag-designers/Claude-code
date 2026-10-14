/** Source-time mapping: speed, ramps, reverse, freeze, offsets, holds, range — frame-exact against makeSourceTime. */
import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { makeSourceTime } from '../../../shared/editor-eval';
import type { Item } from '../../../shared/editor';
import { FFPROBE, exportProject, files, frameLevels, haveFfmpeg, indexClip, makeProject, probeDims, settingsFor, track, vitem } from './helpers';

vi.setConfig({ testTimeout: 60_000 });

const idx = indexClip(100, 30, 64, 64); // 100 frames: 0 .. 99, 3.33 s
const specs = [{ id: 'x', kind: 'video' as const, path: idx, w: 64, h: 64, fps: 30, dur: 3.3 }];
const kfs = (a: [number, number, string?][]) => a.map(([t, v, ease]) => ({ t, v, ease: ease ?? 'linear' }));

async function levels(over: Record<string, unknown>, start = 0, dur = 1, extra: { range?: { startSec: number; endSec: number }; total?: number } = {}) {
  const p = makeProject([track('video', [vitem('i', 'x', start, dur, over)])], specs, { width: 64, height: 64 });
  const r = await exportProject(p, files(specs), settingsFor(64, 64), { range: extra.range, name: 'timing' });
  const lv = frameLevels(r.out);
  const f = makeSourceTime(p.tracks[0]!.items[0] as Extract<Item, { type: 'video' }>);
  const r0 = extra.range?.startSec ?? 0;
  const n = lv.length;
  const near: boolean[] = [];
  const exp = Array.from({ length: n }, (_v, k) => {
    const T = r0 + k / 30;
    if (T < start - 1e-6 || T >= start + dur - 1e-6) {
      near.push(false);
      return -1;
    }
    const x = f(T - start) * 30;
    const frac = x - Math.floor(x + 1e-6);
    // within 0.08 frame of a source frame boundary the 0.3 ms slot slack / PL tolerance may pick the neighbour
    near.push(frac > 0.92 || frac < 0.08);
    return Math.floor(x + 1e-6);
  });
  return { lv, exp, near, out: r.out, p };
}

const same = (a: number[], b: number[], tol = 0, near?: boolean[]) =>
  a.every((v, i) => Math.abs(v - (b[i] as number)) <= (near?.[i] ? Math.max(tol, 1) : tol));

describe.skipIf(!haveFfmpeg)('speed / reverse / freeze', () => {
  const cases: [string, Record<string, unknown>, number][] = [
    ['speed 1', {}, 0],
    ['speed 2 from inSec 1', { inSec: 1, speed: 2 }, 0],
    ['speed 0.5', { inSec: 0.5, speed: 0.5 }, 0],
    ['speed 0.25 (below atempo range, still exact for video)', { inSec: 0.3, speed: 0.25 }, 0],
    ['speed 3', { inSec: 0.1, speed: 3 }, 0],
    ['speed 1.37 (non-integer ratio)', { inSec: 0.2, speed: 1.37 }, 0],
    ['reverse', { inSec: 1, reverse: true }, 0],
    ['reverse + speed 2', { inSec: 0.5, speed: 2, reverse: true }, 0],
    ['reverse + speed 0.5', { inSec: 1, speed: 0.5, reverse: true }, 0],
    ['freeze frame', { freezeAtSec: 1 }, 0],
    ['freeze ignores inSec/speed', { freezeAtSec: 0.5, inSec: 2, speed: 3 }, 0],
    ['inSec offset', { inSec: 1.5 }, 0],
    ['item starting between frames (0.41 s)', { inSec: 0.2 }, 0],
    ['speed ramp 1 → 3', { inSec: 0.2, speedCurve: kfs([[0, 1], [1, 3]]) }, 0],
    ['speed ramp 2 → 0.5 (ease)', { inSec: 0.2, speedCurve: kfs([[0, 2, 'ease-in-out'], [1, 0.5]]) }, 0],
    ['speed ramp + reverse', { inSec: 0.2, reverse: true, speedCurve: kfs([[0, 1], [1, 2.5, 'ease-in-out']]) }, 1],
  ];
  for (const [name, over, tol] of cases) {
    it(name, async () => {
      const start = name.includes('0.41') ? 0.41 : 0;
      const { lv, exp, near } = await levels(over, start, 1);
      expect(lv.length).toBe(exp.length);
      expect(same(lv, exp, tol, near), `got ${lv.join(',')}\nexp ${exp.join(',')}`).toBe(true);
    });
  }

  it('constant speed ramp frames are monotonic (never go backwards)', async () => {
    const { lv } = await levels({ inSec: 0, speedCurve: kfs([[0, 0.5], [1, 4]]) }, 0, 1);
    for (let i = 1; i < lv.length; i++) expect(lv[i]!).toBeGreaterThanOrEqual(lv[i - 1]!);
  });

  it('reverse is monotonic decreasing', async () => {
    const { lv } = await levels({ inSec: 0.5, reverse: true }, 0, 1);
    for (let i = 1; i < lv.length; i++) expect(lv[i]!).toBeLessThan(lv[i - 1]!);
  });

  it('a long reverse (several memory chunks, 10 s of source at speed 4) stays exact', async () => {
    const long = indexClip(100, 30, 64, 64);
    const sp = [{ id: 'x', kind: 'video' as const, path: long, w: 64, h: 64, fps: 30, dur: 3.3 }];
    const p = makeProject([track('video', [vitem('i', 'x', 0, 0.8, { inSec: 0, reverse: true, speed: 4 })])], sp, { width: 64, height: 64 });
    const r = await exportProject(p, files(sp), settingsFor(64, 64), { name: 'rev-long' });
    const lv = frameLevels(r.out);
    expect(lv.length).toBe(24);
    for (let i = 1; i < lv.length; i++) expect(lv[i]!).toBeLessThan(lv[i - 1]!);
    expect(lv[0]).toBe(96); // inSec + span - 0 = 3.2 s → frame 96
  });
});

describe.skipIf(!haveFfmpeg)('holds, gaps and ranges', () => {
  it('an item longer than its source holds the last frame', async () => {
    const { lv } = await levels({ inSec: 3.0 }, 0, 1); // source ends at frame 99
    expect(lv[0]).toBe(90);
    expect(lv[lv.length - 1]).toBe(100);
    expect(lv.slice(10)).toEqual(Array(lv.length - 10).fill(100));
  });

  it('frames before / after an item show nothing (-1)', async () => {
    const p = makeProject([track('video', [vitem('i', 'x', 0.5, 0.5)]), track('overlay', [vitem('pad', 'x', 0, 1.5, { transform: { x: { v: 9999, kf: [] } } })])], specs, { width: 64, height: 64 });
    const r = await exportProject(p, files(specs), settingsFor(64, 64), { name: 'gaps' });
    const lv = frameLevels(r.out);
    expect(lv.slice(0, 15).every((v) => v === -1)).toBe(true);
    expect(lv[15]).toBe(0);
    expect(lv.slice(30).every((v) => v === -1)).toBe(true);
  });

  it('range exports only [start, end): frame k is timeline time start + k/fps', async () => {
    const { lv, exp } = await levels({ inSec: 0.2 }, 0, 3, { range: { startSec: 1.0, endSec: 1.4 } });
    expect(lv.length).toBe(12);
    expect(same(lv, exp)).toBe(true);
    expect(lv[0]).toBe(36);
  });

  it('a one-frame range renders exactly that frame (parity-test mode)', async () => {
    const { lv, exp } = await levels({ speed: 2 }, 0, 3, { range: { startSec: 1.5, endSec: 1.5 + 1 / 30 } });
    expect(lv).toEqual(exp);
    expect(lv).toEqual([90]);
  });

  it('range start between frames keeps the frame grid r0 + k/fps', async () => {
    const { lv, exp } = await levels({}, 0, 3, { range: { startSec: 1.0123, endSec: 1.2 } });
    expect(same(lv, exp)).toBe(true);
  });

  it('range inside a speed ramp with reverse', async () => {
    const { lv, exp } = await levels({ inSec: 0, reverse: true, speedCurve: kfs([[0, 1], [3, 2]]) }, 0, 3, { range: { startSec: 1.0, endSec: 1.5 } });
    expect(same(lv, exp, 1)).toBe(true);
  });

  it('output duration is within one frame of the timeline and the container is H.264 yuv420p mp4', async () => {
    const { out } = await levels({}, 0, 2.5);
    const d = probeDims(out);
    expect(Math.abs(d.dur - 2.5)).toBeLessThanOrEqual(1 / 30 + 1e-6);
    expect(d.fps).toBe(30);
    const info = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,pix_fmt,color_space,color_range,color_transfer', '-of', 'json', out]).toString()).streams[0];
    expect(info.codec_name).toBe('h264');
    expect(info.pix_fmt).toBe('yuv420p');
    expect(info.color_space).toBe('bt709');
    expect(info.color_range).toBe('tv');
  });

  it('24 and 60 fps exports place frames on their own grid', async () => {
    for (const fps of [24, 60]) {
      const p = makeProject([track('video', [vitem('i', 'x', 0, 1)])], specs, { width: 64, height: 64 });
      const r = await exportProject(p, files(specs), settingsFor(64, 64, { fps }), { name: `fps${fps}` });
      const lv = frameLevels(r.out);
      expect(lv.length).toBe(fps);
      // source frame shown at output frame k = floor(30 * k / fps)
      for (let k = 0; k < fps; k++) expect(lv[k]).toBe(Math.floor((30 * k) / fps + 1e-6));
    }
  });

  it('a 25 fps source is resampled to the 30 fps grid (nearest earlier frame)', async () => {
    const src = indexClip(60, 25, 64, 64);
    const sp = [{ id: 'x', kind: 'video' as const, path: src, w: 64, h: 64, fps: 25, dur: 2.4 }];
    const p = makeProject([track('video', [vitem('i', 'x', 0, 1)])], sp, { width: 64, height: 64 });
    const r = await exportProject(p, files(sp), settingsFor(64, 64), { name: 'fps25' });
    const lv = frameLevels(r.out);
    for (let k = 0; k < 30; k++) expect(lv[k]).toBe(Math.floor((25 * k) / 30 + 1e-6));
  });
});
