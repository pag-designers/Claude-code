'use client';

import * as React from 'react';
import { CircleAlert, Loader2, RefreshCw } from 'lucide-react';
import { REFRAME_MODE_LABELS, type ReframeMode } from '@shared/cp2';
import type { ClipView, VideoView } from '@shared/pipeline';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { ScoreChip } from '@/components/ui/score-badge';
import { Badge } from '@/components/ui/badge';
import { formatSpan } from '@/lib/format';
import { useVideoClips } from '@/lib/library';
import { cn } from '@/lib/utils';
import { ClipThumb } from './clip-thumb';
import { LAYOUT_LABELS, LayoutGlyph, MODE_HINTS, ModeRadio } from './layout-glyph';
import { NoClipsYet } from './tool-bodies';
import { useReframeClips } from './use-reframe';

const busy = (c: ClipView) => c.status === 'queued' || c.status === 'rendering';

function ReframeCard({
  clip,
  pending,
  onApply,
}: {
  clip: ClipView;
  pending: boolean;
  onApply: (clip: ClipView, mode: ReframeMode) => void;
}) {
  const [draft, setDraft] = React.useState<ReframeMode>(clip.reframeMode);
  // follow the saved mode when a re-render lands (or the user changed it elsewhere)
  const [seen, setSeen] = React.useState(clip.reframeMode);
  if (seen !== clip.reframeMode) {
    setSeen(clip.reframeMode);
    setDraft(clip.reframeMode);
  }
  const working = busy(clip) || pending;
  const changed = draft !== clip.reframeMode;
  return (
    <li
      data-testid="reframe-card"
      data-clip-id={clip.id}
      className="flex gap-4 rounded-xl border bg-card p-3.5 shadow-xs"
    >
      <div className="relative w-[88px] shrink-0 overflow-hidden rounded-lg border">
        <ClipThumb clip={clip} />
        {working ? (
          <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-popover/75 text-2xs font-medium backdrop-blur-[2px]">
            <Loader2 className="size-4 animate-spin text-primary-text" aria-hidden />
            {clip.status === 'rendering' && clip.renderProgress !== null
              ? `${Math.round(clip.renderProgress * 100)}%`
              : 'Queued'}
          </span>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <div className="min-w-0">
          <h3 className="line-clamp-2 font-sans text-sm font-semibold leading-[18px]">{clip.title}</h3>
          <p className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
            <span className="tabular-nums">{formatSpan(clip.durationSec)}</span>
            {clip.score !== null ? <ScoreChip score={clip.score} /> : null}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5" data-testid="reframe-layout">
          {clip.layout ? (
            <Badge variant="neutral">
              <LayoutGlyph layout={clip.layout} className="w-2.5" /> Layout: {LAYOUT_LABELS[clip.layout]}
            </Badge>
          ) : (
            <Badge variant="outline">Not rendered yet</Badge>
          )}
          <Badge variant="outline">Mode: {REFRAME_MODE_LABELS[clip.reframeMode]}</Badge>
        </div>
        <ModeRadio
          label={`Reframe mode for ${clip.title}`}
          value={draft}
          onChange={setDraft}
          disabled={working}
        />
        <div className="mt-auto flex min-h-8 items-center justify-between gap-2">
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {clip.status === 'failed' ? (
              <span className="inline-flex items-center gap-1 text-danger">
                <CircleAlert className="size-3.5" aria-hidden /> Last render failed
              </span>
            ) : (
              MODE_HINTS[draft]
            )}
          </span>
          <Button
            size="sm"
            variant={changed ? 'primary' : 'outline'}
            disabled={working || !changed}
            onClick={() => onApply(clip, draft)}
            data-testid="reframe-apply"
          >
            <RefreshCw /> Re-frame
          </Button>
        </div>
      </div>
    </li>
  );
}

export function ReframeTool({ video }: { video: VideoView }) {
  const q = useVideoClips(video.id);
  const reframe = useReframeClips();
  const clips = q.data?.items ?? [];
  const [bulkMode, setBulkMode] = React.useState<ReframeMode>('auto');
  const [confirm, setConfirm] = React.useState(false);
  const [pendingIds, setPendingIds] = React.useState<ReadonlySet<string>>(new Set());

  const apply = (ids: string[], mode: ReframeMode, done?: () => void) => {
    setPendingIds(new Set(ids));
    reframe.mutate(
      { ids, mode },
      {
        onSuccess: done,
        onSettled: () => setPendingIds(new Set()),
      },
    );
  };
  const eligible = clips.filter((c) => c.status === 'rendered' || c.status === 'failed');

  if (q.isPending)
    return (
      <ul className="grid grid-cols-2 gap-4 max-[1180px]:grid-cols-1" aria-busy aria-label="Loading clips">
        {Array.from({ length: 4 }, (_, i) => (
          <li key={i} className="flex gap-4 rounded-xl border bg-card p-3.5">
            <Skeleton className="aspect-[9/16] w-[88px] rounded-lg" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-4/5" />
              <Skeleton className="h-3 w-1/3" />
              <Skeleton className="mt-4 h-12 w-48" />
            </div>
          </li>
        ))}
      </ul>
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
  if (clips.length === 0) return <NoClipsYet video={video} tool="re-frame" />;

  return (
    <div className="flex flex-col gap-5" data-testid="reframe-tool">
      <section
        aria-label="Reframe every clip"
        className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border bg-card p-4"
      >
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-md font-semibold">Set every clip at once</h2>
          <p className="text-sm text-muted-foreground">
            Auto picks per clip. Choose a mode below to re-frame all {eligible.length}{' '}
            {eligible.length === 1 ? 'clip' : 'clips'}; each is re-rendered.
          </p>
        </div>
        <ModeRadio label="Reframe mode for all clips" value={bulkMode} onChange={setBulkMode} size="lg" />
        <Button
          variant="primary"
          disabled={eligible.length === 0 || reframe.isPending}
          onClick={() => setConfirm(true)}
          data-testid="reframe-all"
        >
          <RefreshCw /> Apply to {eligible.length} {eligible.length === 1 ? 'clip' : 'clips'}
        </Button>
      </section>

      <ul className="grid grid-cols-2 gap-4 max-[1180px]:grid-cols-1">
        {clips.map((c) => (
          <ReframeCard
            key={c.id}
            clip={c}
            pending={pendingIds.has(c.id)}
            onApply={(clip, mode) => apply([clip.id], mode)}
          />
        ))}
      </ul>

      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent className="max-w-md" data-testid="reframe-confirm">
          <DialogHeader>
            <DialogTitle className="font-display text-lg font-semibold">
              Re-frame {eligible.length} {eligible.length === 1 ? 'clip' : 'clips'}?
            </DialogTitle>
            <DialogDescription className="mt-1 text-sm text-muted-foreground">
              Every rendered clip of this video is re-cropped with “{REFRAME_MODE_LABELS[bulkMode]}” and
              rendered again. Captions and hooks are kept.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={reframe.isPending}
              onClick={() =>
                apply(
                  eligible.map((c) => c.id),
                  bulkMode,
                  () => setConfirm(false),
                )
              }
            >
              Re-frame {eligible.length} {eligible.length === 1 ? 'clip' : 'clips'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <span className={cn('sr-only')} role="status" aria-live="polite">
        {reframe.isPending ? 'Re-framing…' : ''}
      </span>
    </div>
  );
}
