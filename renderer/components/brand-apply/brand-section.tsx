'use client';

import * as React from 'react';
import Link from 'next/link';
import { ArrowUpRight, Palette, RotateCcw, Stamp } from 'lucide-react';
import type { ClipView } from '@shared/pipeline';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { SectionLabel } from '@/components/library/drawer-fields';
import { cn } from '@/lib/utils';
import { BrandKitSelect, KitSwatches } from './kit-select';
import {
  INHERIT,
  NO_KIT,
  applyIdOfChoice,
  brandKitHref,
  choiceOfClip,
  effectiveKit,
  needsRender,
  normalizeChoice,
  sourceNote,
  type BrandState,
} from './logic';
import { useBrandApply, useClipBrand, type ClipBrand } from './use-brand-apply';

export const BRAND_SECTION_ID = 'clip-brand-section';

const STATE_BADGE: Record<
  BrandState,
  { variant: 'success' | 'warning' | 'neutral'; label: (b: ClipBrand) => string }
> = {
  current: { variant: 'success', label: () => 'Up to date' },
  stale: {
    variant: 'warning',
    label: (b) => `Kit changed (now rev ${b.effectiveRev ?? '?'})`,
  },
  different: { variant: 'warning', label: () => 'Different kit now' },
  remove: { variant: 'warning', label: () => 'Kit removed' },
  pending: { variant: 'warning', label: () => 'Not applied yet' },
  plain: { variant: 'neutral', label: () => 'No kit' },
  unrendered: { variant: 'neutral', label: () => 'Not rendered yet' },
};

/** Why the state is not "up to date", in a sentence. */
function stateExplanation(clip: ClipView, b: ClipBrand): string | null {
  const applied = clip.brandApplied;
  const was = b.appliedName ?? 'a Brand Kit that was deleted';
  switch (b.state) {
    case 'stale':
      return `${b.effectiveName ?? 'The kit'} was edited after this clip was rendered (rev ${applied?.rev ?? '?'} to rev ${b.effectiveRev ?? '?'}). Re-render to bring the changes in.`;
    case 'different':
      return `Rendered with ${was}; this clip now uses ${b.effectiveName ?? 'another kit'}.`;
    case 'remove':
      return `Rendered with ${was}; this clip now uses no kit. Re-render to remove the branding.`;
    case 'pending':
      return `${b.effectiveName ?? 'A kit'} is set for this clip, but the current render does not include it.`;
    default:
      return null;
  }
}

function EmptyKits() {
  return (
    <div
      className="flex flex-col items-start gap-3 rounded-xl border border-dashed border-border-strong bg-muted/30 p-4"
      data-testid="brand-empty"
    >
      <span className="flex size-9 items-center justify-center rounded-lg bg-primary-soft text-primary-text">
        <Palette className="size-[18px]" aria-hidden />
      </span>
      <div>
        <p className="text-sm font-semibold">No Brand Kits yet</p>
        <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
          A Brand Kit adds your logo, intro and outro, music and caption style to every clip. Create
          one, then apply it here.
        </p>
      </div>
      <Button variant="outline" size="sm" asChild>
        <Link href={brandKitHref()} data-testid="brand-create-link">
          Create a Brand Kit <ArrowUpRight />
        </Link>
      </Button>
    </div>
  );
}

/**
 * Drawer section: which Brand Kit this clip uses, what its current render was branded with (and whether the kit changed
 * since), and the "Apply and re-render" action through `brand:apply`.
 */
export function ClipBrandSection({ clip }: { clip: ClipView }) {
  const b = useClipBrand(clip);
  const apply = useBrandApply();
  const [pick, setPick] = React.useState<string | null>(null);

  const busy = clip.status === 'queued' || clip.status === 'rendering';
  const current = choiceOfClip(clip.brandKitId);
  const specials = [INHERIT, NO_KIT];
  const shown = normalizeChoice(pick ?? current, b.kits, INHERIT, specials);
  const changed = pick !== null && pick !== current;

  const inherited = effectiveKit({
    clipValue: null,
    runValue: b.runValue,
    defaultKitId: b.defaultKitId,
    kits: b.kits,
  });
  const inheritedName = inherited.kitId
    ? (b.kits.find((k) => k.id === inherited.kitId)?.name ?? 'a kit')
    : 'no brand kit';

  const rendered = clip.status !== 'candidate';
  const canRun = rendered && !busy && (changed || needsRender(b.state));
  const label = changed
    ? shown === NO_KIT
      ? 'Remove and re-render'
      : 'Apply and re-render'
    : b.state === 'stale'
      ? 'Re-render with the latest kit'
      : 'Apply and re-render';
  const hint = !rendered
    ? 'Available once this clip has been rendered.'
    : b.state === 'current'
      ? 'Nothing to change: this clip already uses the latest kit.'
      : b.state === 'plain'
        ? 'Pick a kit to brand this clip.'
        : 'Pick another kit to change it.';

  const run = () => {
    // unchanged picks re-render with the clip's own setting; an override pointing at a deleted kit stays "no kit"
    const id = changed
      ? applyIdOfChoice(shown)
      : clip.brandKitId !== null && b.effective.missingId === clip.brandKitId
        ? NO_KIT
        : clip.brandKitId;
    apply.mutate(
      {
        kitId: id,
        clipIds: [clip.id],
        optimisticIds: [clip.id],
        choice: id === null ? INHERIT : id,
        kitName: b.kits.find((k) => k.id === id)?.name ?? b.effectiveName,
      },
      { onSuccess: () => setPick(null) },
    );
  };

  const explanation = stateExplanation(clip, b);
  const badge = STATE_BADGE[b.state];
  const applied = clip.brandApplied;

  return (
    <section
      id={BRAND_SECTION_ID}
      className="flex scroll-mt-16 flex-col gap-3"
      aria-label="Brand Kit"
      data-testid="brand-section"
      data-brand-state={b.state}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionLabel>Brand Kit</SectionLabel>
        <Link
          href={brandKitHref(b.effective.kitId)}
          data-testid="brand-edit-link"
          className="inline-flex items-center gap-1 rounded-xs text-xs font-medium text-primary-text underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          Edit Brand Kit <ArrowUpRight className="size-3.5" aria-hidden />
        </Link>
      </div>

      {b.loading ? (
        <Skeleton className="h-40 w-full" aria-label="Loading Brand Kits" />
      ) : b.kits.length === 0 && !applied ? (
        <EmptyKits />
      ) : (
        <div className="flex flex-col gap-3.5 rounded-xl border bg-card p-3.5">
          <dl className="grid grid-cols-[7.5rem_minmax(0,1fr)] items-start gap-x-4 gap-y-2.5 text-sm">
            <dt className="pt-0.5 text-xs text-muted-foreground">Used by this clip</dt>
            <dd className="min-w-0" data-testid="brand-effective">
              <span className="flex items-center gap-2 font-medium">
                {b.effective.kitId ? (
                  <>
                    <KitSwatches
                      swatches={b.kits.find((k) => k.id === b.effective.kitId)?.swatches ?? []}
                    />
                    <span className="truncate">{b.effectiveName}</span>
                  </>
                ) : (
                  <span className="text-muted-foreground">No brand kit</span>
                )}
              </span>
              <span className="mt-0.5 block text-xs leading-4 text-subtle">
                {sourceNote(b.effective)}
              </span>
            </dd>
            <dt className="pt-0.5 text-xs text-muted-foreground">Current render</dt>
            <dd className="flex min-w-0 flex-wrap items-center gap-2" data-testid="brand-applied">
              <span className="font-medium">
                {applied
                  ? `Applied: ${b.appliedName ?? 'a deleted kit'} (rev ${applied.rev})`
                  : 'Applied: none'}
              </span>
              <Badge variant={badge.variant} data-testid="brand-state-badge">
                {badge.label(b)}
              </Badge>
            </dd>
          </dl>

          {explanation ? (
            <p
              className="rounded-lg border border-warning/35 bg-warning-soft px-3 py-2 text-xs leading-5 text-foreground"
              role="status"
              data-testid="brand-explanation"
            >
              {explanation}
            </p>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`brand-pick-${clip.id}`} className="text-xs text-muted-foreground">
              Brand Kit for this clip
            </Label>
            <BrandKitSelect
              id={`brand-pick-${clip.id}`}
              testId="brand-select"
              value={shown}
              onValueChange={(v) => setPick(v === current ? null : v)}
              kits={b.kits}
              disabled={busy || apply.isPending}
              specials={[
                { value: INHERIT, label: `Inherit (${inheritedName})` },
                { value: NO_KIT, label: 'No brand kit' },
              ]}
            />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="primary"
              loading={apply.isPending}
              disabled={!canRun}
              onClick={run}
              data-testid="brand-apply"
            >
              <RotateCcw /> {label}
            </Button>
            {changed ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={apply.isPending}
                onClick={() => setPick(null)}
              >
                Cancel
              </Button>
            ) : null}
            {busy ? (
              <span
                className="flex min-w-0 flex-1 items-center gap-2.5 text-xs text-primary-text"
                role="status"
                data-testid="brand-progress"
              >
                <Progress
                  value={clip.renderProgress === null ? null : clip.renderProgress * 100}
                  className="h-1.5 max-w-32"
                  aria-label="Brand Kit render progress"
                />
                <span className="tabular-nums">
                  {clip.status === 'queued'
                    ? 'Queued'
                    : `Re-rendering ${Math.round((clip.renderProgress ?? 0) * 100)}%`}
                </span>
              </span>
            ) : !canRun && !changed ? (
              <span className={cn('flex items-center gap-1.5 text-xs text-subtle')}>
                <Stamp className="size-3.5" aria-hidden /> {hint}
              </span>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}
