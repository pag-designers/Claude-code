'use client';

import * as React from 'react';
import { Film } from 'lucide-react';
import type { PostSource } from '@shared/publish';
import { useExportUrl, useExports } from '@/lib/editor-panels/projects';
import { useAllClips, useClipMediaUrl } from '@/lib/library';
import { cn } from '@/lib/utils';

export interface SourceMeta {
  source: PostSource;
  title: string;
  durationSec: number | null;
  kind: 'clip' | 'export';
  id: string;
  /** The source no longer exists (deleted since). */
  missing: boolean;
}

export const sourceKey = (s: PostSource): string =>
  'clipId' in s ? `c:${s.clipId}` : `e:${s.exportId}`;

/** Titles and durations of clips / exports from the library caches. */
export function useSourceMeta(sources: readonly PostSource[]): SourceMeta[] {
  const clips = useAllClips();
  const exps = useExports();
  return React.useMemo(
    () =>
      sources.map((source) => {
        if ('clipId' in source) {
          const c = clips.data?.items.find((x) => x.id === source.clipId);
          return {
            source,
            kind: 'clip' as const,
            id: source.clipId,
            title: c?.title ?? 'Clip',
            durationSec: c?.durationSec ?? null,
            missing: !!clips.data && !c,
          };
        }
        const e = exps.data?.items.find((x) => x.id === source.exportId);
        return {
          source,
          kind: 'export' as const,
          id: source.exportId,
          title: e?.name ?? 'Export',
          durationSec: e?.durationSec ?? null,
          missing: !!exps.data && !e,
        };
      }),
    [sources, clips.data, exps.data],
  );
}

export function SourceThumb({
  meta,
  className,
}: {
  meta: Pick<SourceMeta, 'kind' | 'id'>;
  className?: string;
}) {
  const clip = useClipMediaUrl(meta.id, 'thumb', meta.kind === 'clip');
  const exp = useExportUrl(meta.id, 'thumb', meta.kind === 'export');
  const url = meta.kind === 'clip' ? clip.data?.url : exp.data?.url;
  return (
    <div
      className={cn(
        'relative aspect-[9/16] w-10 shrink-0 overflow-hidden rounded-md border bg-black',
        className,
      )}
    >
      {url ? (
        <img src={url} alt="" className="size-full object-cover" />
      ) : (
        <span className="flex size-full items-center justify-center text-white/60">
          <Film className="size-4" aria-hidden />
        </span>
      )}
    </div>
  );
}
