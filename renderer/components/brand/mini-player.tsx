'use client';

import * as React from 'react';
import { Pause, Play } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatDur } from '@/lib/brand/helpers';

/** Only one preview sounds at a time. */
let current: HTMLAudioElement | null = null;

/**
 * Compact audio auditioner for the loudness-normalised preview copy. A round play button, a seek bar and the time.
 * `src` null = the preview is not ready (still being made, or it failed).
 */
export function MiniPlayer({
  src,
  name,
  durationSec,
  className,
  size = 'md',
}: {
  src: string | null;
  name: string;
  durationSec?: number | null;
  className?: string;
  size?: 'sm' | 'md';
}) {
  const ref = React.useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = React.useState(false);
  const [t, setT] = React.useState(0);
  const [dur, setDur] = React.useState(durationSec ?? 0);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    const a = ref.current;
    return () => {
      if (a && current === a) current = null;
      a?.pause();
    };
  }, []);

  const toggle = () => {
    const a = ref.current;
    if (!a || !src) return;
    if (a.paused) {
      if (current && current !== a) current.pause();
      current = a;
      void a.play().catch(() => setFailed(true));
    } else a.pause();
  };

  const total = dur || durationSec || 0;
  return (
    <div className={cn('flex min-w-0 items-center gap-2.5', className)}>
      <button
        type="button"
        onClick={toggle}
        disabled={!src || failed}
        aria-label={`${playing ? 'Pause' : 'Play'} ${name}`}
        aria-pressed={playing}
        className={cn(
          'flex shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-xs transition-[background-color,transform] duration-(--duration-fast) hover:bg-primary-hover active:scale-95 disabled:bg-muted disabled:text-subtle',
          size === 'md' ? 'size-9' : 'size-7',
        )}
      >
        {playing ? (
          <Pause className={size === 'md' ? 'size-4' : 'size-3.5'} fill="currentColor" aria-hidden />
        ) : (
          <Play className={size === 'md' ? 'size-4' : 'size-3.5'} fill="currentColor" aria-hidden />
        )}
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <input
          type="range"
          className="range"
          min={0}
          max={total || 1}
          step={0.05}
          value={Math.min(t, total || 1)}
          disabled={!src || failed || !total}
          aria-label={`Seek ${name}`}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (ref.current) ref.current.currentTime = v;
            setT(v);
          }}
          style={{ '--range-fill': `${total ? (t / total) * 100 : 0}%` } as React.CSSProperties}
        />
        <span className="flex justify-between text-2xs tabular-nums text-subtle">
          <span>{formatDur(t)}</span>
          <span>{failed ? 'Preview unavailable' : src ? formatDur(total) : 'Preparing preview…'}</span>
        </span>
      </div>
      {src ? (
        <audio
          ref={ref}
          src={src}
          preload="none"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false);
            setT(0);
          }}
          onTimeUpdate={(e) => setT(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => {
            if (Number.isFinite(e.currentTarget.duration)) setDur(e.currentTarget.duration);
          }}
          onError={() => setFailed(true)}
        />
      ) : null}
    </div>
  );
}
