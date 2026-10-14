import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanBrollQueries } from '@main/services/llm/broll';
import { StubAnthropic } from './llm-stub-server';
import { expectNoForbiddenParams, jsonReply, makeCost, makeV2, wireBlocks } from './llm2-harness';

const stub = new StubAnthropic();
beforeAll(async () => {
  await stub.start();
});
afterAll(async () => {
  await stub.stop();
});
beforeEach(() => stub.reset());

describe('cleanBrollQueries', () => {
  it('strips punctuation, de-duplicates case-insensitively, drops empties and caps at 5', () => {
    expect(
      cleanBrollQueries([
        '  "City traffic, night!"  ',
        'city traffic night',
        '',
        '🙂',
        'typing on laptop',
        'a',
        'b',
        'c',
        'd',
      ]),
    ).toEqual(['City traffic night', 'typing on laptop', 'a', 'b', 'c']);
  });
  it('caps one query at 60 characters', () => {
    expect(cleanBrollQueries(['x'.repeat(200)])[0]).toHaveLength(60);
  });
});

describe('suggestBroll()', () => {
  it('uses the FAST model at effort low, sends the passage as DATA and records the cost as "broll"', async () => {
    stub.replies = [jsonReply({ queries: ['coffee pouring', 'busy office', 'handshake closeup'] })];
    const cost = makeCost();
    const { service } = makeV2(stub, { cost });
    const out = await service.suggestBroll({
      text: 'We met over coffee in a busy office and shook hands.',
    });
    expect(out).toEqual(['coffee pouring', 'busy office', 'handshake closeup']);
    const b = stub.requests[0]!.body;
    expectNoForbiddenParams(b);
    expect(b.model).toBe('claude-haiku-5-5');
    expect(b.output_config?.effort).toBe('low');
    const text = wireBlocks(b)
      .map((x) => x.text ?? '')
      .join('\n');
    expect(text).toContain('<passage>');
    expect(text).toContain('shook hands');
    expect(cost.rows[0]!.purpose).toBe('broll');
  });

  it('rejects an empty passage without calling the model', async () => {
    const { service } = makeV2(stub);
    await expect(service.suggestBroll({ text: '   ' })).rejects.toThrow(/no speech/i);
    expect(stub.requests).toHaveLength(0);
  });

  it('fails clearly when the model returns nothing usable', async () => {
    stub.replies = [jsonReply({ queries: ['', '  '] }), jsonReply({ queries: ['!!!'] })];
    const { service } = makeV2(stub);
    await expect(service.suggestBroll({ text: 'hello world' })).rejects.toThrow();
  });
});
