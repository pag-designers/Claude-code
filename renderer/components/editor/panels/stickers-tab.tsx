'use client';

import * as React from 'react';
import { ArrowRight } from 'lucide-react';
import { toast } from 'sonner';
import type { ShapeKind } from '@shared/editor';
import { CTA_STICKERS, SHAPE_PRESETS } from '@/lib/editor-panels/presets';
import { cn } from '@/lib/utils';
import { addCta, addShape } from './actions';
import { BrandImagesSection } from './brand-images';
import { GroupLabel, tileBase } from './bits';

function ShapeGlyph({ kind }: { kind: ShapeKind }) {
  switch (kind) {
    case 'rect':
      return <span className="h-8 w-12 rounded-md bg-primary" />;
    case 'ellipse':
      return <span className="size-10 rounded-full bg-primary" />;
    case 'line':
      return <span className="h-1 w-14 rounded-full bg-foreground" />;
    case 'arrow':
      return <ArrowRight className="size-9 text-foreground" strokeWidth={2.5} aria-hidden />;
    case 'progress-bar':
      return (
        <span className="relative h-2.5 w-14 overflow-hidden rounded-full bg-border-strong">
          <span className="absolute inset-y-0 left-0 w-2/3 rounded-full bg-primary" />
        </span>
      );
  }
}

export function StickersTab() {
  return (
    <div className="flex flex-col gap-5" data-testid="bin-stickers">
      <section className="flex flex-col gap-2.5" aria-label="Shapes">
        <GroupLabel>Shapes</GroupLabel>
        <ul className="grid grid-cols-3 gap-2">
          {SHAPE_PRESETS.map((s) => (
            <li key={s.kind} className="min-w-0">
              <button
                type="button"
                onClick={() => {
                  addShape(s.kind);
                  toast.success(`${s.label} added at the playhead`);
                }}
                aria-label={`Add ${s.label} at the playhead`}
                title={s.hint}
                data-testid="bin-shape"
                data-kind={s.kind}
                className={cn(tileBase, 'w-full items-center')}
              >
                <span className="flex aspect-square w-full items-center justify-center rounded-md bg-muted">
                  <ShapeGlyph kind={s.kind} />
                </span>
                <span className="w-full truncate text-center text-2xs font-medium">{s.label}</span>
              </button>
            </li>
          ))}
        </ul>
        <p className="text-2xs leading-4 text-subtle">
          The progress bar sits at the bottom edge and fills over the rest of the project.
        </p>
      </section>

      <section className="flex flex-col gap-2.5" aria-label="Call-to-action stickers">
        <GroupLabel>Call to action</GroupLabel>
        <ul className="flex flex-col gap-2">
          {CTA_STICKERS.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => {
                  addCta(c.label);
                  toast.success(`“${c.label}” sticker added at the playhead`);
                }}
                aria-label={`Add the ${c.label} sticker at the playhead`}
                data-testid="bin-cta"
                data-cta={c.id}
                className={cn(tileBase, 'w-full flex-row items-center gap-3 p-2')}
              >
                <span className="flex h-11 w-28 shrink-0 items-center justify-center rounded-md bg-black">
                  <span className="rounded-full bg-primary px-3.5 py-1.5 text-xs font-extrabold text-primary-foreground">
                    {c.label}
                  </span>
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium">{c.label}</span>
                  <span className="block truncate text-2xs text-subtle">{c.hint}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        <p className="text-2xs leading-4 text-subtle">
          Each sticker is a shape and a label grouped together, so it moves and deletes as one.
        </p>
      </section>

      <BrandImagesSection />
    </div>
  );
}
