import type { Db } from '@main/db/client';
import { CostTracker } from '@main/services/cost';
import { createLlmService, type BudgetLevel } from '@main/services/llm';
import type { LlmService } from '@main/pipeline/contracts';
import { settingsSchema, type Settings } from '@shared/settings';
import type { StubAnthropic } from './llm-stub-server';

export const TEST_KEY = 'sk-ant-api03-TESTKEY0123456789abcdefSECRET';

interface CostRow {
  model: string;
  purpose: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWrites: number;
  costUsd: number;
}

/** The REAL CostTracker on an in-memory fake of the two Prisma calls it uses. */
export function makeCost(
  opts: { spentUsd?: number; targetUsd?: number; hardCapUsd?: number } = {},
) {
  const rows: CostRow[] = [];
  if (opts.spentUsd)
    rows.push({
      model: 'seed',
      purpose: 'seed',
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      cacheWrites: 0,
      costUsd: opts.spentUsd,
    });
  const db = {
    costEvent: {
      create: ({ data }: { data: CostRow }) => {
        rows.push(data);
        return Promise.resolve(data);
      },
      aggregate: () =>
        Promise.resolve({
          _sum: {
            costUsd: rows.reduce((a, r) => a + r.costUsd, 0),
            inputTokens: rows.reduce((a, r) => a + r.inputTokens, 0),
            outputTokens: rows.reduce((a, r) => a + r.outputTokens, 0),
            cachedTokens: rows.reduce((a, r) => a + r.cachedTokens, 0),
          },
          _count: rows.length,
        }),
    },
  } as unknown as Db;
  const tracker = new CostTracker(db, () =>
    Promise.resolve({ targetUsd: opts.targetUsd ?? 30, hardCapUsd: opts.hardCapUsd ?? 70 }),
  );
  return { tracker, rows };
}

export function makeService(
  stub: StubAnthropic,
  over: {
    key?: string | null;
    settings?: Partial<Settings>;
    cost?: ReturnType<typeof makeCost>;
    maxRetries?: number;
  } = {},
) {
  const cost = over.cost ?? makeCost();
  const logs: string[] = [];
  const budgetEvents: BudgetLevel[] = [];
  const settings = settingsSchema.parse(over.settings ?? {});
  const service: LlmService = createLlmService({
    getApiKey: () => (over.key === undefined ? TEST_KEY : over.key),
    getSettings: () => Promise.resolve(settings),
    cost: cost.tracker,
    baseUrl: stub.baseUrl,
    log: (m) => logs.push(m),
    onBudget: (l) => budgetEvents.push(l),
    maxRetries: over.maxRetries ?? 2,
  });
  return { service, cost, logs, budgetEvents, settings };
}
