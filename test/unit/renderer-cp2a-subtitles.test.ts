import { describe, expect, it } from 'vitest';
import type { Cue, SubtitleEdits } from '../../shared/cp2';
import {
  HISTORY_LIMIT,
  activeCueIndex,
  applyCueText,
  deleteCue,
  emptyHistory,
  findCueMatches,
  formatCueTime,
  mergeWithNext,
  parseCueTime,
  pushHistory,
  redoHistory,
  setCueStart,
  shiftCue,
  splitCue,
  undoHistory,
  wordsBeforeCaret,
  type SubState,
  type TWord,
} from '../../renderer/components/subtitles/edits';

/** "one two three four five six seven eight" -> 8 words, 0.5 s each, from t = 10. */
const WORDS: TWord[] = 'one two three four five six seven eight'
  .split(' ')
  .map((w, i) => ({ w, s: 10 + i * 0.5, e: 10 + i * 0.5 + 0.4 }));
const emptyEdits = (): SubtitleEdits => ({ rev: 0, words: {}, breaks: [], merges: [] });
const cue = (id: number, a: number, b: number, words: TWord[] = WORDS): Cue => ({
  id,
  wordStart: a,
  wordEnd: b,
  text: words
    .slice(a, b + 1)
    .map((w) => w.w)
    .join(' '),
  s: words[a]!.s,
  e: words[b]!.e,
});
const base = (): SubState => ({
  cues: [cue(1, 0, 3), cue(2, 4, 7)],
  edits: emptyEdits(),
});

describe('applyCueText', () => {
  it('changes one word in place and keeps its timing', () => {
    const r = applyCueText(base(), WORDS, 1, 'one TWO three four');
    expect(r.state.cues[0]!.text).toBe('one TWO three four');
    expect(r.state.edits.words['1']).toEqual({ text: 'TWO' });
    expect(r.state.cues[0]!.s).toBe(10);
    expect(r.state.cues[1]).toEqual(base().cues[1]); // the next cue is untouched
  });

  it('removing words hides them (their timing is kept) and shortens the cue', () => {
    const r = applyCueText(base(), WORDS, 1, 'one four');
    expect(r.state.edits.words['1']).toEqual({ hidden: true });
    expect(r.state.edits.words['2']).toEqual({ hidden: true });
    expect(r.state.cues[0]).toMatchObject({ text: 'one four', s: 10, e: 11.9 });
    expect(r.state.cues[0]!.wordEnd).toBe(3);
  });

  it('hiding the first word moves the cue start to the next visible word', () => {
    const r = applyCueText(base(), WORDS, 1, 'two three four');
    expect(r.state.cues[0]!.s).toBe(10.5);
  });

  it('folds extra typed words into the neighbouring word instead of inventing timings', () => {
    const r = applyCueText(base(), WORDS, 1, 'one two brand new three four');
    expect(r.state.cues[0]!.text).toBe('one two brand new three four');
    // 4 words stay 4 words; the extra text rides on "two"
    expect(r.state.edits.words['1']).toEqual({ text: 'two brand new' });
    expect(Object.keys(r.state.edits.words)).toEqual(['1']);
  });

  it('typing the original text back removes the override', () => {
    const a = applyCueText(base(), WORDS, 1, 'one TWO three four').state;
    const b = applyCueText(a, WORDS, 1, 'one two three four').state;
    expect(b.edits.words).toEqual({});
  });

  it('an empty text removes the cue (all words hidden)', () => {
    const r = applyCueText(base(), WORDS, 1, '   ');
    expect(r.state.cues.map((c) => c.id)).toEqual([2]);
    expect(Object.keys(r.state.edits.words)).toEqual(['0', '1', '2', '3']);
  });

  it('is a no-op for identical text', () => {
    const s = base();
    expect(applyCueText(s, WORDS, 1, ' one  two three four ').state).toBe(s);
  });

  it('does not mutate its input', () => {
    const s = base();
    const frozen = JSON.stringify(s);
    applyCueText(s, WORDS, 1, 'one X four');
    expect(JSON.stringify(s)).toBe(frozen);
  });
});

describe('split / merge', () => {
  it('splits after the n-th visible word and records a break', () => {
    const r = splitCue(base(), WORDS, 1, 2);
    expect(r.state.cues.map((c) => [c.text, c.wordStart, c.wordEnd])).toEqual([
      ['one two', 0, 1],
      ['three four', 2, 3],
      ['five six seven eight', 4, 7],
    ]);
    expect(r.state.edits.breaks).toEqual([2]);
    expect(r.state.cues[1]!.id).toBeLessThan(0); // temporary id until the server answers
    expect(r.state.cues[1]!.s).toBe(11);
  });

  it('refuses to split at the very edges', () => {
    expect(splitCue(base(), WORDS, 1, 0).warning).toMatch(/between two words/);
    expect(splitCue(base(), WORDS, 1, 4).state).toEqual(base());
  });

  it('merge removes an explicit break and records a forced merge', () => {
    const split = splitCue(base(), WORDS, 1, 2).state;
    const merged = mergeWithNext(split, WORDS, split.cues[0]!.id).state;
    expect(merged.cues.map((c) => c.text)).toEqual(['one two three four', 'five six seven eight']);
    expect(merged.edits.breaks).toEqual([]);
    expect(merged.edits.merges).toEqual([2]);
  });

  it('merging two automatic cues forces the merge', () => {
    const r = mergeWithNext(base(), WORDS, 1);
    expect(r.state.cues).toHaveLength(1);
    expect(r.state.cues[0]).toMatchObject({ wordStart: 0, wordEnd: 7, s: 10, e: 13.9 });
    expect(r.state.edits.merges).toEqual([4]);
  });

  it('cannot merge the last cue', () => {
    const r = mergeWithNext(base(), WORDS, 2);
    expect(r.warning).toBeTruthy();
    expect(r.state.cues).toHaveLength(2);
  });

  it('split after merge flips the record back', () => {
    const merged = mergeWithNext(base(), WORDS, 1).state;
    const again = splitCue(merged, WORDS, 1, 4).state;
    expect(again.edits.merges).toEqual([]);
    expect(again.edits.breaks).toEqual([4]);
  });
});

describe('timing', () => {
  it('nudges every word of the cue and accumulates', () => {
    const a = shiftCue(base(), WORDS, 1, 0.1).state;
    const b = shiftCue(a, WORDS, 1, 0.1).state;
    expect(b.cues[0]).toMatchObject({ s: 10.2, e: 12.1 });
    expect(b.edits.words['0']).toEqual({ shift: 0.2 });
    expect(b.cues[1]).toEqual(base().cues[1]); // other cues are untouched
  });

  it('shifting back to zero clears the edit', () => {
    const a = shiftCue(base(), WORDS, 1, 0.1).state;
    const b = shiftCue(a, WORDS, 1, -0.1).state;
    expect(b.edits.words).toEqual({});
  });

  it('never moves a cue before 0:00', () => {
    const early: TWord[] = [{ w: 'hi', s: 0.05, e: 0.3 }];
    const s: SubState = { cues: [cue(1, 0, 0, early)], edits: emptyEdits() };
    const r = shiftCue(s, early, 1, -0.5);
    expect(r.state.cues[0]!.s).toBe(0);
    expect(r.state.edits.words['0']).toEqual({ shift: -0.05 });
  });

  it('retimes to an absolute start by shifting the whole cue', () => {
    const r = setCueStart(base(), WORDS, 2, 20).state;
    expect(r.cues[1]).toMatchObject({ s: 20, e: 21.9 });
    expect(r.edits.words['4']).toEqual({ shift: 8 });
  });

  it('deleting a cue hides all its words', () => {
    const r = deleteCue(base(), 1).state;
    expect(r.cues.map((c) => c.id)).toEqual([2]);
    expect(r.edits.words['3']).toEqual({ hidden: true });
  });
});

describe('helpers', () => {
  it('counts words before a caret, snapping inside a word to the closer side', () => {
    const t = 'one two three';
    expect(wordsBeforeCaret(t, 0)).toBe(0);
    expect(wordsBeforeCaret(t, 3)).toBe(1);
    expect(wordsBeforeCaret(t, 4)).toBe(1);
    expect(wordsBeforeCaret(t, 5)).toBe(1); // "t|wo": closer to the start of "two"
    expect(wordsBeforeCaret(t, 6)).toBe(2); // "tw|o": closer to its end
    expect(wordsBeforeCaret(t, t.length)).toBe(3);
  });

  it('finds the active cue, with a short grace after its end', () => {
    const cues = [
      { s: 1, e: 2 },
      { s: 3, e: 4 },
      { s: 5, e: 6 },
    ];
    expect(activeCueIndex(cues, 0.5)).toBe(-1);
    expect(activeCueIndex(cues, 1.5)).toBe(0);
    expect(activeCueIndex(cues, 2.2)).toBe(0); // grace
    expect(activeCueIndex(cues, 2.6)).toBe(-1);
    expect(activeCueIndex(cues, 5.9)).toBe(2);
    // overlapping cues after a nudge: the one that really contains t wins
    expect(
      activeCueIndex(
        [
          { s: 1, e: 5 },
          { s: 3, e: 4 },
        ],
        4.5,
      ),
    ).toBe(0);
  });

  it('searches case-insensitively with every occurrence', () => {
    const m = findCueMatches([{ text: 'Hello hello' }, { text: 'nope' }], 'HELLO');
    expect(m).toEqual([
      {
        cue: 0,
        ranges: [
          [0, 5],
          [6, 11],
        ],
      },
    ]);
    expect(findCueMatches([{ text: 'a' }], 'a')).toEqual([]); // < 2 chars
  });

  it('formats and parses cue times', () => {
    expect(formatCueTime(75.34)).toBe('1:15.3');
    expect(formatCueTime(3725.99)).toBe('1:02:05.9');
    expect(formatCueTime(0)).toBe('0:00.0');
    expect(parseCueTime('12.5')).toBe(12.5);
    expect(parseCueTime('1:12.5')).toBe(72.5);
    expect(parseCueTime('1:02:03')).toBe(3723);
    expect(parseCueTime('abc')).toBeNull();
    expect(parseCueTime('1:2:3:4')).toBeNull();
    expect(parseCueTime('')).toBeNull();
  });
});

describe('history', () => {
  it('undoes and redoes, and a new change clears the redo stack', () => {
    let h = emptyHistory<number>();
    h = pushHistory(h, 1); // state was 1, now 2
    h = pushHistory(h, 2); // now 3
    const u = undoHistory(h, 3)!;
    expect(u.value).toBe(2);
    const r = redoHistory(u.history, 2)!;
    expect(r.value).toBe(3);
    const u2 = undoHistory(r.history, 3)!;
    const branched = pushHistory(u2.history, 2);
    expect(branched.future).toEqual([]);
    expect(undoHistory(emptyHistory<number>(), 1)).toBeNull();
    expect(redoHistory(emptyHistory<number>(), 1)).toBeNull();
  });

  it('keeps at most 50 levels', () => {
    let h = emptyHistory<number>();
    for (let i = 0; i < 80; i++) h = pushHistory(h, i);
    expect(h.past).toHaveLength(HISTORY_LIMIT);
    expect(h.past[0]).toBe(30);
  });
});
