/**
 * Pure helpers for applying Brand Kits to clips and runs (no React, no `@/` imports, so vitest can load it).
 * The single source of truth for "which kit does a clip render with" is `resolveBrandKitId` in shared/brand.ts; this
 * file adds what the UI needs on top: deleted-kit handling, the Applied-vs-effective comparison (stale indicator)
 * and the plan for a bulk apply (what will really be re-rendered).
 */
import { resolveBrandKitId, type BrandKitSummary } from '@shared/brand';
import type { ClipView } from '@shared/pipeline';

export type KitRef = Pick<BrandKitSummary, 'id' | 'name' | 'isDefault'>;

/** Value of the "Brand Kit" control of a single clip / a bulk apply. */
export const INHERIT = 'inherit';
export const NO_KIT = 'none';
/** Run option / start form value meaning "whatever the default kit is when the clip renders". */
export const DEFAULT_KIT = 'default';

export const BRAND_KIT_HREF = '/brand-kit/';
/** The Brand Kit page, optionally focused on one kit (the page may ignore the parameter). */
export function brandKitHref(id?: string | null): string {
  return id ? `${BRAND_KIT_HREF}?${new URLSearchParams({ id }).toString()}` : BRAND_KIT_HREF;
}

/* ------------------------------------------------------------------------------- effective kit ---- */

export type EffectiveSource =
  /** `Clip.brandKitId` is set. */
  | 'clip'
  /** The run options of the video name a kit (or 'none'). */
  | 'run'
  /** The run options say 'default' (or are unknown): the default kit decides. */
  | 'default';

export interface EffectiveKit {
  /** Kit the clip renders with; null = no kit. A kit id that no longer exists counts as no kit. */
  kitId: string | null;
  source: EffectiveSource;
  /** The textual resolution pointed at a kit that is not in the list (deleted). */
  missingId: string | null;
}

export function effectiveKit(args: {
  /** `Clip.brandKitId` (null = inherit). */
  clipValue: string | null | undefined;
  /** `PipelineOptions.brandKitId` of the clip's video; undefined while the video is not loaded. */
  runValue: string | null | undefined;
  defaultKitId: string | null;
  kits: readonly Pick<KitRef, 'id'>[];
}): EffectiveKit {
  const { clipValue, runValue, defaultKitId, kits } = args;
  const id = resolveBrandKitId(clipValue, runValue, defaultKitId);
  const source: EffectiveSource =
    clipValue !== null && clipValue !== undefined
      ? 'clip'
      : runValue !== null && runValue !== undefined && runValue !== DEFAULT_KIT
        ? 'run'
        : 'default';
  if (id !== null && !kits.some((k) => k.id === id)) return { kitId: null, source, missingId: id };
  return { kitId: id, source, missingId: null };
}

/** The value the per-clip select shows for `Clip.brandKitId`. */
export const choiceOfClip = (clipValue: string | null | undefined): string => clipValue ?? INHERIT;

/** `brand:apply.kitId` for a select value: a kit id, 'none' to remove branding, null to inherit. */
export const applyIdOfChoice = (choice: string): string | null =>
  choice === INHERIT ? null : choice;

/** A stored / chosen select value that is no longer selectable falls back instead of showing an empty select. */
export function normalizeChoice(
  value: string | null | undefined,
  kits: readonly Pick<KitRef, 'id'>[],
  fallback: string,
  specials: readonly string[],
): string {
  if (value && (specials.includes(value) || kits.some((k) => k.id === value))) return value;
  return fallback;
}

/* ------------------------------------------------------------------------------ applied status ---- */

export type BrandState =
  /** Not rendered yet: nothing to compare. */
  | 'unrendered'
  /** Rendered without a kit and none is configured. */
  | 'plain'
  /** A kit is configured but the render does not have it. */
  | 'pending'
  /** Rendered with a kit, but the clip is now configured for no kit. */
  | 'remove'
  /** Rendered with another kit than the one configured now. */
  | 'different'
  /** Same kit, edited since the render (kit rev > applied rev). */
  | 'stale'
  | 'current';

export function brandState(args: {
  status: ClipView['status'];
  applied: ClipView['brandApplied'];
  /** `effectiveKit(...).kitId`. */
  effectiveKitId: string | null;
  /** Current revision of the effective kit; null/undefined while unknown (never reported as stale then). */
  effectiveRev: number | null | undefined;
}): BrandState {
  const { status, applied, effectiveKitId, effectiveRev } = args;
  if (status === 'candidate') return 'unrendered';
  if (!applied) return effectiveKitId ? 'pending' : 'plain';
  if (!effectiveKitId) return 'remove';
  if (applied.kitId !== effectiveKitId) return 'different';
  if (typeof effectiveRev === 'number' && effectiveRev > applied.rev) return 'stale';
  return 'current';
}

/** True when a re-render would change the result (everything except plain / unrendered / current). */
export const needsRender = (s: BrandState): boolean =>
  s === 'pending' || s === 'remove' || s === 'different' || s === 'stale';

/* ----------------------------------------------------------------------------------- bulk plan ---- */

export interface BulkPlan {
  /** Will be re-rendered. */
  render: ClipView[];
  /** Already rendered with exactly this setting and the kit's current revision. */
  upToDate: ClipView[];
  /** Rendering / queued right now (skipped). */
  busy: ClipView[];
  /** Found but never rendered (nothing to re-render). */
  unrendered: ClipView[];
}

/**
 * Which of `clips` a bulk apply of `choice` ('inherit' | 'none' | kit id) re-renders. `excludeUpToDate` is false when
 * the request goes out by `videoId` (main decides there, so the UI must not promise to skip anything).
 */
export function planBulkApply(args: {
  clips: readonly ClipView[];
  choice: string;
  /** `PipelineOptions.brandKitId` per video id. */
  runValueOf: (videoId: string) => string | null | undefined;
  defaultKitId: string | null;
  kits: readonly Pick<KitRef, 'id'>[];
  /** Current revision of the chosen kit, when `choice` is a kit id and it is known. */
  chosenRev?: number | null;
  excludeUpToDate?: boolean;
}): BulkPlan {
  const { clips, choice, runValueOf, defaultKitId, kits, chosenRev, excludeUpToDate = true } = args;
  const plan: BulkPlan = { render: [], upToDate: [], busy: [], unrendered: [] };
  const overrideAfter = applyIdOfChoice(choice);
  for (const clip of clips) {
    if (clip.status === 'queued' || clip.status === 'rendering') {
      plan.busy.push(clip);
      continue;
    }
    if (clip.status === 'candidate') {
      plan.unrendered.push(clip);
      continue;
    }
    if (excludeUpToDate && clip.status === 'rendered') {
      const eff = effectiveKit({
        clipValue: overrideAfter,
        runValue: runValueOf(clip.videoId),
        defaultKitId,
        kits,
      });
      const sameOverride = (clip.brandKitId ?? null) === overrideAfter;
      const rev = eff.kitId !== null && eff.kitId === choice ? chosenRev : undefined;
      const state = brandState({
        status: clip.status,
        applied: clip.brandApplied,
        effectiveKitId: eff.kitId,
        effectiveRev: rev,
      });
      // a kit whose revision is unknown cannot be proven current: render rather than skip silently
      const provable = eff.kitId === null || typeof rev === 'number';
      if (sameOverride && provable && !needsRender(state)) {
        plan.upToDate.push(clip);
        continue;
      }
    }
    plan.render.push(clip);
  }
  return plan;
}

/* ------------------------------------------------------------------------------------- wording ---- */

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
export const clipsWord = (n: number) => plural(n, 'clip', 'clips');

/** Toast headline for a finished `brand:apply` call. */
export function appliedHeadline(args: {
  queued: number;
  choice: string;
  /** Name of the chosen kit when `choice` is a kit id. */
  kitName: string | null;
}): string {
  const { queued, choice, kitName } = args;
  const what = clipsWord(queued);
  if (choice === NO_KIT) return `Removing the Brand Kit from ${what}`;
  if (choice === INHERIT) return `Re-rendering ${what} with their video’s Brand Kit`;
  return `Re-rendering ${what} with ${kitName ?? 'the Brand Kit'}`;
}

/** Human line for the `source` of an effective kit. */
export function sourceNote(e: EffectiveKit): string {
  if (e.missingId) return 'The kit this clip points at was deleted, so it renders without one.';
  switch (e.source) {
    case 'clip':
      return e.kitId ? 'Set on this clip.' : 'This clip is set to render without a kit.';
    case 'run':
      return e.kitId
        ? 'Inherited from this video’s clipping run.'
        : 'This video’s clipping run uses no kit.';
    case 'default':
      return e.kitId ? 'Inherited: your default kit.' : 'Inherited: you have no default kit.';
  }
}
