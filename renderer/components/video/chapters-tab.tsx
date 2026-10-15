'use client';

import * as React from 'react';
import { Play, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import type { Chapter, ClipView, VideoAnalysis, VideoView } from '@shared/pipeline';
import { Badge } from '@/components/ui/badge';
import { YoutubeGlyph } from '@/components/ui/brand-icons';
import { cn } from '@/lib/utils';
import { formatClock, formatSpan } from '@/lib/format';
import { usePlayer, usePlayerSelector } from '@/lib/player';
import { activeRangeIndex } from '@/lib/transcript';
import { AnalysisPending } from './analysis-states';

export function useSeekWithHint() {
  const { seek } = usePlayer();
  return React.useCallback(
    (t: number) => {
      if (!seek(t, { play: true }))
        toast.info('No playable proxy yet', {
          description: 'The 480p proxy is created in the Prepare media stage.',
        });
    },
    [seek],
  );
}

const SEGMENT_TONES = ['bg-primary', 'bg-info', 'bg-success', 'bg-warning'] as const;

function Timeline({
  chapters,
  duration,
  onSeek,
}: {
  chapters: Chapter[];
  duration: number;
  onSeek: (t: number) => void;
}) {
  const idx = usePlayerSelector((s) => activeRangeIndex(chapters, s.time));
  const sec = usePlayerSelector((s) => Math.floor(s.time));
  return (
    <div data-testid="chapter-timeline">
      <div className="relative flex h-9 items-stretch gap-0.5 overflow-hidden rounded-lg">
        {chapters.map((c, i) => (
          <button
            key={`${c.start}-${i}`}
            type="button"
            title={`${formatClock(c.start)} · ${c.title}`}
            aria-label={`Chapter ${i + 1}: ${c.title}, starts at ${formatClock(c.start)}`}
            onClick={() => onSeek(c.start)}
            style={{ flexGrow: Math.max(c.end - c.start, 1), flexBasis: 0 }}
            className={cn(
              'relative min-w-1 overflow-hidden text-left transition-[opacity,filter] duration-(--duration-fast)',
              SEGMENT_TONES[i % SEGMENT_TONES.length],
              i === idx ? 'opacity-100' : 'opacity-45 hover:opacity-75',
            )}
          >
            <span className="absolute inset-y-0 left-2 hidden items-center truncate pr-2 text-2xs font-semibold text-primary-foreground min-[900px]:flex">
              {i + 1}
            </span>
          </button>
        ))}
        {duration > 0 ? (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 w-0.5 rounded-full bg-foreground shadow-[0_0_0_1px_var(--background)]"
            style={{ left: `${Math.min(100, (sec / duration) * 100)}%` }}
          />
        ) : null}
      </div>
      <div className="mt-1.5 flex justify-between text-2xs tabular-nums text-subtle">
        <span>0:00</span>
        <span>{formatClock(duration)}</span>
      </div>
    </div>
  );
}

export function ChaptersTab({
  video,
  analysis,
  clips,
}: {
  video: VideoView;
  analysis: VideoAnalysis | null;
  clips: ClipView[];
}) {
  const seek = useSeekWithHint();
  const chapters = analysis?.chapters ?? [];
  const idx = usePlayerSelector((s) => activeRangeIndex(chapters, s.time));
  if (!analysis || chapters.length === 0) return <AnalysisPending video={video} what="Chapters" />;
  const total = video.durationSec ?? Math.max(...chapters.map((c) => c.end));
  return (
    <div className="flex flex-col gap-5" data-testid="chapters-tab">
      <div className="rounded-xl border bg-card p-4">
        <Timeline chapters={chapters} duration={total} onSeek={seek} />
      </div>
      <ol className="flex flex-col gap-2">
        {chapters.map((c, i) => {
          const inChapter = clips.filter((k) => k.startSec >= c.start && k.startSec < c.end).length;
          return (
            <li key={`${c.start}-${i}`}>
              <button
                type="button"
                onClick={() => seek(c.start)}
                aria-current={i === idx ? 'true' : undefined}
                data-testid="chapter-row"
                className={cn(
                  'group flex w-full items-start gap-4 rounded-xl border bg-card p-4 text-left transition-[border-color,background-color] duration-(--duration-fast)',
                  i === idx
                    ? 'border-primary/60 bg-primary-soft'
                    : 'hover:border-border-strong hover:bg-accent/40',
                )}
              >
                <span
                  className={cn(
                    'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg text-sm font-bold tabular-nums',
                    i === idx
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground group-hover:text-foreground',
                  )}
                >
                  {i === idx ? <Play className="size-3.5 fill-current" aria-hidden /> : i + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-display text-md font-semibold leading-6">{c.title}</span>
                    {c.source === 'youtube' ? (
                      <Badge variant="info">
                        <YoutubeGlyph className="size-3" /> YouTube
                      </Badge>
                    ) : (
                      <Badge variant="primary">
                        <Sparkles aria-hidden /> AI
                      </Badge>
                    )}
                    {inChapter > 0 ? (
                      <Badge variant="neutral">
                        {inChapter} {inChapter === 1 ? 'clip' : 'clips'}
                      </Badge>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block text-xs tabular-nums text-subtle">
                    {formatClock(c.start)} – {formatClock(c.end)} · {formatSpan(c.end - c.start)}
                  </span>
                  <span className="selectable mt-1.5 block text-sm leading-6 text-muted-foreground">
                    {c.summary}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
