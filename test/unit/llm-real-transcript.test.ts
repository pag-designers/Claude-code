import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  estimateRunCost,
  momentsPerWindow,
  naiveCandidates,
  splitWindows,
} from '@main/services/llm/estimate';
import { verifyMoments } from '@main/services/llm/moments';
import { RANK_SYSTEM } from '@main/services/llm/prompts';
import type { ModelMoment } from '@main/services/llm/schemas';
import { estimateTokens, formatSentenceLines, speakerTag } from '@main/services/llm/transcript';
import { durationRange, transcriptSchema, type Transcript } from '@shared/pipeline';
import { makeService } from './llm-harness';
import { makeOptions } from './llm-fixtures';
import { StubAnthropic, type WireBlock } from './llm-stub-server';

/**
 * Real ASR output (whisper tiny on a 3-minute local-news interview): fragments like "Okay,",
 * sentences split at commas and mid-phrase, speaker labels "S1"/"S2", missing full stops.
 */
const transcript: Transcript = transcriptSchema.parse(
  JSON.parse(
    fs.readFileSync(path.join(__dirname, '../fixtures/llm-news-3min.transcript.json'), 'utf8'),
  ),
);
const sentences = transcript.sentences;

const stub = new StubAnthropic();
beforeAll(async () => {
  await stub.start();
});
afterAll(async () => {
  await stub.stop();
});
beforeEach(() => stub.reset());

const mm = (a: number, b: number, over: Partial<ModelMoment> = {}): ModelMoment => ({
  candidateId: null,
  startSentence: a,
  endSentence: b,
  title: 'A title',
  hook: 'A hook',
  whyItWorks: 'because',
  keywords: [],
  scores: { hook: 10, retention: 10, emotion: 10, clarity: 10, shareability: 10 },
  confidence: 0.5,
  ...over,
});

const verify = (raw: ModelMoment[], range = { minSec: 5, maxSec: 60 }) =>
  verifyMoments({
    raw,
    sentences,
    window: { startSec: 0, endSec: transcript.durationSec },
    range,
    candidates: [],
    maxClips: 10,
    log: () => {},
  });

describe('real transcript: formatting', () => {
  it('labels every sentence, uses spk1/spk2 so speakers cannot be mistaken for S<id>', () => {
    const text = formatSentenceLines(sentences);
    const lines = text.split('\n');
    expect(lines).toHaveLength(sentences.length);
    for (const l of lines) expect(l).toMatch(/^S\d+ \[\d\d:\d\d\] (\{spk\d\} )?\S/);
    expect(lines[0]).toMatch(/^S0 \[00:00\] \{spk1\} So those were/);
    expect(lines[3]).toMatch(/^S3 \[00:15\] \{spk2\} And then/);
    expect(lines[4]).not.toContain('{spk'); // same speaker as the line before
    expect(text).not.toContain('{S1}');
  });

  it('speakerTag handles labels with and without digits', () => {
    expect(speakerTag('S2')).toBe('spk2');
    expect(speakerTag('SPEAKER_03')).toBe('spk03');
    expect(speakerTag('Host')).toBe('Host');
  });

  it('a 3-minute video is a small prompt (est. tokens)', () => {
    const t = estimateTokens(formatSentenceLines(sentences));
    expect(t).toBeGreaterThan(600);
    expect(t).toBeLessThan(1500);
    expect(estimateTokens(RANK_SYSTEM)).toBeGreaterThan(1000);
  });
});

describe('real transcript: sentence-boundary repair', () => {
  it('extends an end that stops mid-sentence ("... at the end of high school to" / "really do well")', () => {
    const r = verify([mm(0, 0)]);
    expect(r.moments).toHaveLength(1);
    expect(r.moments[0]!.startSec).toBe(0);
    expect(r.moments[0]!.endSec).toBe(sentences[1]!.e);
  });

  it('moves a start back when the first line is the tail of a sentence', () => {
    const r = verify([mm(1, 2)]);
    expect(r.moments[0]!.startSec).toBe(sentences[0]!.s);
  });

  it('pulls in the fragment "Okay," before "but everybody worked hard ..."', () => {
    const r = verify([mm(12, 15)]);
    expect(r.moments[0]!.startSec).toBe(sentences[11]!.s);
  });

  it('accepts moments that already start and end cleanly', () => {
    const r = verify([mm(7, 10)]);
    expect(r.moments).toHaveLength(1);
    expect(r.moments[0]!.startSec).toBe(sentences[7]!.s);
    expect(r.moments[0]!.endSec).toBe(sentences[10]!.e);
  });
});

describe('real transcript: end to end against the stub', () => {
  it('rankMoments picks a heuristic candidate through the prompt, and understand() maps real ids', async () => {
    const options = makeOptions({ clipPreset: '30-60', clipCount: 3 });
    const range = durationRange(options);
    const candidates = naiveCandidates(sentences, range, 12);
    expect(candidates.length).toBeGreaterThan(3);

    // The "model" reads candidate ids from the prompt it receives, like the real one would.
    stub.replies = [
      (body) => {
        const vol = (body.messages[0]!.content as WireBlock[])[1]!.text;
        const first = /^(n\d+) \| S(\d+)-S(\d+) \|/m.exec(vol);
        if (!first) throw new Error('no candidate line in the prompt');
        return {
          text: JSON.stringify({
            moments: [
              {
                candidateId: first[1],
                startSentence: Number(first[2]),
                endSentence: Number(first[3]),
                title: 'Growing up with autism in the 90s',
                hook: 'Nobody knew what services to ask for',
                whyItWorks:
                  'A parent admits they were inventing the wheel; the payoff is the journey.',
                keywords: ['autism', 'services'],
                scores: { hook: 14, retention: 13, emotion: 9, clarity: 10, shareability: 8 },
                confidence: 0.6,
              },
            ],
            windowNotes: '',
          }),
        };
      },
    ];
    const { service } = makeService(stub);
    const out = await service.rankMoments({
      videoId: 'v',
      info: { title: 'News Now', channel: null },
      analysis: null,
      options,
      window: { startSec: 0, endSec: transcript.durationSec },
      sentences,
      candidates,
      maxClips: 3,
    });
    expect(out).toHaveLength(1);
    const c = candidates.find((x) => x.id === out[0]!.candidateId)!;
    // sentence-boundary repair may widen it, never shrink it
    expect(out[0]!.startSec).toBeLessThanOrEqual(c.s);
    expect(out[0]!.endSec).toBeGreaterThanOrEqual(c.e);
    expect(out[0]!.endSec - out[0]!.startSec).toBeLessThanOrEqual(range.maxSec + 5);

    // understand: real ids, verbatim quote from the last sentence
    stub.replies = [
      {
        text: JSON.stringify({
          overview: {
            summary: 's',
            tone: 't',
            participants: ['Host', 'John'],
            takeaways: ['a', 'b', 'c', 'd', 'e'],
          },
          chapters: [
            { title: 'Early years', startSentence: 0, summary: 'a' },
            { title: 'Self-discovery', startSentence: 7, summary: 'b' },
            { title: 'Advice for the community', startSentence: 25, summary: 'c' },
          ],
          notes: {
            keyPoints: ['k'],
            quotes: [
              { text: 'when did you realize that John had this gift with his arts', sentence: 1 },
            ],
            numbers: [],
            claims: [],
            actionItems: [],
          },
          topics: ['autism'],
          entities: ['John'],
          keywords: ['autism'],
        }),
      },
    ];
    const a = await service.understand({
      info: { title: 'News Now', channel: null, description: null, chapters: [] },
      transcript,
    });
    expect(a.chapters.map((x) => [x.start, x.end])).toEqual([
      [0, sentences[7]!.s],
      [sentences[7]!.s, sentences[25]!.s],
      [sentences[25]!.s, transcript.durationSec],
    ]);
    expect(a.notes.quotes).toEqual([
      { text: 'when did you realize that John had this gift with his arts', at: sentences[37]!.s },
    ]);
  });
});

describe('estimate helpers on real data', () => {
  it('splitWindows keeps every sentence once, in order, and never splits one', () => {
    const wins = splitWindows(sentences, 60);
    expect(wins.length).toBeGreaterThanOrEqual(3);
    expect(wins.flatMap((w) => w.sentences.map((s) => s.id))).toEqual(sentences.map((s) => s.id));
    for (const w of wins) {
      expect(w.startSec).toBe(w.sentences[0]!.s);
      expect(w.endSec).toBe(w.sentences.at(-1)!.e);
    }
  });

  it('naiveCandidates stay inside the duration range and the window', () => {
    for (const c of naiveCandidates(sentences, { minSec: 30, maxSec: 60 }, 20)) {
      expect(c.e - c.s).toBeGreaterThanOrEqual(30);
      expect(c.e - c.s).toBeLessThanOrEqual(60);
      expect(c.sentenceIds.length).toBeGreaterThan(0);
    }
  });

  it('momentsPerWindow: spreads the clip count, never more than fit in the window', () => {
    expect(momentsPerWindow(10, 6, 600, { minSec: 30 })).toBe(3);
    expect(momentsPerWindow(10, 1, 180, { minSec: 30 })).toBe(6);
    expect(momentsPerWindow(null, 2, 600, { minSec: 60 })).toBe(9);
    expect(momentsPerWindow(1, 20, 600, { minSec: 30 })).toBe(1);
  });

  it('estimateRunCost is plausible and scales with video length', () => {
    const options = makeOptions();
    const small = estimateRunCost({ transcript, options });
    expect(small.windows).toBe(1);
    expect(small.totalUsd).toBeGreaterThan(0.02);
    expect(small.totalUsd).toBeLessThan(0.3);
    expect(small.understand.cacheWriteTokens).toBeGreaterThan(1000);
    const longer: Transcript = {
      ...transcript,
      durationSec: transcript.durationSec * 4,
      sentences: Array.from({ length: 4 }, (_, k) =>
        sentences.map((s) => ({ ...s, id: s.id + k * 100, s: s.s + k * 181, e: s.e + k * 181 })),
      ).flat(),
    };
    const big = estimateRunCost({ transcript: longer, options, windowSec: 200 });
    expect(big.windows).toBe(4);
    expect(big.totalUsd).toBeGreaterThan(small.totalUsd * 2);
    expect(big.moments.cacheReadTokens).toBeGreaterThan(0); // windows 2-4 read the system prompt
    expect(big.assumptions.join(' ')).toContain('UNMEASURED');
  });
});
