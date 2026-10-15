import type { Sentence, Transcript } from '@shared/pipeline';
import { durationRange, pipelineOptionsSchema } from '@shared/pipeline';
import type { HighlightCandidate } from '../../pipeline/contracts2';
import {
  buildTranscriptBlock,
  buildVideoContext,
  CHAT_SYSTEM,
  buildRetrievalStable,
  RETRIEVE_SYSTEM,
} from '../chat/prompts';
import { CHAT_TOOLS } from '../chat/tools';
import { SLICE_TOKENS, EXCERPT_TOKEN_BUDGET, sliceSentences } from '../chat/retrieval';
import { WHOLE_TRANSCRIPT_MAX_TOKENS } from '../chat/chat';
import { computeCostUsd } from '../cost';
import { naiveCandidates } from './estimate';
import {
  buildClipStable,
  buildHighlightStable,
  buildHighlightVolatile,
  buildHooksVolatile,
  buildMetaVolatile,
  buildThumbsVolatile,
  HIGHLIGHT_SYSTEM,
  HOOKS_SYSTEM,
  META_SYSTEM,
  THUMBS_SYSTEM,
} from './prompts2';
import { estimateTokens } from './transcript';

/**
 * Cost PREVIEW of the CP2 calls, built from the real prompt builders (so it follows prompt changes) and
 * the cost table. Prompt sizes are estimates (chars/3.6 + label overhead); output and thinking sizes
 * are ASSUMPTIONS (thinking cannot be measured without a real key). Every call is priced as the FIRST
 * call (cache write) and, where caching applies, as a FOLLOW-UP inside the 5-minute cache lifetime.
 */

export interface CallEstimate {
  kind: string;
  model: string;
  /** Uncached input, cache writes, cache reads, output (incl. assumed thinking). */
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  usd: number;
  note: string;
}

export const CP2_ASSUMPTIONS = {
  highlightsOut: 2_450, // ~450 visible JSON + ~2,000 thinking (Sonnet, effort medium)
  hooksOut: 2_100, // ~1,100 visible (15 variants) + ~1,000 thinking (Haiku, effort medium)
  metaOut: 1_200, // ~900 visible + ~300 thinking (Haiku, effort low)
  thumbsOut: 550, // ~350 visible + ~200 thinking (Sonnet, effort low)
  chatOut: 550, // ~250 visible + ~300 thinking (Sonnet, effort low)
  chatToolTurnOut: 300, // tool call turn
  retrievalOut: 350, // Haiku, effort low
  imageTokens: Math.ceil((432 * 768) / 750), // a 9:16 frame downscaled to 432x768
  frames: 6,
  historyTokens: 600,
};

const SONNET = 'claude-sonnet-5-5';
const HAIKU = 'claude-haiku-5-5';

function price(
  kind: string,
  model: string,
  u: { input: number; write: number; read: number; output: number },
  note: string,
): CallEstimate {
  return {
    kind,
    model,
    inputTokens: u.input,
    cacheWriteTokens: u.write,
    cacheReadTokens: u.read,
    outputTokens: u.output,
    usd: computeCostUsd(model, {
      inputTokens: u.input,
      outputTokens: u.output,
      cacheReadTokens: u.read,
      cacheWriteTokens: u.write,
    }),
    note,
  };
}

/** Tiles a transcript until it is `hours` long (for the long-video scenario). */
export function tileTranscript(t: Transcript, hours: number): Sentence[] {
  const out: Sentence[] = [];
  const span = Math.max(1, t.durationSec);
  const reps = Math.max(1, Math.ceil((hours * 3600) / span));
  let id = 0;
  for (let r = 0; r < reps; r++)
    for (const s of t.sentences) out.push({ ...s, id: id++, s: s.s + r * span, e: s.e + r * span });
  return out;
}

export function toHighlightCandidates(
  sentences: readonly Sentence[],
  max: number,
): HighlightCandidate[] {
  const range = durationRange(pipelineOptionsSchema.parse({ clipPreset: '30-60', clipCount: 10 }));
  return naiveCandidates(sentences, range, max).map((c, i) => {
    const part = sentences.filter((s) => c.sentenceIds.includes(s.id));
    return {
      id: `c${i + 1}`,
      title: `Clip ${i + 1}`,
      hook: part[0]?.text.slice(0, 60) ?? null,
      startSec: c.s,
      endSec: c.e,
      text: c.text,
      whyItWorks: 'Estimate placeholder (about the size of a real one).',
      score: 60 + (i % 5) * 5,
      sentences: part,
    };
  });
}

export function estimateCp2Cost(args: {
  transcript: Transcript;
  title?: string;
  /** Also price a chat on a video of this many hours (tiles the transcript). */
  longVideoHours?: number;
}): {
  calls: CallEstimate[];
  assumptions: string[];
  chatPath: 'whole' | 'retrieval';
  transcriptTokens: number;
} {
  const A = CP2_ASSUMPTIONS;
  const title = args.title ?? 'Video title';
  const sentences = args.transcript.sentences;
  const calls: CallEstimate[] = [];

  // ---- highlights (8 candidates ~ what one video's top clips give)
  const cands = toHighlightCandidates(sentences, 8);
  const hlSys = estimateTokens(HIGHLIGHT_SYSTEM);
  const hlStable = estimateTokens(
    buildHighlightStable({
      title,
      channel: 'Channel',
      summary: 'x'.repeat(500),
      topics: ['a', 'b', 'c'],
      candidates: cands,
    }),
  );
  const hlVol = estimateTokens(
    buildHighlightVolatile({ steering: '', minSec: 60, maxSec: 90, frugal: false }),
  );
  calls.push(
    price(
      'highlights',
      SONNET,
      { input: hlVol, write: hlSys + hlStable, read: 0, output: A.highlightsOut },
      `${cands.length} candidates, first call`,
    ),
    price(
      'highlights (steered re-run)',
      SONNET,
      { input: hlVol, write: 0, read: hlSys + hlStable, output: A.highlightsOut },
      'same candidates, new steering text, within 5 min',
    ),
  );

  // ---- per-clip calls on a typical 45 s clip
  const clipCand = cands[0];
  const clip = {
    title: 'A clip title of typical length',
    hook: 'A typical hook of ten words or so',
    startSec: clipCand?.startSec ?? 0,
    endSec: clipCand?.endSec ?? 45,
    text: clipCand?.text ?? '',
    whyItWorks: 'Concrete hook, tension and payoff in one sentence of ordinary length.',
    score: 78,
  };
  const clipStable = estimateTokens(buildClipStable({ title, channel: 'Channel' }, clip));
  calls.push(
    price(
      'hooks (15 variants)',
      HAIKU,
      {
        input: estimateTokens(HOOKS_SYSTEM) + clipStable + estimateTokens(buildHooksVolatile()),
        write: 0,
        read: 0,
        output: A.hooksOut,
      },
      'prefix is below the minimum cacheable size, billed as plain input',
    ),
    price(
      'metadata (3 platforms)',
      HAIKU,
      {
        input:
          estimateTokens(META_SYSTEM) + clipStable + estimateTokens(buildMetaVolatile(clip.hook)),
        write: 0,
        read: 0,
        output: A.metaOut,
      },
      'idem',
    ),
  );
  const thumbIn =
    estimateTokens(THUMBS_SYSTEM) +
    clipStable +
    estimateTokens(buildThumbsVolatile(A.frames)) +
    A.frames * (A.imageTokens + 4);
  calls.push(
    price(
      'thumbnails (6 frames, downscaled)',
      SONNET,
      { input: thumbIn, write: 0, read: 0, output: A.thumbsOut },
      `${A.frames} frames at ~${A.imageTokens} tokens each`,
    ),
    price(
      'thumbnails (6 frames, 1080x1920 as-is)',
      SONNET,
      {
        input: thumbIn + A.frames * (Math.ceil((882 * 1568) / 750) - A.imageTokens),
        write: 0,
        read: 0,
        output: A.thumbsOut,
      },
      'what it would cost without the downscale (the API caps at ~1568 px)',
    ),
  );

  // ---- chat
  const toolsTok = estimateTokens(JSON.stringify(CHAT_TOOLS));
  const sysTok = estimateTokens(CHAT_SYSTEM) + toolsTok;
  const ctxInfo = { title, channel: 'Channel', description: null } as const;
  const durationSec = args.transcript.durationSec;
  const ctxTok = estimateTokens(
    buildVideoContext({ info: ctxInfo, analysis: null, clip: null, durationSec }),
  );
  const trTok = estimateTokens(buildTranscriptBlock(sentences, durationSec));
  const chatPath = trTok <= WHOLE_TRANSCRIPT_MAX_TOKENS ? 'whole' : 'retrieval';
  if (chatPath === 'whole') {
    const q = 25;
    calls.push(
      price(
        'chat turn 1 (whole transcript)',
        SONNET,
        { input: q, write: sysTok + ctxTok + trTok, read: 0, output: A.chatOut },
        'pays the cache write of tools + system + transcript',
      ),
      price(
        'chat follow-up turn',
        SONNET,
        { input: q + A.historyTokens, write: 0, read: sysTok + ctxTok + trTok, output: A.chatOut },
        'reads the cached prefix (within 5 min of the last turn)',
      ),
      price(
        'chat turn with a tool call (2 model calls)',
        SONNET,
        {
          input: 2 * (q + A.historyTokens) + 150,
          write: 0,
          read: 2 * (sysTok + ctxTok + trTok),
          output: A.chatToolTurnOut + A.chatOut,
        },
        'call 1 emits the tool call, call 2 confirms it',
      ),
    );
  }

  // ---- long video scenario (retrieval path)
  const hours = args.longVideoHours;
  if (hours) {
    const long = tileTranscript(args.transcript, hours);
    const longTok = estimateTokens(buildTranscriptBlock(long, hours * 3600));
    const slices = sliceSentences(long, SLICE_TOKENS);
    const sliceTok = slices.map((sl) =>
      estimateTokens(
        buildRetrievalStable({
          title,
          summary: 'x'.repeat(500),
          sentences: sl,
          durationSec: hours * 3600,
          sliceLabel: 'part 1 of N, 0:00:00-0:00:00',
        }),
      ),
    );
    const retrSys = estimateTokens(RETRIEVE_SYSTEM);
    const firstUsd = sliceTok.reduce(
      (a, t) =>
        a +
        computeCostUsd(HAIKU, {
          inputTokens: 80,
          outputTokens: A.retrievalOut,
          cacheWriteTokens: retrSys + t,
        }),
      0,
    );
    const nextUsd = sliceTok.reduce(
      (a, t) =>
        a +
        computeCostUsd(HAIKU, {
          inputTokens: 80,
          outputTokens: A.retrievalOut,
          cacheReadTokens: retrSys + t,
        }),
      0,
    );
    const total = (u: number) => sliceTok.reduce((a, t) => a + t, 0) + u;
    calls.push({
      kind: `chat retrieval, ${hours} h video, 1st question`,
      model: `${HAIKU} x${slices.length} slices + ${SONNET}`,
      inputTokens: 0,
      cacheWriteTokens: total(retrSys * slices.length),
      cacheReadTokens: 0,
      outputTokens: slices.length * A.retrievalOut + A.chatOut,
      usd:
        firstUsd +
        computeCostUsd(SONNET, {
          inputTokens: EXCERPT_TOKEN_BUDGET + 25,
          outputTokens: A.chatOut,
          cacheWriteTokens: sysTok + ctxTok + 600,
        }),
      note: `transcript ~${Math.round(longTok / 1000)}K tokens > ${WHOLE_TRANSCRIPT_MAX_TOKENS / 1000}K; slices cached; excerpts ~${EXCERPT_TOKEN_BUDGET / 1000}K tokens (upper bound)`,
    });
    calls.push({
      kind: `chat retrieval, ${hours} h video, later questions`,
      model: `${HAIKU} x${slices.length} slices + ${SONNET}`,
      inputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: total(retrSys * slices.length),
      outputTokens: slices.length * A.retrievalOut + A.chatOut,
      usd:
        nextUsd +
        computeCostUsd(SONNET, {
          inputTokens: EXCERPT_TOKEN_BUDGET + 25 + A.historyTokens,
          outputTokens: A.chatOut,
          cacheReadTokens: sysTok + ctxTok,
        }),
      note: 'slice prefixes read from cache at 0.1x (within 5 min of the last question)',
    });
  }

  return {
    calls,
    chatPath,
    transcriptTokens: trTok,
    assumptions: [
      'Prompt token counts are estimates (≈3.6 chars/token + label overhead), not API counts; Haiku 5.5 may count ~30% more tokens for the same text.',
      `Visible output + thinking per call are ASSUMPTIONS and UNMEASURED: highlights ${A.highlightsOut}, hooks ${A.hooksOut}, metadata ${A.metaOut}, thumbnails ${A.thumbsOut}, chat turn ${A.chatOut} tokens.`,
      'Cache write 1.25x, cache read 0.1x of the input price; prefixes below the minimum cacheable size (hooks, metadata, thumbnails: ~1-2K tokens) are billed as plain input.',
      'Thumbnail frames are priced at ~width*height/750 tokens each; the 1080x1920 row shows what skipping the downscale would cost.',
      'No repair retries, no tool-call retries, and a single steering text per highlights call are assumed.',
    ],
  };
}
