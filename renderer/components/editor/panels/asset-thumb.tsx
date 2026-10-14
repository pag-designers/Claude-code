'use client';

import * as React from 'react';
import { Film, ImageIcon, Music, Palette } from 'lucide-react';
import type { Asset } from '@shared/editor';
import { cn } from '@/lib/utils';
import { useIpcQuery } from '@/lib/ipc';
import { useClipMediaUrl, useVideos } from '@/lib/library';
import { useInView } from '@/lib/use-in-view';
import { useEditorStore } from '@/lib/editor/core';

export const KIND_ICON = { video: Film, image: ImageIcon, audio: Music, lut: Palette } as const;

/**
 * Visual for a project asset: the Library thumbnail for clips and source videos, the first frame / the picture
 * itself for uploads (served by `editor:previewUrl`), and a typed icon when there is nothing to show yet.
 */
export function AssetThumb({
  asset,
  className,
  fit = 'cover',
}: {
  asset: Asset;
  className?: string;
  fit?: 'cover' | 'contain';
}) {
  const [ref, inView] = useInView<HTMLDivElement>();
  const projectId = useEditorStore((s) => s.projectId);
  const videos = useVideos();
  const clipId = asset.source.kind === 'clip' ? asset.source.clipId : '';
  const clipThumb = useClipMediaUrl(clipId, 'thumb', inView && asset.source.kind === 'clip');
  const upload = useIpcQuery(
    'editor:previewUrl',
    { projectId: projectId ?? '', assetId: asset.id },
    {
      enabled: inView && !!projectId && asset.source.kind === 'upload' && asset.kind !== 'audio',
      staleTime: 20 * 60_000,
      retry: 1,
    },
  );
  const [failed, setFailed] = React.useState(false);

  let src: string | null = null;
  let isVideoFrame = false;
  if (asset.source.kind === 'clip') src = clipThumb.data?.url ?? null;
  else if (asset.source.kind === 'video') {
    const id = asset.source.videoId;
    src = videos.data?.items.find((v) => v.id === id)?.thumbnail ?? null;
  } else if (asset.kind === 'image') src = upload.data?.url ?? null;
  else if (asset.kind === 'video') {
    src = upload.data?.url ?? null;
    isVideoFrame = true;
  }
  const Icon = KIND_ICON[asset.kind];

  return (
    <div ref={ref} className={cn('relative overflow-hidden bg-muted', className)}>
      {src && !failed ? (
        isVideoFrame ? (
          <video
            src={`${src}#t=0.1`}
            muted
            preload="metadata"
            playsInline
            tabIndex={-1}
            aria-hidden
            className={cn('size-full', fit === 'cover' ? 'object-cover' : 'object-contain')}
            onError={() => setFailed(true)}
          />
        ) : (
          <img
            src={src}
            alt=""
            loading="lazy"
            draggable={false}
            referrerPolicy="no-referrer"
            className={cn('size-full', fit === 'cover' ? 'object-cover' : 'object-contain')}
            onError={() => setFailed(true)}
          />
        )
      ) : (
        <div className="flex size-full items-center justify-center bg-primary-soft text-primary-text">
          <Icon className="size-5" strokeWidth={1.6} aria-hidden />
        </div>
      )}
    </div>
  );
}
