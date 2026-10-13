'use client';

import * as React from 'react';
import { Skeleton } from '@/components/ui/skeleton';

function TabSkeleton({ label }: { label: string }) {
  return (
    <div className="flex flex-col gap-3" aria-busy aria-label={label}>
      <Skeleton className="h-9 w-64" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

/** Self-contained clip tabs: they work inside the clip drawer and as standalone tool routes. Skeletons for now. */
export function HookTab({ clipId }: { clipId: string }) {
  return <TabSkeleton label={`Hooks for ${clipId}`} />;
}
export function MetaTab({ clipId }: { clipId: string }) {
  return <TabSkeleton label={`Metadata for ${clipId}`} />;
}
export function ThumbnailTab({ clipId }: { clipId: string }) {
  return <TabSkeleton label={`Thumbnail for ${clipId}`} />;
}
export function ReframeTab({ clipId }: { clipId: string }) {
  return <TabSkeleton label={`Reframe for ${clipId}`} />;
}
