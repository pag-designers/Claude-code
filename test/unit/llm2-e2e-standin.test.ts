import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startSmartAnthropicStub } from '../support/e2e-anthropic';
import type { StubAnthropic } from './llm-stub-server';
import { makeTranscript } from './llm-fixtures';
import { CANDS, info, makeV2, S } from './llm2-harness';

/**
 * The scripted e2e stand-in (test/support/e2e-anthropic.ts) must answer every CP2 request kind with
 * output that passes the REAL service's validation - otherwise the lead's Electron e2e would fail for
 * reasons unrelated to the app. This proves schema/validation compatibility only, NOT model quality.
 */

let stub: StubAnthropic;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipfern-standin-'));
beforeAll(async () => {
  stub = await startSmartAnthropicStub();
});
afterAll(async () => {
  await stub.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

const clip = {
  title: 'He called every customer',
  hook: 'The first million was the easy part',
  startSec: 57.2,
  endSec: 107.6,
  text: S.slice(13, 25)
    .map((s) => s.text)
    .join(' '),
  whyItWorks: null,
  score: 80,
};
const vinfo = { title: info.title, channel: info.channel };

describe('scripted e2e stand-in answers the CP2 request kinds', () => {
  it('highlights: 3-4 valid spans inside the candidates, total inside the range', async () => {
    const { service } = makeV2(stub);
    const r = await service.composeHighlights({
      info: vinfo,
      analysis: null,
      candidates: CANDS,
      prompt: '',
      minSec: 45,
      maxSec: 90,
    });
    expect(r.segments.length).toBeGreaterThanOrEqual(3);
    expect(r.segments.length).toBeLessThanOrEqual(4);
    const total = r.segments.reduce((a, s) => a + s.endSec - s.startSec, 0);
    expect(total).toBeGreaterThanOrEqual(45);
    expect(total).toBeLessThanOrEqual(90);
  });

  it('hooks: 5 variants for each platform; metadata: all three platforms', async () => {
    const { service } = makeV2(stub);
    const h = await service.writeHooks({ info: vinfo, clip });
    expect([h.tiktok.length, h.reels.length, h.shorts.length]).toEqual([5, 5, 5]);
    const m = await service.writeMeta({ info: vinfo, clip, hook: h.tiktok[0]!.text });
    expect(m.shorts.hashtags[0]).toBe('Shorts');
    expect(m.tiktok.hashtags.length).toBeGreaterThanOrEqual(3);
  });

  it('thumbnails: a request with image blocks is ranked by position', async () => {
    const { service } = makeV2(stub);
    const files = [0, 1, 2].map((i) => {
      const f = path.join(dir, `f${i}.jpg`);
      const b = Buffer.alloc(40);
      b.set([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 1, 0, 0, 200, 3]);
      fs.writeFileSync(f, b);
      return { index: i, file: f };
    });
    const r = await service.rankThumbnails({ clip, frames: files });
    expect(r.ranking.map((x) => x.index)).toEqual([0, 1, 2]);
    expect(r.overlayText.split(' ').length).toBeLessThanOrEqual(3);
  });

  it('chat: streams an answer with [mm:ss] citations; "make a clip" triggers one create_clip then a closing text', async () => {
    const { service } = makeV2(stub);
    const base = {
      info: { title: info.title, channel: info.channel, description: null },
      analysis: null,
      transcript: makeTranscript(),
      clip: null,
      history: [],
      onAction: () => {},
    };
    const cites: { t: number; label: string }[] = [];
    const deltas: string[] = [];
    const a = await service.chat({
      ...base,
      userText: 'What did he do about the customers?',
      executeTool: () => Promise.reject(new Error('must not be called')),
      onDelta: (d) => deltas.push(d),
      onCitation: (c) => cites.push(c),
    });
    expect(a.text).toContain('Scripted e2e stand-in');
    expect(cites.length).toBeGreaterThanOrEqual(1);
    expect(deltas.join('')).toBe(a.text);

    const executed: string[] = [];
    const b = await service.chat({
      ...base,
      userText: 'Please make a clip of the customer calls',
      executeTool: (name, input) => {
        executed.push(`${name}:${String(input.title)}`);
        return Promise.resolve({ ok: true, summary: 'Created clip.' });
      },
      onDelta: () => {},
      onCitation: () => {},
    });
    expect(executed).toHaveLength(1);
    expect(executed[0]).toMatch(/^create_clip:/);
    expect(b.text).toContain('all done');
  });

  it('retrieval requests get windows from the slice they contain', async () => {
    const { service } = makeV2(stub);
    // 2,300 sentences of ~100 chars > 60K estimated tokens -> retrieval path
    const sentences = Array.from({ length: 2300 }, (_, i) => ({
      id: i,
      s: i * 5,
      e: i * 5 + 4,
      speaker: null,
      wordStart: 0,
      wordEnd: 0,
      text: `Sentence number ${i} talks about topic ${i % 50} with some more filler words to pad it out.`,
    }));
    const r = await service.chat({
      info: { title: 'Long', channel: null, description: null },
      analysis: null,
      transcript: {
        language: 'en',
        languageProbability: 1,
        durationSec: 2300 * 5,
        model: 'tiny',
        words: [],
        sentences,
      },
      clip: null,
      history: [],
      userText: 'What is said about topic 7?',
      executeTool: () => Promise.reject(new Error('no')),
      onDelta: () => {},
      onCitation: () => {},
      onAction: () => {},
    });
    expect(r.text).toContain('Scripted e2e stand-in');
    expect(
      stub.requests.some((q) =>
        JSON.stringify(q.body.output_config?.format ?? '').includes('windows'),
      ),
    ).toBe(true);
  }, 30_000);
});
