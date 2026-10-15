import type { ClipMeta, Platform, PlatformMeta } from '@shared/cp2';
import { PLATFORMS } from '@shared/cp2';
import type { LlmServiceV2 } from '../../pipeline/contracts2';
import type { BudgetGuard } from './budget';
import type { LlmEngine } from './client';
import { abortError, LlmError } from './errors';
import { buildClipStable, buildMetaVolatile, META_SYSTEM } from './prompts2';
import { toJsonSchema } from './schemas';
import { modelMetaSchema, type ModelMeta } from './schemas2';

/**
 * writeMeta - per-platform title, description, hashtags and a posting-time suggestion (BRIEF §4.11).
 *
 * Fast (Haiku-class) model, effort 'low': mechanical copywriting from a small, fully specified
 * context; the model skips thinking on most such requests. Design choice, not a measurement.
 *
 * Honesty: the app has no audience analytics, so `postingTime.reason` ALWAYS starts with a fixed
 * disclaimer added by code, whatever the model wrote.
 */

const META_EFFORT = 'low' as const;
export const POSTING_DISCLAIMER = 'General best-practice suggestion, not based on your analytics: ';
export const HASHTAG_MIN = 3;
export const HASHTAG_MAX = 8;
const HASHTAG_MAX_LEN = 30;

const LIMITS: Record<Platform, { title: number; description: number }> = {
  tiktok: { title: 90, description: 300 },
  reels: { title: 100, description: 600 },
  shorts: { title: 100, description: 800 },
};

/**
 * Tags that do not work or are spam / engagement bait / adult. A small heuristic list, not an
 * authority: platforms change their banned tags often (extend as needed).
 */
const BANNED_TAGS = new Set([
  'fyp',
  'fy',
  'foryou',
  'foryoupage',
  'xyzbca',
  'viral',
  'followforfollow',
  'follow4follow',
  'f4f',
  'likeforlike',
  'like4like',
  'l4l',
  'sub4sub',
  'subforsub',
  'nsfw',
  'adult',
  'porn',
  'sex',
  'nude',
]);

export interface MetaContext {
  engine: LlmEngine;
  budget: BudgetGuard;
  getSettings: () => Promise<{ modelFast: string }>;
  log: (m: string) => void;
}

type MetaInput = Parameters<LlmServiceV2['writeMeta']>[0];
export type MetaResult = Omit<ClipMeta, 'generatedAt'>;

export async function runMeta(ctx: MetaContext, input: MetaInput): Promise<MetaResult> {
  ctx.engine.assertConfigured();
  if (input.signal?.aborted) throw abortError(input.signal);
  if (!input.clip.text.trim()) {
    throw new LlmError('empty-transcript', 'This clip has no speech to write metadata for.');
  }
  const settings = await ctx.getSettings();
  await ctx.budget.peek(); // throws BudgetExceededError at the hard cap

  const out = await ctx.engine.run<ModelMeta>({
    model: settings.modelFast,
    purpose: 'metadata',
    system: META_SYSTEM,
    stable: buildClipStable(input.info, input.clip),
    volatile: buildMetaVolatile(input.hook),
    schema: modelMetaSchema,
    jsonSchema: META_JSON_SCHEMA,
    effort: META_EFFORT,
    maxTokens: 12_000,
    expectedOutputChars: 2_400,
    estimatedOutputTokens: 1_200,
    signal: input.signal,
    onProgress: input.onProgress,
    validate: (parsed, { finalAttempt }) => {
      if (finalAttempt) return null;
      const r = cleanMeta(parsed, () => {}, false);
      return r.problems.length ? `${r.problems.slice(0, 5).join('; ')}.` : null;
    },
  });
  const r = cleanMeta(out, ctx.log, true);
  if (r.fatal.length) {
    throw new LlmError(
      'invalid-output',
      `Claude returned unusable metadata: ${r.fatal.join('; ')}.`,
    );
  }
  return r.meta;
}

const META_JSON_SCHEMA = toJsonSchema(modelMetaSchema);

/** Normalises one hashtag: no "#", no spaces (CamelCase), letters/digits/underscore only. */
export function normalizeHashtag(raw: string): string {
  const words = raw
    .replace(/#/g, ' ')
    .split(/[\s,;]+/)
    .map((w) => w.replace(/[^\p{L}\p{N}_]/gu, ''))
    .filter(Boolean);
  const joined = words
    .map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join('');
  return joined.slice(0, HASHTAG_MAX_LEN);
}

function cutAtWord(t: string, max: number): string {
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,;:\-–—]+$/u, '')}…`;
}

const flat = (t: string) => t.replace(/\s+/g, ' ').trim();
const stripHashtags = (t: string) =>
  t
    .replace(/(^|\s)#[\p{L}\p{N}_]+/gu, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

/**
 * `final` = last attempt: over-long text is cut instead of reported. Returns the cleaned metadata,
 * `problems` (for the repair retry) and `fatal` (what makes the result unusable even then).
 */
export function cleanMeta(
  raw: ModelMeta,
  log: (m: string) => void,
  final: boolean,
): { meta: MetaResult; problems: string[]; fatal: string[] } {
  const problems: string[] = [];
  const fatal: string[] = [];
  const meta = {} as MetaResult;
  for (const p of PLATFORMS) {
    const r = raw[p];
    const lim = LIMITS[p];
    let title = flat(r.title).replace(/^["“”]+|["“”]+$/g, '');
    if (p === 'shorts') title = flat(title.replace(/#shorts\b/gi, ''));
    if (!title) fatal.push(`${p} title is empty`);
    if (title.length > lim.title) {
      problems.push(`${p} title has ${title.length} characters (max ${lim.title})`);
      title = cutAtWord(title, lim.title);
    }
    let description = stripHashtags(r.description.replace(/\r/g, '').trim());
    if (description.length > lim.description) {
      problems.push(
        `${p} description has ${description.length} characters (max ${lim.description})`,
      );
      description = cutAtWord(description, lim.description);
    }

    const seen = new Set<string>();
    const tags: string[] = [];
    const dropped: string[] = [];
    for (const h of r.hashtags) {
      const n = normalizeHashtag(h);
      const key = n.toLowerCase();
      if (!n || seen.has(key)) continue;
      if (BANNED_TAGS.has(key)) {
        dropped.push(n);
        continue;
      }
      seen.add(key);
      tags.push(n);
    }
    if (dropped.length)
      problems.push(
        `${p}: do not use the reach/engagement-bait tags ${dropped.map((d) => `#${d}`).join(', ')}`,
      );
    if (p === 'shorts' && !seen.has('shorts')) tags.unshift('Shorts');
    const finalTags = tags.slice(0, HASHTAG_MAX);
    if (finalTags.length < HASHTAG_MIN) {
      problems.push(`${p} needs at least ${HASHTAG_MIN} valid hashtags`);
      fatal.push(`${p} has fewer than ${HASHTAG_MIN} usable hashtags`);
    }

    const t = r.postingTime;
    let reason = flat(t.reason);
    if (/\byour (audience|followers|analytics|insights|data|account)\b/i.test(reason))
      problems.push(
        `${p} posting-time reason claims to know the creator's audience; it is a general suggestion`,
      );
    reason = reason.replace(/^general best[- ]practice( suggestion)?[:,.\s-]*/i, '');
    reason = `${POSTING_DISCLAIMER}${cutAtWord(reason || 'evenings and weekends tend to see more short-form viewing.', 220)}`;
    const hour = Number.isFinite(t.hour) ? Math.min(23, Math.max(0, Math.round(t.hour))) : 18;
    const day =
      t.dayOfWeek !== null && Number.isFinite(t.dayOfWeek) && t.dayOfWeek >= 0 && t.dayOfWeek <= 6
        ? Math.round(t.dayOfWeek)
        : null;
    if (t.hour < 0 || t.hour > 23) problems.push(`${p} posting hour must be 0-23`);

    const out: PlatformMeta = {
      title,
      description,
      hashtags: finalTags,
      postingTime: { dayOfWeek: day, hour, reason },
    };
    meta[p] = out;
  }
  if (final) for (const pr of problems) log(`metadata: adjusted - ${pr}`);
  return { meta, problems, fatal };
}
