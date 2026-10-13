import type { CostSummary } from '@shared/domain';
import type { Db } from '../db/client';

/** USD per 1M tokens. Update when Anthropic changes prices (BRIEF §9: "fetched/updatable"). */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const DEFAULT_PRICING: Record<string, ModelPrice> = {
  sonnet: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  haiku: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  opus: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
};

export function priceFor(model: string, table = DEFAULT_PRICING): ModelPrice {
  const m = model.toLowerCase();
  if (m.includes('haiku')) return table.haiku!;
  if (m.includes('opus')) return table.opus!;
  return table.sonnet!; // sonnet + unknown models: assume the mid tier so we never under-count
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export function computeCostUsd(model: string, u: Usage, table = DEFAULT_PRICING): number {
  const p = priceFor(model, table);
  return (
    (u.inputTokens * p.input +
      u.outputTokens * p.output +
      (u.cacheReadTokens ?? 0) * p.cacheRead +
      (u.cacheWriteTokens ?? 0) * p.cacheWrite) /
    1_000_000
  );
}

export class CostTracker {
  constructor(
    private readonly db: Db,
    private readonly budget: () => Promise<{ targetUsd: number; hardCapUsd: number }>,
  ) {}

  async record(model: string, purpose: string, u: Usage): Promise<number> {
    const costUsd = computeCostUsd(model, u);
    await this.db.costEvent.create({
      data: {
        model,
        purpose,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cachedTokens: u.cacheReadTokens ?? 0,
        cacheWrites: u.cacheWriteTokens ?? 0,
        costUsd,
      },
    });
    return costUsd;
  }

  async summary(now = new Date()): Promise<CostSummary> {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const agg = await this.db.costEvent.aggregate({
      where: { createdAt: { gte: start } },
      _sum: { costUsd: true, inputTokens: true, outputTokens: true, cachedTokens: true },
      _count: true,
    });
    const spent = agg._sum.costUsd ?? 0;
    const { targetUsd, hardCapUsd } = await this.budget();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const elapsedDays = Math.max(1, now.getDate() - 1 + now.getHours() / 24 + 1 / 24);
    const projected = spent > 0 ? (spent / elapsedDays) * daysInMonth : 0;
    const level: CostSummary['level'] =
      spent >= hardCapUsd
        ? 'hard-cap'
        : spent >= targetUsd
          ? 'over-target'
          : spent >= targetUsd * 0.8
            ? 'warn'
            : 'ok';
    return {
      month: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
      spentUsd: spent,
      projectedUsd: projected,
      targetUsd,
      hardCapUsd,
      calls: agg._count,
      inputTokens: agg._sum.inputTokens ?? 0,
      outputTokens: agg._sum.outputTokens ?? 0,
      cachedTokens: agg._sum.cachedTokens ?? 0,
      level,
    };
  }
}
