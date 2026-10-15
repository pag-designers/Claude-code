'use client';

import * as React from 'react';
import { Film } from 'lucide-react';
import type { ClipView } from '@shared/pipeline';
import { useClipMediaUrl } from '@/lib/library';
import { useInView } from '@/lib/use-in-view';
import { cn } from '@/lib/utils';

/** Lazy 9:16 clip thumbnail (presigned URL fetched when it scrolls into view). */
export function ClipThumb({
  clip,
  className,
}: {
  clip: Pick<ClipView, 'id' | 'hasThumb' | 'title'>;
  className?: string;
}) {
  const [ref, seen] = useInView<HTMLDivElement>('200px');
  const url = useClipMediaUrl(clip.id, 'thumb', seen && clip.hasThumb);
  const [failed, setFailed] = React.useState(false);
  return (
    <div ref={ref} className={cn('relative aspect-[9/16] overflow-hidden bg-muted', className)}>
      {url.data?.url && !failed ? (
        <img
          src={url.data.url}
          alt=""
          draggable={false}
          loading="lazy"
          className="size-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="flex size-full items-center justify-center text-subtle">
          <Film className="size-5" strokeWidth={1.6} aria-hidden />
        </div>
      )}
    </div>
  );
}
