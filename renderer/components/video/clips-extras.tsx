'use client';

import * as React from 'react';
import { Sparkles } from 'lucide-react';

/** Steering panel + One-Click Highlights above the clips grid (CP2). Skeleton: built out in the next step. */
export function ClipsExtras({ videoId }: { videoId: string }) {
  return (
    <section
      aria-label="Find more moments"
      data-testid="clips-extras"
      data-video-id={videoId}
      className="flex items-center gap-2 rounded-xl border bg-card px-4 py-3 text-sm text-muted-foreground"
    >
      <Sparkles className="size-4 text-primary-text" aria-hidden /> Find more moments
    </section>
  );
}
