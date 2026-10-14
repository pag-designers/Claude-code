'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { TEXT_STYLE_KINDS, type BrandTextStyle } from '@shared/brand';
import { brandStyleSample } from '@/lib/editor-panels/brand';
import { textStyleCss } from '@/lib/editor-panels/brand-css';
import { useBrandPanelKit } from '@/lib/editor-panels/brand-hooks';
import { useBrandFonts } from '@/lib/brand/fonts';
import { cn } from '@/lib/utils';
import { addBrandText } from './brand-actions';
import { BrandSection } from './brand-bits';
import { tileBase } from './bits';

const KIND_LABEL: Record<BrandTextStyle['kind'], string> = {
  title: 'Title',
  hook: 'Hook',
  cta: 'Call to action',
  'lower-third': 'Lower third',
};

/** Text tab: the kit's title / hook / CTA / lower-third styles; click creates a text layer in that look. */
export function BrandTextSection() {
  const panel = useBrandPanelKit();
  useBrandFonts(); // registers uploaded fonts so the previews use them
  const styles = panel.kit?.spec.textStyles ?? [];
  const kind = (k: BrandTextStyle['kind']) => styles.filter((s) => s.kind === k);
  return (
    <BrandSection
      title="Brand Kit text styles"
      testId="bin-brandkit-text"
      panel={panel}
      isEmpty={styles.length === 0}
      emptyTitle="No text styles in this kit"
      emptyHint="Add title, hook, call-to-action or lower-third styles in the kit and they show up here."
    >
      <div className="flex flex-col gap-3">
        {TEXT_STYLE_KINDS.filter((k) => kind(k).length > 0).map((k) => (
          <div key={k} className="flex flex-col gap-1.5">
            <h4 className="text-2xs font-medium text-subtle">{KIND_LABEL[k]}</h4>
            <ul className="grid grid-cols-2 gap-2" aria-label={`${KIND_LABEL[k]} styles`}>
              {kind(k).map((ts) => (
                <li key={ts.id} className="min-w-0">
                  <button
                    type="button"
                    onClick={() => {
                      if (!panel.kit) return;
                      addBrandText(panel.kit, ts);
                      toast.success(`${ts.name} added at the playhead`);
                    }}
                    aria-label={`Add ${ts.name} text at the playhead`}
                    data-testid="bin-brand-text"
                    data-style-id={ts.id}
                    data-kind={ts.kind}
                    className={cn(tileBase, 'ed-play w-full')}
                  >
                    <span className="flex aspect-[16/10] w-full items-center justify-center overflow-hidden rounded-md bg-black px-2">
                      <span style={textStyleCss(ts.style)} className="max-w-full">
                        {brandStyleSample(ts.kind)}
                      </span>
                    </span>
                    <span className="block truncate px-0.5 text-xs font-medium">{ts.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <p className="text-2xs leading-4 text-subtle">
          Hook styles are found again by “Apply Brand Kit”, so changing kit restyles them.
        </p>
      </div>
    </BrandSection>
  );
}
