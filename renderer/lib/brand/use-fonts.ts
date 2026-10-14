'use client';

import * as React from 'react';
import { EDITOR_FONTS, ensureEditorFonts } from '@/lib/editor/compositor/fonts';
import { useBrandFonts, type BrandFontRef } from './fonts';

export interface FontChoice {
  family: string;
  weights: number[];
  source: 'brand' | 'shipped';
  /** Shipped category (sans, display, …) or 'brand'. */
  category: string;
}

/**
 * Fonts a Brand Kit style can use: the families Clipfern ships (editor canvas + libass) and every uploaded brand font
 * (registered with `document.fonts` by `useBrandFonts`). `ready` flips once both sets are loaded in the browser.
 */
export function useFontChoices(): {
  choices: FontChoice[];
  brandFonts: BrandFontRef[];
  ready: boolean;
} {
  const { fonts, ready: brandReady } = useBrandFonts();
  const [shippedReady, setShippedReady] = React.useState(false);
  React.useEffect(() => {
    let alive = true;
    void ensureEditorFonts().then(() => alive && setShippedReady(true));
    return () => {
      alive = false;
    };
  }, []);
  const choices = React.useMemo(() => {
    const out: FontChoice[] = [];
    const brand = new Map<string, Set<number>>();
    for (const f of fonts) {
      if (!brand.has(f.family)) brand.set(f.family, new Set());
      brand.get(f.family)!.add(f.weight);
    }
    for (const [family, w] of [...brand].sort((a, b) => a[0].localeCompare(b[0])))
      out.push({ family, weights: [...w].sort((a, b) => a - b), source: 'brand', category: 'brand' });
    for (const f of EDITOR_FONTS)
      if (!brand.has(f.family))
        out.push({ family: f.family, weights: f.weights, source: 'shipped', category: f.category });
    return out;
  }, [fonts]);
  return { choices, brandFonts: fonts, ready: brandReady && shippedReady };
}
