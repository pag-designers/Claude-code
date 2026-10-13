'use client';

import * as React from 'react';
import { CircleAlert, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatClock } from '@/lib/format';
import { useProxyUrl } from '@/lib/library';
import { useOptionalPlayer } from '@/lib/player';
import { usePeek } from '@/lib/cp2-chat';

/**
 * A small source player inside the chat panel. A timestamp click first asks the page's own players (video page proxy
 * player, open clip drawer) to seek; when none can show the moment (hidden on another tab, or covered by this panel) the
 * peek plays it right here, so a click always shows the moment.
 */
export function SourcePeek({ videoId }: { videoId: string }) {
  const peek = usePeek((s) => s.peek);
  const close = usePeek((s) => s.close);
  const proxy = useProxyUrl(videoId, !!peek);
  const player = useOptionalPlayer();
  const ref = React.useRef<HTMLVideoElement | null>(null);
  const n = peek?.n;
  const sec = peek?.sec ?? 0;

  const seek = React.useCallback(() => {
    const v = ref.current;
    if (!v) return;
    v.currentTime = sec;
    void v.play().catch(() => undefined);
  }, [sec]);
  // a new timestamp while the peek is open re-seeks it
  React.useEffect(() => {
    const v = ref.current;
    if (v && v.readyState >= 1) seek();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n]);

  if (!peek || peek.videoId !== videoId) return null;
  return (
    <section
      className="border-b bg-black/95 text-white"
      aria-label="Source video"
      data-testid="chat-peek"
    >
      <div className="flex items-center justify-between px-3 py-1.5 text-xs">
        <span className="font-medium">
          Source video · <span className="tabular-nums">{formatClock(sec)}</span>
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Close source video"
          onClick={close}
          className="text-white/80 hover:bg-white/15 hover:text-white"
        >
          <X />
        </Button>
      </div>
      <div className="relative mx-auto aspect-video max-h-52 w-full bg-black">
        {proxy.isPending ? (
          <div className="flex size-full items-center justify-center">
            <Loader2 className="size-5 animate-spin" aria-hidden />
          </div>
        ) : !proxy.data?.url ? (
          <div
            className="flex size-full flex-col items-center justify-center gap-1.5 p-4 text-center"
            data-testid="chat-peek-missing"
          >
            <CircleAlert className="size-5" aria-hidden />
            <p className="text-sm font-medium">No source copy to play</p>
            <p className="text-xs text-white/70">
              Re-run “Prepare media” on this video to create its 480p playback copy.
            </p>
          </div>
        ) : (
          <video
            ref={ref}
            src={proxy.data.url}
            controls
            playsInline
            preload="auto"
            data-testid="chat-peek-video"
            className="size-full object-contain"
            onLoadedMetadata={seek}
            onPlay={() => player?.videoRef.current?.pause()}
            onError={() => void proxy.refetch()}
          />
        )}
      </div>
    </section>
  );
}
