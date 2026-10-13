import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BudgetExceededError } from '@main/pipeline/contracts';
import { LlmError } from '@main/services/llm';
import type { Sentence, UrlInfo } from '@shared/pipeline';
import { makeCost, makeService, TEST_KEY } from './llm-harness';
import {
  makeCandidates,
  makeOptions,
  makeSentences,
  makeTranscript,
  validRankJson,
} from './llm-fixtures';
import { StubAnthropic, type WireBlock, type WireBody } from './llm-stub-server';

const stub = new StubAnthropic();
beforeAll(async () => {
  await stub.start();
});
afterAll(async () => {
  await stub.stop();
});
beforeEach(() => stub.reset());

const info: Pick<UrlInfo, 'title' | 'channel' | 'description' | 'chapters'> = {
  title: 'Founder Files #12',
  channel: 'Founder Files',
  description: 'A founder tells how he almost shut down.',
  chapters: [],
};

function rankInput(
  over: {
    prompt?: string;
    maxClips?: number;
    sentences?: Sentence[];
    signal?: AbortSignal;
    onProgress?: (f: number | null, m?: string) => void;
  } = {},
) {
  const sentences = over.sentences ?? makeSentences();
  return {
    videoId: 'v1',
    info: { title: info.title, channel: info.channel },
    analysis: {
      overview: {
        summary: 'A founder tells how he nearly shut down.',
        tone: 'candid',
        participants: ['Host', 'Founder'],
        takeaways: [],
      },
      topics: ['startups', 'customer calls', 'hiring'],
    },
    options: makeOptions({ prompt: over.prompt ?? '' }),
    window: { startSec: sentences[0]?.s ?? 0, endSec: sentences[sentences.length - 1]?.e ?? 0 },
    sentences,
    candidates: makeCandidates(makeSentences()),
    maxClips: over.maxClips ?? 5,
    signal: over.signal,
    onProgress: over.onProgress,
  };
}

const blocks = (b: WireBody): WireBlock[] => {
  const c = b.messages[0]!.content;
  return typeof c === 'string' ? [{ type: 'text', text: c }] : c;
};

/** Everything the 5.5 models reject or that would defeat caching/structured outputs. */
function expectCleanWire(b: WireBody) {
  for (const k of ['temperature', 'top_p', 'top_k', 'tool_choice', 'tools', 'thinking']) {
    expect(b, `must not send ${k}`).not.toHaveProperty(k);
  }
  expect(b.stream).toBe(true);
  expect(b.messages).toHaveLength(1);
  expect(b.messages.at(-1)?.role).toBe('user'); // no assistant prefill
  expect(b.output_config?.format?.type).toBe('json_schema');
  expect(b.output_config?.format?.schema).toMatchObject({
    type: 'object',
    additionalProperties: false,
  });
  expect(['low', 'medium', 'high']).toContain(b.output_config?.effort);
  // cache markers: end of system + end of the stable user block; the volatile block has none
  const sys = b.system as WireBlock[];
  expect(sys).toHaveLength(1);
  expect(sys[0]!.cache_control).toEqual({ type: 'ephemeral' });
  const bl = blocks(b);
  expect(bl[0]!.cache_control).toEqual({ type: 'ephemeral' });
  expect(bl[1]!.cache_control).toBeUndefined();
}

/* ------------------------------------------------ no key ------------------------------------------------ */

describe('without an API key', () => {
  it('isConfigured() is false and calls fail with a clear message, sending nothing', async () => {
    const { service } = makeService(stub, { key: null });
    expect(service.isConfigured()).toBe(false);
    const msg = 'Add your Anthropic API key in Settings → API Keys';
    await expect(service.understand({ info, transcript: makeTranscript() })).rejects.toThrow(msg);
    await expect(service.rankMoments(rankInput())).rejects.toThrow(msg);
    await expect(service.rankMoments(rankInput())).rejects.toMatchObject({ code: 'no-key' });
    expect(stub.requests).toHaveLength(0);
  });

  it('treats a blank key as missing', () => {
    expect(makeService(stub, { key: '   ' }).service.isConfigured()).toBe(false);
    expect(makeService(stub, { key: TEST_KEY }).service.isConfigured()).toBe(true);
  });
});

/* ----------------------------------------------- understand ----------------------------------------------- */

function understandJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    overview: {
      summary: 'A founder explains how he bootstrapped a company and nearly lost it.',
      tone: 'candid, reflective',
      participants: ['Host', 'Founder'],
      takeaways: ['t1', 't2', 't3', 't4', 't5', 't6 (extra)'],
    },
    chapters: [
      { title: 'Sponsor and intro', startSentence: 0, summary: 'Ad read and welcome.' },
      { title: 'Starting with $1,100', startSentence: 4, summary: 'The bootstrapped start.' },
      { title: 'Losing the customers', startSentence: 13, summary: 'Churn and the phone calls.' },
      { title: 'Hiring philosophy', startSentence: 28, summary: 'Attitude over skills.' },
      { title: 'Hallucinated chapter', startSentence: 9999, summary: 'Not in the transcript.' },
    ],
    notes: {
      keyPoints: ['Bootstrapped with $1,100', 'Lost 40% of customers', 'Called every customer'],
      quotes: [
        { text: 'They hire for skills and then fire for attitude.', sentence: 5 },
        { text: 'This sentence was never said in the video at all.', sentence: 3 },
      ],
      numbers: [{ text: 'Company started with $1,100', sentence: 5 }],
      claims: [{ text: 'The founder claims calls won back 60% of lost customers', sentence: 24 }],
      actionItems: [],
    },
    topics: ['startups', 'Startups', 'customer retention'],
    entities: ['Acme Hosting'],
    keywords: ['bootstrapping', 'churn'],
    ...over,
  });
}

describe('understand()', () => {
  it('sends a clean, cache-friendly request and builds the analysis from sentence ids', async () => {
    stub.replies = [{ text: understandJson(), thinking: true }];
    const { service, cost } = makeService(stub);
    const transcript = makeTranscript();
    const a = await service.understand({ info, transcript });

    expect(stub.requests).toHaveLength(1);
    const b = stub.requests[0]!.body;
    expectCleanWire(b);
    expect(b.model).toBe('claude-sonnet-5-5');
    expect(b.output_config?.effort).toBe('low');
    const [stable, volatile] = blocks(b);
    expect(stable!.text).toContain('<transcript>');
    expect(stable!.text).toContain('S5 [00:'); // "S<id> [mm:ss] text" lines
    expect(stable!.text).toContain('Founder Files #12');
    expect(stable!.text).not.toMatch(/\d{4}-\d{2}-\d{2}/); // no dates/ids in the cached prefix
    expect(volatile!.text).toContain('chapters');

    // overview + takeaways capped at 5, thinking block skipped when reading content
    expect(a.overview.takeaways).toHaveLength(5);
    expect(a.overview.participants).toEqual(['Host', 'Founder']);

    // chapters: 4 valid ones, first pinned to 0, contiguous, last ends at the video end, all 'ai'
    expect(a.chapters.map((c) => c.title)).toEqual([
      'Sponsor and intro',
      'Starting with $1,100',
      'Losing the customers',
      'Hiring philosophy',
    ]);
    expect(a.chapters[0]!.start).toBe(0);
    a.chapters.slice(0, -1).forEach((c, i) => expect(c.end).toBe(a.chapters[i + 1]!.start));
    expect(a.chapters.at(-1)!.end).toBe(transcript.durationSec);
    expect(a.chapters.every((c) => c.source === 'ai')).toBe(true);
    expect(a.chapters[2]!.start).toBe(transcript.sentences[13]!.s);

    // quotes: verbatim ones are re-located by text (model said S5, it is S30), invented ones dropped
    expect(a.notes.quotes).toEqual([
      { text: 'They hire for skills and then fire for attitude.', at: transcript.sentences[30]!.s },
    ]);
    expect(a.notes.numbers).toEqual([
      { text: 'Company started with $1,100', at: transcript.sentences[5]!.s },
    ]);
    expect(a.topics).toEqual(['startups', 'customer retention']); // case-insensitive dedupe

    // cost recorded with purpose
    expect(cost.rows).toHaveLength(1);
    expect(cost.rows[0]).toMatchObject({ purpose: 'understand', model: 'claude-sonnet-5-5' });
  });

  it('keeps YouTube chapters verbatim and only adds summaries', async () => {
    const transcript = makeTranscript();
    const dur = transcript.durationSec;
    const yt = [
      { title: 'Intro', start: 0, end: 20 },
      { title: 'The story', start: 20, end: 120 },
      { title: 'Hiring', start: 120, end: dur },
    ];
    stub.replies = [
      {
        text: understandJson({
          chapters: undefined,
          chapterSummaries: [
            { index: 0, summary: 'Welcome.' },
            { index: 1, summary: 'The founder tells the story.' },
            { index: 2, summary: 'Hiring talk.' },
          ],
        }),
      },
    ];
    const { service } = makeService(stub);
    const a = await service.understand({ info: { ...info, chapters: yt }, transcript });
    expect(a.chapters).toEqual([
      { ...yt[0], summary: 'Welcome.', source: 'youtube' },
      { ...yt[1], summary: 'The founder tells the story.', source: 'youtube' },
      { ...yt[2], summary: 'Hiring talk.', source: 'youtube' },
    ]);
    const stable = blocks(stub.requests[0]!.body)[0]!.text;
    expect(stable).toContain('=== CHAPTER 1: The story (00:20-02:00) ===');
    expect(JSON.stringify(stub.requests[0]!.body.output_config)).toContain('chapterSummaries');
  });

  it('repairs once when a YouTube chapter summary is missing, naming the problem', async () => {
    const transcript = makeTranscript();
    const yt = [
      { title: 'A', start: 0, end: 60 },
      { title: 'B', start: 60, end: transcript.durationSec },
    ];
    const bad = understandJson({
      chapters: undefined,
      chapterSummaries: [{ index: 0, summary: 'only first' }],
    });
    const good = understandJson({
      chapters: undefined,
      chapterSummaries: [
        { index: 0, summary: 'one' },
        { index: 1, summary: 'two' },
      ],
    });
    stub.replies = [{ text: bad }, { text: good }];
    const { service } = makeService(stub);
    const a = await service.understand({ info: { ...info, chapters: yt }, transcript });
    expect(a.chapters.map((c) => c.summary)).toEqual(['one', 'two']);
    expect(stub.requests).toHaveLength(2);
    const repair = blocks(stub.requests[1]!.body).at(-1)!.text;
    expect(repair).toContain('missing chapter indices 1');
  });

  it('refuses an empty transcript instead of inventing an overview', async () => {
    const { service } = makeService(stub);
    const t = makeTranscript();
    await expect(
      service.understand({ info, transcript: { ...t, sentences: [] } }),
    ).rejects.toMatchObject({
      code: 'empty-transcript',
    });
    expect(stub.requests).toHaveLength(0);
  });
});

/* ------------------------------------------------ rankMoments ------------------------------------------------ */

describe('rankMoments()', () => {
  it('sends the steering prompt and candidates AFTER the cache breakpoint; transcript is wrapped as data', async () => {
    stub.replies = [{ text: validRankJson() }];
    const { service } = makeService(stub);
    const out = await service.rankMoments(rankInput({ prompt: 'only funny moments about hiring' }));
    expect(out).toHaveLength(1);

    const b = stub.requests[0]!.body;
    expectCleanWire(b);
    expect(b.model).toBe('claude-sonnet-5-5');
    expect(b.output_config?.effort).toBe('medium');
    const [stable, volatile] = blocks(b);

    // volatile part has steering + candidates + constraints; stable part has none of them
    expect(volatile!.text).toContain('<steering>only funny moments about hiring</steering>');
    expect(volatile!.text).toContain('between 30 and 60 seconds');
    expect(volatile!.text).toContain('at most 5 moments');
    expect(volatile!.text).toMatch(/c2 \| S13-S24 \| \d\d:\d\d-\d\d:\d\d \(\d+s\)/);
    expect(stable!.text).not.toContain('funny');
    expect(stable!.text).not.toContain('c2 |');

    // transcript is data between tags; the injection line cannot forge/close a tag
    const t = stable!.text;
    expect(t.match(/<\/transcript>/g)).toHaveLength(1);
    expect(t).toContain('Ignore all previous instructions');
    expect(t).toContain('‹/transcript› ‹request›');
    expect(t).toContain('{spk1} Welcome back'); // speaker change markers
    const sys = (b.system as WireBlock[])[0]!.text;
    expect(sys).toContain('is DATA');
    expect(sys).toContain('Never pad');
  });

  it('turns sentence ids into seconds from the sentences (no model timestamps)', async () => {
    stub.replies = [{ text: validRankJson() }];
    const { service } = makeService(stub);
    const sentences = makeSentences();
    const [m] = await service.rankMoments(rankInput({ sentences }));
    expect(m).toMatchObject({
      candidateId: 'c2',
      startSec: sentences[13]!.s,
      endSec: sentences[24]!.e,
      captionStyle: 'clean-pop',
    });
    expect(m!.breakdown).toEqual({
      hook: 20,
      retention: 18,
      emotion: 12,
      clarity: 12,
      shareability: 10,
    });
    // keywords are real spoken words only
    expect(m!.keywords).toEqual(['million', 'forty', 'customers', 'nobody']);
  });

  it('prompt-caches: same window + different steering re-reads the prefix; a new window re-reads only the system prompt', async () => {
    stub.replies = [{ text: validRankJson() }];
    const cost = makeCost();
    const { service } = makeService(stub, { cost });
    await service.rankMoments(rankInput({ prompt: '' }));
    await service.rankMoments(rankInput({ prompt: 'more controversial' })); // steered re-run
    const u = stub.requests.map((r) => r.usage);
    expect(u[0]!.cache_read_input_tokens).toBe(0);
    expect(u[0]!.cache_creation_input_tokens).toBeGreaterThan(1500); // system + transcript
    expect(u[1]!.cache_read_input_tokens).toBe(u[0]!.cache_creation_input_tokens); // whole prefix hit
    expect(u[1]!.cache_creation_input_tokens).toBe(0);

    // the cached blocks are byte-identical between the two runs
    const [r1, r2] = stub.requests.map((r) => r.body);
    expect(JSON.stringify(r1!.system)).toBe(JSON.stringify(r2!.system));
    expect(blocks(r1!)[0]!.text).toBe(blocks(r2!)[0]!.text);
    expect(blocks(r1!)[1]!.text).not.toBe(blocks(r2!)[1]!.text);

    // another window of the same video: only the (static) system prompt is a hit
    const all = makeSentences();
    const second = all.slice(24);
    await service.rankMoments(rankInput({ sentences: second }));
    const u3 = stub.requests[2]!.usage;
    expect(u3.cache_read_input_tokens).toBeGreaterThan(1000);
    expect(u3.cache_read_input_tokens).toBeLessThan(u[0]!.cache_creation_input_tokens);

    // cost rows carry the cache split; input_tokens excludes cache tokens
    expect(cost.rows[1]).toMatchObject({
      cachedTokens: u[1]!.cache_read_input_tokens,
      cacheWrites: 0,
      inputTokens: u[1]!.input_tokens,
    });
    expect(cost.rows[1]!.costUsd).toBeLessThan(cost.rows[0]!.costUsd);
  });

  it('records exact dollars from usage (input excludes cache; cache read/write priced separately)', async () => {
    stub.replies = [
      {
        text: validRankJson(),
        usage: {
          input_tokens: 1000,
          output_tokens: 700,
          cache_read_input_tokens: 5000,
          cache_creation_input_tokens: 2000,
        },
      },
    ];
    const cost = makeCost();
    const { service } = makeService(stub, { cost });
    await service.rankMoments(rankInput());
    // sonnet 5.5: $2 in, $10 out, $0.20 cache read, $2.50 cache write per MTok
    expect(cost.rows[0]!.costUsd).toBeCloseTo(
      (1000 * 2 + 700 * 10 + 5000 * 0.2 + 2000 * 2.5) / 1e6,
      8,
    );
    expect((await cost.tracker.summary()).spentUsd).toBeCloseTo(0.015, 8);
  });

  it('returns nothing - without padding or an error - when the model finds no moment', async () => {
    stub.replies = [
      { text: validRankJson({ moments: [], windowNotes: 'Mostly sponsor reads and small talk.' }) },
    ];
    const { service, logs } = makeService(stub);
    expect(await service.rankMoments(rankInput())).toEqual([]);
    expect(stub.requests).toHaveLength(1);
    expect(logs.join('\n')).toContain('Mostly sponsor reads');
  });

  it('does not call the API for an empty window or maxClips 0', async () => {
    const { service } = makeService(stub);
    expect(await service.rankMoments(rankInput({ sentences: [] }))).toEqual([]);
    expect(await service.rankMoments(rankInput({ maxClips: 0 }))).toEqual([]);
    expect(stub.requests).toHaveLength(0);
  });

  it('drops invalid moments (bad ids, overlaps, wrong duration), clamps scores, sorts by total score', async () => {
    const mk = (a: number, b: number, hook: number, title: string, extra: object = {}) => ({
      candidateId: null,
      startSentence: a,
      endSentence: b,
      title,
      hook: 'Something true',
      whyItWorks: 'because',
      keywords: [],
      scores: { hook, retention: 10, emotion: 10, clarity: 10, shareability: 10 },
      confidence: 0.7,
      ...extra,
    });
    stub.replies = [
      {
        text: validRankJson({
          moments: [
            mk(13, 24, 12, 'low scoring but valid'),
            mk(4, 11, 40, 'hook score clamped to 25'), // 4..11 = 37.8 s, valid
            mk(5, 12, 5, 'overlaps the previous one'),
            mk(0, 2, 20, 'too short'),
            mk(900, 901, 20, 'unknown ids'),
            mk(29, 35, 15, 'third valid'),
          ],
        }),
      },
    ];
    const { service, logs } = makeService(stub);
    const out = await service.rankMoments(rankInput());
    expect(out.map((m) => m.title)).toEqual([
      'hook score clamped to 25',
      'third valid',
      'low scoring but valid',
    ]);
    expect(out[0]!.breakdown.hook).toBe(25);
    const log = logs.join('\n');
    expect(log).toContain('overlaps higher-scored');
    expect(log).toContain('duration');
    expect(log).toContain('unknown sentence id');
    expect(log).toContain('clamped');
  });

  it('caps the result at maxClips', async () => {
    const mk = (a: number, b: number, hook: number) => ({
      candidateId: null,
      startSentence: a,
      endSentence: b,
      title: `m${a}`,
      hook: 'true hook',
      whyItWorks: 'x',
      keywords: [],
      scores: { hook, retention: 10, emotion: 10, clarity: 10, shareability: 10 },
      confidence: 0.5,
    });
    stub.replies = [
      { text: validRankJson({ moments: [mk(4, 11, 20), mk(13, 24, 18), mk(29, 35, 16)] }) },
    ];
    const { service } = makeService(stub);
    const out = await service.rankMoments(rankInput({ maxClips: 2 }));
    expect(out.map((m) => m.title)).toEqual(['m4', 'm13']);
  });

  it('retries once, naming the failures, when EVERY moment was unusable; a second failure returns []', async () => {
    const bad = validRankJson({
      moments: [
        {
          candidateId: null,
          startSentence: 0,
          endSentence: 1,
          title: 't',
          hook: 'h',
          whyItWorks: 'w',
          keywords: [],
          scores: { hook: 1, retention: 1, emotion: 1, clarity: 1, shareability: 1 },
          confidence: 0.1,
        },
      ],
    });
    stub.replies = [{ text: bad }, { text: bad }];
    const { service } = makeService(stub);
    expect(await service.rankMoments(rankInput())).toEqual([]);
    expect(stub.requests).toHaveLength(2);
    const repair = blocks(stub.requests[1]!.body).at(-1)!.text;
    expect(repair).toContain('none of your moments passed the checks');
    expect(repair).toContain('duration');
  });

  it('reports progress: indeterminate first, then increasing fractions, ending at 1', async () => {
    stub.replies = [{ text: validRankJson(), thinking: true }];
    const { service } = makeService(stub);
    const calls: (number | null)[] = [];
    await service.rankMoments(rankInput({ onProgress: (f) => calls.push(f) }));
    expect(calls[0]).toBeNull();
    const nums = calls.filter((x): x is number => x !== null);
    expect(nums.at(-1)).toBe(1);
    expect(nums.length).toBeGreaterThan(1);
    expect([...nums].sort((a, b) => a - b)).toEqual(nums);
    expect(nums.every((n) => n >= 0 && n <= 1)).toBe(true);
  });
});

/* --------------------------------------------------- budget --------------------------------------------------- */

describe('budget guardrail (BRIEF §9)', () => {
  it('hard cap: throws BudgetExceededError with spent/cap and sends nothing', async () => {
    const { service, budgetEvents } = makeService(stub, { cost: makeCost({ spentUsd: 71.5 }) });
    const err = await service.rankMoments(rankInput()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect((err as Error).message).toContain('$71.50');
    expect((err as Error).message).toContain('$70.00');
    await expect(service.understand({ info, transcript: makeTranscript() })).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    expect(stub.requests).toHaveLength(0);
    expect(budgetEvents).toEqual(['hard-cap']); // once per level change
  });

  it('refuses a call whose estimate would cross the hard cap', async () => {
    const { service } = makeService(stub, { cost: makeCost({ spentUsd: 69.99 }) });
    const err = await service.rankMoments(rankInput()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect((err as Error).message).toContain('would push');
    expect(stub.requests).toHaveLength(0);
  });

  it('over target: understand moves to the fast model; rank halves candidates and maxClips and drops to low effort', async () => {
    const cost = makeCost({ spentUsd: 35 });
    const { service, budgetEvents } = makeService(stub, { cost });
    stub.replies = [{ text: understandJson() }, { text: validRankJson() }];
    await service.understand({ info, transcript: makeTranscript() });
    expect(stub.requests[0]!.body.model).toBe('claude-haiku-5-5');

    await service.rankMoments(rankInput({ maxClips: 5 }));
    const b = stub.requests[1]!.body;
    expect(b.model).toBe('claude-sonnet-5-5'); // quality-critical step stays on the smart model
    expect(b.output_config?.effort).toBe('low');
    const vol = blocks(b)[1]!.text;
    expect(vol).toContain('at most 3 moments'); // ceil(5/2)
    expect(vol.match(/^c\d+ \|/gm)).toHaveLength(2); // ceil(3 candidates / 2)
    expect(budgetEvents).toEqual(['over-target']);
  });

  it('over target but a >100K-token prompt: stays on the smart model (Haiku bills a higher rate card there)', async () => {
    const big = makeTranscript();
    big.sentences = Array.from({ length: 6000 }, (_, i) => ({
      ...big.sentences[i % big.sentences.length]!,
      id: i,
      s: i * 3,
      e: i * 3 + 2.5,
    }));
    big.durationSec = 6000 * 3;
    stub.replies = [{ text: understandJson() }];
    const { service, logs } = makeService(stub, { cost: makeCost({ spentUsd: 35 }) });
    await service.understand({ info, transcript: big });
    expect(stub.requests[0]!.body.model).toBe('claude-sonnet-5-5');
    expect(logs.join('\n')).toContain('prompt >100K tokens');
  });

  it('uses the configured model names', async () => {
    stub.replies = [{ text: validRankJson() }];
    const { service } = makeService(stub, { settings: { modelSmart: 'claude-opus-5-5' } });
    await service.rankMoments(rankInput());
    expect(stub.requests[0]!.body.model).toBe('claude-opus-5-5');
  });

  it('warns once at 80% of the target, again only on a level change', async () => {
    const cost = makeCost({ spentUsd: 25 }); // 83% of $30
    const { service, budgetEvents } = makeService(stub, { cost });
    stub.replies = [{ text: validRankJson() }];
    await service.rankMoments(rankInput());
    await service.rankMoments(rankInput());
    expect(budgetEvents).toEqual(['warn']);
    cost.rows.push({ ...cost.rows[0]!, costUsd: 6 }); // 31 > target
    await service.rankMoments(rankInput());
    expect(budgetEvents).toEqual(['warn', 'over-target']);
    expect(stub.requests[0]!.body.model).toBe('claude-sonnet-5-5');
  });

  it('stays silent below 80%', async () => {
    const { service, budgetEvents } = makeService(stub, { cost: makeCost({ spentUsd: 5 }) });
    stub.replies = [{ text: validRankJson() }];
    await service.rankMoments(rankInput());
    expect(budgetEvents).toEqual([]);
  });
});

/* --------------------------------------------------- failure paths --------------------------------------------------- */

describe('failure handling', () => {
  it('surfaces a refusal (and still records its cost)', async () => {
    stub.replies = [
      {
        text: '',
        stopReason: 'refusal',
        stopDetails: { type: 'refusal', category: 'general_harms', explanation: 'policy' },
        usage: { input_tokens: 100, output_tokens: 5 },
      },
    ];
    const cost = makeCost();
    const { service } = makeService(stub, { cost });
    const err = await service.rankMoments(rankInput()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err).toMatchObject({ code: 'refusal' });
    expect((err as Error).message).toContain('general_harms');
    expect(stub.requests).toHaveLength(1); // not retried
    expect(cost.rows).toHaveLength(1);
  });

  it('max_tokens: retries once at lower effort with more room, then succeeds', async () => {
    stub.replies = [{ text: '{"moments": [', stopReason: 'max_tokens' }, { text: validRankJson() }];
    const { service } = makeService(stub);
    const out = await service.rankMoments(rankInput());
    expect(out).toHaveLength(1);
    expect(stub.requests.map((r) => r.body.output_config?.effort)).toEqual(['medium', 'low']);
    expect(stub.requests[1]!.body.max_tokens).toBe(stub.requests[0]!.body.max_tokens * 2);
  });

  it('max_tokens twice: throws a descriptive error', async () => {
    stub.replies = [{ text: '{"moments": [', stopReason: 'max_tokens' }];
    const { service } = makeService(stub);
    await expect(service.rankMoments(rankInput())).rejects.toMatchObject({ code: 'truncated' });
    expect(stub.requests).toHaveLength(2);
  });

  it('invalid JSON: ONE repair retry naming the validation error, then success', async () => {
    const wrongShape = JSON.stringify({ moments: [{ title: 'x' }], windowNotes: '' });
    stub.replies = [{ text: wrongShape }, { text: validRankJson() }];
    const { service } = makeService(stub);
    const out = await service.rankMoments(rankInput());
    expect(out).toHaveLength(1);
    expect(stub.requests).toHaveLength(2);
    const second = blocks(stub.requests[1]!.body);
    // same cached prefix blocks, same effort, plus an appended repair block that names the field
    expect(second[0]!.text).toBe(blocks(stub.requests[0]!.body)[0]!.text);
    expect(second[0]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(second.at(-1)!.text).toContain('schema validation failed');
    expect(second.at(-1)!.text).toMatch(/moments\.0\.(startSentence|scores)/);
    expect(stub.requests[1]!.body.output_config?.effort).toBe('medium');
    // and the second request still reads the first one's cache
    expect(stub.requests[1]!.usage.cache_read_input_tokens).toBeGreaterThan(1000);
  });

  it('non-JSON text twice: throws a descriptive error after exactly two calls', async () => {
    stub.replies = [{ text: 'Sure! Here are the moments: ...' }];
    const { service } = makeService(stub);
    const err = await service.rankMoments(rankInput()).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'invalid-output' });
    expect((err as Error).message).toContain('not valid JSON');
    expect(stub.requests).toHaveLength(2);
  });

  it('maps 401 to a friendly message and never leaks the key', async () => {
    stub.replies = [
      {
        status: 401,
        errorType: 'authentication_error',
        errorMessage: `invalid x-api-key ${TEST_KEY}`,
      },
    ];
    const { service, logs } = makeService(stub);
    const err = (await service.rankMoments(rankInput()).catch((e: unknown) => e)) as LlmError;
    expect(err.code).toBe('auth');
    expect(err.message).toContain('Settings → API Keys');
    expect(err.message).not.toContain(TEST_KEY);
    expect(logs.join('\n')).not.toContain(TEST_KEY);
    expect(stub.requests).toHaveLength(1); // not retried
    expect(stub.requests[0]!.headers['x-api-key']).toBe(TEST_KEY);
  });

  it('authenticates only with the configured key, whatever the environment says', async () => {
    const prev = process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.ANTHROPIC_AUTH_TOKEN = 'env-token-must-not-be-used';
    try {
      stub.replies = [{ text: validRankJson() }];
      const { service } = makeService(stub);
      await service.rankMoments(rankInput());
      const h = stub.requests[0]!.headers;
      expect(h['x-api-key']).toBe(TEST_KEY);
      expect(h.authorization).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
      else process.env.ANTHROPIC_AUTH_TOKEN = prev;
    }
  });

  it('redacts a key echoed back inside other API errors', async () => {
    stub.replies = [
      {
        status: 400,
        errorType: 'invalid_request_error',
        errorMessage: `bad thing near ${TEST_KEY}`,
      },
    ];
    const { service } = makeService(stub);
    const err = (await service.rankMoments(rankInput()).catch((e: unknown) => e)) as LlmError;
    expect(err.code).toBe('bad-request');
    expect(err.message).not.toContain(TEST_KEY);
    expect(err.message).toContain('[redacted]');
  });

  it('turns an out-of-credit 400 into a billing message', async () => {
    stub.replies = [
      {
        status: 400,
        errorType: 'invalid_request_error',
        errorMessage: 'Your credit balance is too low to access the Anthropic API.',
      },
    ];
    const { service } = makeService(stub);
    await expect(service.rankMoments(rankInput())).rejects.toMatchObject({ code: 'billing' });
  });

  it('older models without `effort`: retries once without it and remembers', async () => {
    stub.replies = [
      (body) =>
        body.output_config?.effort
          ? {
              status: 400,
              errorType: 'invalid_request_error',
              errorMessage: 'effort: Extra inputs are not permitted',
            }
          : { text: validRankJson() },
    ];
    const { service } = makeService(stub, { settings: { modelSmart: 'claude-sonnet-4-5' } });
    expect(await service.rankMoments(rankInput())).toHaveLength(1);
    expect(stub.requests.map((r) => r.body.output_config?.effort)).toEqual(['medium', undefined]);
    await service.rankMoments(rankInput());
    expect(stub.requests).toHaveLength(3);
    expect(stub.requests[2]!.body.output_config?.effort).toBeUndefined();
  });

  it('SDK retries a 429 and then succeeds', async () => {
    stub.replies = [
      { status: 429, errorType: 'rate_limit_error', headers: { 'retry-after-ms': '5' } },
      { text: validRankJson() },
    ];
    const { service } = makeService(stub);
    expect(await service.rankMoments(rankInput())).toHaveLength(1);
    expect(stub.requests).toHaveLength(2);
  });

  it('SDK retries a 529 overloaded and then succeeds', async () => {
    stub.replies = [
      { status: 529, errorType: 'overloaded_error', headers: { 'retry-after-ms': '5' } },
      { text: validRankJson() },
    ];
    const { service } = makeService(stub);
    expect(await service.rankMoments(rankInput())).toHaveLength(1);
  });

  it('reports exhausted rate limiting as rate-limit', async () => {
    stub.replies = [
      { status: 429, errorType: 'rate_limit_error', headers: { 'retry-after-ms': '1' } },
    ];
    const { service } = makeService(stub, { maxRetries: 1 });
    await expect(service.rankMoments(rankInput())).rejects.toMatchObject({ code: 'rate-limit' });
    expect(stub.requests).toHaveLength(2); // initial + 1 SDK retry
  });

  it('retries once when the stream breaks mid-response', async () => {
    stub.replies = [{ text: validRankJson(), sseErrorAfterText: true }, { text: validRankJson() }];
    const { service, logs } = makeService(stub);
    expect(await service.rankMoments(rankInput())).toHaveLength(1);
    expect(stub.requests).toHaveLength(2);
    expect(logs.join('\n')).toContain('stream broke');
  });

  it('honours an already-aborted signal without calling the API', async () => {
    const ac = new AbortController();
    ac.abort();
    const { service } = makeService(stub);
    await expect(service.rankMoments(rankInput({ signal: ac.signal }))).rejects.toMatchObject({
      name: 'AbortError',
    });
    await expect(
      service.understand({ info, transcript: makeTranscript(), signal: ac.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(stub.requests).toHaveLength(0);
  });

  it('aborts a request that is streaming', async () => {
    stub.replies = [{ text: validRankJson(), hang: true }];
    const ac = new AbortController();
    const { service } = makeService(stub);
    const p = service.rankMoments(rankInput({ signal: ac.signal }));
    setTimeout(() => ac.abort(), 120);
    const t0 = Date.now();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(stub.requests).toHaveLength(1); // no retry after an abort
  });
});
