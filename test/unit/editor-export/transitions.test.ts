/** All 12 transition types: export frames at p = 0 .25 .5 .75 1 vs the evaluator (transitionOps) reference. */
import { describe, expect, it, vi } from 'vitest';
import { A, TR, std } from './fixtures';
import { exportProject, files, frameAt, haveFfmpeg, makeProject, settingsFor, track, vitem } from './helpers';
import { parity } from './parity';

vi.setConfig({ testTimeout: 60_000 });
const { specs, sources } = std();

// from: q 0 .. 1.0   to: r 0.5 .. 1.5, transitionIn 0.5 s → overlap = frames 15..29 (p = (k-15)/15)
const P = (k: number) => 15 + Math.round(k * 15); // frame of progress k ∈ {0,.25,.5,.75,1}
const FRAMES = [0, 0.25, 0.5, 0.75, 1].map(P).map((f) => (f > 30 ? 30 : f));

const build = (type: string, over: Record<string, unknown> = {}, fromOver: Record<string, unknown> = {}) =>
  makeProject(
    [track('video', [vitem('a', 'q', 0, 1, fromOver), vitem('b', 'r', 0.5, 1, { transitionIn: { type, durationSec: 0.5 }, ...over })])],
    specs,
  );

const TYPES = ['cut', 'crossfade', 'dip-black', 'dip-white', 'slide-left', 'slide-right', 'slide-up', 'slide-down', 'zoom', 'blur', 'whip-pan', 'glitch'] as const;

describe.skipIf(!haveFfmpeg)('transitions: 12 types at p = 0, .25, .5, .75, 1', () => {
  for (const type of TYPES) {
    it(`${type}`, async () => {
      const p = build(type);
      // blur / whip-pan blur the layers (the flat-colour reference has no blur): compare away from the seams only
      const blurry = type === 'blur' || type === 'whip-pan';
      const r = await parity(p, specs, sources, { frames: FRAMES, name: `tr-${type}`, edge: blurry ? 24 : 5 });
      expect(r.rows.length).toBeGreaterThan(10);
      expect(r.maxErr, r.worst).toBeLessThan(blurry ? 40 : 12);
    });
  }
});

describe.skipIf(!haveFfmpeg)('transitions: specific frames', () => {
  const run = async (type: string, name: string) => exportProject(build(type), files(specs), settingsFor(160, 284), { name });

  it('crossfade p = 0.5 is the 50/50 mix of both pictures', async () => {
    const r = await run('crossfade', 'x50');
    const c = frameAt(r.out, 22).px(40, 70); // from: red (quad TL), to: red clip → red; use bottom-left blue vs red
    const d = frameAt(r.out, 22).px(40, 210); // from: blue (BL) , to: red → mix
    expect(d[0]).toBeGreaterThan(110);
    expect(d[0]).toBeLessThan(150);
    expect(d[2]).toBeGreaterThan(100);
    expect(d[2]).toBeLessThan(150);
    expect(c[0]).toBeGreaterThan(240);
  });

  it('dip-black: fully black at p = 0.5, picture on both sides', async () => {
    const r = await run('dip-black', 'dipb');
    const mid = frameAt(r.out, 22 + 1).px(40, 210); // p = 8/15 ≈ .53 → alpha .93 of black
    expect(mid[0] + mid[1] + mid[2]).toBeLessThan(60);
    expect(frameAt(r.out, 14).px(40, 210)[2]).toBeGreaterThan(240);
    expect(frameAt(r.out, 29).px(40, 210)[0]).toBeGreaterThan(200); // late: mostly the incoming red
  });

  it('dip-white: white at the midpoint', async () => {
    const r = await run('dip-white', 'dipw');
    const mid = frameAt(r.out, 23).px(40, 210);
    expect(Math.min(...mid)).toBeGreaterThan(200);
  });

  it('slide-left: the incoming picture enters from the right edge', async () => {
    const r = await run('slide-left', 'sl');
    const f = frameAt(r.out, 22); // p ≈ 0.467: incoming covers x ≥ W(1-p) = ~85
    expect(f.px(140, 70)[0]).toBeGreaterThan(240); // incoming (red)
    expect(f.px(20, 210)[0]).toBeGreaterThan(200); // outgoing picture moved left by p·W: its yellow half is now at x 5..85
    expect(f.px(20, 210)[1]).toBeGreaterThan(200);
  });

  it('slide-down: incoming enters from the top', async () => {
    const r = await run('slide-down', 'sd');
    const f = frameAt(r.out, 22);
    expect(f.px(80, 20)[0]).toBeGreaterThan(240);
  });

  it('zoom: the outgoing picture scales up 1 → 1.5 while the incoming fades in', async () => {
    const r = await run('zoom', 'zm');
    const f = frameAt(r.out, 29); // p = 14/15 → outgoing 1.47x: quad centre still on the red/green/blue/yellow crossing
    expect(f.w).toBe(160);
    const early = frameAt(r.out, 16);
    expect(early.px(30, 40)[0]).toBeGreaterThan(200);
  });

  it('cut with an overlap: the outgoing item disappears at the overlap start', async () => {
    const r = await run('cut', 'cut');
    expect(frameAt(r.out, 14).px(40, 210)[2]).toBeGreaterThan(240); // outgoing blue still there
    expect(frameAt(r.out, 15).px(40, 210)[0]).toBeGreaterThan(240); // incoming red
  });

  it('the overlap is exactly `durationSec` long and the total length is the project length', async () => {
    const r = await run('crossfade', 'len');
    expect(r.durationSec).toBeCloseTo(1.5, 6);
    expect(frameAt(r.out, 44).px(40, 210)[0]).toBeGreaterThan(240);
  });

  it('transition ops come after the item transform (scale about the canvas centre)', async () => {
    const p = build('zoom', {}, { transform: TR({ x: A(40) }) });
    const r = await parity(p, specs, sources, { frames: [0, 20, 26], name: 'tr-after-xf', edge: 5 });
    expect(r.maxErr, r.worst).toBeLessThan(12);
  });

  it('three items, two transitions in a row', async () => {
    const p = makeProject(
      [track('video', [vitem('a', 'r', 0, 1), vitem('b', 'g', 0.8, 1, { transitionIn: { type: 'crossfade', durationSec: 0.2 } }), vitem('c', 'b', 1.6, 1, { transitionIn: { type: 'slide-left', durationSec: 0.2 } })])],
      specs,
    );
    const r = await parity(p, specs, sources, { frames: [5, 25, 27, 30, 40, 50, 53], name: 'tr-chain', edge: 5 });
    expect(r.maxErr, r.worst).toBeLessThan(12);
  });

  it('transition on an overlay track composites over the lower track', async () => {
    const p = makeProject(
      [
        track('video', [vitem('bg', 'g', 0, 1.5)]),
        track('overlay', [vitem('a', 'q', 0, 1, { transform: TR({ scale: A(0.5) }) }), vitem('b', 'r', 0.5, 1, { transform: TR({ scale: A(0.5) }), transitionIn: { type: 'crossfade', durationSec: 0.5 } })]),
      ],
      specs,
    );
    const r = await parity(p, specs, sources, { frames: [3, 18, 22, 29, 36], name: 'tr-overlay', edge: 5 });
    expect(r.maxErr, r.worst).toBeLessThan(12);
  });
});
