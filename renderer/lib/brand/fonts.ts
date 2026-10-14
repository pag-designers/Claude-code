'use client';

import * as React from 'react';
import { ipc, useIpcEvent, useIpcQuery } from '../ipc';

/**
 * Brand Kit fonts, registered with `document.fonts` so every picker, preview and the editor canvas can use them by
 * family name. Idempotent per asset; the `url` is a short-lived presigned URL, so a font is only fetched once.
 */
const loaded = new Map<string, FontFace>();
let inflight: Promise<void> | null = null;

export interface BrandFontRef {
  assetId: string;
  kitId: string;
  family: string;
  weight: number;
  italic: boolean;
  url: string;
}

/** Fetches `brand:fonts` and registers every font not yet registered. Resolves when all have loaded (failures are skipped). */
export function registerBrandFonts(): Promise<BrandFontRef[]> {
  if (typeof document === 'undefined') return Promise.resolve([]);
  const run = async (): Promise<BrandFontRef[]> => {
    const { fonts } = await ipc.invoke('brand:fonts');
    const keep = new Set(fonts.map((f) => f.assetId));
    for (const [id, face] of loaded) {
      if (!keep.has(id)) {
        document.fonts.delete(face);
        loaded.delete(id);
      }
    }
    await Promise.all(
      fonts
        .filter((f) => !loaded.has(f.assetId))
        .map(async (f) => {
          const face = new FontFace(f.family, `url(${JSON.stringify(f.url)})`, {
            weight: String(f.weight),
            style: f.italic ? 'italic' : 'normal',
          });
          try {
            await face.load();
            document.fonts.add(face);
            loaded.set(f.assetId, face);
          } catch {
            /* unreadable font: the picker still lists the family, the browser falls back */
          }
        }),
    );
    return fonts;
  };
  const p = (inflight ?? Promise.resolve()).then(run, run);
  inflight = p.then(
    () => undefined,
    () => undefined,
  );
  return p;
}

/** Brand fonts for pickers: the list is live, and each font is registered before `ready` flips. */
export function useBrandFonts(): { fonts: BrandFontRef[]; ready: boolean; families: string[] } {
  const q = useIpcQuery('brand:fonts', undefined, { staleTime: 60_000 });
  const [ready, setReady] = React.useState(false);
  const fonts = React.useMemo(() => q.data?.fonts ?? [], [q.data]);
  React.useEffect(() => {
    let alive = true;
    if (!q.data) return;
    void registerBrandFonts()
      .catch(() => undefined)
      .then(() => alive && setReady(true));
    return () => {
      alive = false;
    };
  }, [q.data]);
  useIpcEvent('brand:changed', () => void q.refetch());
  const families = React.useMemo(() => [...new Set(fonts.map((f) => f.family))].sort(), [fonts]);
  return { fonts, ready, families };
}
