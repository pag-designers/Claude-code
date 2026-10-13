import type { CostSummary } from '@shared/domain';
import { BudgetExceededError } from '../../pipeline/contracts';
import { priceFor, type Usage } from '../cost';

/** The slice of CostTracker the LLM layer needs (the real class satisfies it structurally). */
export interface CostPort {
  record(model: string, purpose: string, usage: Usage): Promise<number>;
  summary(now?: Date): Promise<CostSummary>;
}

export type BudgetLevel = 'warn' | 'over-target' | 'hard-cap';

export interface BudgetGuard {
  /** Reads the month's spend, notifies on level changes, throws at the hard cap. */
  peek(): Promise<CostSummary>;
  /**
   * Like `peek`, but also refuses a call whose conservative cost estimate would cross the hard cap
   * ("never silently exceed").
   */
  check(model: string, inputTokens: number, outputTokens: number): Promise<CostSummary>;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

export function hardCapMessage(spent: number, cap: number, estimate?: number): string {
  return estimate === undefined
    ? `Monthly Claude API hard cap reached: ${usd(spent)} spent of the ${usd(cap)} cap. ` +
        'AI features are paused until next month — or raise the cap in Settings → Cost.'
    : `This request (about ${usd(estimate)}) would push this month's Claude API spend (${usd(spent)}) ` +
        `past the ${usd(cap)} hard cap, so it was not sent. Raise the cap in Settings → Cost or wait until next month.`;
}

export function createBudgetGuard(deps: {
  cost: CostPort;
  onBudget?: (level: BudgetLevel) => void;
  log: (m: string) => void;
}): BudgetGuard {
  // Last level we told the UI about; 'ok' re-arms the notifications.
  let notified: CostSummary['level'] = 'ok';

  const read = async (): Promise<CostSummary> => {
    const s = await deps.cost.summary();
    if (s.level !== notified) {
      notified = s.level;
      if (s.level !== 'ok') {
        deps.log(
          `budget level -> ${s.level} (spent ${usd(s.spentUsd)}, target ${usd(s.targetUsd)}, cap ${usd(s.hardCapUsd)})`,
        );
        try {
          deps.onBudget?.(s.level);
        } catch (e) {
          deps.log(`onBudget handler threw: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    return s;
  };

  return {
    async peek() {
      const s = await read();
      if (s.level === 'hard-cap') throw new BudgetExceededError(hardCapMessage(s.spentUsd, s.hardCapUsd));
      return s;
    },
    async check(model, inputTokens, outputTokens) {
      const s = await read();
      if (s.level === 'hard-cap') throw new BudgetExceededError(hardCapMessage(s.spentUsd, s.hardCapUsd));
      const p = priceFor(model);
      // Conservative: assume nothing is served from cache.
      const estimate = (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
      if (s.spentUsd + estimate >= s.hardCapUsd) {
        throw new BudgetExceededError(hardCapMessage(s.spentUsd, s.hardCapUsd, estimate));
      }
      return s;
    },
  };
}
