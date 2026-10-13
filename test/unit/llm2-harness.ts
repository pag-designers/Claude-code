import { expect } from 'vitest';
import type { LlmServiceV2 } from '@main/pipeline/contracts2';
import type { LlmService } from '@main/pipeline/contracts';
import { createLlmService, type BudgetLevel, type DownscalePort } from '@main/services/llm';
import { settingsSchema, type Settings } from '@shared/settings';
import type { Sentence, UrlInfo } from '@shared/pipeline';
import type { HighlightCandidate } from '@main/pipeline/contracts2';
import { makeCost, TEST_KEY } from './llm-harness';
import { makeSentences } from './llm-fixtures';
import type {
  StubAnthropic,
  StubReply,
  WireBody,
  WireContentBlock,
  WireTool,
} from './llm-stub-server';

export { makeCost, TEST_KEY };

export function makeV2(
  stub: StubAnthropic,
  over: {
    key?: string | null;
    settings?: Partial<Settings>;
    cost?: ReturnType<typeof makeCost>;
    maxRetries?: number;
    downscaleImage?: DownscalePort;
  } = {},
) {
  const cost = over.cost ?? makeCost();
  const logs: string[] = [];
  const budgetEvents: BudgetLevel[] = [];
  const settings = settingsSchema.parse(over.settings ?? {});
  const service: LlmService & LlmServiceV2 = createLlmService({
    getApiKey: () => (over.key === undefined ? TEST_KEY : over.key),
    getSettings: () => Promise.resolve(settings),
    cost: cost.tracker,
    baseUrl: stub.baseUrl,
    log: (m) => logs.push(m),
    onBudget: (l) => budgetEvents.push(l),
    maxRetries: over.maxRetries ?? 2,
    downscaleImage: over.downscaleImage,
  });
  return { service, cost, logs, budgetEvents, settings };
}

export const info: Pick<UrlInfo, 'title' | 'channel' | 'description' | 'chapters'> = {
  title: 'Founder Files #12',
  channel: 'Founder Files',
  description: 'A founder tells how he almost shut down.',
  chapters: [],
};

export const jsonReply = (doc: unknown, extra: Partial<StubReply> = {}): StubReply => ({
  text: JSON.stringify(doc),
  thinking: true,
  ...extra,
});

/* ---- wire helpers (loose views of the request body) ---- */

export const wireBlocks = (b: WireBody, msg = 0): WireContentBlock[] => {
  const c = b.messages[msg]!.content as unknown;
  return typeof c === 'string' ? [{ type: 'text', text: c }] : (c as WireContentBlock[]);
};
export const wireSystem = (b: WireBody): WireContentBlock[] =>
  b.system as unknown as WireContentBlock[];
export const wireTools = (b: WireBody): WireTool[] => (b as { tools?: WireTool[] }).tools ?? [];
export const allText = (b: WireBody): string =>
  JSON.stringify([b.system, b.messages, wireTools(b)]);

/** Everything the 5.x models reject or that would defeat caching, for ANY request kind. */
export function expectNoForbiddenParams(b: WireBody) {
  for (const k of ['temperature', 'top_p', 'top_k', 'tool_choice', 'thinking']) {
    expect(b, `must not send ${k}`).not.toHaveProperty(k);
  }
  expect(b.stream).toBe(true);
  expect(b.messages.at(-1)?.role).toBe('user'); // no assistant prefill
}

/* ---- highlight fixtures ---- */

const sents = makeSentences();
export const S: Sentence[] = sents;

export function cand(id: string, a: number, b: number, score: number): HighlightCandidate {
  const part = sents.slice(a, b + 1);
  return {
    id,
    title: `Clip ${id}`,
    hook: `Hook of ${id}`,
    startSec: part[0]!.s,
    endSec: part[part.length - 1]!.e,
    text: part.map((s) => s.text).join(' '),
    whyItWorks: 'Strong claim, tension, payoff.',
    score,
    sentences: part,
  };
}
/** c1 = S4-S11 (16.6-54.4 s), c2 = S13-S24 (57.2-107.6 s), c3 = S29-S35 (122.6-158.0 s) */
export const CANDS = [cand('c1', 4, 11, 70), cand('c2', 13, 24, 85), cand('c3', 29, 35, 55)];

export const sec = (a: number, b: number) => S[b]!.e - S[a]!.s;
