import type { Settings } from '@shared/settings';
import type { LlmService } from '../../pipeline/contracts';
import type { LlmServiceV2 } from '../../pipeline/contracts2';
import { runChat } from '../chat/chat';
import { redact } from '../../logger';
import { createBudgetGuard, type BudgetLevel, type CostPort } from './budget';
import { LlmEngine } from './client';
import { runHighlights } from './highlights';
import { runHooks } from './hooks';
import { electronDownscale, type DownscalePort } from './images';
import { runBroll } from './broll';
import { runMeta } from './meta';
import { runRank } from './moments';
import { runThumbnails } from './thumbnails';
import { runUnderstand } from './understand';

export { LlmError, type LlmErrorCode } from './errors';
export type { BudgetLevel, CostPort } from './budget';
export { estimateRunCost, type RunEstimate } from './estimate';
export type { DownscalePort } from './images';

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
  /**
   * Shrinks a candidate thumbnail frame to <= maxLongSide px before the vision call (frames already
   * <= 720 px wide are sent as they are). Default: Electron's `nativeImage` in the main process; when
   * unavailable frames are sent unchanged (the API caps them at 1568 px itself).
   */
  downscaleImage?: DownscalePort;
}

/**
 * The Claude-backed `LlmService` (BRIEF §4.4/4.5/4.9, §9).
 *  - understand():  overview, chapters, notes, topics.
 *  - rankMoments(): picks and scores clip moments by sentence ids.
 * Budget: reads the month's spend before every call; hard cap throws `BudgetExceededError`;
 * over the target, understand() uses the fast model and rankMoments() halves candidates/maxClips.
 *
 * CP2 (LlmServiceV2), through the same engine:
 *  - composeHighlights(): One-Click Highlights (smart model, sentence ids -> validated seconds).
 *  - writeHooks() / writeMeta(): fast model, 5 hooks x 3 platforms / per-platform copy.
 *  - rankThumbnails(): vision ranking of up to 6 frames.
 *  - chat(): streamed, tool-using assistant with citations (services/chat).
 */
export function createLlmService(deps: LlmDeps): LlmService & LlmServiceV2 {
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
    composeHighlights: (input) => runHighlights(ctx, input),
    writeHooks: (input) => runHooks(ctx, input),
    writeMeta: (input) => runMeta(ctx, input),
    suggestBroll: (input) => runBroll(ctx, input),
    rankThumbnails: (input) =>
      runThumbnails({ ...ctx, downscale: deps.downscaleImage ?? electronDownscale }, input),
    chat: (input) => runChat(ctx, input),
  };
}
