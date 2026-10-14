'use client';

import * as React from 'react';
import Link from 'next/link';
import { Check, CircleAlert, Palette } from 'lucide-react';
import { toast } from 'sonner';
import { projectDuration } from '@shared/editor-eval';
import { brandPartsFromDefaults } from '@shared/brand-apply';
import type { BrandPart } from '@shared/brand';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { DisabledTip } from '@/components/ui/tooltip';
import { useBrandKit, useBrandKits, useDefaultBrandKitId } from '@/lib/brand/queries';
import { newId, useEditorStore } from '@/lib/editor/core';
import {
  PART_LABEL,
  PART_ORDER,
  partAvailability,
  previewBrandApply,
} from '@/lib/editor-panels/brand';
import { applyBrandToProject } from '@shared/brand-apply';
import { cn } from '@/lib/utils';
import { formatClock } from '@/lib/format';

const previewId = (prefix: string) => `${prefix}_preview`;

/**
 * "Apply Brand Kit" for the open project: pick a kit (the project's, else the default one is preselected), tick the
 * parts to take over, read what each would do, apply. The whole thing is ONE undoable edit built by the pure
 * `applyBrandToProject`; re-applying a kit changes nothing, applying another kit replaces what the first one added.
 */
function ApplyBrandContent({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const project = useEditorStore((s) => s.project);
  const kits = useBrandKits();
  const defaultId = useDefaultBrandKitId();
  const items = kits.data?.items;

  // The kit the dialog works on. null = not chosen yet (follows project / default), so it settles once data arrives.
  const [picked, setPicked] = React.useState<string | null>(null);
  const [parts, setParts] = React.useState<BrandPart[] | null>(null);

  const exists = (id: string | null | undefined): id is string =>
    !!id && !!items && items.some((k) => k.id === id);
  const kitId =
    [picked, project.brandKitId, defaultId].find(exists) ?? (items?.[0] ? items[0].id : null);
  const kitQ = useBrandKit(kitId);
  const prevId = project.brandKitId && project.brandKitId !== kitId ? project.brandKitId : null;
  const prevQ = useBrandKit(prevId);
  const kit = kitQ.data?.kit ?? null;
  const assets = React.useMemo(() => kitQ.data?.assets ?? [], [kitQ.data]);

  // Default ticks come from the kit's switches; a different kit resets them.
  const defaults = React.useMemo(() => (kit ? brandPartsFromDefaults(kit.spec) : []), [kit]);
  const chosen = parts ?? defaults;
  const avail = kit ? partAvailability(kit) : null;
  const ticked = React.useMemo(() => chosen.filter((p) => !(avail && avail[p])), [chosen, avail]);

  const preview = React.useMemo(() => {
    if (!kit) return null;
    return previewBrandApply({
      project,
      kit,
      assets,
      parts: ticked,
      previousKit: prevQ.data?.kit ?? null,
      newId: previewId,
    });
  }, [kit, assets, ticked, project, prevQ.data]);

  const changes = preview ? preview.result.project !== project : false;
  const before = projectDuration(project);
  const after = preview ? projectDuration(preview.result.project) : before;

  const toggle = (p: BrandPart, on: boolean) =>
    setParts((cur) => {
      const base = cur ?? defaults;
      return on ? [...base.filter((x) => x !== p), p] : base.filter((x) => x !== p);
    });

  const apply = () => {
    if (!kit) return;
    const st = useEditorStore.getState();
    const r = applyBrandToProject({
      project: st.project,
      kit,
      assets,
      parts: ticked,
      newId,
      previousKit: prevQ.data?.kit ?? null,
    });
    onOpenChange(false);
    if (r.project === st.project) {
      toast.info('Nothing to change', {
        description: r.skipped.length
          ? `${r.skipped.length} part${r.skipped.length === 1 ? ' was' : 's were'} skipped.`
          : `${kit.name} is already applied.`,
      });
      return;
    }
    st.replaceProject(`Apply Brand Kit “${kit.name}”`, r.project);
    const names = r.applied.map((p) => PART_LABEL[p].label.toLowerCase()).join(', ');
    toast.success(`Applied ${kit.name}`, {
      description:
        `${names.charAt(0).toUpperCase()}${names.slice(1)}.` +
        (r.skipped.length
          ? ` Skipped: ${r.skipped.map((s) => PART_LABEL[s.part].label.toLowerCase()).join(', ')}.`
          : ''),
      action: { label: 'Undo', onClick: () => useEditorStore.getState().undo() },
    });
  };

  let body: React.ReactNode;
  if (kits.isPending || (kitId && kitQ.isPending))
    body = (
      <div className="flex flex-col gap-3" aria-busy>
        <Skeleton className="h-8 w-full rounded-md" />
        <Skeleton className="h-40 w-full rounded-lg" />
      </div>
    );
  else if (!items || items.length === 0)
    body = (
      <div
        className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-8 text-center"
        data-testid="apply-brand-empty"
      >
        <Palette className="size-6 text-muted-foreground" aria-hidden />
        <p className="text-sm font-semibold">No Brand Kit yet</p>
        <p className="max-w-xs text-xs text-muted-foreground">
          Create a kit with your logo, intro, fonts and music, then apply it to any project here.
        </p>
        <Button variant="secondary" size="sm" asChild>
          <Link href="/brand-kit/">Open Brand Kit</Link>
        </Button>
      </div>
    );
  else if (!kit)
    body = (
      <p role="alert" className="text-sm text-danger">
        Could not load that kit{kitQ.error ? `: ${kitQ.error.message}` : '.'}
      </p>
    );
  else
    body = (
      <div className="flex flex-col gap-5">
        <div className="flex items-center gap-3">
          <label
            htmlFor="apply-brand-kit"
            className="shrink-0 text-xs font-medium text-muted-foreground"
          >
            Brand Kit
          </label>
          <Select
            value={kitId ?? undefined}
            onValueChange={(v) => {
              setPicked(v);
              setParts(null);
            }}
          >
            <SelectTrigger id="apply-brand-kit" data-testid="apply-brand-kit" className="h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent onEscapeKeyDown={(e) => e.stopPropagation()}>
              {items.map((k) => (
                <SelectItem key={k.id} value={k.id}>
                  {k.name}
                  {k.isDefault ? ' · default' : ''}
                  {project.brandKitId === k.id ? ' · applied' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <ul className="flex flex-col gap-1" aria-label="Parts to apply">
          {PART_ORDER.map((p) => {
            const reason = avail?.[p] ?? null;
            const on = ticked.includes(p);
            const line = preview?.lines.find((l) => l.part === p);
            const row = (
              <div
                className={cn(
                  'flex w-full items-start gap-3 rounded-lg border px-3 py-2 transition-colors duration-(--duration-fast)',
                  on ? 'border-border-strong bg-card' : 'bg-transparent',
                  reason && 'opacity-60',
                )}
                data-testid={`apply-part-${p}`}
                data-state={reason ? 'unavailable' : on ? (line?.status ?? 'on') : 'off'}
              >
                <Checkbox
                  checked={on}
                  disabled={!!reason}
                  aria-label={PART_LABEL[p].label}
                  data-testid={`apply-check-${p}`}
                  onCheckedChange={(v) => toggle(p, v)}
                  className="mt-0.5"
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium leading-5">{PART_LABEL[p].label}</p>
                  {reason ? (
                    <p className="text-xs leading-4 text-subtle">{reason}</p>
                  ) : on && line ? (
                    <p
                      className={cn(
                        'flex items-start gap-1.5 text-xs leading-4',
                        line.status === 'applied' ? 'text-muted-foreground' : 'text-warning',
                      )}
                      data-testid={`apply-line-${p}`}
                    >
                      {line.status === 'applied' ? (
                        <Check className="mt-px size-3 shrink-0 text-success" aria-hidden />
                      ) : (
                        <CircleAlert className="mt-px size-3 shrink-0" aria-hidden />
                      )}
                      <span>{line.text}</span>
                    </p>
                  ) : (
                    <p className="text-xs leading-4 text-subtle">{PART_LABEL[p].hint}</p>
                  )}
                </div>
              </div>
            );
            return (
              <li key={p}>
                {reason ? (
                  <DisabledTip
                    reason={`${reason} Add one in the Brand Kit.`}
                    className="flex w-full"
                    side="left"
                  >
                    {row}
                  </DisabledTip>
                ) : (
                  row
                )}
              </li>
            );
          })}
        </ul>

        {project.brandKitId && project.brandKitId !== kitId ? (
          <p className="text-xs leading-4 text-subtle">
            This project was branded with another kit. Applying replaces its intro, outro, watermark
            and music; text and captions are restyled.
          </p>
        ) : null}
      </div>
    );

  const nothing = !kit || ticked.length === 0 || !preview || preview.result.applied.length === 0;
  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2 font-display text-xl font-semibold">
          <Palette className="size-5 text-primary-text" aria-hidden /> Apply Brand Kit
        </DialogTitle>
        <DialogDescription className="text-sm text-muted-foreground">
          Take over a kit&apos;s watermark, intro and outro, caption style, hook look and music. One
          undo step reverts it all.
        </DialogDescription>
      </DialogHeader>
      <DialogBody>{body}</DialogBody>
      <DialogFooter className="justify-between">
        <p className="text-xs tabular-nums text-subtle" data-testid="apply-brand-length">
          {kit && changes && after !== before
            ? `Length ${formatClock(before)} → ${formatClock(after)}`
            : kit && !changes && ticked.length > 0 && preview?.result.applied.length
              ? 'Already applied'
              : ''}
        </p>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={nothing} onClick={apply} data-testid="apply-brand-go">
            <Palette /> Apply
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}

/** The top bar's "Brand Kit" dialog. Its content mounts on open, so every open starts from the defaults. */
export function ApplyBrandDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="apply-brand-dialog">
        {open ? <ApplyBrandContent onOpenChange={onOpenChange} /> : null}
      </DialogContent>
    </Dialog>
  );
}
