'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FilePlus2 } from 'lucide-react';
import { ASPECT_SIZES, type EditorProjectDoc } from '@shared/editor';
import { BrandKitSelect } from '@/components/brand-apply/kit-select';
import { BRAND_KIT_HREF, NO_KIT, normalizeChoice } from '@/components/brand-apply/logic';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useBrandKits, useDefaultBrandKitId } from '@/lib/brand/queries';
import { editorHref } from '@/lib/hrefs';
import { useCreateProject } from '@/lib/editor-panels/projects';
import { cn } from '@/lib/utils';

type Aspect = '9:16' | '1:1' | '16:9' | '4:5';

const ASPECTS: { id: Aspect; label: string; hint: string }[] = [
  { id: '9:16', label: 'Vertical', hint: 'TikTok, Reels, Shorts' },
  { id: '1:1', label: 'Square', hint: 'Feed posts' },
  { id: '16:9', label: 'Landscape', hint: 'YouTube' },
  { id: '4:5', label: 'Portrait', hint: 'Instagram feed' },
];

/** Blank project: pick the canvas shape, optionally name it, choose a Brand Kit, then jump into the editor. */
export function NewProjectDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Called with the created project and the chosen Brand Kit (`brandKitId` null = "No brand kit") BEFORE navigating
   * to the editor; awaited, so the caller can apply the kit to the project first. The dialog itself only creates the
   * blank project (`editor:create` has no kit parameter).
   */
  onCreated?: (doc: EditorProjectDoc, brand: { brandKitId: string | null }) => void | Promise<void>;
}) {
  const router = useRouter();
  const create = useCreateProject();
  const [aspect, setAspect] = React.useState<Aspect>('9:16');
  const [name, setName] = React.useState('');
  const nameId = React.useId();
  const brandId = React.useId();
  const kitsQ = useBrandKits();
  const defaultKitId = useDefaultBrandKitId() ?? null;
  const kits = kitsQ.data?.items ?? [];
  // null = untouched: follows the default kit, which may still be loading when the dialog opens
  const [kitPick, setKitPick] = React.useState<string | null>(null);
  const kitChoice = normalizeChoice(kitPick ?? defaultKitId ?? NO_KIT, kits, NO_KIT, [NO_KIT]);
  const brandKitId = kitChoice === NO_KIT ? null : kitChoice;

  const submit = () => {
    const trimmed = name.trim();
    create.mutate(
      { from: { blank: true, aspect }, brandKitId, ...(trimmed ? { name: trimmed } : {}) },
      {
        onSuccess: async (doc) => {
          try {
            await onCreated?.(doc, { brandKitId });
          } finally {
            onOpenChange(false);
            setName('');
            setKitPick(null);
            router.push(editorHref(doc.id));
          }
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !create.isPending && onOpenChange(o)}>
      <DialogContent className="max-w-md" data-testid="new-project-dialog">
        <DialogHeader>
          <DialogTitle className="font-display text-lg font-semibold">
            New blank project
          </DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            Start from an empty timeline and import or drag in your own media. You can change the
            canvas later.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <Label id="new-project-aspect">Canvas</Label>
            <div
              role="radiogroup"
              aria-labelledby="new-project-aspect"
              className="grid grid-cols-4 gap-2"
            >
              {ASPECTS.map((a) => {
                const size = ASPECT_SIZES[a.id];
                const active = aspect === a.id;
                const h = 34;
                const w = Math.round((h * size.width) / size.height);
                return (
                  <button
                    key={a.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setAspect(a.id)}
                    data-testid="new-project-aspect"
                    data-aspect={a.id}
                    className={cn(
                      'flex flex-col items-center gap-2 rounded-lg border px-2 py-3 text-center outline-none transition-[border-color,background-color] duration-(--duration-fast) focus-visible:ring-2 focus-visible:ring-ring',
                      active
                        ? 'border-primary bg-primary-soft text-primary-text'
                        : 'text-muted-foreground hover:border-border-strong hover:bg-accent/40 hover:text-foreground',
                    )}
                  >
                    <span className="flex h-10 items-center">
                      <span
                        aria-hidden
                        className="rounded-[4px] border-2 border-current"
                        style={{ width: Math.max(w, 18), height: h }}
                      />
                    </span>
                    <span className="text-xs font-semibold tabular-nums">{a.id}</span>
                    <span className="text-2xs leading-3 opacity-80">{a.hint}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <div
            className="flex flex-col gap-2"
            data-testid="new-project-brand"
            data-brand-kit-id={brandKitId ?? 'none'}
          >
            <Label htmlFor={brandId}>Brand Kit</Label>
            {kits.length === 0 ? (
              <p className="text-sm text-muted-foreground" id={brandId}>
                {kitsQ.isPending ? (
                  'Loading your Brand Kits…'
                ) : (
                  <>
                    No Brand Kits yet.{' '}
                    <Link
                      href={BRAND_KIT_HREF}
                      className="font-medium text-primary-text underline-offset-4 hover:underline"
                      data-testid="new-project-brand-create"
                    >
                      Create a Brand Kit
                    </Link>
                  </>
                )}
              </p>
            ) : (
              <BrandKitSelect
                id={brandId}
                testId="new-project-brand-select"
                value={kitChoice}
                onValueChange={setKitPick}
                kits={kits}
                specials={[{ value: NO_KIT, label: 'No brand kit' }]}
              />
            )}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={nameId}>
              Name <span className="font-normal text-subtle">(optional)</span>
            </Label>
            <Input
              id={nameId}
              value={name}
              maxLength={120}
              placeholder="Untitled project"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !create.isPending && submit()}
              data-testid="new-project-name"
            />
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={create.isPending}
            onClick={submit}
            data-testid="new-project-create"
          >
            <FilePlus2 /> Create project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
