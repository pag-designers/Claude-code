import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Project } from '@shared/editor';
import { projectProblems } from '../../renderer/lib/editor/core/ops';
import { A, C, S, T, V, asset, makeStore, proj, track } from './editor-core-fixtures';

/** 3,000 items: 1,400 clips on the main track (with gaps), 600 overlays, 600 captions, 300 texts, 100 music. */
function bigProject(): Project {
  const run = <X>(n: number, step: number, dur: number, mk: (i: number, s: number) => X): X[] =>
    Array.from({ length: n }, (_, i) => mk(i, i * step));
  return proj(
    [
      track('v1', 'video', run(1400, 1.2, 1, (i, s) => V(`v${i}`, s, 1, { inSec: (i % 50) + 1, transitionIn: null }))),
      track('ov', 'overlay', run(600, 2.8, 2.5, (i, s) => (i % 2 ? S(`s${i}`, s, 2.5) : V(`ov${i}`, s, 2.5, { inSec: 3 })))),
      track('cap', 'subtitle', run(600, 2.8, 2.5, (i, s) => C(`c${i}`, s, 2.5, [['a', 0, 0.5], ['b', 0.6, 1.2], ['c', 1.3, 2]]))),
      track('tx', 'text', run(300, 5.6, 5, (i, s) => T(`t${i}`, s, 5))),
      track('m', 'audio', run(100, 17, 16, (i, s) => A(`m${i}`, s, 16, { inSec: 10 }))),
    ],
    { assets: [asset('av', 'video', 60), asset('aa', 'audio', 120, { beats: Array.from({ length: 200 }, (_, i) => i * 0.5) }), asset('ai', 'image', null)] },
  );
}

const report = (name: string, ms: number) => {
  if (process.env.EDITOR_PERF_REPORT) appendFileSync(process.env.EDITOR_PERF_REPORT, `${name}: ${ms.toFixed(2)} ms\n`);
};
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;
function time(fn: () => void, runs = 21): number {
  for (let i = 0; i < 3; i++) fn(); // warm up
  const ts: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    ts.push(performance.now() - t0);
  }
  return median(ts);
}

describe('performance on a 3,000-item project', () => {
  const p = bigProject();
  const total = p.tracks.reduce((n, t) => n + t.items.length, 0);

  it('fixture really has 3,000 items and is valid', () => {
    expect(total).toBe(3000);
    expect(projectProblems(p)).toEqual([]);
  });

  it('a drag preview (snap + validity) takes < 8 ms', () => {
    const st = makeStore(p);
    let d = 0;
    const ms = time(() => {
      d += 0.37;
      st.getState().previewMove(['v700'], 5 + (d % 3), 'v1', { pxPerSec: 100 });
    });
    report('preview single', ms);
    expect(ms).toBeLessThan(8);
  });

  it('a drag preview of a 50-item multi-selection takes < 8 ms', () => {
    const st = makeStore(p);
    const ids = Array.from({ length: 50 }, (_, i) => `v${200 + i}`);
    let d = 0;
    const ms = time(() => {
      d += 0.21;
      st.getState().previewMove(ids, 3 + (d % 2), null, { pxPerSec: 100 });
    });
    report('preview 50 items', ms);
    expect(ms).toBeLessThan(8);
  });

  it('applying edits takes < 25 ms each', () => {
    const cases: [string, (s: ReturnType<typeof makeStore>) => void][] = [
      ['move', (s) => s.getState().applyMoves([{ itemId: 'v700', trackId: 'v1', startSec: 840.4 + Math.random() * 0.2 }])],
      ['trim', (s) => s.getState().trim('v300', 'end', 360.5 + Math.random() * 0.3, { snap: false })],
      ['ripple trim', (s) => s.getState().trim('v300', 'end', 360.5 + Math.random() * 0.3, { snap: false, ripple: true })],
      ['split', (s) => void s.getState().split('v400', 480.5 + Math.random() * 0.2)],
      ['delete', (s) => s.getState().deleteItems(['v500'])],
      ['ripple delete', (s) => s.getState().deleteItems(['v600'], { ripple: true })],
      ['setProp', (s) => s.getState().setProp('v100', 'transform.x', Math.random() * 100)],
      ['updateItem', (s) => s.getState().updateItem('v101', { fit: 'contain' })],
      ['setTransition', (s) => s.getState().setTransition('v900', { type: 'crossfade', durationSec: 0.2 })],
      ['setSpeed', (s) => s.getState().setSpeed('v800', 1.5)],
      ['duplicate', (s) => void s.getState().duplicateItems(['v1000'])],
      ['cue text', (s) => s.getState().setCueText('c10', 'a b c d')],
      ['addAsset', (s) => void s.getState().addAsset('aa', { startSec: 5000 })],
      ['delete gaps', (s) => s.getState().deleteGaps('v1')],
    ];
    for (const [name, run] of cases) {
      const times: number[] = [];
      for (let k = 0; k < 7; k++) {
        const st = makeStore(p);
        const t0 = performance.now();
        run(st);
        times.push(performance.now() - t0);
      }
      report(name, median(times));
      expect(median(times), name).toBeLessThan(25);
    }
  });

  it('select-all + delete and select-all + split stay interactive (< 150 ms)', () => {
    const st = makeStore(p);
    st.getState().selectAll();
    const t0 = performance.now();
    st.getState().deleteItems(st.getState().selection.itemIds);
    expect(performance.now() - t0).toBeLessThan(150);
    const st2 = makeStore(p);
    st2.getState().selectAll();
    st2.getState().setPlayhead(100.3);
    const t1 = performance.now();
    st2.getState().split(null);
    expect(performance.now() - t1).toBeLessThan(150);
  });

  it('200 undo levels on 3,000 items stay cheap: each step < 25 ms, undo-all and redo-all < 100 ms, memory shared', () => {
    const st = makeStore(p);
    const worst: number[] = [];
    for (let i = 0; i < 200; i++) {
      const t0 = performance.now();
      st.getState().trim(`v${i}`, 'end', i * 1.2 + 0.5 + (i % 3) * 0.1, { snap: false });
      worst.push(performance.now() - t0);
    }
    expect(median(worst)).toBeLessThan(25);
    expect(Math.max(...worst)).toBeLessThan(120);
    const t1 = performance.now();
    let n = 0;
    while (st.getState().canUndo) {
      st.getState().undo();
      n++;
    }
    const undoAll = performance.now() - t1;
    expect(n).toBe(200);
    expect(undoAll).toBeLessThan(100);
    expect(st.getState().project.tracks[0]).toBe(p.tracks[0]);
    const t2 = performance.now();
    while (st.getState().canRedo) st.getState().redo();
    expect(performance.now() - t2).toBeLessThan(100);
  });

  it('snap candidate index is reused between previews of the same project', () => {
    const st = makeStore(p);
    const cold = time(() => st.getState().previewMove(['v10'], 1, null, { pxPerSec: 100 }), 1);
    const warm = time(() => st.getState().previewMove(['v10'], 1.01, null, { pxPerSec: 100 }), 15);
    expect(warm).toBeLessThan(8);
    expect(cold).toBeLessThan(60);
  });
});
