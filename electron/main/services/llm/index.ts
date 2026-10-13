import type { Settings } from '@shared/settings';
import type { LlmService } from '../../pipeline/contracts';
import { redact } from '../../logger';
import { createBudgetGuard, type BudgetLevel, type CostPort } from './budget';
import { LlmEngine } from './client';
import { runRank } from './moments';
import { runUnderstand } from './understand';

export { LlmError, type LlmErrorCode } from './errors';
export type { BudgetLevel, CostPort } from './budget';

export interface LlmDeps {
  /** Current Anthropic key (stored or .env); null when none is set. Called on every request. */
  getApiKey: () => string | null;
  getSettings: () => Promise<Settings>;
  /** The real `CostTracker` satisfies `CostPort`. */
  cost: CostPort;
  /** Override for tests / proxies. Defaults to https://api.anthropic.com. */
  baseUrl?: string;
  log: (m: string) => void;
  /** Called once per level change: 'warn' (>=80% of target), 'over-target', 'hard-cap'. */
  onBudget?: (level: BudgetLevel) => void;
  /** SDK retries for 429/5xx/connection errors before the first byte. Default 3. */
  maxRetries?: number;
}

/**
 * The Claude-backed `LlmService` (BRIEF §4.4/4.5/4.9, §9).
 *  - understand():  overview, chapters, notes, topics.
 *  - rankMoments(): picks and scores clip moments by sentence ids.
 * Budget: reads the month's spend before every call; hard cap throws `BudgetExceededError`;
 * over the target, understand() uses the fast model and rankMoments() halves candidates/maxClips.
 */
export function createLlmService(deps: LlmDeps): LlmService {
  // Defence in depth: nothing that reaches the app log may contain a key.
  const log = (m: string) => deps.log(redact(m));
  const budget = createBudgetGuard({ cost: deps.cost, onBudget: deps.onBudget, log });
  const engine = new LlmEngine({
    getApiKey: deps.getApiKey,
    cost: deps.cost,
    budget,
    baseUrl: deps.baseUrl,
    maxRetries: deps.maxRetries,
    log,
  });
  const ctx = { engine, budget, getSettings: deps.getSettings, log };
  return {
    isConfigured: () => engine.isConfigured(),
    understand: (input) => runUnderstand(ctx, input),
    rankMoments: (input) => runRank(ctx, input),
  };
}
