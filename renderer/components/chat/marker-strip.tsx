'use client';

import * as React from 'react';
import { useMarkers } from '@/lib/cp2-chat';
import { formatClock } from '@/lib/format';
import { usePlayer, usePlayerSelector } from '@/lib/player';

/**
 * Tick marks for the video's markers, drawn under the source player. Clicking one seeks to it. Renders nothing until
 * the video has markers and the player knows its duration, so it never takes space for users who do not use them.
 */
export function MarkerStrip({ videoId }: { videoId: string }) {
  const q = useMarkers(videoId);
  const { seek } = usePlayer();
  const duration = usePlayerSelector((s) => s.duration);
  const items = q.data?.items ?? [];
  if (items.length === 0 || duration <= 0) return null;
  return (
    <div
      className="relative h-4 border-t bg-muted/40"
      data-testid="marker-strip"
      role="group"
      aria-label="Markers on the timeline"
    >
      {items.map((m) => (
        <button
          key={m.id}
          type="button"
          onClick={() => seek(m.atSec, { play: true })}
          title={`${formatClock(m.atSec)} · ${m.label}`}
          aria-label={`Marker ${m.label} at ${formatClock(m.atSec)}`}
          data-testid="marker-tick"
          className="absolute top-0 flex h-full w-3 -translate-x-1/2 items-center justify-center"
          style={{ left: `${Math.min(100, Math.max(0, (m.atSec / duration) * 100))}%` }}
        >
          <span className="block h-3 w-0.5 rounded-full bg-primary transition-transform duration-(--duration-fast) hover:scale-x-150" />
        </button>
      ))}
    </div>
  );
}
