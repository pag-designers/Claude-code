'use client';

import * as React from 'react';
import { CircleAlert } from 'lucide-react';
import type { ClipView, VideoView } from '@shared/pipeline';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { ScoreChip } from '@/components/ui/score-badge';
import { Button } from '@/components/ui/button';
import { ClipsBrowser } from '@/components/library/clips-browser';
import { HookTab, ThumbnailTab } from '@/components/library/drawer-tabs';
import { ClipsExtras } from '@/components/video/clips-extras';
import { formatSpan } from '@/lib/format';
import { useVideoClips } from '@/lib/library';
import { cn } from '@/lib/utils';
import { ClipThumb } from './clip-thumb';
import { NoClipsYet } from './tool-bodies';

/**
 * Find Moments / One-Click Highlights: the steering panel and highlight builder live with the clips
 * (components/video/clips-extras), so the tool simply hosts them above the video's clip grid.
 */
export function MomentsTool({ video, tool }: { video: VideoView; tool: 'find-moments' | 'highlights' }) {
  return (
    <div className="flex flex-col gap-6" data-testid={`${tool}-tool`}>
      <ClipsExtras videoId={video.id} />
      <ClipsBrowser scope={{ kind: 'video', videoId: video.id }} processing={video.status !== 'ready'} />
    </div>
  );
}

function PickerRow({
  clip,
  selected,
  onSelect,
}: {
  clip: ClipView;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        data-testid="clip-pick"
        data-clip-id={clip.id}
        aria-pressed={selected}
        onClick={() => onSelect(clip.id)}
        className={cn(
          'flex w-full items-center gap-3 rounded-xl border p-2 text-left outline-none transition-[border-color,background-color] duration-(--duration-fast)',
          'focus-visible:ring-2 focus-visible:ring-ring',
          selected ? 'border-primary/70 bg-primary-soft' : 'bg-card hover:border-border-strong hover:bg-accent/40',
        )}
      >
        <div className="w-12 shrink-0 overflow-hidden rounded-md border">
          <ClipThumb clip={clip} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-sm font-semibold leading-[18px]">{clip.title}</p>
          <p className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
            <span className="tabular-nums">{formatSpan(clip.durationSec)}</span>
            {clip.score !== null ? <ScoreChip score={clip.score} /> : null}
          </p>
        </div>
      </button>
    </li>
  );
}

/** AI Hook / AI Thumbnail: pick one of the video's clips, then work on it with the clip drawer's own tab. */
export function ClipTool({
  video,
  tool,
  clipId,
  onSelectClip,
}: {
  video: VideoView;
  tool: 'hook' | 'thumbnail';
  clipId: string | null;
  onSelectClip: (id: string) => void;
}) {
  const q = useVideoClips(video.id);
  const clips = React.useMemo(() => q.data?.items ?? [], [q.data]);
  const selected = clips.find((c) => c.id === clipId) ?? null;

  // land on the best clip when none was chosen
  const firstId = clips[0]?.id;
  React.useEffect(() => {
    if (!clipId && firstId && q.isSuccess) onSelectClip(firstId);
  }, [clipId, firstId, q.isSuccess, onSelectClip]);

  if (q.isPending)
    return (
      <div className="grid grid-cols-[300px_minmax(0,1fr)] gap-6" aria-busy aria-label="Loading clips">
        <div className="space-y-2">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-96 w-full rounded-xl" />
      </div>
    );
  if (q.isError)
    return (
      <EmptyState
        size="sm"
        icon={CircleAlert}
        title="Could not load the clips"
        description={q.error.message}
        actions={<Button onClick={() => void q.refetch()}>Try again</Button>}
      />
    );
  if (clips.length === 0) return <NoClipsYet video={video} tool={tool === 'hook' ? 'write hooks for' : 'pick thumbnails for'} />;

  return (
    <div
      className="grid grid-cols-[300px_minmax(0,1fr)] items-start gap-6 max-[1000px]:grid-cols-1"
      data-testid={`${tool}-tool`}
    >
      <aside aria-label="Clips" className="flex flex-col gap-2">
        <h2 className="px-1 text-2xs font-semibold uppercase tracking-wider text-subtle">
          {clips.length} {clips.length === 1 ? 'clip' : 'clips'}
        </h2>
        <ul className="scrollbar-thin flex max-h-[min(70vh,720px)] flex-col gap-2 overflow-y-auto pr-1">
          {clips.map((c) => (
            <PickerRow key={c.id} clip={c} selected={c.id === selected?.id} onSelect={onSelectClip} />
          ))}
        </ul>
      </aside>
      <section
        aria-label={tool === 'hook' ? 'Hook variants' : 'Thumbnail options'}
        className="min-w-0 rounded-xl border bg-card p-5"
      >
        {selected ? (
          <>
            <h2 className="mb-4 line-clamp-1 font-display text-md font-semibold">{selected.title}</h2>
            {tool === 'hook' ? <HookTab clipId={selected.id} /> : <ThumbnailTab clipId={selected.id} />}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            That clip no longer exists. Choose another one from the list.
          </p>
        )}
      </section>
    </div>
  );
}
