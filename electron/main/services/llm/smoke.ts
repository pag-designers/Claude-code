/**
 * LIVE smoke check of the LLM layer against the real Anthropic API.
 *
 *   ANTHROPIC_API_KEY=sk-ant-... node scripts/llm-smoke.mjs <transcript.json> [options]
 *
 * <transcript.json> is a `Transcript` (shared/pipeline.ts), e.g. the fixtures produced by the
 * media engineer (`news-3min.transcript.json`, `news-full.transcript.json`).
 * Options:  --windows=N      rank the first N windows (default 2)
 *           --window-sec=S   window length in seconds (default 600)
 *           --preset=30-60   clip length preset: 15-30 | 30-60 | 60-90 (default 30-60)
 *           --clips=N        clips wanted for the whole video (default 10)
 *           --prompt="..."   steering prompt; when given, window 1 is run twice (plain, then steered)
 *                            so you can see the second run hit the prompt cache
 *           --dry-run        no API call and no key needed: print prompt sizes and the cost estimate
 *
 * What it does: understand() on the whole transcript, then rankMoments() on the first N windows with
 * naive heuristic candidates, printing overview, chapters, every moment and - from the API's own usage
 * numbers - the dollars spent (the same CostTracker maths as the app). A run of the 3-minute
 * fixture costs a few cents; the 19-minute one well under a dollar.
 *
 * What to look at: do the clips start on a hook and end on a payoff, are scores spread out (not all
 * 80+), is `cacheRead` > 0 on the second call, and is the cost in line with the estimate.
 */
import fs from 'node:fs';
import {
  durationRange,
  pipelineOptionsSchema,
  totalScore,
  transcriptSchema,
} from '@shared/pipeline';
import type { Transcript } from '@shared/pipeline';
import { DEFAULT_SETTINGS } from '@shared/settings';
import type { CostSummary } from '@shared/domain';
import { computeCostUsd, type Usage } from '../cost';
import type { CostPort } from './budget';
import { estimateRunCost, momentsPerWindow, naiveCandidates, splitWindows } from './estimate';
import { createLlmService } from './index';
import { fmtClock } from './transcript';

export interface SmokeOptions {
  windows?: number;
  windowSec?: number;
  preset?: '15-30' | '30-60' | '60-90';
  clips?: number;
  prompt?: string;
  dryRun?: boolean;
  baseUrl?: string;
  /** Where lines go; defaults to stdout. */
  print?: (line: string) => void;
}

export interface SmokeResult {
  calls: { purpose: string; model: string; usage: Usage; usd: number }[];
  totalUsd: number;
  momentCount: number;
}

export function loadTranscript(path: string): Transcript {
  const raw: unknown = JSON.parse(fs.readFileSync(path, 'utf8'));
  const candidate = (raw as { transcript?: unknown }).transcript ?? raw;
  const parsed = transcriptSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(
      `${path} is not a Transcript: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}

const usd = (n: number) => `$${n.toFixed(4)}`;

export async function runSmoke(
  apiKey: string | null,
  transcriptJsonPath: string,
  opts: SmokeOptions = {},
): Promise<SmokeResult> {
  const print = opts.print ?? ((l: string) => void process.stdout.write(`${l}\n`));
  const transcript = loadTranscript(transcriptJsonPath);
  const options = pipelineOptionsSchema.parse({
    clipPreset: opts.preset ?? '30-60',
    clipCount: opts.clips ?? 10,
    prompt: opts.prompt ?? '',
  });
  const range = durationRange(options);
  const windowSec = opts.windowSec ?? 600;
  const title =
    transcriptJsonPath
      .split('/')
      .pop()
      ?.replace(/\.transcript\.json$/, '') ?? 'Smoke test video';

  const est = estimateRunCost({ transcript, title, options, windowSec });
  print(
    `Transcript: ${transcript.sentences.length} sentences, ${fmtClock(transcript.durationSec)} ` +
      `(${transcript.language}), ${est.windows} window(s) of ~${windowSec}s`,
  );
  print(
    `Estimate for the WHOLE video: understand ${usd(est.understand.usd)} + moments ${usd(est.moments.usd)} ` +
      `= ${usd(est.totalUsd)} (a steered re-run of all windows: ~${usd(est.steeredRerunUsd)})`,
  );
  est.assumptions.forEach((a) => print(`  - ${a}`));
  if (opts.dryRun) return { calls: [], totalUsd: 0, momentCount: 0 };
  if (!apiKey) throw new Error('Set ANTHROPIC_API_KEY (or use --dry-run).');

  // ---- in-memory cost tracker with the app's pricing maths
  const calls: SmokeResult['calls'] = [];
  const cost: CostPort = {
    record: (model, purpose, usage) => {
      const u = computeCostUsd(model, usage);
      calls.push({ purpose, model, usage, usd: u });
      return Promise.resolve(u);
    },
    summary: () => {
      const spent = calls.reduce((a, c) => a + c.usd, 0);
      const s: CostSummary = {
        month: 'smoke',
        spentUsd: spent,
        projectedUsd: spent,
        targetUsd: DEFAULT_SETTINGS.budgetTargetUsd,
        hardCapUsd: DEFAULT_SETTINGS.budgetHardCapUsd,
        calls: calls.length,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        level: 'ok',
      };
      return Promise.resolve(s);
    },
  };
  const llm = createLlmService({
    getApiKey: () => apiKey,
    getSettings: () => Promise.resolve(DEFAULT_SETTINGS),
    cost,
    baseUrl: opts.baseUrl,
    log: (m) => print(`  [llm] ${m}`),
    onBudget: (l) => print(`  [budget] ${l}`),
  });

  // ---- 1. understand
  print('\n=== understand() ===');
  const t0 = Date.now();
  const analysis = await llm.understand({
    info: { title, channel: null, description: null, chapters: [] },
    transcript,
    onProgress: () => {},
  });
  print(`(${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  print(`Summary: ${analysis.overview.summary}`);
  print(
    `Tone: ${analysis.overview.tone}   Participants: ${analysis.overview.participants.join(', ')}`,
  );
  analysis.overview.takeaways.forEach((t, i) => print(`  ${i + 1}. ${t}`));
  print('Chapters:');
  analysis.chapters.forEach((c) =>
    print(`  ${fmtClock(c.start)}-${fmtClock(c.end)}  ${c.title} - ${c.summary}`),
  );
  print(
    `Notes: ${analysis.notes.keyPoints.length} key points, ${analysis.notes.quotes.length} quotes, ` +
      `${analysis.notes.numbers.length} numbers, ${analysis.notes.claims.length} claims, ` +
      `${analysis.notes.actionItems.length} action items`,
  );
  print(`Topics: ${analysis.topics.join(', ')}`);

  // ---- 2. rank the first N windows
  const windows = splitWindows(transcript.sentences, windowSec).slice(0, opts.windows ?? 2);
  const perWindow = momentsPerWindow(
    options.clipCount,
    est.windows,
    Math.min(windowSec, transcript.durationSec),
    range,
  );
  let momentCount = 0;
  const runWindow = async (wi: number, prompt: string) => {
    const w = windows[wi]!;
    const candidates = naiveCandidates(w.sentences, range, 15);
    print(
      `\n=== rankMoments() window ${wi + 1}/${windows.length} ${fmtClock(w.startSec)}-${fmtClock(w.endSec)}` +
        `${prompt ? `  steering: "${prompt}"` : ''}  (${candidates.length} naive candidates) ===`,
    );
    const t1 = Date.now();
    const moments = await llm.rankMoments({
      videoId: 'smoke',
      info: { title, channel: null },
      analysis: { overview: analysis.overview, topics: analysis.topics },
      options: { ...options, prompt },
      window: { startSec: w.startSec, endSec: w.endSec },
      sentences: w.sentences,
      candidates,
      maxClips: perWindow,
    });
    print(`(${((Date.now() - t1) / 1000).toFixed(1)}s) ${moments.length} moment(s)`);
    for (const m of moments) {
      print(
        `\n  [${totalScore(m.breakdown)}] ${fmtClock(m.startSec)}-${fmtClock(m.endSec)} (${Math.round(m.endSec - m.startSec)}s)  ${m.title}`,
      );
      print(
        `      hook: "${m.hook}"   confidence ${m.confidence.toFixed(2)}   candidate ${m.candidateId ?? '-'}`,
      );
      print(`      why:  ${m.whyItWorks}`);
      const b = m.breakdown;
      print(
        `      hook ${b.hook}/25  retention ${b.retention}/25  emotion ${b.emotion}/20  clarity ${b.clarity}/15  share ${b.shareability}/15   keywords: ${m.keywords.join(', ')}`,
      );
      const text = transcript.sentences.filter(
        (s) => s.s >= m.startSec - 0.01 && s.e <= m.endSec + 0.01,
      );
      if (text.length) {
        print(`      first: ${text[0]!.text}`);
        print(`      last:  ${text[text.length - 1]!.text}`);
      }
    }
    momentCount += moments.length;
  };
  for (let i = 0; i < windows.length; i++) await runWindow(i, i === 0 ? '' : options.prompt);
  if (options.prompt && windows.length) await runWindow(0, options.prompt); // steered re-run -> cache hit

  // ---- 3. cost table
  print('\n=== API usage and cost (API-reported tokens, app pricing) ===');
  print('purpose      model               input  cacheRead cacheWrite   output        cost');
  for (const c of calls) {
    print(
      `${c.purpose.padEnd(12)} ${c.model.padEnd(18)} ${String(c.usage.inputTokens).padStart(7)} ${String(c.usage.cacheReadTokens ?? 0).padStart(9)} ${String(c.usage.cacheWriteTokens ?? 0).padStart(10)} ${String(c.usage.outputTokens).padStart(8)} ${usd(c.usd).padStart(11)}`,
    );
  }
  const total = calls.reduce((a, c) => a + c.usd, 0);
  print(`TOTAL ${usd(total)} for ${calls.length} call(s)`);
  return { calls, totalUsd: total, momentCount };
}
