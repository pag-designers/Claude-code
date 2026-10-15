import type Anthropic from '@anthropic-ai/sdk';
import type { LlmServiceV2 } from '../../pipeline/contracts2';
import type { BudgetGuard } from './budget';
import type { LlmEngine } from './client';
import { abortError, LlmError } from './errors';
import { prepareImage, type DownscalePort } from './images';
import { buildClipStable, buildThumbsVolatile, THUMBS_SYSTEM } from './prompts2';
import { toJsonSchema } from './schemas';
import { modelThumbRankSchema, type ModelThumbRank } from './schemas2';

/**
 * rankThumbnails - vision ranking of up to 6 candidate frames (BRIEF §4.12).
 *
 * Request layout: system (instructions, cached) -> stable clip context (cached) -> "Frame K" label +
 * image per frame (varies per call, after the breakpoint) -> volatile task. The model refers to frames
 * by their 1-based label; this file maps them back to the caller's `index`.
 *
 * Smart model (Sonnet-class): judging blur, blinks and expressions is the part where the cheap model
 * is weakest, and 6 downscaled frames are only ~3K tokens (~$0.01). Over the monthly target the fast
 * model is used. Effort 'low' (perception, not deliberation). Design choices, not measurements.
 */

export const MAX_FRAMES = 6;
export const OVERLAY_MAX_WORDS = 5;

export interface ThumbContext {
  engine: LlmEngine;
  budget: BudgetGuard;
  getSettings: () => Promise<{ modelSmart: string; modelFast: string }>;
  downscale: DownscalePort;
  log: (m: string) => void;
}

type ThumbInput = Parameters<LlmServiceV2['rankThumbnails']>[0];
type ThumbResult = Awaited<ReturnType<LlmServiceV2['rankThumbnails']>>;

export async function runThumbnails(ctx: ThumbContext, input: ThumbInput): Promise<ThumbResult> {
  ctx.engine.assertConfigured();
  if (input.signal?.aborted) throw abortError(input.signal);
  if (input.frames.length === 0)
    throw new LlmError('bad-request', 'There are no candidate frames to rank.');
  let frames = input.frames;
  if (frames.length > MAX_FRAMES) {
    ctx.log(`thumbnails: ${frames.length} frames given; ranking the first ${MAX_FRAMES}`);
    frames = frames.slice(0, MAX_FRAMES);
  }

  const settings = await ctx.getSettings();
  const status = await ctx.budget.peek(); // throws BudgetExceededError at the hard cap
  const model = status.level === 'over-target' ? settings.modelFast : settings.modelSmart;
  if (model === settings.modelFast) ctx.log(`thumbnails: over monthly target - using ${model}`);

  const media: Anthropic.ContentBlockParam[] = [];
  let imageTokens = 0;
  for (const [k, f] of frames.entries()) {
    let img;
    try {
      img = await prepareImage(f.file, ctx.downscale, ctx.log);
    } catch (e) {
      throw new LlmError(
        'bad-request',
        `Could not read thumbnail frame ${f.file}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    media.push({ type: 'text', text: `Frame ${k + 1}` });
    media.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.data.toString('base64') },
    });
    imageTokens += img.width && img.height ? Math.ceil((img.width * img.height) / 750) : 1_500;
  }

  const n = frames.length;
  const out = await ctx.engine.run<ModelThumbRank>({
    model,
    purpose: 'thumbnails',
    system: THUMBS_SYSTEM,
    stable: buildClipStable({ title: input.clip.title, channel: null }, input.clip),
    media,
    volatile: buildThumbsVolatile(n),
    schema: modelThumbRankSchema,
    jsonSchema: THUMBS_JSON_SCHEMA,
    effort: 'low',
    maxTokens: 8_000,
    expectedOutputChars: 220 * n + 80,
    estimatedOutputTokens: 120 * n + 600,
    extraPromptTokens: imageTokens,
    signal: input.signal,
    onProgress: input.onProgress,
    validate: (parsed, { finalAttempt }) => {
      if (finalAttempt) return null;
      const r = mapRanking(parsed, n);
      return r.problems.length ? `${r.problems.slice(0, 4).join('; ')}.` : null;
    },
  });

  const r = mapRanking(out, n);
  const ranking = r.order.map((frameNo, i) => ({
    index: frames[frameNo - 1]!.index,
    rank: i + 1,
    note: r.notes.get(frameNo) ?? 'Not assessed by the model.',
  }));
  if (r.problems.length) ctx.log(`thumbnails: adjusted - ${r.problems.join('; ')}`);
  return { ranking, overlayText: r.overlay };
}

const THUMBS_JSON_SCHEMA = toJsonSchema(modelThumbRankSchema);

/**
 * Validates the model's frame numbers: unknown / repeated ones are dropped, frames it forgot are
 * appended at the end (so the result always ranks every frame exactly once).
 */
export function mapRanking(
  raw: ModelThumbRank,
  n: number,
): { order: number[]; notes: Map<number, string>; overlay: string; problems: string[] } {
  const problems: string[] = [];
  const order: number[] = [];
  const notes = new Map<number, string>();
  for (const r of raw.ranking) {
    if (!Number.isInteger(r.frame) || r.frame < 1 || r.frame > n) {
      problems.push(`unknown frame number ${r.frame} (frames are 1-${n})`);
      continue;
    }
    if (order.includes(r.frame)) {
      problems.push(`frame ${r.frame} is ranked twice`);
      continue;
    }
    order.push(r.frame);
    notes.set(r.frame, r.note.replace(/\s+/g, ' ').trim().slice(0, 200));
  }
  for (let f = 1; f <= n; f++) {
    if (!order.includes(f)) {
      problems.push(`frame ${f} is missing from the ranking`);
      order.push(f);
    }
  }
  let overlay = raw.overlayText
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '');
  if (overlay.split(' ').filter(Boolean).length > OVERLAY_MAX_WORDS) {
    problems.push(`overlayText has more than ${OVERLAY_MAX_WORDS} words`);
    overlay = ''; // never cut a phrase mid-way: no overlay is better than a broken one
  }
  return { order, notes, overlay, problems };
}
