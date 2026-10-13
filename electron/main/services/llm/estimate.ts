import type { MomentCandidate, PipelineOptions, Sentence, Transcript } from '@shared/pipeline';
import { durationRange } from '@shared/pipeline';
import { computeCostUsd } from '../cost';
import {
  buildRankStable,
  buildRankVolatile,
  buildUnderstandStable,
  buildUnderstandVolatile,
  RANK_SYSTEM,
  targetChapterCount,
  UNDERSTAND_SYSTEM,
} from './prompts';
import { estimateTokens } from './transcript';

/**
 * Cost PREVIEW built from the real prompt builders (so it tracks prompt changes) and the cost
 * table. Token counts are estimates (chars/3.6 + label overhead); output sizes are ASSUMPTIONS
 * (thinking cannot be measured without a real key) - every assumption is returned in the result so
 * the number is never presented as a measurement.
 */

export interface StageEstimate {
  calls: number;
  /** Prompt tokens by billing class. */
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  usd: number;
}

export interface RunEstimate {
  windows: number;
  understand: StageEstimate;
  moments: StageEstimate;
  totalUsd: number;
  /** Extra cost of ONE steered re-run of every window inside the 5-minute cache lifetime. */
  steeredRerunUsd: number;
  assumptions: string[];
}

export const ESTIMATE_ASSUMPTIONS = {
  windowSec: 600,
  candidatesPerWindow: 15,
  /** Visible JSON answer per moment (title, hook, why, keywords, scores). */
  outputTokensPerMoment: 230,
  /** Adaptive thinking at effort=medium for one window. A guess, NOT a measurement. */
  rankThinkingTokens: 2_500,
  /** Adaptive thinking at effort=low for the whole-video analysis. A guess. */
  understandThinkingTokens: 800,
};

/**
 * Deliberately naive candidate generator, ONLY for the smoke test and cost preview (the real one
 * is MomentService): greedy sentence windows of about the middle of the duration range.
 */
export function naiveCandidates(
  sentences: readonly Sentence[],
  range: { minSec: number; maxSec: number },
  max: number,
): MomentCandidate[] {
  const target = (range.minSec + range.maxSec) / 2;
  const out: MomentCandidate[] = [];
  for (let i = 0; i < sentences.length; i += 3) {
    const first = sentences[i]!;
    let j = i;
    while (j + 1 < sentences.length && sentences[j]!.e - first.s < target) j++;
    const d = sentences[j]!.e - first.s;
    if (d < range.minSec || d > range.maxSec) continue;
    const part = sentences.slice(i, j + 1);
    const text = part.map((s) => s.text).join(' ');
    out.push({
      id: `n${out.length + 1}`,
      s: first.s,
      e: sentences[j]!.e,
      prior: 0.3 + (/\?/.test(part[0]!.text) ? 0.2 : 0) + (/\d/.test(text) ? 0.1 : 0),
      sentenceIds: part.map((s) => s.id),
      text,
      signals: {
        hookStrength: 0.5,
        energy: 0.5,
        speechRateChange: 0,
        laughter: 0,
        hasQuestion: /\?/.test(part[0]!.text),
        hasNumber: /\d/.test(text),
        selfContained: 0.5,
      },
    });
  }
  return out.sort((a, b) => b.prior - a.prior).slice(0, max);
}

/**
 * How many moments to ask for per window: the user's clip count spread over the windows with 50%
 * headroom (ranking filters), but never more than fit in the window.
 */
export function momentsPerWindow(
  clipCount: number | null,
  windows: number,
  windowSec: number,
  range: { minSec: number },
): number {
  const share = Math.ceil(((clipCount ?? 12) / Math.max(1, windows)) * 1.5);
  const fits = Math.max(1, Math.floor(windowSec / range.minSec));
  return Math.max(1, Math.min(share, fits));
}

/** Splits sentences into consecutive windows of about `windowSec` (never mid-sentence). */
export function splitWindows(
  sentences: readonly Sentence[],
  windowSec: number,
): { startSec: number; endSec: number; sentences: Sentence[] }[] {
  const wins: { startSec: number; endSec: number; sentences: Sentence[] }[] = [];
  let cur: Sentence[] = [];
  let start = sentences[0]?.s ?? 0;
  for (const s of sentences) {
    if (cur.length && s.s - start >= windowSec) {
      wins.push({ startSec: start, endSec: cur[cur.length - 1]!.e, sentences: cur });
      cur = [];
      start = s.s;
    }
    cur.push(s);
  }
  if (cur.length) wins.push({ startSec: start, endSec: cur[cur.length - 1]!.e, sentences: cur });
  return wins;
}

const zero = (): StageEstimate => ({
  calls: 0,
  inputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  outputTokens: 0,
  usd: 0,
});

function add(
  st: StageEstimate,
  model: string,
  u: { input: number; write: number; read: number; output: number },
): void {
  st.calls++;
  st.inputTokens += u.input;
  st.cacheWriteTokens += u.write;
  st.cacheReadTokens += u.read;
  st.outputTokens += u.output;
  st.usd += computeCostUsd(model, {
    inputTokens: u.input,
    outputTokens: u.output,
    cacheReadTokens: u.read,
    cacheWriteTokens: u.write,
  });
}

export function estimateRunCost(args: {
  transcript: Transcript;
  title?: string;
  options: PipelineOptions;
  modelSmart?: string;
  windowSec?: number;
  candidatesPerWindow?: number;
  /** Uploader chapters, if any (changes the understand prompt). */
  youtubeChapterCount?: number;
}): RunEstimate {
  const A = ESTIMATE_ASSUMPTIONS;
  const model = args.modelSmart ?? 'claude-sonnet-5-5';
  const windowSec = args.windowSec ?? A.windowSec;
  const nCand = args.candidatesPerWindow ?? A.candidatesPerWindow;
  const sentences = args.transcript.sentences;
  const durationSec = args.transcript.durationSec;
  const title = args.title ?? 'Video title';
  const range = durationRange(args.options);

  // ---- understand: one call, whole transcript
  const understand = zero();
  {
    const sys = estimateTokens(UNDERSTAND_SYSTEM);
    const stable = estimateTokens(
      buildUnderstandStable({
        title,
        channel: 'Channel',
        description: null,
        durationSec,
        sentences,
        youtubeChapters: [],
      }),
    );
    const vol = estimateTokens(
      buildUnderstandVolatile({ durationSec, youtubeChapterCount: args.youtubeChapterCount ?? 0 }),
    );
    const chapters = args.youtubeChapterCount ?? targetChapterCount(durationSec);
    const out = 1_400 + chapters * 80 + A.understandThinkingTokens;
    add(understand, model, { input: vol, write: sys + stable, read: 0, output: out });
  }

  // ---- moments: one call per window; the static system prompt is read from the 2nd call on
  const moments = zero();
  const wins = splitWindows(sentences, windowSec);
  const perWindowClips = momentsPerWindow(
    args.options.clipCount,
    wins.length,
    Math.min(windowSec, durationSec),
    range,
  );
  let steered = 0;
  const sys = estimateTokens(RANK_SYSTEM);
  wins.forEach((w, i) => {
    const stable = estimateTokens(
      buildRankStable({
        title,
        channel: 'Channel',
        summary: 'x'.repeat(500),
        tone: 'casual',
        topics: ['topic one', 'topic two', 'topic three'],
        windowStartSec: w.startSec,
        windowEndSec: w.endSec,
        sentences: w.sentences,
      }),
    );
    const cands = naiveCandidates(w.sentences, range, nCand);
    const vol = estimateTokens(
      buildRankVolatile({
        steering: args.options.prompt,
        minSec: range.minSec,
        maxSec: range.maxSec,
        maxClips: perWindowClips,
        candidates: cands,
        hours: w.endSec >= 3600,
        frugal: false,
      }),
    );
    const out = perWindowClips * A.outputTokensPerMoment + 80 + A.rankThinkingTokens;
    add(moments, model, {
      input: vol,
      write: i === 0 ? sys + stable : stable,
      read: i === 0 ? 0 : sys,
      output: out,
    });
    // a steered re-run reads system + window from cache and only pays the volatile block + output
    const re = zero();
    add(re, model, { input: vol, write: 0, read: sys + stable, output: out });
    steered += re.usd;
  });

  return {
    windows: wins.length,
    understand,
    moments,
    totalUsd: understand.usd + moments.usd,
    steeredRerunUsd: steered,
    assumptions: [
      `Token counts are estimates (≈3.6 chars/token + label overhead), not API counts.`,
      `Windows of ${windowSec}s; ${nCand} heuristic candidates per window; ${perWindowClips} moments requested per window.`,
      `Answer size ${A.outputTokensPerMoment} tokens/moment; thinking assumed ${A.rankThinkingTokens} tokens/window (rank, effort medium) and ${A.understandThinkingTokens} (understand, effort low). Thinking is UNMEASURED.`,
      `${model}: cache write 1.25x, cache read 0.1x of the input price; the first window pays the system-prompt write, later windows read it.`,
      `Excludes later tools (hooks, metadata, chat) and any repair retries.`,
    ],
  };
}
