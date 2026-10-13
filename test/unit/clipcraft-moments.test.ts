import { describe, expect, it } from 'vitest';
import {
  pipelineOptionsSchema,
  type AudioSignals,
  type Sentence,
  type Transcript,
  type Word,
} from '../../shared/pipeline';
import {
  GUARD,
  PAD_MAX,
  buildIndex,
  createMomentService,
  hookStrength,
  selfContainment,
  snapSpan,
} from '../../electron/main/services/moments';

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

const LEX = [
  'the',
  'people',
  'really',
  'think',
  'about',
  'money',
  'and',
  'time',
  'because',
  'you',
  'never',
  'know',
  'what',
  'happens',
  'when',
  'we',
  'start',
  'building',
  'something',
  'new',
];

interface Synth {
  transcript: Transcript;
  signals: AudioSignals;
}

/** Random transcript: words 0.12-0.5 s, gaps 0-0.45 s (some 0), sentences of 5-16 words. */
function synth(seed: number, nSentences = 80, opts: { zeroGaps?: boolean } = {}): Synth {
  const r = rng(seed);
  const words: Word[] = [];
  const sentences: Sentence[] = [];
  let t = 0.4;
  for (let si = 0; si < nSentences; si++) {
    const n = 5 + Math.floor(r() * 12);
    const first = words.length;
    for (let k = 0; k < n; k++) {
      const dur = 0.12 + r() * 0.38;
      const gap = opts.zeroGaps ? 0 : r() < 0.25 ? 0 : r() * 0.2;
      let w = LEX[Math.floor(r() * LEX.length)] ?? 'word';
      if (k === 0) w = w[0]?.toUpperCase() + w.slice(1);
      if (k === n - 1) w += si % 7 === 3 ? '?' : '.';
      words.push({ w, s: t, e: t + dur });
      t += dur + gap;
    }
    sentences.push({
      id: si,
      s: words[first]?.s ?? 0,
      e: words[words.length - 1]?.e ?? 0,
      text: words
        .slice(first)
        .map((x) => x.w)
        .join(' '),
      speaker: 'S1',
      wordStart: first,
      wordEnd: words.length - 1,
    });
    t += 0.3 + r() * 0.8; // pause between sentences
  }
  const durationSec = t + 1;
  const hop = 0.5;
  const nh = Math.ceil(durationSec / hop);
  const signals: AudioSignals = {
    hopSec: hop,
    durationSec,
    loudness: Array.from({ length: nh }, () => -24 + r() * 8),
    speechRate: Array.from({ length: nh }, () => 2 + r() * 2),
    silences: [],
    laughter: [],
    speakerChanges: [],
    sceneCuts: [],
  };
  return {
    transcript: {
      language: 'en',
      languageProbability: 1,
      durationSec,
      model: 'test',
      words,
      sentences,
    },
    signals,
  };
}

const opts = (preset: '15-30' | '30-60' = '15-30') =>
  pipelineOptionsSchema.parse({ clipPreset: preset });
const insideWord = (words: Word[], t: number): Word | undefined =>
  words.find((w) => t > w.s + 1e-9 && t < w.e - 1e-9);

describe('snapSpan: never cuts inside a word, pads 120-250 ms', () => {
  it('property: random spans never start/end strictly inside a word and padding stays in bounds', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const { transcript, signals } = synth(seed);
      const ix = buildIndex(transcript, signals.silences);
      const r = rng(seed * 101);
      const range = { minSec: 15, maxSec: 30 };
      for (let i = 0; i < 200; i++) {
        const a = r() * (transcript.durationSec - 40);
        const len = 5 + r() * 50;
        const res = snapSpan(ix, a, a + len, range);
        const { words } = transcript;
        expect(insideWord(words, res.startSec), `start ${res.startSec}`).toBeUndefined();
        expect(insideWord(words, res.endSec), `end ${res.endSec}`).toBeUndefined();
        const fw = words[res.firstWord];
        const lw = words[res.lastWord];
        if (!fw || !lw) throw new Error('missing words');
        // padding bounds
        const lead = fw.s - res.startSec;
        const tail = res.endSec - lw.e;
        expect(lead).toBeGreaterThanOrEqual(-1e-9);
        expect(tail).toBeGreaterThanOrEqual(-1e-9);
        expect(lead).toBeLessThanOrEqual(PAD_MAX + 1e-9);
        expect(tail).toBeLessThanOrEqual(PAD_MAX + 1e-9);
        // never into the neighbouring word's region (GUARD kept when there was a gap)
        const prev = words[res.firstWord - 1];
        const next = words[res.lastWord + 1];
        if (prev) expect(res.startSec).toBeGreaterThanOrEqual(prev.e - 1e-9);
        if (next) expect(res.endSec).toBeLessThanOrEqual(next.s + 1e-9);
        // full pad when there is room
        if (prev && fw.s - prev.e - GUARD >= 0.18) expect(lead).toBeGreaterThanOrEqual(0.12);
        if (next && next.s - lw.e - GUARD >= 0.22) expect(tail).toBeGreaterThanOrEqual(0.12);
        // clamped to the transcript
        expect(res.startSec).toBeGreaterThanOrEqual(0);
        expect(res.endSec).toBeLessThanOrEqual(transcript.durationSec + 1e-9);
        // duration range respected (transcript is long enough)
        const d = res.endSec - res.startSec;
        expect(d).toBeGreaterThanOrEqual(range.minSec - 1e-6);
        expect(d).toBeLessThanOrEqual(range.maxSec + 1e-6);
      }
    }
  });

  it('property: also holds when words touch each other (zero gaps, tiny-model timings)', () => {
    const { transcript, signals } = synth(77, 60, { zeroGaps: true });
    const ix = buildIndex(transcript, signals.silences);
    const r = rng(5);
    for (let i = 0; i < 300; i++) {
      const a = r() * (transcript.durationSec - 40);
      const res = snapSpan(ix, a, a + 8 + r() * 40, { minSec: 15, maxSec: 30 });
      expect(insideWord(transcript.words, res.startSec)).toBeUndefined();
      expect(insideWord(transcript.words, res.endSec)).toBeUndefined();
    }
  });

  it('keeps a whole word when the LLM boundary falls inside it (nearer edge wins)', () => {
    const words: Word[] = [
      { w: 'Hello', s: 1, e: 1.4 },
      { w: 'there', s: 1.6, e: 2.0 },
      { w: 'friend.', s: 2.2, e: 2.8 },
    ];
    const tr: Transcript = {
      language: 'en',
      languageProbability: 1,
      durationSec: 4,
      model: 't',
      words,
      sentences: [
        {
          id: 0,
          s: 1,
          e: 2.8,
          text: 'Hello there friend.',
          speaker: null,
          wordStart: 0,
          wordEnd: 2,
        },
      ],
    };
    const ix = buildIndex(tr);
    // start inside "there" (1.6-2.0) closer to its end -> "there" is dropped, start at "friend."
    const a = snapSpan(ix, 1.9, 2.8, { minSec: 0.1, maxSec: 10 });
    expect(a.firstWord).toBe(2);
    // start inside "there" closer to its start -> keep "there"
    const b = snapSpan(ix, 1.65, 2.8, { minSec: 0.1, maxSec: 10 });
    expect(b.firstWord).toBe(1);
  });

  it('pads inside a silence and never beyond the measured silence start/end', () => {
    const words: Word[] = [
      { w: 'before.', s: 1.0, e: 1.5 },
      { w: 'Start', s: 3.0, e: 3.4 },
      { w: 'here.', s: 3.4, e: 3.9 },
      { w: 'After', s: 5.0, e: 5.4 },
    ];
    const tr: Transcript = {
      language: 'en',
      languageProbability: 1,
      durationSec: 6,
      model: 't',
      words,
      sentences: [
        { id: 0, s: 1, e: 1.5, text: 'before.', speaker: null, wordStart: 0, wordEnd: 0 },
        { id: 1, s: 3, e: 3.9, text: 'Start here.', speaker: null, wordStart: 1, wordEnd: 2 },
        { id: 2, s: 5, e: 5.4, text: 'After', speaker: null, wordStart: 3, wordEnd: 3 },
      ],
    };
    // audio says speech ends at 2.9 and resumes at 3.0 (the silence starts at 2.95: closer than 180 ms)
    const ix = buildIndex(tr, [
      { s: 2.95, e: 3.0 },
      { s: 3.93, e: 4.95 },
    ]);
    const r = snapSpan(ix, 3.0, 3.9, { minSec: 0.1, maxSec: 10 });
    expect(r.startSec).toBeGreaterThanOrEqual(2.95);
    expect(r.startSec).toBeLessThanOrEqual(3.0);
    expect(r.endSec).toBeGreaterThan(3.9);
    expect(r.endSec).toBeLessThanOrEqual(3.9 + PAD_MAX + 1e-9);
  });

  it('uses a shorter pad when a neighbouring word is closer', () => {
    const words: Word[] = [
      { w: 'one.', s: 1, e: 1.5 },
      { w: 'Two', s: 1.58, e: 2.0 },
      { w: 'three.', s: 2.0, e: 2.5 },
      { w: 'Four', s: 2.55, e: 3.0 },
    ];
    const tr: Transcript = {
      language: 'en',
      languageProbability: 1,
      durationSec: 4,
      model: 't',
      words,
      sentences: [
        { id: 0, s: 1, e: 1.5, text: 'one.', speaker: null, wordStart: 0, wordEnd: 0 },
        { id: 1, s: 1.58, e: 2.5, text: 'Two three.', speaker: null, wordStart: 1, wordEnd: 2 },
        { id: 2, s: 2.55, e: 3, text: 'Four', speaker: null, wordStart: 3, wordEnd: 3 },
      ],
    };
    const ix = buildIndex(tr);
    const r = snapSpan(ix, 1.58, 2.5, { minSec: 0.1, maxSec: 10 });
    expect(r.startSec).toBeGreaterThanOrEqual(1.5 + GUARD - 1e-9); // 80 ms gap -> at most 50 ms of pad
    expect(r.startSec).toBeLessThanOrEqual(1.58);
    expect(r.endSec).toBeLessThanOrEqual(2.55 - GUARD + 1e-9);
  });

  it('enforces the duration range by moving to sentence boundaries', () => {
    const { transcript, signals } = synth(9, 60);
    const ix = buildIndex(transcript, signals.silences);
    // a 5 s LLM span is stretched to >= 30 s; a 120 s span is trimmed to <= 60 s
    const short = snapSpan(ix, 20, 25, { minSec: 30, maxSec: 60 });
    expect(short.endSec - short.startSec).toBeGreaterThanOrEqual(30 - 1e-6);
    expect(short.endSec - short.startSec).toBeLessThanOrEqual(60 + 1e-6);
    const long = snapSpan(ix, 20, 140, { minSec: 30, maxSec: 60 });
    expect(long.endSec - long.startSec).toBeLessThanOrEqual(60 + 1e-6);
    expect(long.endSec - long.startSec).toBeGreaterThanOrEqual(30 - 1e-6);
    // ends on a sentence end
    expect(ix.isSentenceEnd[long.lastWord]).toBe(1);
  });

  it('clamps to the transcript and survives empty/degenerate input', () => {
    const { transcript, signals } = synth(3, 30);
    const svc = createMomentService();
    const r = svc.snap({
      startSec: -50,
      endSec: transcript.durationSec + 100,
      transcript,
      signals,
      options: opts('30-60'),
    });
    expect(r.startSec).toBeGreaterThanOrEqual(0);
    expect(r.endSec).toBeLessThanOrEqual(transcript.durationSec);
    const empty: Transcript = { ...transcript, words: [], sentences: [] };
    const e = svc.snap({ startSec: 3, endSec: 9, transcript: empty, signals, options: opts() });
    expect(e.endSec).toBeGreaterThanOrEqual(e.startSec);
  });
});

describe('hook and self-containment heuristics', () => {
  it('rates question / number / bold-claim openings above filler openings', () => {
    const strong = hookStrength(
      'Why does nobody tell you this about 3 simple mistakes?',
      'Why does nobody tell you this about 3 simple mistakes?',
      10,
    );
    const filler = hookStrength(
      'um so yeah and then he said it',
      'um so yeah and then he said it.',
      9,
    );
    const dangling = hookStrength(
      'They went there and it was fine',
      'They went there and it was fine.',
      8,
    );
    expect(strong.score).toBeGreaterThan(0.7);
    expect(strong.isQuestion).toBe(true);
    expect(strong.hasNumber).toBe(true);
    expect(filler.score).toBeLessThan(0.2);
    expect(dangling.score).toBeLessThan(strong.score - 0.4);
    const story = hookStrength(
      'I remember when I was twelve we lost everything',
      'I remember when I was twelve we lost everything.',
      9,
    );
    expect(story.score).toBeGreaterThan(filler.score + 0.3);
  });

  it('penalises dangling starts, open endings and unanswered questions', () => {
    const base = {
      firstTokens: ['the', 'secret', 'is'],
      lastWord: 'done.',
      lastSentence: 'And that is how it is done.',
      firstSentence: 'The secret is simple.',
      sentenceCount: 3,
      wordsAfterFirstSentence: 40,
      speakerChanges: 0,
      startsAtSentenceStart: true,
      endsAtSentenceEnd: true,
    };
    const good = selfContainment(base);
    expect(good).toBeGreaterThan(0.7);
    expect(selfContainment({ ...base, firstTokens: ['but', 'then', 'we'] })).toBeLessThan(
      good - 0.3,
    );
    expect(selfContainment({ ...base, firstTokens: ['and', 'so'] })).toBeLessThan(good - 0.3);
    expect(selfContainment({ ...base, firstTokens: ['they', 'did', 'it'] })).toBeLessThan(
      good - 0.1,
    );
    expect(
      selfContainment({ ...base, lastWord: 'and', lastSentence: 'We went to the store and' }),
    ).toBeLessThan(good - 0.3);
    const answered = selfContainment({
      ...base,
      firstSentence: 'Why does this work?',
      firstTokens: ['why', 'does', 'this'],
    });
    const unanswered = selfContainment({
      ...base,
      firstSentence: 'Why does this work?',
      firstTokens: ['why', 'does', 'this'],
      sentenceCount: 1,
      wordsAfterFirstSentence: 0,
      lastSentence: 'Why does this work?',
      lastWord: 'work?',
    });
    expect(answered).toBeGreaterThan(unanswered + 0.3);
  });
});

describe('generateCandidates', () => {
  const { transcript, signals } = synth(21, 140);
  const svc = createMomentService();
  const args = {
    transcript,
    signals,
    options: opts('30-60'),
    window: { startSec: 0, endSec: transcript.durationSec },
    maxCandidates: 10,
  };

  it('returns <= max candidates inside the duration range, sentence aligned, without heavy overlap', () => {
    const c = svc.generateCandidates(args);
    expect(c.length).toBeGreaterThan(3);
    expect(c.length).toBeLessThanOrEqual(10);
    const ix = buildIndex(transcript, signals.silences);
    for (const m of c) {
      const d = m.e - m.s;
      expect(d).toBeGreaterThanOrEqual(30 - 1e-6);
      expect(d).toBeLessThanOrEqual(60 + 1e-6);
      expect(m.prior).toBeGreaterThanOrEqual(0);
      expect(m.prior).toBeLessThanOrEqual(1);
      expect(insideWord(transcript.words, m.s)).toBeUndefined();
      expect(insideWord(transcript.words, m.e)).toBeUndefined();
      // first/last covered sentence ids match the sentence boundaries
      const first = ix.sentences.find((s) => s.id === m.sentenceIds[0]);
      const last = ix.sentences.find((s) => s.id === m.sentenceIds[m.sentenceIds.length - 1]);
      expect(transcript.words[first?.first ?? -1]?.s).toBeGreaterThanOrEqual(m.s);
      expect(transcript.words[last?.last ?? -1]?.e).toBeLessThanOrEqual(m.e);
      expect(m.text.length).toBeGreaterThan(20);
    }
    for (let i = 0; i < c.length; i++) {
      for (let j = i + 1; j < c.length; j++) {
        const a = c[i];
        const b = c[j];
        if (!a || !b) continue;
        const inter = Math.min(a.e, b.e) - Math.max(a.s, b.s);
        if (inter > 0)
          expect(inter / Math.min(a.e - a.s, b.e - b.s)).toBeLessThanOrEqual(0.3 + 1e-9);
      }
    }
    // sorted by prior, descending
    for (let i = 1; i < c.length; i++)
      expect(c[i - 1]!.prior).toBeGreaterThanOrEqual(c[i]!.prior - 1e-12);
  });

  it('is deterministic and ids are stable', () => {
    const a = svc.generateCandidates(args);
    const b = createMomentService().generateCandidates({
      ...args,
      transcript: structuredClone(transcript),
    });
    expect(b).toEqual(a);
    expect(new Set(a.map((m) => m.id)).size).toBe(a.length);
    expect(a[0]?.id).toMatch(/^m\d+-\d+$/);
  });

  it('respects the window and maxCandidates=0', () => {
    const w = { startSec: 100, endSec: 260 };
    const c = svc.generateCandidates({ ...args, window: w });
    expect(c.length).toBeGreaterThan(0);
    for (const m of c) {
      expect(m.s).toBeGreaterThanOrEqual(w.startSec - 0.3);
      expect(m.e).toBeLessThanOrEqual(w.endSec + 0.3);
    }
    expect(svc.generateCandidates({ ...args, maxCandidates: 0 })).toEqual([]);
  });

  it('prefers a strong hook with a payoff over a filler start (planted moments)', () => {
    const r = rng(4);
    const words: Word[] = [];
    const sentences: Sentence[] = [];
    let t = 0.5;
    const add = (text: string, wordDur = 0.3): void => {
      const first = words.length;
      for (const w of text.split(' ')) {
        words.push({ w, s: t, e: t + wordDur });
        t += wordDur + 0.03;
      }
      sentences.push({
        id: sentences.length,
        s: words[first]?.s ?? 0,
        e: words[words.length - 1]?.e ?? 0,
        text,
        speaker: 'S1',
        wordStart: first,
        wordEnd: words.length - 1,
      });
      t += 0.35;
    };
    const filler = (n: number): void => {
      for (let i = 0; i < n; i++)
        add(
          `${LEX[Math.floor(r() * 20)]} ${LEX[Math.floor(r() * 20)]} was there and we saw it all today.`,
        );
    };
    // segment A: filler/dangling start
    add('um so yeah and then it went on for a while you know.');
    filler(12);
    const bStart = t;
    // segment B: strong hook with a number, question that gets answered
    add('Why do 90 percent of startups fail in the first year?');
    add('Because nobody ever tells you the truth about cash flow.');
    filler(12);
    const dur = t + 1;
    const hop = 0.5;
    const tr: Transcript = {
      language: 'en',
      languageProbability: 1,
      durationSec: dur,
      model: 't',
      words,
      sentences,
    };
    const sig: AudioSignals = {
      hopSec: hop,
      durationSec: dur,
      loudness: Array.from({ length: Math.ceil(dur / hop) }, () => -22),
      speechRate: Array.from({ length: Math.ceil(dur / hop) }, () => 3),
      silences: [],
      laughter: [],
      speakerChanges: [],
      sceneCuts: [],
    };
    const c = svc.generateCandidates({
      transcript: tr,
      signals: sig,
      options: pipelineOptionsSchema.parse({ clipPreset: 'custom', minSec: 10, maxSec: 25 }),
      window: { startSec: 0, endSec: dur },
      maxCandidates: 5,
    });
    expect(c.length).toBeGreaterThan(1);
    const top = c[0];
    expect(top?.s).toBeGreaterThanOrEqual(bStart - 0.5);
    expect(top?.s).toBeLessThan(bStart + 0.5);
    expect(top?.signals.hasQuestion).toBe(true);
    expect(top?.signals.hasNumber).toBe(true);
    const fillerCand = c.find((m) => m.s < 1);
    if (fillerCand) expect(fillerCand.prior).toBeLessThan(top?.prior ?? 0);
  });
});
