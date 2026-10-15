import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BudgetExceededError } from '@main/pipeline/contracts';
import { cleanHooks } from '@main/services/llm/hooks';
import { cleanMeta, normalizeHashtag, POSTING_DISCLAIMER } from '@main/services/llm/meta';
import type { ModelHooks, ModelMeta } from '@main/services/llm/schemas2';
import { StubAnthropic } from './llm-stub-server';
import {
  expectNoForbiddenParams,
  info,
  jsonReply,
  makeCost,
  makeV2,
  wireBlocks,
  wireSystem,
} from './llm2-harness';

const stub = new StubAnthropic();
beforeAll(async () => {
  await stub.start();
});
afterAll(async () => {
  await stub.stop();
});
beforeEach(() => stub.reset());

const clip = {
  title: 'He lost 40% of his customers, then called every one of them',
  hook: 'The first million was the easy part',
  startSec: 57.2,
  endSec: 107.6,
  text: 'But here is the part nobody tells you. The first million was the easy part. We lost forty percent of our customers. I called every single one of them myself.',
  whyItWorks: 'Contrarian opening, low point, phone-call payoff.',
  score: 82,
};
const vinfo = { title: info.title, channel: info.channel };

/* ------------------------------------------------- hooks ------------------------------------------------- */

const variants = (prefix: string, n = 5) =>
  Array.from({ length: n }, (_, i) => ({
    text: [
      'lost 40% of customers then called each one',
      'the part nobody tells founders',
      'what a 3am bank balance taught me',
      'why calling customers beats ads',
      'would you phone every customer?',
    ][i % 5]!.replace(/^/, i < 5 ? '' : prefix),
    spoken: i % 2 === 0 ? 'Here is what happened when I picked up the phone.' : null,
    angle: ['number', 'contrarian', 'story', 'curiosity', 'question'][i % 5]!,
  }));
const hooksDoc = (): ModelHooks => ({
  tiktok: variants(''),
  reels: variants('').map((v) => ({ ...v, text: `${v.text}.` })),
  shorts: variants('').map((v) => ({ ...v, text: `Founder: ${v.text}` })),
});

describe('writeHooks()', () => {
  it('uses the FAST model at effort medium; clip text is DATA after the cache breakpoint of the system prompt', async () => {
    stub.replies = [jsonReply(hooksDoc())];
    const cost = makeCost();
    const { service } = makeV2(stub, { cost });
    await service.writeHooks({ info: vinfo, clip });
    const b = stub.requests[0]!.body;
    expectNoForbiddenParams(b);
    expect(b).not.toHaveProperty('tools');
    expect(b.model).toBe('claude-haiku-5-5');
    expect(b.output_config?.effort).toBe('medium');
    expect(wireSystem(b)[0]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(wireSystem(b)[0]!.text).toContain('tiktok:');
    const blocks = wireBlocks(b);
    expect(blocks[0]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(blocks[0]!.text).toContain('<clip_text>');
    expect(blocks[0]!.text).toContain('I called every single one of them myself');
    expect(blocks[1]!.cache_control).toBeUndefined();
    expect(cost.rows[0]!.purpose).toBe('hooks');
  });

  it('returns 5 variants per platform with text, spoken and angle', async () => {
    stub.replies = [jsonReply(hooksDoc())];
    const { service } = makeV2(stub);
    const r = await service.writeHooks({ info: vinfo, clip });
    for (const p of ['tiktok', 'reels', 'shorts'] as const) {
      expect(r[p]).toHaveLength(5);
      for (const v of r[p]) {
        expect(v.text.split(' ').length).toBeLessThanOrEqual(10);
        expect(typeof v.angle).toBe('string');
      }
    }
    expect(r.tiktok[0]!.spoken).toContain('picked up the phone');
    expect(r.tiktok[1]!.spoken).toBeNull();
  });

  it('too-long and duplicate variants go back to the model ONCE with the concrete problem', async () => {
    const bad = hooksDoc();
    bad.tiktok[1] = {
      text: 'one two three four five six seven eight nine ten eleven twelve',
      spoken: null,
      angle: 'story',
    };
    bad.reels[2] = { ...bad.reels[0]! };
    stub.replies = [jsonReply(bad), jsonReply(hooksDoc())];
    const { service } = makeV2(stub);
    const r = await service.writeHooks({ info: vinfo, clip });
    expect(stub.requests).toHaveLength(2);
    const repair = wireBlocks(stub.requests[1]!.body).at(-1)!.text!;
    expect(repair).toContain('tiktok #2 has 12 words');
    expect(repair).toContain('reels #3 repeats');
    expect(r.tiktok).toHaveLength(5);
  });

  it('last attempt: bad variants are DROPPED (not truncated); >= 3 must remain per platform', async () => {
    const bad = hooksDoc();
    bad.tiktok[0] = {
      text: 'one two three four five six seven eight nine ten eleven twelve',
      spoken: null,
      angle: 'a',
    };
    bad.tiktok[1] = { ...bad.tiktok[2]! };
    stub.replies = [jsonReply(bad), jsonReply(bad)];
    const { service } = makeV2(stub);
    const r = await service.writeHooks({ info: vinfo, clip });
    expect(r.tiktok).toHaveLength(3);
    expect(r.tiktok.every((v) => !v.text.includes('eleven'))).toBe(true);
    expect(r.tiktok.every((v) => !v.text.endsWith('…'))).toBe(true);
  });

  it('fails clearly when fewer than 3 usable variants survive', async () => {
    const bad = hooksDoc();
    bad.shorts = [bad.shorts[0]!, { ...bad.shorts[0]! }, { ...bad.shorts[0]! }];
    stub.replies = [jsonReply(bad)];
    const { service } = makeV2(stub);
    await expect(service.writeHooks({ info: vinfo, clip })).rejects.toMatchObject({
      code: 'invalid-output',
    });
    expect(stub.requests).toHaveLength(2);
  });

  it('refuses a clip without speech; hard cap sends nothing', async () => {
    const { service } = makeV2(stub);
    await expect(
      service.writeHooks({ info: vinfo, clip: { ...clip, text: '  ' } }),
    ).rejects.toMatchObject({
      code: 'empty-transcript',
    });
    const capped = makeV2(stub, { cost: makeCost({ spentUsd: 80 }) });
    await expect(capped.service.writeHooks({ info: vinfo, clip })).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    expect(stub.requests).toHaveLength(0);
  });
});

describe('cleanHooks() rules', () => {
  const v = (text: string, spoken: string | null = null, angle = 'x') => ({ text, spoken, angle });
  const doc = (tiktok: ReturnType<typeof v>[]): ModelHooks => ({ tiktok, reels: [], shorts: [] });

  it('near-duplicates (Jaccard >= 0.75) are dropped', () => {
    const r = cleanHooks(
      doc([
        v('he lost forty percent of his customers'),
        v('he lost forty percent of his customers!'),
      ]),
      () => {},
    );
    expect(r.hooks.tiktok).toHaveLength(1);
  });
  it('strips wrapping quotes, normalises angle, nulls an over-long spoken line', () => {
    const long = Array.from({ length: 30 }, () => 'word').join(' ');
    const r = cleanHooks(doc([v('"Quoted hook text"', long, '  Curiosity ')]), () => {});
    expect(r.hooks.tiktok[0]).toEqual({
      text: 'Quoted hook text',
      spoken: null,
      angle: 'curiosity',
    });
  });
  it("keeps the model's order (best first) and at most 5", () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      v(
        `distinct hook number ${['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'][i]}`,
      ),
    );
    const r = cleanHooks(doc(many), () => {});
    expect(r.hooks.tiktok.map((h) => h.text.split(' ').at(-1))).toEqual([
      'alpha',
      'bravo',
      'charlie',
      'delta',
      'echo',
    ]);
  });
});

/* ---------------------------------------------- metadata ---------------------------------------------- */

const pm = (over: Partial<ModelMeta['tiktok']> = {}): ModelMeta['tiktok'] => ({
  title: 'lost 40% of my customers and called every one',
  description:
    'The part of the founder story nobody posts about. Would you have picked up the phone?',
  hashtags: ['Entrepreneurship', 'startup', 'CustomerService', 'founderlife'],
  postingTime: {
    dayOfWeek: 2,
    hour: 18,
    reason: 'Weekday evenings tend to see more short-form viewing.',
  },
  ...over,
});
const metaDoc = (): ModelMeta => ({
  tiktok: pm(),
  reels: pm({ title: 'The part nobody tells founders' }),
  shorts: pm({ title: 'Why calling customers beats ads | founder story' }),
});

describe('writeMeta()', () => {
  it('uses the FAST model at effort low; carries the current hook; result has all three platforms', async () => {
    stub.replies = [jsonReply(metaDoc())];
    const cost = makeCost();
    const { service } = makeV2(stub, { cost });
    const r = await service.writeMeta({
      info: vinfo,
      clip,
      hook: 'The first million was the easy part',
    });
    const b = stub.requests[0]!.body;
    expectNoForbiddenParams(b);
    expect(b.model).toBe('claude-haiku-5-5');
    expect(b.output_config?.effort).toBe('low');
    expect(wireBlocks(b)[1]!.text).toContain(
      'Hook currently shown in the video: The first million was the easy part',
    );
    expect(wireBlocks(b)[0]!.text).not.toContain('Hook currently shown');
    expect(Object.keys(r).sort()).toEqual(['reels', 'shorts', 'tiktok']);
    expect(cost.rows[0]!.purpose).toBe('metadata');
  });

  it('posting time is HONEST: the reason always starts with the "no analytics" disclaimer', async () => {
    stub.replies = [jsonReply(metaDoc())];
    const { service } = makeV2(stub);
    const r = await service.writeMeta({ info: vinfo, clip, hook: null });
    for (const p of ['tiktok', 'reels', 'shorts'] as const) {
      expect(r[p].postingTime.reason.startsWith(POSTING_DISCLAIMER)).toBe(true);
      expect(r[p].postingTime.hour).toBe(18);
      expect(r[p].postingTime.dayOfWeek).toBe(2);
    }
    expect(wireSystem(stub.requests[0]!.body)[0]!.text).toContain('NO analytics');
  });

  it('a reason that claims audience data is sent back for repair', async () => {
    const lie = metaDoc();
    lie.tiktok.postingTime.reason =
      'Your audience is most active at 6pm according to your analytics.';
    stub.replies = [jsonReply(lie), jsonReply(metaDoc())];
    const { service } = makeV2(stub);
    await service.writeMeta({ info: vinfo, clip, hook: null });
    expect(stub.requests).toHaveLength(2);
    expect(wireBlocks(stub.requests[1]!.body).at(-1)!.text).toContain(
      "claims to know the creator's audience",
    );
  });

  it('shorts: title <= 100, #Shorts is guaranteed in the hashtags (once), never in the title', async () => {
    const m = metaDoc();
    m.shorts.title = '#Shorts ' + 'Why calling customers beats ads';
    stub.replies = [jsonReply(m)];
    const { service } = makeV2(stub);
    const r = await service.writeMeta({ info: vinfo, clip, hook: null });
    expect(r.shorts.title).toBe('Why calling customers beats ads');
    expect(r.shorts.hashtags[0]).toBe('Shorts');
    expect(r.shorts.hashtags.filter((h) => h.toLowerCase() === 'shorts')).toHaveLength(1);
  });

  it('hashtags: no spaces, no #, de-duplicated, banned/misleading tags removed, 3-8 per platform', async () => {
    const m = metaDoc();
    m.tiktok.hashtags = [
      '#fyp',
      'ForYou',
      'founder life',
      '#Startup',
      'startup',
      'viral',
      'followforfollow',
      'Business',
    ];
    m.reels.hashtags = Array.from({ length: 12 }, (_, i) => `tag${i}`);
    stub.replies = [jsonReply(m), jsonReply(m)];
    const { service } = makeV2(stub);
    const r = await service.writeMeta({ info: vinfo, clip, hook: null });
    expect(r.tiktok.hashtags).toEqual(['founderLife', 'Startup', 'Business']);
    expect(r.reels.hashtags).toHaveLength(8);
    for (const p of ['tiktok', 'reels', 'shorts'] as const)
      for (const h of r[p].hashtags) expect(h).toMatch(/^[\p{L}\p{N}_]+$/u);
  });

  it('too-long title: repaired once, then cut at a word boundary on the last attempt', async () => {
    const m = metaDoc();
    m.tiktok.title = 'word '.repeat(40).trim();
    stub.replies = [jsonReply(m), jsonReply(m)];
    const { service } = makeV2(stub);
    const r = await service.writeMeta({ info: vinfo, clip, hook: null });
    expect(stub.requests).toHaveLength(2);
    expect(r.tiktok.title.length).toBeLessThanOrEqual(90);
    expect(r.tiktok.title.endsWith('…')).toBe(true);
  });

  it('descriptions never contain hashtags (the app appends them)', async () => {
    const m = metaDoc();
    m.reels.description = 'Great story #founder #startup about calling customers.';
    stub.replies = [jsonReply(m)];
    const { service } = makeV2(stub);
    const r = await service.writeMeta({ info: vinfo, clip, hook: null });
    expect(r.reels.description).toBe('Great story about calling customers.');
  });

  it('fewer than 3 usable hashtags twice -> invalid-output', async () => {
    const m = metaDoc();
    m.tiktok.hashtags = ['fyp', 'viral'];
    stub.replies = [jsonReply(m)];
    const { service } = makeV2(stub);
    await expect(service.writeMeta({ info: vinfo, clip, hook: null })).rejects.toMatchObject({
      code: 'invalid-output',
    });
    expect(stub.requests).toHaveLength(2);
  });

  it('clamps an impossible hour', () => {
    const m = metaDoc();
    m.tiktok.postingTime = { dayOfWeek: 9, hour: 31, reason: 'x' };
    const r = cleanMeta(m, () => {}, true);
    expect(r.meta.tiktok.postingTime.hour).toBe(23);
    expect(r.meta.tiktok.postingTime.dayOfWeek).toBeNull();
  });
});

describe('normalizeHashtag()', () => {
  it('CamelCases multi-word tags and strips punctuation', () => {
    expect(normalizeHashtag('#small business!')).toBe('smallBusiness');
    expect(normalizeHashtag('  #Café-Life ')).toBe('CaféLife');
    expect(normalizeHashtag('###')).toBe('');
    expect(normalizeHashtag('a'.repeat(50))).toHaveLength(30);
  });
});
