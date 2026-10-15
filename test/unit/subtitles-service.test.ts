import { describe, expect, it } from 'vitest';
import type { Cue, SubtitleEdits } from '../../shared/cp2';
import { subtitleEditsSchema } from '../../shared/cp2';
import type { Word } from '../../shared/pipeline';
import { createSubtitleService, tokenize } from '../../electron/main/services/subtitles';
import { createCaptionService } from '../../electron/main/services/captions';

const svc = createSubtitleService();
const EMPTY: SubtitleEdits = subtitleEditsSchema.parse({});

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VOCAB =
  'the of and to in that is was he for it with as his on be at by this had not are but from or have an they which one you were her all she there would their we him been has when who will more no if out so said what up its about into than them can only other new some could time these two may then do first any my now such like our over man me even most made after also did many before must through back years where much your way well down should because each just those people how too little state good very make world still own see men work long get here between both life being under never day same another know while last might us great old year off come since against go came right used take three'.split(
    ' ',
  );

/** Synthetic transcript: sentences with punctuation, pauses and the odd long word. */
function transcript(n: number, seed = 1): Word[] {
  const r = rng(seed);
  const out: Word[] = [];
  let t = 0.4;
  let sentence = 0;
  for (let i = 0; i < n; i++) {
    let w = VOCAB[Math.floor(r() * VOCAB.length)] ?? 'the';
    if (r() < 0.03) w = 'internationalization';
    sentence++;
    if (sentence > 4 && r() < 0.15) {
      w += '.';
      sentence = 0;
    } else if (r() < 0.07) w += ',';
    const dur = 0.12 + r() * 0.4;
    out.push({ w, s: Math.round(t * 100) / 100, e: Math.round((t + dur) * 100) / 100 });
    t += dur + (r() < 0.1 ? 0.5 + r() : 0.02 + r() * 0.1);
  }
  return out;
}

const WORDS = transcript(400, 7);

/** Invariants every cue list must satisfy. */
function checkCues(words: Word[], edits: SubtitleEdits, cues: Cue[], note = ''): void {
  const shown = svc.applyEdits(words, edits);
  let lastEnd = -Infinity;
  let lastIdx = -1;
  cues.forEach((c, i) => {
    const m = `${note} cue ${i}`;
    expect(c.id, m).toBe(i);
    expect(c.e, m).toBeGreaterThan(c.s);
    expect(c.s, m).toBeGreaterThanOrEqual(lastEnd - 1e-9); // monotonic, no overlap
    expect(c.s, m).toBeGreaterThanOrEqual(0);
    expect(c.wordStart, m).toBeLessThanOrEqual(c.wordEnd);
    expect(c.wordStart, m).toBeGreaterThan(lastIdx - 1e-9 - 0); // indices increase across cues
    expect(c.wordStart, m).toBeGreaterThanOrEqual(0);
    expect(c.wordEnd, m).toBeLessThan(words.length);
    const lines = c.text.split('\n');
    expect(lines.length, m).toBeLessThanOrEqual(2);
    for (const l of lines) {
      expect(l, m).not.toBe('');
      const single = tokenize(l).length === 1;
      if (!single) expect(l.length, m).toBeLessThanOrEqual(42);
    }
    expect(c.e - c.s, m).toBeLessThanOrEqual(6.0001 + 1e-6);
    lastEnd = c.e;
    lastIdx = c.wordEnd;
  });
  // no word is lost or duplicated: cue text = displayed words, in order
  const fromCues = cues.flatMap((c) => tokenize(c.text));
  expect(fromCues).toEqual(shown.map((w) => w.w));
}

describe('applyEdits', () => {
  const w: Word[] = [
    { w: 'Hello', s: 1, e: 1.5 },
    { w: 'there', s: 1.5, e: 2 },
    { w: 'world.', s: 2, e: 2.6 },
  ];

  it('is the identity for empty edits and keeps the original index', () => {
    const out = svc.applyEdits(w, EMPTY);
    expect(out.map((x) => [x.w, x.s, x.e, x.origIndex])).toEqual([
      ['Hello', 1, 1.5, 0],
      ['there', 1.5, 2, 1],
      ['world.', 2, 2.6, 2],
    ]);
  });

  it('replaces text, shifts times, drops hidden words', () => {
    const out = svc.applyEdits(w, {
      ...EMPTY,
      words: { '0': { text: 'Howdy' }, '1': { shift: 0.25 }, '2': { hidden: true } },
    });
    expect(out.map((x) => [x.w, x.s, x.e, x.origIndex])).toEqual([
      ['Howdy', 1, 1.5, 0],
      ['there', 1.75, 2.25, 1],
    ]);
  });

  it('clamps negative times to 0 and treats an empty override as hidden', () => {
    const out = svc.applyEdits(w, { ...EMPTY, words: { '0': { shift: -5 }, '1': { text: '  ' } } });
    expect(out[0]?.s).toBe(0);
    expect(out[0]?.e).toBe(0);
    expect(out.map((x) => x.origIndex)).toEqual([0, 2]);
  });

  it('expands an override with several words, splitting the span by length (timings interpolated)', () => {
    const out = svc.applyEdits(w, { ...EMPTY, words: { '1': { text: 'is it really' } } });
    const mid = out.filter((x) => x.origIndex === 1);
    expect(mid.map((x) => x.w)).toEqual(['is', 'it', 'really']);
    expect(mid[0]?.s).toBeCloseTo(1.5, 3);
    expect(mid[2]?.e).toBeCloseTo(2, 3);
    for (let i = 1; i < mid.length; i++) expect(mid[i]?.s).toBeCloseTo(mid[i - 1]?.e ?? 0, 3);
    expect((mid[2]?.e ?? 0) - (mid[2]?.s ?? 0)).toBeGreaterThan(
      (mid[0]?.e ?? 0) - (mid[0]?.s ?? 0),
    );
  });

  it('feeds the caption engine: edited words burn in with the edited text and timing', () => {
    const edited = svc.applyEdits(w, {
      ...EMPTY,
      words: { '0': { text: 'Howdy' }, '2': { shift: 0.5 } },
    });
    const ass = createCaptionService().buildAss({
      words: edited,
      startSec: 0,
      endSec: 10,
      width: 1080,
      height: 1920,
      style: createCaptionService().builtinStyles()[0]!,
    });
    expect(ass).toContain('HOWDY');
    expect(ass).not.toContain('HELLO');
    expect(ass).toMatch(/Dialogue: 1,0:00:02\.50,/); // "world." now starts at 2.5 s
  });
});

describe('cues', () => {
  it('follow the rules on a long synthetic transcript', () => {
    const cues = svc.cues(WORDS, EMPTY);
    expect(cues.length).toBeGreaterThan(30);
    checkCues(WORDS, EMPTY, cues);
    // most cues are single line; some are two lines; none exceed 6 s
    expect(cues.some((c) => c.text.includes('\n'))).toBe(true);
    expect(cues.filter((c) => c.e - c.s < 0.99).length).toBeLessThan(cues.length * 0.08);
  });

  it('break on sentence ends and long pauses, not in the middle of a phrase', () => {
    const w: Word[] = [
      { w: 'First', s: 0, e: 0.4 },
      { w: 'sentence', s: 0.4, e: 0.9 },
      { w: 'ends.', s: 0.9, e: 1.5 },
      { w: 'Second', s: 1.55, e: 2.0 },
      { w: 'one', s: 2.0, e: 2.4 },
      { w: 'then', s: 2.4, e: 2.8 },
      { w: 'a', s: 4.2, e: 4.3 },
      { w: 'pause', s: 4.3, e: 5.0 },
    ];
    const cues = svc.cues(w, EMPTY);
    expect(cues.map((c) => c.text)).toEqual(['First sentence ends.', 'Second one then', 'a pause']);
    expect(cues.map((c) => [c.wordStart, c.wordEnd])).toEqual([
      [0, 2],
      [3, 5],
      [6, 7],
    ]);
  });

  it('extend short cues to 1 s when the gap allows, and never overlap', () => {
    const w: Word[] = [
      { w: 'Yes.', s: 0, e: 0.3 },
      { w: 'Absolutely', s: 3, e: 3.6 },
      { w: 'not.', s: 3.6, e: 4.1 },
    ];
    const cues = svc.cues(w, EMPTY);
    expect(cues[0]?.e).toBeCloseTo(1, 3);
    expect(cues[1]?.s).toBeCloseTo(3, 3);
  });

  it('never exceed two lines of 42 characters: long text splits into more cues', () => {
    const w: Word[] = Array.from({ length: 40 }, (_, i) => ({
      w: 'wonderful',
      s: i * 0.3,
      e: i * 0.3 + 0.28,
    }));
    const cues = svc.cues(w, EMPTY);
    expect(cues.length).toBeGreaterThan(3);
    checkCues(w, EMPTY, cues);
  });

  it('survive zero-length, overlapping and unsorted-looking ASR words', () => {
    const w: Word[] = [
      { w: 'a', s: 1, e: 1 },
      { w: 'b', s: 1, e: 1.3 },
      { w: 'c', s: 1.2, e: 1.6 },
      { w: 'd', s: 1.6, e: 1.6 },
    ];
    checkCues(w, EMPTY, svc.cues(w, EMPTY));
    expect(svc.cues([], EMPTY)).toEqual([]);
  });
});

describe('editCueText', () => {
  it('returns the very same edits when the text is unchanged (identity round trip)', () => {
    const cues = svc.cues(WORDS, EMPTY);
    for (const c of cues) expect(svc.editCueText(WORDS, EMPTY, c.id, c.text)).toBe(EMPTY);
    // also after edits exist
    const e1 = svc.editCueText(WORDS, EMPTY, 3, 'something else entirely');
    for (const c of svc.cues(WORDS, e1)) {
      expect(svc.editCueText(WORDS, e1, c.id, c.text)).toEqual(e1);
    }
  });

  it('whitespace-only differences are not edits', () => {
    const c = svc.cues(WORDS, EMPTY)[2] as Cue;
    expect(svc.editCueText(WORDS, EMPTY, c.id, `  ${c.text.replace('\n', '   \n ')}  `)).toBe(
      EMPTY,
    );
  });

  it('replaces a word in place, keeping the timing of the others', () => {
    const w: Word[] = [
      { w: 'I', s: 0, e: 0.2 },
      { w: 'like', s: 0.2, e: 0.6 },
      { w: 'cats.', s: 0.6, e: 1.2 },
    ];
    const edits = svc.editCueText(w, EMPTY, 0, 'I love cats.');
    expect(edits.rev).toBe(1);
    expect(edits.words).toEqual({ '1': { text: 'love' } });
    const out = svc.applyEdits(w, edits);
    expect(out.map((x) => [x.w, x.s, x.e])).toEqual([
      ['I', 0, 0.2],
      ['love', 0.2, 0.6],
      ['cats.', 0.6, 1.2],
    ]);
  });

  it('deletes words (hides them) and restoring them drops the override again', () => {
    const w: Word[] = [
      { w: 'one', s: 0, e: 0.3 },
      { w: 'two', s: 0.3, e: 0.6 },
      { w: 'three', s: 0.6, e: 1 },
    ];
    const del = svc.editCueText(w, EMPTY, 0, 'one three');
    expect(del.words).toEqual({ '1': { hidden: true } });
    expect(svc.cues(w, del)[0]?.text).toBe('one three');
    const back = svc.editCueText(w, del, 0, 'one two three');
    expect(back.words).toEqual({});
    expect(svc.cues(w, back)[0]?.text).toBe('one two three');
  });

  it('inserts words: they share the previous word and get interpolated timings inside its span', () => {
    const w: Word[] = [
      { w: 'one', s: 0, e: 0.5 },
      { w: 'four', s: 0.5, e: 1 },
    ];
    const edits = svc.editCueText(w, EMPTY, 0, 'one two three four');
    const out = svc.applyEdits(w, edits);
    expect(out.map((x) => x.w)).toEqual(['one', 'two', 'three', 'four']);
    for (let i = 1; i < out.length; i++) {
      expect(out[i]?.s ?? 0).toBeGreaterThanOrEqual((out[i - 1]?.s ?? 0) - 1e-9);
      expect(out[i]?.s ?? 0).toBeLessThanOrEqual(1);
    }
    expect(out[3]?.s).toBeCloseTo(0.5, 3);
    expect(out.map((x) => x.origIndex)).toEqual([0, 0, 0, 1]);
  });

  it('inserting before the first word and after the last word works', () => {
    const w: Word[] = [
      { w: 'middle', s: 0, e: 0.5 },
      { w: 'part', s: 0.5, e: 1 },
    ];
    const e = svc.editCueText(w, EMPTY, 0, 'the middle part of it');
    expect(svc.applyEdits(w, e).map((x) => x.w)).toEqual(['the', 'middle', 'part', 'of', 'it']);
  });

  it('replaces the whole text of a cue (no common words)', () => {
    const w: Word[] = [
      { w: 'aaa', s: 0, e: 0.3 },
      { w: 'bbb', s: 0.3, e: 0.6 },
      { w: 'ccc.', s: 0.6, e: 1 },
    ];
    const e = svc.editCueText(w, EMPTY, 0, 'x y');
    expect(svc.applyEdits(w, e).map((x) => x.w)).toEqual(['x', 'y']);
    const e2 = svc.editCueText(w, EMPTY, 0, 'p q r s t');
    expect(svc.applyEdits(w, e2).map((x) => x.w)).toEqual(['p', 'q', 'r', 's', 't']);
  });

  it('clearing a cue removes it; unknown cue ids are ignored', () => {
    const w: Word[] = [
      { w: 'gone', s: 0, e: 0.5 },
      { w: 'soon.', s: 0.5, e: 1 },
      { w: 'Next', s: 3, e: 3.5 },
    ];
    const e = svc.editCueText(w, EMPTY, 0, '   ');
    expect(svc.cues(w, e).map((c) => c.text)).toEqual(['Next']);
    expect(svc.editCueText(w, EMPTY, 99, 'x')).toBe(EMPTY);
    expect(svc.editCueText(w, EMPTY, -1, 'x')).toBe(EMPTY);
  });

  it('does not touch words outside the cue and keeps existing shifts', () => {
    const e0 = svc.shiftCue(WORDS, EMPTY, 5, 0.1);
    const c = svc.cues(WORDS, e0)[5] as Cue;
    const e1 = svc.editCueText(WORDS, e0, 5, `${c.text} extra`);
    for (const [k, v] of Object.entries(e1.words)) {
      const idx = Number(k);
      if (idx < c.wordStart || idx > c.wordEnd) expect(v).toEqual(e0.words[k]);
    }
    expect(svc.applyEdits(WORDS, e1).find((x) => x.origIndex === c.wordStart)?.s).toBeCloseTo(
      (WORDS[c.wordStart]?.s ?? 0) + 0.1,
      3,
    );
  });
});

describe('splitCue / mergeWithNext / shiftCue', () => {
  const w: Word[] = [
    { w: 'alpha', s: 0, e: 0.5 },
    { w: 'beta', s: 0.5, e: 1 },
    { w: 'gamma', s: 1, e: 1.5 },
    { w: 'delta.', s: 1.5, e: 2 },
    { w: 'epsilon', s: 2.05, e: 2.55 },
    { w: 'zeta.', s: 2.55, e: 3.1 },
  ];

  it('split adds a break at the word and creates a new cue there', () => {
    const before = svc.cues(w, EMPTY);
    expect(before.map((c) => c.text)).toEqual(['alpha beta gamma delta.', 'epsilon zeta.']);
    const e = svc.splitCue(w, EMPTY, 0, 2);
    expect(e.breaks).toEqual([2]);
    expect(e.rev).toBe(1);
    expect(svc.cues(w, e).map((c) => c.text)).toEqual([
      'alpha beta',
      'gamma delta.',
      'epsilon zeta.',
    ]);
  });

  it('split rejects positions outside the cue or at its first word', () => {
    expect(svc.splitCue(w, EMPTY, 0, 0)).toBe(EMPTY);
    expect(svc.splitCue(w, EMPTY, 0, 4)).toBe(EMPTY);
    expect(svc.splitCue(w, EMPTY, 7, 1)).toBe(EMPTY);
  });

  it('merge joins a cue with the next one (suppressing the automatic break)', () => {
    const e = svc.mergeWithNext(w, EMPTY, 0);
    expect(e.merges).toEqual([4]);
    const cues = svc.cues(w, e);
    expect(cues).toHaveLength(1);
    expect(cues[0]?.text.replace('\n', ' ')).toBe('alpha beta gamma delta. epsilon zeta.');
    expect(cues[0]?.text.split('\n').length).toBeLessThanOrEqual(2);
  });

  it('split then merge returns to the original cues; merge of a split removes the break', () => {
    const split = svc.splitCue(w, EMPTY, 0, 2);
    const merged = svc.mergeWithNext(w, split, 0);
    expect(merged.breaks).toEqual([]);

    expect(svc.cues(w, merged).map((c) => c.text)).toEqual([
      'alpha beta gamma delta.',
      'epsilon zeta.',
    ]);
  });

  it('refuses a merge that would break the length rules, and the last cue has no next', () => {
    const long: Word[] = Array.from({ length: 30 }, (_, i) => ({
      w: i % 6 === 5 ? 'sentence.' : 'wonderful',
      s: i * 0.35,
      e: i * 0.35 + 0.33,
    }));
    const cues = svc.cues(long, EMPTY);
    for (let i = 0; i < cues.length - 1; i++) {
      const e = svc.mergeWithNext(long, EMPTY, i);
      checkCues(long, e, svc.cues(long, e), `merge ${i}`); // either merged legally, or unchanged
    }
    expect(svc.mergeWithNext(long, EMPTY, cues.length - 1)).toBe(EMPTY);
  });

  it('shift moves every word of the cue and is clamped between its neighbours', () => {
    const e = svc.shiftCue(w, EMPTY, 1, -0.02);
    expect(e.words['4']).toEqual({ shift: -0.02 });
    expect(e.words['5']).toEqual({ shift: -0.02 });
    expect(svc.cues(w, e)[1]?.s).toBeCloseTo(2.03, 3);
    // cannot move into the previous cue (its last word ends at 2.0 s) or before 0
    const far = svc.shiftCue(w, EMPTY, 1, -5);
    const c = svc.cues(w, far);
    expect(c[1]?.s).toBeGreaterThanOrEqual((c[0]?.e ?? 0) - 1e-9);
    const first = svc.shiftCue(w, EMPTY, 0, -5);
    expect(svc.cues(w, first)[0]?.s).toBe(0);
    // later cue can move later freely; shifts accumulate and cancel
    const a = svc.shiftCue(w, EMPTY, 1, 0.5);
    const b = svc.shiftCue(w, a, 1, -0.5);
    expect(b.words).toEqual({});
  });

  it('every operation increments rev and keeps the result schema-valid', () => {
    let e = EMPTY;
    e = svc.editCueText(w, e, 0, 'alpha BETA gamma delta.');
    e = svc.splitCue(w, e, 0, 2);
    e = svc.shiftCue(w, e, 1, 0.01);
    e = svc.mergeWithNext(w, e, 0);
    expect(e.rev).toBe(4);
    expect(subtitleEditsSchema.safeParse(e).success).toBe(true);
    expect(JSON.parse(JSON.stringify(e))).toEqual(e);
  });
});

describe('SRT / VTT', () => {
  const cues: Cue[] = [
    {
      id: 0,
      s: 1.5,
      e: 3.25,
      text: 'Hello <b>there</b> --> you\n& friends',
      wordStart: 0,
      wordEnd: 3,
    },
    { id: 1, s: 3.25, e: 5, text: 'Second\n\ncue with blank line', wordStart: 4, wordEnd: 8 },
    { id: 2, s: 3725.5, e: 3727.001, text: 'Over an hour', wordStart: 9, wordEnd: 11 },
  ];

  it('SRT: numbered blocks, comma milliseconds, no blank lines inside a cue, tag-like text neutralised', () => {
    const srt = svc.toSrt(cues);
    const blocks = srt.trim().split('\n\n');
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toBe(
      '1\n00:00:01,500 --> 00:00:03,250\nHello ‹b>there‹/b> -> you\n& friends',
    );
    expect(blocks[1]).toBe('2\n00:00:03,250 --> 00:00:05,000\nSecond\ncue with blank line');
    expect(blocks[2]).toContain('01:02:05,500 --> 01:02:07,001');
    expect(srt.endsWith('\n')).toBe(true);
    expect(srt).not.toMatch(/\n\n\n/);
  });

  it('VTT: header, dot milliseconds, escaped &, <, >', () => {
    const vtt = svc.toVtt(cues);
    expect(vtt.startsWith('WEBVTT\n\n00:00:01.500 --> 00:00:03.250\n')).toBe(true);
    expect(vtt).toContain('Hello &lt;b&gt;there&lt;/b&gt; --&gt; you\n&amp; friends');
    expect(vtt).not.toMatch(/\d,\d{3} -->/);
    expect(vtt).not.toContain('\n\n\n');
  });

  it('range export: clip-relative times, clamped, renumbered, edge cues kept only when mostly inside', () => {
    const range = { startSec: 3, endSec: 4.5 };
    const srt = svc.toSrt(cues, range);
    const blocks = srt.trim().split('\n\n');
    // cue 0 overlaps only 0.25 s of 1.75 s (14 %) -> dropped; cue 1 overlaps 1.25 of 1.75
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toBe('1\n00:00:00,250 --> 00:00:01,500\nSecond\ncue with blank line');
    expect(svc.toVtt(cues, { startSec: 100, endSec: 200 })).toBe('WEBVTT\n\n');
    expect(svc.toSrt([])).toBe('');
  });
});

/* ------------------------------------------- property tests ------------------------------------------ */

describe('property: random edit sequences', () => {
  type Op = 'text' | 'split' | 'merge' | 'shift';

  function randomText(r: () => number, cue: Cue): string {
    const toks = tokenize(cue.text);
    const op = r();
    if (op < 0.25 && toks.length > 1) toks.splice(Math.floor(r() * toks.length), 1);
    else if (op < 0.5)
      toks.splice(
        Math.floor(r() * (toks.length + 1)),
        0,
        ...['new', 'extra words'].slice(0, 1 + Math.floor(r() * 2)),
      );
    else if (op < 0.75 && toks.length > 0)
      toks[Math.floor(r() * toks.length)] = r() < 0.5 ? 'swapped' : 'two words';
    else if (op < 0.85) return '   ';
    else return `brand new text ${Math.floor(r() * 100)}`;
    return toks.join(' ');
  }

  it('indices stay valid, times monotonic, nothing lost or duplicated (60 sequences x 25 ops)', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const r = rng(seed * 7919);
      const words = transcript(30 + Math.floor(r() * 60), seed);
      let edits = EMPTY;
      for (let step = 0; step < 25; step++) {
        const cues = svc.cues(words, edits);
        if (cues.length === 0) break;
        const cue = cues[Math.floor(r() * cues.length)] as Cue;
        const ops: Op[] = ['text', 'split', 'merge', 'shift'];
        const op = ops[Math.floor(r() * ops.length)] as Op;
        const prev = edits;
        if (op === 'text') edits = svc.editCueText(words, edits, cue.id, randomText(r, cue));
        else if (op === 'split') {
          const at = cue.wordStart + 1 + Math.floor(r() * Math.max(1, cue.wordEnd - cue.wordStart));
          edits = svc.splitCue(words, edits, cue.id, at);
        } else if (op === 'merge') edits = svc.mergeWithNext(words, edits, cue.id);
        else edits = svc.shiftCue(words, edits, cue.id, (r() - 0.5) * 2);
        expect(edits.rev === prev.rev || edits.rev === prev.rev + 1).toBe(true);
        expect(subtitleEditsSchema.safeParse(edits).success).toBe(true);
        for (const k of Object.keys(edits.words)) {
          expect(Number(k)).toBeGreaterThanOrEqual(0);
          expect(Number(k)).toBeLessThan(words.length);
        }
        checkCues(words, edits, svc.cues(words, edits), `seed ${seed} step ${step} ${op}`);
      }
    }
  }, 60_000);

  it('editing a cue to text T makes the cue (range) display exactly T', () => {
    for (let seed = 1; seed <= 120; seed++) {
      const r = rng(seed * 31);
      const words = transcript(60, seed);
      let edits = EMPTY;
      for (let step = 0; step < 6; step++) {
        const cues = svc.cues(words, edits);
        const cue = cues[Math.floor(r() * cues.length)] as Cue;
        const text = randomText(r, cue);
        const next = svc.editCueText(words, edits, cue.id, text);
        const wanted = tokenize(text);
        const shown = svc
          .applyEdits(words, next)
          .filter((w) => w.origIndex >= cue.wordStart && w.origIndex <= cue.wordEnd)
          .map((w) => w.w);
        expect(shown, `seed ${seed} step ${step}`).toEqual(wanted);
        edits = next;
      }
    }
  });

  it("identity edits: editCueText with a cue's own text never changes anything (all cues, many transcripts)", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const words = transcript(80, seed);
      const cues = svc.cues(words, EMPTY);
      for (const c of cues) expect(svc.editCueText(words, EMPTY, c.id, c.text)).toBe(EMPTY);
      // split every cue at its middle, then identity again
      let e = EMPTY;
      for (const c of svc.cues(words, EMPTY)) {
        if (c.wordEnd > c.wordStart)
          e = svc.splitCue(
            words,
            e,
            svc.cues(words, e).find((x) => x.wordStart === c.wordStart)?.id ?? 0,
            c.wordStart + 1,
          );
      }
      for (const c of svc.cues(words, e)) expect(svc.editCueText(words, e, c.id, c.text)).toBe(e);
    }
  });
});
