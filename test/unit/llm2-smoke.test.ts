import { spawn } from 'node:child_process';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { smartReply, startSmartAnthropicStub } from '../support/e2e-anthropic';
import type { StubAnthropic } from './llm-stub-server';

/** Runs the real `scripts/llm-smoke.mjs --cp2` (esbuild bundle + CLI) against the scripted stand-in. */

const root = path.resolve(__dirname, '../..');
const fixture = path.join(root, 'test/fixtures/llm-news-3min.transcript.json');
let stub: StubAnthropic;
beforeAll(async () => {
  stub = await startSmartAnthropicStub();
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

describe('scripts/llm-smoke.mjs --cp2', () => {
  it('--dry-run needs no key: prompt sizes, cost per call kind, honest assumptions, long-video scenario', async () => {
    const r = await run([fixture, '--cp2', '--dry-run', '--long-hours=4'], {});
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('Estimated cost per call kind');
    for (const k of [
      'highlights',
      'hooks (15 variants)',
      'metadata (3 platforms)',
      'thumbnails',
      'chat turn 1',
      'chat follow-up turn',
      'chat retrieval, 4 h video',
    ])
      expect(r.out).toContain(k);
    expect(r.out).toContain('UNMEASURED');
    expect(stub.requests).toHaveLength(0);
  }, 60_000);

  it('refuses to run live without a key', async () => {
    const r = await run([fixture, '--cp2'], {});
    expect(r.code).toBe(2);
    expect(r.out).toContain('ANTHROPIC_API_KEY is not set');
  }, 60_000);

  it('runs hooks, metadata, highlights and a 3-turn chat with exactly one tool call; prints results and dollars; never prints the key', async () => {
    stub.reset();
    stub.replies = [(b) => smartReply(b)];
    const key = 'sk-ant-api03-SMOKEKEY00000000000000000000';
    const r = await run([fixture, '--cp2'], {
      ANTHROPIC_API_KEY: key,
      CLIPFERN_LLM_BASE_URL: stub.baseUrl,
    });
    expect(r.out).not.toContain(key);
    expect(r.code, r.out).toBe(0);
    for (const h of [
      '=== writeHooks() ===',
      '=== writeMeta() ===',
      '=== composeHighlights()',
      '=== chat(): 3 turns ===',
    ])
      expect(r.out).toContain(h);
    expect(r.out).toContain('Tool use OK: exactly one create_clip, on the third turn.');
    expect(r.out).toContain('[action done] create_clip');
    expect(r.out).toMatch(/TOTAL \$\d\.\d{4} for \d+ call\(s\)/);
    expect(r.out).toContain('thumbnails skipped');
  }, 90_000);
});
