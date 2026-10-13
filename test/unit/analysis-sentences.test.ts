import { describe, expect, it } from 'vitest';
import {
  pauseBefore,
  MAX_SEC,
  MAX_WORDS,
  PAUSE_SPLIT_SEC,
  isTerminal,
  joinWords,
  segmentSentences,
} from '../../electron/main/services/analysis/sentences';
import { buildTranscript, toTranscriptWords } from '../../electron/main/services/analysis';
import { sentenceSchema, transcriptSchema, type Word } from '../../shared/pipeline';
import type { TranscribeResult } from '../../electron/main/services/sidecar';

/** Builds words at `rate` words/s from text tokens; `gaps[i]` adds extra silence BEFORE token i. */
function words(
  text: string,
  opts: { start?: number; dur?: number; gap?: number; gaps?: Record<number, number> } = {},
): Word[] {
  const dur = opts.dur ?? 0.25;
  const gap = opts.gap ?? 0.05;
  let t = opts.start ?? 0;
  return text
    .trim()
    .split(/\s+/)
    .map((w, i) => {
      t += opts.gaps?.[i] ?? 0;
      const word = { w, s: round(t), e: round(t + dur) };
      t += dur + gap;
      return word;
    });
}
const round = (n: number): number => Math.round(n * 1000) / 1000;

/** Every word belongs to exactly one sentence, in order, with matching times. */
function expectPartition(ws: Word[], ss: ReturnType<typeof segmentSentences>): void {
  let next = 0;
  ss.forEach((s, i) => {
    expect(s.id).toBe(i);
    expect(s.wordStart).toBe(next);
    expect(s.wordEnd).toBeGreaterThanOrEqual(s.wordStart);
    expect(s.s).toBe(ws[s.wordStart]?.s);
    expect(s.e).toBe(ws[s.wordEnd]?.e);
    expect(() => sentenceSchema.parse(s)).not.toThrow();
    next = s.wordEnd + 1;
  });
  expect(next).toBe(ws.length);
}

describe('segmentSentences - punctuation', () => {
  it('splits after . ? ! and keeps inclusive word indices exact', () => {
    const ws = words('Hello there. How are you? I am fine! Thanks');
    const ss = segmentSentences(ws);
    expect(ss.map((s) => [s.wordStart, s.wordEnd])).toEqual([
      [0, 1],
      [2, 4],
      [5, 7],
      [8, 8],
    ]);
    expect(ss.map((s) => s.text)).toEqual(['Hello there.', 'How are you?', 'I am fine!', 'Thanks']);
    expectPartition(ws, ss);
  });

  it('does not split on abbreviations, initials or decimals', () => {
    const ws = words('Dr. Smith met Mr. J. Brown at 3.5 percent. Then left.');
    const ss = segmentSentences(ws);
    expect(ss.map((s) => s.text)).toEqual([
      'Dr. Smith met Mr. J. Brown at 3.5 percent.',
      'Then left.',
    ]);
    expectPartition(ws, ss);
  });

  it('a sentence-final pronoun "I." still ends the sentence', () => {
    const ws = words('So do I. Me too.');
    expect(segmentSentences(ws).map((s) => s.text)).toEqual(['So do I.', 'Me too.']);
  });

  it('treats closing quotes/brackets after terminal punctuation as terminal', () => {
    expect(isTerminal('done."')).toBe(true);
    expect(isTerminal('really?)')).toBe(true);
    expect(isTerminal('Dr.')).toBe(false);
    expect(isTerminal('comma,')).toBe(false);
    expect(isTerminal('wait…')).toBe(true);
    expect(isTerminal('終わり。')).toBe(true);
  });

  it('returns [] for no words and one sentence for one word', () => {
    expect(segmentSentences([])).toEqual([]);
    const one = segmentSentences(words('Hi'));
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ wordStart: 0, wordEnd: 0, text: 'Hi' });
  });
});

describe('segmentSentences - pauses', () => {
  it('splits on a pause longer than the threshold even without punctuation', () => {
    const ws = words('we went to the store and then we came home', {
      gaps: { 5: PAUSE_SPLIT_SEC + 0.1 },
    });
    const ss = segmentSentences(ws);
    expect(ss.map((s) => [s.wordStart, s.wordEnd])).toEqual([
      [0, 4],
      [5, 9],
    ]);
    expectPartition(ws, ss);
  });

  it('does not split on a pause below the threshold', () => {
    const ws = words('we went to the store and then we came home', {
      gaps: { 5: PAUSE_SPLIT_SEC - 0.2 },
    });
    expect(segmentSentences(ws)).toHaveLength(1);
  });

  it('uses the audio silence when the ASR word gap hides the pause', () => {
    // Whisper stretches word ends into the pause: gap between words is 0.05 s ...
    const ws = words('first part of it second part of it');
    // ... but the audio is silent for 1.2 s around the boundary (word 4 starts at ~1.2 s).
    const boundary = (ws[3]?.e ?? 0) + 0.025;
    const ss = segmentSentences(ws, {
      silences: [{ s: boundary - 0.55, e: boundary + 0.65 }],
      speakerChanges: [],
    });
    expect(ss.map((s) => [s.wordStart, s.wordEnd])).toEqual([
      [0, 3],
      [4, 7],
    ]);
  });
});

describe('segmentSentences - length caps', () => {
  it('caps a long run-on at MAX_WORDS, preferring the longest pause / comma', () => {
    const n = 90;
    const text = Array.from({ length: n }, (_, i) => (i === 30 ? 'there,' : `w${i}`)).join(' ');
    const ws = words(text, { gaps: { 31: 0.5 } }); // a 0.5 s pause (below the hard split) after the comma
    const ss = segmentSentences(ws);
    expectPartition(ws, ss);
    for (const s of ss) {
      expect(s.wordEnd - s.wordStart + 1).toBeLessThanOrEqual(MAX_WORDS);
    }
    // the comma + pause is the most natural break within reach of the first part
    expect(ss[0]?.wordEnd).toBe(30);
  });

  it('caps sentences by duration too', () => {
    const ws = words(Array.from({ length: 40 }, (_, i) => `w${i}`).join(' '), {
      dur: 0.8,
      gap: 0.1,
    });
    const ss = segmentSentences(ws);
    expectPartition(ws, ss);
    for (const s of ss) expect(s.e - s.s).toBeLessThanOrEqual(MAX_SEC + 1);
    expect(ss.length).toBeGreaterThan(1);
  });

  it('never leaves a tiny stub when splitting', () => {
    const ws = words(Array.from({ length: MAX_WORDS + 3 }, (_, i) => `w${i}`).join(' '));
    const ss = segmentSentences(ws);
    expect(ss.length).toBe(2);
    expect(Math.min(...ss.map((s) => s.wordEnd - s.wordStart + 1))).toBeGreaterThanOrEqual(6);
  });
});

describe('segmentSentences - speakers', () => {
  const ws = words('I think so. Really now? Yes absolutely. Great then.', { gap: 0.1 });

  it('leaves speaker null when no signals are given', () => {
    expect(segmentSentences(ws).every((s) => s.speaker === null)).toBe(true);
  });

  it('labels everything S1 when signals exist but no change was found', () => {
    const ss = segmentSentences(ws, { silences: [], speakerChanges: [] });
    expect(new Set(ss.map((s) => s.speaker))).toEqual(new Set(['S1']));
  });

  it('alternates S1/S2 at speaker changes and splits a sentence exactly there', () => {
    // Change time between "Really" (index 4) and "now?" (index 5): mid-sentence.
    const t = ((ws[4]?.e ?? 0) + (ws[5]?.s ?? 0)) / 2;
    const ss = segmentSentences(ws, { silences: [], speakerChanges: [t, (ws[7]?.e ?? 0) + 0.01] });
    expectPartition(ws, ss);
    const starts = ss.map((s) => s.wordStart);
    expect(starts).toContain(5); // forced boundary before "now?"
    const bySpeaker = ss.map((s) => s.speaker);
    expect(bySpeaker[0]).toBe('S1');
    expect(bySpeaker.at(-1)).not.toBeNull();
    // first change flips to S2
    const idx = ss.findIndex((s) => s.wordStart === 5);
    expect(ss[idx]?.speaker).toBe('S2');
  });

  it('assigns a change to the nearest gap by word midpoints (change inside a word)', () => {
    const w = words('alpha beta gamma delta epsilon zeta', { dur: 0.5, gap: 0.1 });
    const inside = (w[2]?.s ?? 0) + 0.1; // inside "gamma"
    const ss = segmentSentences(w, { silences: [], speakerChanges: [inside] });
    expectPartition(w, ss);
    expect(ss.map((s) => s.wordStart)).toEqual([0, 2]);
  });
});

describe('joinWords', () => {
  const W = (w: string): Word => ({ w, s: 0, e: 1 });
  it('handles Whisper leading spaces, trimmed words and attached punctuation tokens', () => {
    expect(joinWords([W(' Hello'), W(' world'), W('!')])).toBe('Hello world!');
    expect(joinWords([W('Hello'), W('world,'), W('again')])).toBe('Hello world, again');
    expect(joinWords([W('Hello'), W('...')])).toBe('Hello...');
  });
  it('joins CJK without inserting spaces', () => {
    expect(joinWords([W('今日'), W('は'), W('晴れ'), W('です。')])).toBe('今日は晴れです。');
    expect(joinWords([W('Hello'), W('世界')])).toBe('Hello世界');
  });
});

describe('segmentSentences - invariants on random input', () => {
  function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }

  it('never loses, duplicates or reorders a word, for 200 random transcripts', () => {
    const r = rng(7);
    for (let trial = 0; trial < 200; trial++) {
      const n = 1 + Math.floor(r() * 300);
      let t = r() * 5;
      const ws: Word[] = [];
      for (let i = 0; i < n; i++) {
        const gap = r() < 0.1 ? r() * 2 : r() * 0.2;
        t += gap;
        const dur = 0.1 + r() * 0.5;
        const punct = r() < 0.08 ? '.' : r() < 0.04 ? '?' : r() < 0.1 ? ',' : '';
        ws.push({ w: `w${i}${punct}`, s: round(t), e: round(t + dur) });
        t += dur;
      }
      const silences = Array.from({ length: Math.floor(r() * 10) }, () => {
        const s = r() * t;
        return { s, e: s + r() };
      }).sort((a, b) => a.s - b.s);
      const changes = Array.from({ length: Math.floor(r() * 8) }, () => r() * t).sort(
        (a, b) => a - b,
      );
      const ss = segmentSentences(
        ws,
        trial % 2 ? { silences, speakerChanges: changes } : undefined,
      );
      expectPartition(ws, ss);
      for (const s of ss) expect(s.wordEnd - s.wordStart + 1).toBeLessThanOrEqual(MAX_WORDS);
    }
  });
});

describe('transcript conversion', () => {
  const result: TranscribeResult = {
    model: 'tiny',
    device: 'cpu',
    compute_type: 'int8',
    language: 'en',
    language_probability: 0.98,
    duration: 12.5,
    duration_after_vad: 9,
    elapsed_s: 1,
    segments: [
      {
        id: 0,
        start: 0,
        end: 3,
        text: ' Hello there. How are you',
        avg_logprob: -0.2,
        no_speech_prob: 0.01,
        words: [
          { word: ' Hello', start: 0.12, end: 0.5, probability: 0.9871 },
          { word: ' there.', start: 0.5, end: 0.9, probability: 0.95 },
          { word: ' ', start: 0.9, end: 0.95, probability: 0.1 },
          { word: ' How', start: 1.2, end: 1.4, probability: 0.9 },
        ],
      },
      {
        id: 1,
        start: 3,
        end: 5,
        text: ' are you?',
        avg_logprob: -0.3,
        no_speech_prob: 0.02,
        // overlapping/out-of-order timestamps as Whisper sometimes emits
        words: [
          { word: ' are', start: 1.3, end: 1.2, probability: 0.8 },
          { word: ' you?', start: 1.6, end: 2.0, probability: 0.8 },
        ],
      },
    ],
  };

  it('trims words, drops empties and makes times monotonic', () => {
    const ws = toTranscriptWords(result);
    expect(ws.map((w) => w.w)).toEqual(['Hello', 'there.', 'How', 'are', 'you?']);
    for (let i = 0; i < ws.length; i++) {
      expect(ws[i]!.e).toBeGreaterThanOrEqual(ws[i]!.s);
      if (i > 0) expect(ws[i]!.s).toBeGreaterThanOrEqual(ws[i - 1]!.s);
    }
    expect(ws[0]).toEqual({ w: 'Hello', s: 0.12, e: 0.5, p: 0.987 });
  });

  it('buildTranscript validates against transcriptSchema', () => {
    const t = buildTranscript(result);
    expect(() => transcriptSchema.parse(t)).not.toThrow();
    expect(t.sentences.map((s) => s.text)).toEqual(['Hello there.', 'How are you?']);
    expect(t.language).toBe('en');
    expect(t.durationSec).toBe(12.5);
  });
});

describe('pauseBefore', () => {
  it('is the larger of the ASR gap and the silence centred in the gap', () => {
    const ws = words('a b c d', { dur: 0.3, gap: 0.1 }); // gaps of 0.1 s
    const p0 = pauseBefore(ws, []);
    expect(Array.from(p0).map((v) => Math.round(v * 100) / 100)).toEqual([0, 0.1, 0.1, 0.1]);
    const mid = ((ws[1]?.e ?? 0) + (ws[2]?.s ?? 0)) / 2;
    const p1 = pauseBefore(ws, [{ s: mid - 0.5, e: mid + 0.5 }]);
    expect(p1[2]).toBeCloseTo(1, 5);
    expect(p1[1]).toBeCloseTo(0.1, 5);
    expect(p1[3]).toBeCloseTo(0.1, 5);
  });
});
