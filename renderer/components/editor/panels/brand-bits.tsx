'use client';

import * as React from 'react';
import Link from 'next/link';
import { ExternalLink, Palette } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import type { BrandPanelKit } from '@/lib/editor-panels/brand-hooks';
import { cn } from '@/lib/utils';
import { GroupLabel, Note } from './bits';

/** Kit picker for the dock sections: a select when there are several kits, the kit's name when there is one. */
export function BrandKitSelect({ panel }: { panel: BrandPanelKit }) {
  if (!panel.kit) return null;
  if (panel.kits.length < 2)
    return (
      <span
        className="max-w-[9rem] truncate rounded-full bg-muted px-2 py-0.5 text-2xs font-medium text-muted-foreground"
        data-testid="brand-kit-name"
        title={panel.kit.name}
      >
        {panel.kit.name}
      </span>
    );
  return (
    <Select value={panel.kitId ?? undefined} onValueChange={panel.setKitId}>
      <SelectTrigger
        aria-label="Brand Kit"
        data-testid="brand-kit-select"
        className="h-6 w-auto max-w-[10rem] gap-1 px-2 text-2xs"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end" onEscapeKeyDown={(e) => e.stopPropagation()}>
        {panel.kits.map((k) => (
          <SelectItem key={k.id} value={k.id} className="min-h-7 text-xs">
            {k.name}
            {k.isDefault ? ' · default' : ''}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function ManageLink({ className }: { className?: string }) {
  return (
    <Link
      href="/brand-kit/"
      data-testid="brand-manage-link"
      className={cn(
        'inline-flex items-center gap-1 text-2xs font-medium text-primary-text underline-offset-2 hover:underline',
        className,
      )}
    >
      Manage in Brand Kit <ExternalLink className="size-3" aria-hidden />
    </Link>
  );
}

/**
 * A dock section fed by the Brand Kit: heading + kit picker, then loading / no kit / nothing of this kind / content.
 * `isEmpty` is decided by the caller from the kit's assets; `children` only renders with a kit and something to show.
 */
export function BrandSection({
  title,
  testId,
  panel,
  isEmpty,
  emptyTitle,
  emptyHint,
  children,
}: {
  title: string;
  testId: string;
  panel: BrandPanelKit;
  isEmpty: boolean;
  emptyTitle: string;
  emptyHint: string;
  children: React.ReactNode;
}) {
  let body: React.ReactNode;
  if (panel.loading)
    body = (
      <div className="grid grid-cols-2 gap-2" aria-busy>
        <Skeleton className="h-24 rounded-lg" />
        <Skeleton className="h-24 rounded-lg" />
      </div>
    );
  else if (panel.error)
    body = (
      <p role="alert" className="text-xs text-danger">
        Could not load the Brand Kit: {panel.error}
      </p>
    );
  else if (!panel.kit)
    body = (
      <Note icon={Palette} title="No Brand Kit yet">
        Create a kit to keep your logos, fonts, colors and music here.
        <span className="mt-1.5 block">
          <ManageLink />
        </span>
      </Note>
    );
  else if (isEmpty)
    body = (
      <Note icon={Palette} title={emptyTitle}>
        {emptyHint}
        <span className="mt-1.5 block">
          <ManageLink />
        </span>
      </Note>
    );
  else body = children;
  return (
    <section
      className="flex flex-col gap-2.5"
      aria-label={title}
      data-testid={testId}
      data-state={panel.loading ? 'loading' : !panel.kit ? 'no-kit' : isEmpty ? 'empty' : 'ready'}
    >
      <GroupLabel action={<BrandKitSelect panel={panel} />}>{title}</GroupLabel>
      {body}
    </section>
  );
}
