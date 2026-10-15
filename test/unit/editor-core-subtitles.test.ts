import { describe, expect, it } from 'vitest';
import type { SubtitleItem } from '@shared/editor';
import {
  mergeCueWithNextOp,
  projectProblems,
  replaceCuesOp,
  retimeCueOp,
  retimeWordsForText,
  setCueTextOp,
  splitCueOp,
  tokenize,
} from '../../renderer/lib/editor/core/ops';
import { C, T, V, item, items, proj, spans, track } from './editor-core-fixtures';

const healthy = (p: Parameters<typeof projectProblems>[0]) =>
  expect(projectProblems(p)).toEqual([]);
const cue = (p: ReturnType<typeof proj>, id: string) => item(p, id) as SubtitleItem;
const W = (...a: [string, number, number][]) => a.map(([w, s, e]) => ({ w, s, e, color: null }));

const base = () =>
  proj([
    track('s', 'subtitle', [
      C('c1', 0, 4, [
        ['hello', 0, 0.8],
        ['big', 1, 1.5],
        ['world', 2, 3.5],
      ]),
      C('c2', 5, 3, [
        ['second', 0, 1],
        ['cue', 1.2, 2],
      ]),
    ]),
  ]);

describe('setCueText', () => {
  it('unchanged words keep their timing', () => {
    const r = setCueTextOp(base(), 'c1', 'hello big world today');
    const w = cue(r, 'c1').words;
    expect(w.slice(0, 3).map((x) => [x.w, x.s, x.e])).toEqual([
      ['hello', 0, 0.8],
      ['big', 1, 1.5],
      ['world', 2, 3.5],
    ]);
    expect(w[3]?.w).toBe('today');
    healthy(r);
  });

  it('a replaced word takes over the timing of the word it replaces', () => {
    const r = setCueTextOp(base(), 'c1', 'hello small world');
    const w = cue(r, 'c1').words;
    expect(w[1]).toMatchObject({ w: 'small', s: 1, e: 1.5 });
    expect(w[0]?.s).toBe(0);
    expect(w[2]).toMatchObject({ w: 'world', s: 2, e: 3.5 });
  });

  it('several replacing words share the replaced span', () => {
    const r = setCueTextOp(base(), 'c1', 'hello a very big thing');
    const w = cue(r, 'c1').words;
    const mid = w.filter((x) => ['a', 'very'].includes(x.w));
    expect(mid.length).toBe(2);
    // "big" kept → 'a very' is an insertion between hello(…0.8) and big(1…1.5); the gap is a bit small,
    // so a sliver is borrowed from the neighbours but their order and rough timing hold
    const big = w.find((x) => x.w === 'big')!;
    expect(mid[0]!.s).toBeGreaterThanOrEqual(0.5);
    expect(mid[1]!.e).toBeLessThanOrEqual(big.s + 1e-9);
    expect(big.s).toBeLessThan(1.1);
    expect(big.e).toBe(1.5);
    healthy(r);
  });

  it('a pure insertion shares the gap between neighbours', () => {
    const r = setCueTextOp(base(), 'c1', 'hello and big world');
    const w = cue(r, 'c1').words;
    const and = w[1]!;
    expect(and.w).toBe('and');
    expect(and.s).toBeGreaterThanOrEqual(0.8 - 1e-9);
    expect(and.e).toBeLessThanOrEqual(1 + 1e-9);
    expect(and.e - and.s).toBeGreaterThan(0.05);
    healthy(r);
  });

  it('insertion with no gap borrows time from the neighbours', () => {
    const p = proj([
      track('s', 'subtitle', [
        C('c', 0, 2, [
          ['a', 0, 1],
          ['b', 1, 2],
        ]),
      ]),
    ]);
    const r = setCueTextOp(p, 'c', 'a new b');
    const w = cue(r, 'c').words;
    expect(w.map((x) => x.w)).toEqual(['a', 'new', 'b']);
    expect(w[1]!.e - w[1]!.s).toBeGreaterThan(0.05);
    expect(w[0]!.e).toBeLessThanOrEqual(w[1]!.s + 1e-9);
    expect(w[1]!.e).toBeLessThanOrEqual(w[2]!.s + 1e-9);
    healthy(r);
  });

  it('words appended at the end and inserted at the start get time too', () => {
    const p = proj([
      track('s', 'subtitle', [
        C('c', 0, 2, [
          ['a', 0, 1],
          ['b', 1, 2],
        ]),
      ]),
    ]);
    const end = cue(setCueTextOp(p, 'c', 'a b c'), 'c').words;
    expect(end[2]!.w).toBe('c');
    expect(end[2]!.e - end[2]!.s).toBeGreaterThan(0.05);
    const start = cue(setCueTextOp(p, 'c', 'z a b'), 'c').words;
    expect(start[0]!.w).toBe('z');
    expect(start[0]!.e - start[0]!.s).toBeGreaterThan(0.05);
    healthy(setCueTextOp(p, 'c', 'z a b c'));
  });

  it('deleting words keeps the rest', () => {
    const r = setCueTextOp(base(), 'c1', 'hello world');
    expect(cue(r, 'c1').words.map((x) => [x.w, x.s])).toEqual([
      ['hello', 0],
      ['world', 2],
    ]);
  });

  it('completely new text spreads over the old span', () => {
    const r = setCueTextOp(base(), 'c1', 'totally different words');
    const w = cue(r, 'c1').words;
    expect(w[0]!.s).toBeCloseTo(0);
    expect(w.at(-1)!.e).toBeCloseTo(3.5);
    for (let i = 1; i < w.length; i++) expect(w[i]!.s).toBeGreaterThanOrEqual(w[i - 1]!.e - 1e-9);
  });

  it('from an empty cue the words share the whole cue', () => {
    const p = proj([track('s', 'subtitle', [C('c', 0, 3, [])])]);
    const w = cue(setCueTextOp(p, 'c', 'one two three'), 'c').words;
    expect(w[0]!.s).toBe(0);
    expect(w.at(-1)!.e).toBeCloseTo(3);
  });

  it('empty text empties the cue; whitespace-only equals empty', () => {
    expect(cue(setCueTextOp(base(), 'c1', '   '), 'c1').words).toEqual([]);
  });

  it("unchanged text → same project; extra spaces don't matter", () => {
    const p = base();
    expect(setCueTextOp(p, 'c1', 'hello   big world')).toBe(p);
  });

  it('keeps per-word colour of retained words', () => {
    const p = proj([
      track('s', 'subtitle', [
        C('c', 0, 2, [
          ['a', 0, 1],
          ['b', 1, 2],
        ]),
      ]),
    ]);
    const coloured = {
      ...p,
      tracks: [
        {
          ...p.tracks[0]!,
          items: [
            { ...cue(p, 'c'), words: cue(p, 'c').words.map((w) => ({ ...w, color: '#FF0000' })) },
          ],
        },
      ],
    };
    const r = setCueTextOp(coloured as typeof p, 'c', 'a x b');
    expect(cue(r, 'c').words.map((w) => w.color)).toEqual(['#FF0000', null, '#FF0000']);
  });

  it('only subtitle cues; locked rejected', () => {
    const p = proj([track('o', 'overlay', [T('t', 0, 2)])]);
    expect(setCueTextOp(p, 't', 'x')).toBe(p);
    const l = proj([track('s', 'subtitle', [C('c', 0, 2)], { locked: true })]);
    expect(setCueTextOp(l, 'c', 'changed')).toBe(l);
  });

  it('retimeWordsForText stays inside the cue and ordered (property sample)', () => {
    const old = W(['a', 0, 0.4], ['b', 0.4, 0.9], ['c', 1, 1.8], ['d', 1.8, 2.0]);
    for (const text of [
      'a b c d',
      'x a b',
      'a b c d e f g h',
      'd c b a',
      'a q q q d',
      'q',
      'a',
      'a b b b c d',
    ]) {
      const w = retimeWordsForText(old, text, 2);
      expect(w.map((x) => x.w)).toEqual(tokenize(text));
      let last = 0;
      for (const x of w) {
        expect(x.s).toBeGreaterThanOrEqual(last - 1e-9);
        expect(x.e).toBeGreaterThanOrEqual(x.s);
        expect(x.e).toBeLessThanOrEqual(2 + 1e-9);
        last = x.s;
      }
    }
  });
});

describe('splitCue', () => {
  it('splits at a word index into two cues, the second right after', () => {
    const r = splitCueOp(base(), 'c1', 1);
    expect(r.newId).toBeTruthy();
    const [a, b] = items(r.project, 's') as SubtitleItem[];
    expect(a?.words.map((w) => w.w)).toEqual(['hello']);
    expect(b?.words.map((w) => w.w)).toEqual(['big', 'world']);
    expect(b?.id).toBe(r.newId);
    expect(a!.startSec + a!.durationSec).toBeCloseTo(b!.startSec);
    expect(b!.startSec + b!.durationSec).toBeCloseTo(4);
    // right words are local to the new cue and keep their relative timing
    expect(b!.words[1]!.s - b!.words[0]!.s).toBeCloseTo(1);
    healthy(r.project);
  });

  it('refuses index 0, n and out of range', () => {
    const p = base();
    expect(splitCueOp(p, 'c1', 0)).toEqual({ project: p, newId: null });
    expect(splitCueOp(p, 'c1', 3)).toEqual({ project: p, newId: null });
    expect(splitCueOp(p, 'c1', 1.5).newId).toBeNull();
    expect(splitCueOp(p, 'nope', 1).newId).toBeNull();
  });

  it('keeps the style on both cues', () => {
    const p = proj([
      track('s', 'subtitle', [
        C(
          'c',
          0,
          3,
          [
            ['a', 0, 1],
            ['b', 1.5, 3],
          ],
          { styleId: 'boxed' },
        ),
      ]),
    ]);
    const r = splitCueOp(p, 'c', 1).project;
    expect((items(r, 's') as SubtitleItem[]).map((c) => c.styleId)).toEqual(['boxed', 'boxed']);
  });
});

describe('mergeCueWithNext', () => {
  it('merges words with times shifted by the gap', () => {
    const r = mergeCueWithNextOp(base(), 'c1');
    expect(items(r, 's').length).toBe(1);
    const c = cue(r, 'c1');
    expect(c.words.map((w) => w.w)).toEqual(['hello', 'big', 'world', 'second', 'cue']);
    expect(c.words[3]!.s).toBeCloseTo(5);
    expect(c.durationSec).toBeCloseTo(8);
    healthy(r);
  });

  it('does nothing on the last cue or when the neighbour is not a cue', () => {
    const p = base();
    expect(mergeCueWithNextOp(p, 'c2')).toBe(p);
  });

  it('split then merge round-trips the words', () => {
    const p = base();
    const s = splitCueOp(p, 'c1', 2).project;
    const m = mergeCueWithNextOp(s, 'c1');
    expect(cue(m, 'c1').words.map((w) => w.w)).toEqual(['hello', 'big', 'world']);
    expect(cue(m, 'c1').words[2]!.s).toBeCloseTo(2);
    expect(cue(m, 'c1').durationSec).toBeCloseTo(4);
  });
});

describe('retimeCue', () => {
  it('moves the edges and rescales word times', () => {
    const r = retimeCueOp(base(), 'c2', 5, 11);
    const c = cue(r, 'c2');
    expect([c.startSec, c.durationSec]).toEqual([5, 6]);
    expect(c.words[0]).toMatchObject({ s: 0, e: 2 });
    expect(c.words[1]!.s).toBeCloseTo(2.4);
    expect(c.words[1]!.e).toBeCloseTo(4);
    healthy(r);
  });

  it('a pure shift keeps durations and word offsets', () => {
    const r = retimeCueOp(base(), 'c2', 6, 9);
    const c = cue(r, 'c2');
    expect(c.startSec).toBe(6);
    expect(c.words[1]!.s).toBeCloseTo(1.2);
  });

  it('is limited by neighbours and 0', () => {
    const r = retimeCueOp(base(), 'c2', 1, 20);
    expect(cue(r, 'c2').startSec).toBe(4);
    const r0 = retimeCueOp(base(), 'c1', -5, 3);
    expect(cue(r0, 'c1').startSec).toBe(0);
    const r2 = retimeCueOp(base(), 'c1', 0, 30);
    expect(cue(r2, 'c1').startSec + cue(r2, 'c1').durationSec).toBeCloseTo(5);
    healthy(r2);
  });

  it('enforces the 0.04 s minimum and ignores non-finite input', () => {
    const r = retimeCueOp(base(), 'c2', 7, 7);
    expect(cue(r, 'c2').durationSec).toBeGreaterThanOrEqual(0.04 - 1e-9);
    const p = base();
    expect(retimeCueOp(p, 'c2', Number.NaN, 3)).toBe(p);
    expect(retimeCueOp(p, 'c2', 5, 8)).toBe(p);
  });
});

describe('replaceCues', () => {
  it('replaces all cues of a subtitle track', () => {
    const r = replaceCuesOp(base(), 's', [C('n1', 1, 2), C('n2', 3, 1)]);
    expect(items(r, 's').map((i) => i.id)).toEqual(['n1', 'n2']);
  });

  it('sorts and resolves overlaps by shortening the earlier cue', () => {
    const r = replaceCuesOp(base(), 's', [C('b', 2, 3), C('a', 0, 2.5)]);
    expect(items(r, 's').map((i) => i.id)).toEqual(['a', 'b']);
    expect(spans(r, 's')).toEqual([
      [0, 2],
      [2, 5],
    ]);
    healthy(r);
  });

  it('drops non-subtitle / invalid entries and refuses non-subtitle or locked tracks', () => {
    const r = replaceCuesOp(base(), 's', [
      C('a', 0, 1),
      T('t', 2, 1),
      { type: 'subtitle', id: 'bad' } as never,
    ]);
    expect(items(r, 's').map((i) => i.id)).toEqual(['a']);
    const p = proj([track('v1', 'video', [V('x', 0, 1)])]);
    expect(replaceCuesOp(p, 'v1', [C('a', 0, 1)])).toBe(p);
    const l = proj([track('s', 'subtitle', [C('c', 0, 2)], { locked: true })]);
    expect(replaceCuesOp(l, 's', [])).toBe(l);
  });

  it('re-ids a cue that collides with an item on another track', () => {
    const p = proj([track('v1', 'video', [V('x', 0, 1)]), track('s', 'subtitle', [])]);
    const r = replaceCuesOp(p, 's', [C('x', 0, 1)]);
    expect(items(r, 's')[0]!.id).not.toBe('x');
    healthy(r);
  });

  it('an empty list clears the track', () => {
    expect(items(replaceCuesOp(base(), 's', []), 's')).toEqual([]);
  });
});
