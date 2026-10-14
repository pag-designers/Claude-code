'use client';

import * as React from 'react';
import Link from 'next/link';
import { ArrowUpRight, RotateCcw, Stamp } from 'lucide-react';
import type { ClipView } from '@shared/pipeline';
import { Button, type ButtonProps } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useVideos } from '@/lib/library';
import { useBrandKit, useBrandKits, useDefaultBrandKitId } from '@/lib/brand/queries';
import { BrandKitSelect } from './kit-select';
import {
  INHERIT,
  NO_KIT,
  applyIdOfChoice,
  brandKitHref,
  clipsWord,
  normalizeChoice,
  planBulkApply,
} from './logic';
import { useBrandApply } from './use-brand-apply';

/**
 * "Apply Brand Kit…" popover for a set of clips: pick a kit (or none / each video's own setting), see how many clips
 * will really be re-rendered, confirm. With `videoId` the request goes out for every clip of that video
 * ("Apply to all clips"); otherwise for the given clips.
 */
export function ApplyBrandPopover({
  clips,
  videoId,
  label,
  variant = 'ghost',
  size = 'sm',
  className,
  testId = 'brand-apply-trigger',
  disabled,
  onApplied,
}: {
  /** The clips the action covers (the selection, or every clip of the video). */
  clips: readonly ClipView[];
  videoId?: string;
  label: string;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
  className?: string;
  testId?: string;
  disabled?: boolean;
  onApplied?: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [picked, setPicked] = React.useState<string | null>(null);
  const kitsQ = useBrandKits();
  const defaultKitId = useDefaultBrandKitId() ?? null;
  const videos = useVideos();
  const apply = useBrandApply();

  const kits = React.useMemo(() => kitsQ.data?.items ?? [], [kitsQ.data]);
  const specials = [INHERIT, NO_KIT];
  const fallback = defaultKitId ?? NO_KIT;
  const choice = normalizeChoice(picked ?? fallback, kits, fallback, specials);
  const chosenKitId = choice !== INHERIT && choice !== NO_KIT ? choice : null;
  const chosenKit = useBrandKit(open ? chosenKitId : null);
  const chosenName = kits.find((k) => k.id === chosenKitId)?.name ?? null;
  const revPending = chosenKitId !== null && chosenKit.isPending;

  const runValueOf = React.useCallback(
    (id: string) => videos.data?.items.find((v) => v.id === id)?.options.brandKitId,
    [videos.data],
  );
  const plan = React.useMemo(
    () =>
      planBulkApply({
        clips,
        choice,
        runValueOf,
        defaultKitId,
        kits,
        chosenRev: chosenKit.data?.kit.rev ?? null,
        excludeUpToDate: !videoId,
      }),
    [clips, choice, runValueOf, defaultKitId, kits, chosenKit.data, videoId],
  );

  const n = plan.render.length;
  const target =
    choice === NO_KIT
      ? 'without a Brand Kit'
      : choice === INHERIT
        ? 'with each video’s own Brand Kit'
        : `with ${chosenName ?? 'this Brand Kit'}`;

  const confirm = () => {
    if (n === 0) return;
    const kitId = applyIdOfChoice(choice);
    apply.mutate(
      {
        kitId,
        ...(videoId ? { videoId } : { clipIds: plan.render.map((c) => c.id) }),
        optimisticIds: plan.render.map((c) => c.id),
        choice,
        kitName: chosenName,
      },
      { onSuccess: () => onApplied?.() },
    );
    setOpen(false);
  };

  const notes: string[] = [];
  if (plan.upToDate.length > 0)
    notes.push(
      `${plan.upToDate.length} already ${plan.upToDate.length === 1 ? 'uses' : 'use'} this setting and ${plan.upToDate.length === 1 ? 'is' : 'are'} left alone.`,
    );
  if (plan.busy.length > 0)
    notes.push(
      `${plan.busy.length} ${plan.busy.length === 1 ? 'is' : 'are'} rendering now and ${plan.busy.length === 1 ? 'is' : 'are'} skipped.`,
    );
  if (plan.unrendered.length > 0)
    notes.push(
      `${plan.unrendered.length} ${plan.unrendered.length === 1 ? 'is' : 'are'} not rendered yet and ${plan.unrendered.length === 1 ? 'is' : 'are'} left as ${plan.unrendered.length === 1 ? 'it is' : 'they are'}.`,
    );

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setPicked(null);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          size={size}
          variant={variant}
          className={className}
          disabled={disabled || clips.length === 0}
          data-testid={testId}
        >
          <Stamp /> {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="center"
        side="top"
        className="w-[22rem] p-4"
        data-testid="brand-apply-popover"
      >
        <h3 className="font-display text-md font-semibold leading-6">
          {videoId
            ? 'Apply a Brand Kit to all clips'
            : `Apply a Brand Kit to ${clipsWord(clips.length)}`}
        </h3>
        {kitsQ.isPending ? (
          <p className="mt-2 text-sm text-muted-foreground">Loading your Brand Kits…</p>
        ) : kits.length === 0 ? (
          <div className="mt-2 flex flex-col items-start gap-3" data-testid="brand-empty">
            <p className="text-sm leading-5 text-muted-foreground">
              You have no Brand Kits yet. Create one with your logo, intro and outro, music and
              caption style, then apply it here.
            </p>
            <Button variant="outline" size="sm" asChild>
              <Link href={brandKitHref()} data-testid="brand-create-link">
                Create a Brand Kit <ArrowUpRight />
              </Link>
            </Button>
          </div>
        ) : (
          <>
            <div className="mt-3 flex flex-col gap-1.5">
              <Label htmlFor="brand-bulk-kit" className="text-xs text-muted-foreground">
                Brand Kit
              </Label>
              <BrandKitSelect
                id="brand-bulk-kit"
                testId="brand-bulk-select"
                value={choice}
                onValueChange={setPicked}
                kits={kits}
                specials={[
                  { value: NO_KIT, label: 'No brand kit (remove branding)' },
                  { value: INHERIT, label: 'Each video’s own setting' },
                ]}
              />
            </div>
            <div className="mt-3 rounded-lg bg-muted/60 px-3 py-2.5 text-sm" aria-live="polite">
              <p className="font-semibold" data-testid="brand-plan-count">
                {n === 0 ? 'Nothing to re-render' : `${clipsWord(n)} will be re-rendered ${target}`}
              </p>
              {notes.length > 0 ? (
                <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs leading-5 text-muted-foreground">
                  {notes.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
              ) : null}
              {n > 0 ? (
                <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
                  Each clip’s current file is replaced when its new render finishes.
                </p>
              ) : null}
            </div>
            <div className="mt-4 flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={n === 0 || revPending}
                loading={revPending}
                onClick={confirm}
                data-testid="brand-bulk-confirm"
              >
                <RotateCcw /> {n === 0 ? 'Re-render' : `Re-render ${clipsWord(n)}`}
              </Button>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
