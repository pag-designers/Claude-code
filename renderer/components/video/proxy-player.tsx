'use client';

import * as React from 'react';
import { CircleAlert, Loader2, MonitorPlay } from 'lucide-react';
import type { Chapter, VideoView } from '@shared/pipeline';
import { cn } from '@/lib/utils';
import { formatClock } from '@/lib/format';
import { useProxyUrl } from '@/lib/library';
import { usePlayer, usePlayerSelector } from '@/lib/player';
import { activeRangeIndex } from '@/lib/transcript';
import { isActiveVideo } from '@/lib/pipeline-ui';

function PlayerClock() {
  const t = usePlayerSelector((s) => Math.floor(s.time));
  const d = usePlayerSelector((s) => Math.floor(s.duration));
  return (
    <span className="tabular-nums" data-testid="player-clock">
      {formatClock(t)}
      {d > 0 ? ` / ${formatClock(d)}` : ''}
    </span>
  );
}

function CurrentChapter({ chapters }: { chapters: Chapter[] }) {
  const idx = usePlayerSelector((s) => activeRangeIndex(chapters, s.time));
  const ch = chapters[idx];
  if (!ch) return <span className="text-subtle">No chapter</span>;
  return (
    <span className="min-w-0 truncate" data-testid="player-chapter">
      <span className="text-subtle">Chapter {idx + 1} · </span>
      {ch.title}
    </span>
  );
}

/** The 480p proxy player. Everything else on the page seeks it through `usePlayer().seek`. */
export function ProxyPlayer({
  video,
  chapters,
  className,
}: {
  video: VideoView;
  chapters: Chapter[];
  className?: string;
}) {
  const player = usePlayer();
  const { store, videoRef } = player;
  const url = useProxyUrl(video.id, video.hasProxy);

  const unavailable = !video.hasProxy || (url.isSuccess && !url.data.url);

  return (
    <div
      className={cn('overflow-hidden rounded-xl border bg-card shadow-xs', className)}
      data-testid="proxy-player"
    >
      <div className="relative aspect-video bg-black">
        {!unavailable && url.data?.url ? (
          <video
            ref={videoRef}
            src={url.data.url}
            poster={video.thumbnail ?? undefined}
            controls
            playsInline
            preload="metadata"
            data-testid="proxy-video"
            className="size-full object-contain"
            onLoadedMetadata={(e) => {
              const v = e.currentTarget;
              store.set({ duration: v.duration, available: true });
              const p = player.getPending();
              if (p) {
                player.setPending(null);
                v.currentTime = Math.min(p.t, v.duration);
                if (p.play) void v.play().catch(() => undefined);
              }
            }}
            onTimeUpdate={(e) => store.set({ time: e.currentTarget.currentTime })}
            onSeeked={(e) => store.set({ time: e.currentTarget.currentTime })}
            onPlay={() => store.set({ playing: true })}
            onPause={() => store.set({ playing: false })}
            onEnded={() => store.set({ playing: false })}
            onError={() => void url.refetch()}
          />
        ) : (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center text-white/85"
            data-testid="player-unavailable"
          >
            {url.isPending && video.hasProxy ? (
              <Loader2 className="size-5 animate-spin" aria-hidden />
            ) : isActiveVideo(video) && !video.hasProxy ? (
              <MonitorPlay className="size-5" aria-hidden />
            ) : (
              <CircleAlert className="size-5" aria-hidden />
            )}
            <p className="text-sm font-semibold">
              {url.isPending && video.hasProxy
                ? 'Loading playback…'
                : isActiveVideo(video) && !video.hasProxy
                  ? 'Playback is not ready yet'
                  : 'No playback copy for this video'}
            </p>
            <p className="max-w-64 text-xs text-white/60">
              {isActiveVideo(video) && !video.hasProxy
                ? 'The 480p proxy is created in the Prepare media stage. Transcript and clips still work meanwhile.'
                : 'Clicking a timestamp can’t seek without the 480p proxy. Re-run “Prepare media” to create it again.'}
            </p>
          </div>
        )}
      </div>
      <div className="flex items-center justify-between gap-3 border-t px-3.5 py-2.5 text-xs text-muted-foreground">
        <CurrentChapter chapters={chapters} />
        <PlayerClock />
      </div>
    </div>
  );
}
