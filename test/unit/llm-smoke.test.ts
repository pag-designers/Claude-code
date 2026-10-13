import { spawn } from 'node:child_process';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StubAnthropic, type StubReply, type WireBlock, type WireBody } from './llm-stub-server';

/** Runs the real `scripts/llm-smoke.mjs` (esbuild bundle + CLI) against the local stub server. */

const root = path.resolve(__dirname, '../..');
const fixture = path.join(root, 'test/fixtures/llm-news-3min.transcript.json');
const stub = new StubAnthropic();
beforeAll(async () => {
  await stub.start();
});
afterAll(async () => {
  await stub.stop();
});

function run(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, 'scripts/llm-smoke.mjs'), ...args], {
      cwd: root,
      env: { PATH: process.env.PATH ?? '', ...env },
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('close', (code) => resolve({ code, out }));
  });
}

const reply = (body: WireBody): StubReply => {
  const sys = (body.system as WireBlock[])[0]!.text;
  if (sys.includes('video analyst')) {
    return {
      text: JSON.stringify({
        overview: {
          summary: 'An interview.',
          tone: 'warm',
          participants: ['Host', 'John'],
          takeaways: ['a', 'b', 'c', 'd', 'e'],
        },
        chapters: [
          { title: 'Early years', startSentence: 0, summary: 'School years.' },
          { title: 'Looking ahead', startSentence: 25, summary: 'Community support.' },
        ],
        notes: { keyPoints: ['k'], quotes: [], numbers: [], claims: [], actionItems: [] },
        topics: ['autism'],
        entities: [],
        keywords: [],
      }),
    };
  }
  const vol = (body.messages[0]!.content as WireBlock[])[1]!.text;
  const m = /^(n\d+) \| S(\d+)-S(\d+) \|/m.exec(vol)!;
  return {
    text: JSON.stringify({
      moments: [
        {
          candidateId: m[1],
          startSentence: Number(m[2]),
          endSentence: Number(m[3]),
          title: 'Inventing the wheel as parents',
          hook: 'We did not know what to ask for',
          whyItWorks: 'Honest, specific, ends on the lesson.',
          keywords: ['services'],
          scores: { hook: 15, retention: 14, emotion: 10, clarity: 11, shareability: 9 },
          confidence: 0.6,
        },
      ],
      windowNotes: '',
    }),
  };
};

describe('scripts/llm-smoke.mjs', () => {
  it('--dry-run needs no key and prints a cost estimate', async () => {
    const r = await run([fixture, '--dry-run'], {});
    expect(r.code).toBe(0);
    expect(r.out).toContain('Estimate for the WHOLE video');
    expect(r.out).toContain('UNMEASURED');
  }, 60_000);

  it('refuses to run without a key', async () => {
    const r = await run([fixture], {});
    expect(r.code).toBe(2);
    expect(r.out).toContain('ANTHROPIC_API_KEY is not set');
  }, 60_000);

  it('runs understand + rankMoments (+ a steered re-run) and prints moments, usage and dollars', async () => {
    stub.reset();
    stub.replies = [reply];
    const key = 'sk-ant-api03-SMOKEKEY00000000000000000000';
    const r = await run([fixture, '--windows=1', '--prompt=only the parents'], {
      ANTHROPIC_API_KEY: key,
      CLIPFERN_LLM_BASE_URL: stub.baseUrl,
    });
    expect(r.out).not.toContain(key);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('=== understand() ===');
    expect(r.out).toContain('Early years');
    expect(r.out).toContain('Inventing the wheel as parents');
    expect(r.out).toMatch(/steering: "only the parents"/);
    expect(r.out).toContain('API usage and cost');
    expect(r.out).toMatch(/TOTAL \$\d\.\d{4} for 3 call\(s\)/);
    // understand + rank + steered rank; the steered run read the cache
    expect(stub.requests).toHaveLength(3);
    expect(stub.requests[2]!.usage.cache_read_input_tokens).toBeGreaterThan(1000);
    expect(JSON.stringify(stub.requests[2]!.body.messages)).toContain('only the parents');
  }, 60_000);
});
