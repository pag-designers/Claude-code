import { describe, expect, it } from 'vitest';
import {
  cleanKeywords,
  durationTolerance,
  fitHook,
  fitTitle,
  pickPromptCandidates,
  verifyMoments,
  type VerifyArgs,
} from '@main/services/llm/moments';
import type { ModelMoment } from '@main/services/llm/schemas';
import type { Sentence } from '@shared/pipeline';
import { makeCandidates, makeSentences } from './llm-fixtures';

const sentences = makeSentences();
const win = { startSec: sentences[0]!.s, endSec: sentences.at(-1)!.e };

function mm(a: number, b: number, over: Partial<ModelMoment> = {}): ModelMoment {
  return {
    candidateId: null,
    startSentence: a,
    endSentence: b,
    title: `Moment ${a}-${b}`,
    hook: 'A true hook',
    whyItWorks: 'because',
    keywords: [],
    scores: { hook: 15, retention: 15, emotion: 10, clarity: 10, shareability: 10 },
    confidence: 0.6,
    ...over,
  };
}

function run(raw: ModelMoment[], over: Partial<VerifyArgs> = {}) {
  const logs: string[] = [];
  const res = verifyMoments({
    raw,
    sentences,
    window: win,
    range: { minSec: 30, maxSec: 60 },
    candidates: makeCandidates(sentences),
    maxClips: 10,
    log: (m) => logs.push(m),
    ...over,
  });
  return { ...res, logs: logs.join('\n') };
}

describe('verifyMoments', () => {
  it('derives seconds from the sentences and fills the RankedMoment contract', () => {
    const { moments } = run([mm(13, 24)]);
    expect(moments).toHaveLength(1);
    expect(moments[0]).toMatchObject({
      startSec: sentences[13]!.s,
      endSec: sentences[24]!.e,
      captionStyle: 'clean-pop',
      candidateId: null,
    });
  });

  it('accepts durations within the tolerance and rejects beyond it', () => {
    const tol = durationTolerance({ minSec: 30, maxSec: 60 });
    expect(tol).toBe(5);
    expect(durationTolerance({ minSec: 15, maxSec: 30 })).toBe(3);
    expect(durationTolerance({ minSec: 5, maxSec: 10 })).toBe(2);
    // 13..24 = 50.4 s -> fine for 30-60; too long for 15-30 (even with +3 s)
    expect(run([mm(13, 24)]).moments).toHaveLength(1);
    const r = run([mm(13, 24)], { range: { minSec: 15, maxSec: 30 } });
    expect(r.moments).toHaveLength(0);
    expect(r.rejected[0]!.reason).toMatch(/duration 50\.\d+s is outside 15-30s/);
  });

  it('rejects unknown ids, reversed ids and spans outside the window', () => {
    expect(run([mm(400, 410)]).rejected[0]!.reason).toContain('unknown sentence id');
    expect(run([mm(24, 13)]).rejected[0]!.reason).toContain('comes after');
    const half = sentences.slice(0, 20);
    const r = run([mm(13, 24)], { sentences: half }); // 24 is not in this window's sentences
    expect(r.rejected[0]!.reason).toContain('unknown sentence id');
    const tight = run([mm(13, 24)], { window: { startSec: 0, endSec: 60 } });
    expect(tight.rejected[0]!.reason).toContain('outside the window');
  });

  it('falls back to the candidate span when the ids are bad but the candidate is known', () => {
    const { moments, logs } = run([mm(900, 901, { candidateId: 'c2' })]);
    expect(moments).toHaveLength(1);
    expect(moments[0]).toMatchObject({ candidateId: 'c2', startSec: sentences[13]!.s });
    expect(logs).toContain("using candidate c2's span");
  });

  it('forgets unknown candidate ids instead of passing them on', () => {
    expect(run([mm(13, 24, { candidateId: 'zzz' })]).moments[0]!.candidateId).toBeNull();
  });

  it('removes overlaps (best score wins), sorts by total score and respects maxClips', () => {
    const hi = mm(4, 11, {
      scores: { hook: 25, retention: 20, emotion: 15, clarity: 10, shareability: 10 },
    });
    const overlapLow = mm(6, 14, {
      title: 'overlap',
      scores: { hook: 5, retention: 5, emotion: 5, clarity: 5, shareability: 5 },
    });
    const mid = mm(13, 24, { title: 'mid' });
    const r = run([overlapLow, mid, hi]);
    expect(r.moments.map((m) => m.title)).toEqual(['Moment 4-11', 'mid']);
    expect(r.logs).toContain('overlaps higher-scored');
    const capped = run([mid, hi], { maxClips: 1 });
    expect(capped.moments.map((m) => m.title)).toEqual(['Moment 4-11']);
    expect(capped.logs).toContain('beyond maxClips');
  });

  it('ties are broken by confidence, then by time', () => {
    const a = mm(4, 11, { title: 'a', confidence: 0.5 });
    const b = mm(13, 24, { title: 'b', confidence: 0.9 });
    expect(run([a, b]).moments.map((m) => m.title)).toEqual(['b', 'a']);
  });

  it('clamps scores to the rubric caps and normalises confidence', () => {
    const { moments } = run([
      mm(13, 24, {
        scores: { hook: 99, retention: -4, emotion: 20.4, clarity: 15.6, shareability: Number.NaN },
        confidence: 85,
      }),
    ]);
    expect(moments[0]!.breakdown).toEqual({
      hook: 25,
      retention: 0,
      emotion: 20,
      clarity: 15,
      shareability: 0,
    });
    expect(moments[0]!.confidence).toBeCloseTo(0.85);
    expect(run([mm(13, 24, { confidence: -2 })]).moments[0]!.confidence).toBe(0);
  });

  it('rejects empty titles and hooks', () => {
    expect(run([mm(13, 24, { title: '  ' })]).rejected[0]!.reason).toBe('empty title');
    expect(run([mm(13, 24, { hook: '' })]).rejected[0]!.reason).toBe('empty hook');
  });

  it('enforces the 60-char title and 10-word hook limits', () => {
    const long = run([
      mm(13, 24, {
        title:
          'An extremely long and rambling title that clearly exceeds the sixty character limit',
        hook: 'one two three four five six seven eight nine ten eleven twelve',
      }),
    ]);
    const m = long.moments[0]!;
    expect(m.title.length).toBeLessThanOrEqual(60);
    expect(m.title.endsWith('…')).toBe(true);
    expect(m.hook.split(' ')).toHaveLength(10);
    expect(m.hook.endsWith('…')).toBe(true);
  });

  it('keeps keywords that are really spoken inside the clip, as single lowercase tokens', () => {
    const { moments } = run([
      mm(13, 24, { keywords: ['Million!', 'forty percent', 'dragon', 'hiring', 'customers.'] }),
    ]);
    // "dragon" and "hiring" are not spoken in sentences 13-24
    expect(moments[0]!.keywords).toEqual(['million', 'forty', 'percent', 'customers']);
  });
});

describe('verifyMoments: mid-sentence cuts', () => {
  const mk = (texts: string[]): Sentence[] =>
    texts.map((text, i) => ({
      id: i,
      s: i * 10,
      e: i * 10 + 9.5,
      text,
      speaker: null,
      wordStart: 0,
      wordEnd: 0,
    }));
  const base = (ss: Sentence[], a: number, b: number, range = { minSec: 15, maxSec: 45 }) =>
    run([mm(a, b)], {
      sentences: ss,
      window: { startSec: 0, endSec: ss.length * 10 },
      range,
      candidates: [],
    });

  it('extends the end when ASR split a sentence at a pause', () => {
    const ss = mk([
      'It starts here.',
      'We were about to give up and',
      'then the phone rang.',
      'Next topic.',
    ]);
    const r = base(ss, 0, 1);
    expect(r.moments).toHaveLength(1);
    expect(r.moments[0]!.endSec).toBe(ss[2]!.e); // pulled in "then the phone rang."
  });

  it('moves the start back when the first sentence is a continuation', () => {
    const ss = mk([
      'Intro.',
      'The thing about bootstrapping is that',
      'nobody warns you about the silence.',
      'Done.',
    ]);
    const r = base(ss, 2, 3);
    expect(r.moments[0]!.startSec).toBe(ss[1]!.s);
  });

  it('rejects when the fix would exceed the maximum duration', () => {
    const ss = mk([
      'Intro.',
      'The thing about bootstrapping is that',
      'nobody warns you about the silence.',
      'Done.',
    ]);
    const r = base(ss, 2, 3, { minSec: 5, maxSec: 12 });
    expect(r.moments).toHaveLength(0);
    expect(r.rejected[0]!.reason).toBe('starts in the middle of a sentence');
  });

  it('does not punish a missing full stop when the next sentence starts a new thought', () => {
    const ss = mk([
      'Opening line.',
      'A complete thought without punctuation',
      'Another new sentence here.',
    ]);
    expect(base(ss, 0, 1, { minSec: 10, maxSec: 30 }).moments).toHaveLength(1);
  });
});

describe('text helpers', () => {
  it('fitTitle trims quotes, cuts on a word boundary and never exceeds 60', () => {
    expect(fitTitle('  "Short and sweet"  ')).toBe('Short and sweet');
    const t = fitTitle('word '.repeat(30));
    expect(t.length).toBeLessThanOrEqual(60);
    expect(t.endsWith('…')).toBe(true);
    expect(fitTitle('x'.repeat(80)).length).toBe(60);
  });

  it('fitHook keeps at most 10 words', () => {
    expect(fitHook('Nobody tells you this about money')).toBe('Nobody tells you this about money');
    expect(fitHook('a b c d e f g h i j k')).toBe('a b c d e f g h i j…');
  });

  it('cleanKeywords dedupes, strips punctuation, caps at 8 and drops unspoken words', () => {
    const text = 'Forty percent of $5,000 customers left, customers!';
    expect(cleanKeywords(['Forty', '$5,000', 'customers', 'customers', 'ghost'], text)).toEqual([
      'forty',
      '5,000',
      'customers',
    ]);
    const many = Array.from({ length: 12 }, (_, i) => `w${i}`);
    expect(cleanKeywords(many, many.join(' '))).toHaveLength(8);
  });
});

describe('pickPromptCandidates', () => {
  const cands = Array.from({ length: 40 }, (_, i) => ({
    ...makeCandidates(sentences)[0]!,
    id: `k${i}`,
    s: 20 + i,
    e: 50 + i,
    prior: i / 40,
  }));
  const window = { startSec: 0, endSec: 200 };

  it('keeps the 30 best by prior, ordered by time; dedupes ids; drops out-of-window ones', () => {
    const picked = pickPromptCandidates(
      [...cands, cands[5]!, { ...cands[0]!, id: 'far', s: 900, e: 940 }],
      window,
      false,
    );
    expect(picked).toHaveLength(30);
    expect(new Set(picked.map((c) => c.id)).size).toBe(30);
    expect(picked.map((c) => c.id)).not.toContain('far');
    expect(picked.map((c) => c.id)).not.toContain('k0'); // lowest prior is dropped
    expect([...picked].sort((a, b) => a.s - b.s)).toEqual(picked);
  });

  it('halves the list in budget mode', () => {
    expect(pickPromptCandidates(cands, window, true)).toHaveLength(15);
    expect(pickPromptCandidates(cands.slice(0, 3), window, true)).toHaveLength(2);
    expect(pickPromptCandidates([], window, true)).toEqual([]);
  });
});
