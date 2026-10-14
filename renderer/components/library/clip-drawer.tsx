'use client';

import * as React from 'react';
import {
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock,
  Download,
  Film,
  Loader2,
  MonitorPlay,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import type { ClipView } from '@shared/pipeline';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { Segmented } from '@/components/ui/segmented';
import { StarButton } from '@/components/ui/star-button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DisabledTip, Tip } from '@/components/ui/tooltip';
import { DrawerBrandChip } from '@/components/brand-apply/drawer-chip';
import { ChatLauncher } from '@/components/chat/chat-launcher';
import { OpenInEditorButton } from '@/components/editor/panels/open-in-editor';
import { DRAWER_VIEWS, isDrawerView, useClipUi, type DrawerView } from '@/lib/cp2-clips';
import { registerSeeker, useChatUi } from '@/lib/cp2-chat';
import { formatClock, formatSpan, timeAgo } from '@/lib/format';
import {
  useClipMediaUrl,
  useDeleteClips,
  useDownloadClips,
  useProxyUrl,
  useRerenderClip,
  useSetClipFavorite,
  useVideos,
} from '@/lib/library';
import { ClipScore } from './clip-card';
import { HookTab, MetaTab, ReframeTab, ThumbnailTab } from './drawer-tabs';
import { ScoreBreakdownBars } from './score-breakdown';

type Mode = 'clip' | 'source';
/** A request to show the source at a moment (from "Play source at this moment" or a chat citation). */
interface SourceAt {
  t: number;
  n: number;
}

const TAB_LABELS: Record<DrawerView, string> = {
  overview: 'Overview',
  hook: 'Hook',
  meta: 'Metadata',
  thumbnail: 'Thumbnail',
  reframe: 'Reframe & Style',
};

function ClipPlayer({
  clip,
  mode,
  autoplaySource,
  sourceAt,
}: {
  clip: ClipView;
  mode: Mode;
  autoplaySource: boolean;
  sourceAt: SourceAt | null;
}) {
  const canPlay = clip.status === 'rendered' && clip.hasRender;
  const render = useClipMediaUrl(clip.id, 'render', canPlay && mode === 'clip');
  const thumb = useClipMediaUrl(clip.id, 'thumb', clip.hasThumb);
  const proxy = useProxyUrl(clip.videoId, mode === 'source');
  const ref = React.useRef<HTMLVideoElement | null>(null);
  // a citation outside the clip's own range must not be cut off by the clip-end guard below
  const freeSeek = !!sourceAt && (sourceAt.t < clip.startSec || sourceAt.t > clip.endSec);
  const seekN = sourceAt?.n;
  React.useEffect(() => {
    const v = ref.current;
    if (mode !== 'source' || !v || !sourceAt || v.readyState < 1) return;
    v.currentTime = sourceAt.t;
    void v.play().catch(() => undefined);
    // re-seek only when a new request arrives
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekN, mode]);

  if (mode === 'source') {
    if (proxy.isPending)
      return (
        <div className="flex size-full items-center justify-center text-white/70">
          <Loader2 className="size-5 animate-spin" aria-hidden />
        </div>
      );
    if (!proxy.data?.url)
      return (
        <div className="flex size-full flex-col items-center justify-center gap-2 p-6 text-center text-white/80">
          <CircleAlert className="size-5" aria-hidden />
          <p className="text-sm font-medium">No source proxy yet</p>
          <p className="text-xs text-white/60">
            The 480p playback copy appears once Prepare media has finished.
          </p>
        </div>
      );
    return (
      <video
        key={`src-${clip.id}`}
        ref={ref}
        src={proxy.data.url}
        controls
        playsInline
        preload="auto"
        data-testid="drawer-source-video"
        className="size-full object-contain"
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          v.currentTime = sourceAt?.t ?? clip.startSec;
          if (autoplaySource) void v.play().catch(() => undefined);
        }}
        onTimeUpdate={(e) => {
          const v = e.currentTarget;
          if (!freeSeek && v.currentTime >= clip.endSec && !v.paused) v.pause();
        }}
      />
    );
  }

  if (!canPlay)
    return (
      <div className="relative size-full">
        {thumb.data?.url ? (
          <img src={thumb.data.url} alt="" className="size-full object-cover opacity-40" />
        ) : null}
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center text-white">
          {clip.status === 'failed' ? (
            <CircleAlert className="size-6" aria-hidden />
          ) : clip.status === 'rendering' ? (
            <Loader2 className="size-6 animate-spin" aria-hidden />
          ) : (
            <Clock className="size-6" aria-hidden />
          )}
          <p className="text-sm font-semibold">
            {clip.status === 'failed'
              ? 'Rendering failed'
              : clip.status === 'rendering'
                ? 'Rendering this clip…'
                : clip.status === 'queued'
                  ? 'Waiting in the render queue'
                  : 'Not rendered yet'}
          </p>
          {clip.status === 'failed' && clip.error ? (
            <p className="text-xs text-white/70">{clip.error}</p>
          ) : null}
        </div>
      </div>
    );
  if (render.isPending || !render.data?.url)
    return (
      <div className="flex size-full items-center justify-center text-white/70">
        <Loader2 className="size-5 animate-spin" aria-hidden />
      </div>
    );
  return (
    <video
      key={`clip-${clip.id}-${clip.status}`}
      ref={ref}
      src={render.data.url}
      poster={thumb.data?.url ?? undefined}
      controls
      loop
      autoPlay
      playsInline
      data-testid="drawer-clip-video"
      className="size-full object-contain"
      onError={() => void render.refetch()}
    />
  );
}

/** Large clip detail dialog: 9:16 player, score breakdown, source jump, download / favorite / delete / re-render. */
export function ClipDrawer({
  clips,
  clipId,
  onClipChange,
  onClose,
}: {
  clips: ClipView[];
  clipId: string | null;
  onClipChange: (id: string) => void;
  onClose: () => void;
}) {
  const index = clipId ? clips.findIndex((c) => c.id === clipId) : -1;
  const clip = index >= 0 ? clips[index] : undefined;
  const open = !!clip;
  const [mode, setMode] = React.useState<Mode>('clip');
  const [autoplaySource, setAutoplaySource] = React.useState(false);
  const [sourceAt, setSourceAt] = React.useState<SourceAt | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  // with the AI Chat panel open, the drawer slides left so the panel never covers its controls
  const chatOpen = useChatUi((s) => s.open);
  const view = useClipUi((s) => s.drawerView);
  const setView = useClipUi((s) => s.setDrawerView);
  const videos = useVideos();
  const video = videos.data?.items.find((v) => v.id === clip?.videoId);
  const fav = useSetClipFavorite();
  const del = useDeleteClips();
  const rerender = useRerenderClip();
  const download = useDownloadClips();

  // reset to the rendered clip whenever another clip is shown
  const [lastId, setLastId] = React.useState<string | null>(null);
  if (clip && clip.id !== lastId) {
    setLastId(clip.id);
    setMode('clip');
    setAutoplaySource(false);
    setSourceAt(null);
  }

  // the chat's clickable timestamps ("play source at this moment") land here while the drawer is open
  const hasProxyNow = !!video?.hasProxy;
  const clipVideoId = clip?.videoId;
  React.useEffect(() => {
    if (!open || !clipVideoId || !hasProxyNow) return;
    return registerSeeker((videoId, t) => {
      if (videoId !== clipVideoId) return false;
      setAutoplaySource(true);
      setSourceAt((prev) => ({ t, n: (prev?.n ?? 0) + 1 }));
      setMode('source');
      return true;
    });
  }, [open, clipVideoId, hasProxyNow]);

  // leaving the drawer returns it to Overview next time (a deep link may pick another tab right after)
  React.useEffect(() => {
    if (!open) setView('overview');
  }, [open, setView]);

  // a deleted clip (or a filter change) removes it from `clips`: close instead of showing stale data
  React.useEffect(() => {
    if (clipId && index < 0) onClose();
  }, [clipId, index, onClose]);

  const hasProxy = !!video?.hasProxy;
  const busy = clip?.status === 'queued' || clip?.status === 'rendering';
  const step = (d: -1 | 1) => {
    const next = clips[index + d];
    if (next) onClipChange(next.id);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
        <DialogContent
          className="h-[min(88vh,780px)] max-h-none max-w-[940px] flex-row transition-[left] duration-(--duration-slow) ease-(--ease-standard)"
          data-testid="clip-drawer"
          data-chat-open={chatOpen || undefined}
          style={chatOpen ? { left: 'max(470px, calc((100vw - 452px) / 2))' } : undefined}
          // the AI Chat panel is a separate, non-modal layer: using it must not dismiss the drawer underneath;
          // neither must a toast action (e.g. "Try again" after a failed Brand Kit apply)
          onInteractOutside={(e) => {
            const t = e.target;
            if (t instanceof Element && t.closest('[data-chat-panel], [data-sonner-toaster]'))
              e.preventDefault();
          }}
        >
          {clip ? (
            <>
              <div className="flex w-[min(340px,42%)] shrink-0 flex-col gap-3 border-r bg-card/60 p-5">
                <div className="relative aspect-[9/16] w-full overflow-hidden rounded-xl bg-black shadow-md">
                  <ClipPlayer
                    clip={clip}
                    mode={mode}
                    autoplaySource={autoplaySource}
                    sourceAt={sourceAt}
                  />
                </div>
                <Segmented<Mode>
                  label="Player source"
                  size="sm"
                  className="w-full"
                  value={mode}
                  onValueChange={(m) => {
                    if (m === 'source' && !hasProxy) return;
                    setAutoplaySource(false);
                    setMode(m);
                  }}
                  options={[
                    { value: 'clip', label: 'Clip' },
                    {
                      value: 'source',
                      label: 'Source',
                      disabled: !hasProxy,
                      hint: hasProxy ? undefined : 'No 480p source proxy for this video',
                    },
                  ]}
                />
                <section className="flex flex-col gap-2.5 rounded-xl border bg-muted/40 px-3.5 py-3">
                  <div>
                    <p className="text-2xs font-semibold uppercase tracking-wider text-subtle">
                      In the source video
                    </p>
                    <p
                      className="mt-0.5 text-sm font-semibold tabular-nums"
                      data-testid="drawer-range"
                    >
                      {formatClock(clip.startSec)} – {formatClock(clip.endSec)}
                    </p>
                  </div>
                  {hasProxy ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setAutoplaySource(true);
                        setSourceAt(null);
                        setMode('source');
                      }}
                    >
                      <MonitorPlay /> Play source at this moment
                    </Button>
                  ) : (
                    <DisabledTip reason="This video has no 480p source proxy to play." side="top">
                      <Button variant="outline" size="sm" disabled className="w-full">
                        <MonitorPlay /> Play source at this moment
                      </Button>
                    </DisabledTip>
                  )}
                </section>
              </div>
              <div className="scrollbar-thin flex min-w-0 flex-1 flex-col gap-5 overflow-y-auto px-6">
                <div className="flex items-start gap-4 pr-10 pt-6">
                  <ClipScore clip={clip} size={64} showLabel />
                  <div className="min-w-0 flex-1">
                    <DialogTitle className="font-display text-xl font-semibold leading-7">
                      {clip.title}
                    </DialogTitle>
                    <DialogDescription className="mt-1 text-xs text-muted-foreground">
                      {clip.videoTitle ? `From “${clip.videoTitle}” · ` : ''}
                      found {timeAgo(clip.createdAt)}
                    </DialogDescription>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {clip.kind === 'highlight' ? (
                        <Badge variant="primary" data-testid="drawer-highlight-badge">
                          <Film /> Highlight reel
                        </Badge>
                      ) : null}
                      <Badge variant="neutral" className="tabular-nums">
                        {formatSpan(clip.durationSec)}
                      </Badge>
                      <Badge variant="neutral">{clip.aspect}</Badge>
                      {clip.status !== 'rendered' ? (
                        <Badge variant={clip.status === 'failed' ? 'danger' : 'primary'}>
                          {clip.status}
                        </Badge>
                      ) : null}
                      <DrawerBrandChip clip={clip} onOpen={() => setView('reframe')} />
                    </div>
                  </div>
                </div>

                <Tabs
                  value={view}
                  onValueChange={(v) => isDrawerView(v) && setView(v)}
                  className="flex flex-col gap-5"
                >
                  <TabsList
                    aria-label="Clip sections"
                    className="scrollbar-thin sticky top-0 z-10 -mx-6 -mt-1 w-[calc(100%+3rem)] overflow-x-auto bg-popover px-6"
                  >
                    {DRAWER_VIEWS.map((v) => (
                      <TabsTrigger key={v} value={v} data-testid={`drawer-tab-${v}`}>
                        {TAB_LABELS[v]}
                        {(v === 'hook' && clip.hasHooks) ||
                        (v === 'meta' && clip.hasMeta) ||
                        (v === 'thumbnail' && clip.hasThumbOptions) ? (
                          <span
                            aria-label="has content"
                            className="size-1.5 rounded-full bg-primary"
                            data-testid={`drawer-tab-${v}-dot`}
                          />
                        ) : null}
                      </TabsTrigger>
                    ))}
                  </TabsList>

                  <TabsContent value="overview" className="flex flex-col gap-5">
                    {clip.hook ? (
                      <section>
                        <h3 className="mb-1.5 text-2xs font-semibold uppercase tracking-wider text-subtle">
                          Hook
                        </h3>
                        <p
                          className="rounded-lg border-l-2 border-primary bg-primary-soft px-3.5 py-2.5 font-display text-md font-medium leading-snug"
                          data-testid="drawer-hook"
                        >
                          “{clip.hook}”
                        </p>
                      </section>
                    ) : null}
                    {clip.whyItWorks ? (
                      <section>
                        <h3 className="mb-1.5 text-2xs font-semibold uppercase tracking-wider text-subtle">
                          Why it works
                        </h3>
                        <p
                          className="text-sm leading-6 text-muted-foreground"
                          data-testid="drawer-why"
                        >
                          {clip.whyItWorks}
                        </p>
                      </section>
                    ) : null}

                    <section>
                      <h3 className="mb-3 text-2xs font-semibold uppercase tracking-wider text-subtle">
                        Virality score breakdown
                      </h3>
                      {clip.breakdown ? (
                        <ScoreBreakdownBars
                          breakdown={clip.breakdown}
                          confidence={clip.confidence}
                        />
                      ) : (
                        <p className="rounded-lg border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">
                          The breakdown appears once Claude has scored this moment.
                        </p>
                      )}
                    </section>

                    {clip.status === 'rendering' || clip.status === 'queued' ? (
                      <div className="flex items-center gap-3" data-testid="drawer-render-progress">
                        <Progress
                          value={clip.renderProgress === null ? null : clip.renderProgress * 100}
                          className="h-1.5"
                          aria-label="Render progress"
                        />
                        <span className="w-24 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                          {clip.status === 'queued'
                            ? 'Queued'
                            : `${Math.round((clip.renderProgress ?? 0) * 100)}%`}
                        </span>
                      </div>
                    ) : null}
                  </TabsContent>
                  <TabsContent value="hook">
                    <HookTab key={clip.id} clipId={clip.id} clip={clip} />
                  </TabsContent>
                  <TabsContent value="meta">
                    <MetaTab key={clip.id} clipId={clip.id} clip={clip} />
                  </TabsContent>
                  <TabsContent value="thumbnail">
                    <ThumbnailTab key={clip.id} clipId={clip.id} clip={clip} />
                  </TabsContent>
                  <TabsContent value="reframe">
                    <ReframeTab key={clip.id} clipId={clip.id} clip={clip} />
                  </TabsContent>
                </Tabs>

                <div className="sticky bottom-0 z-10 -mx-6 mt-auto flex flex-wrap items-center gap-2 border-t bg-popover px-6 py-3.5">
                  <Button
                    variant="primary"
                    loading={download.isPending}
                    disabled={!clip.hasRender || clip.status !== 'rendered'}
                    onClick={() => download.mutate({ ids: [clip.id] })}
                  >
                    <Download /> Download
                  </Button>
                  <Button
                    variant="outline"
                    loading={rerender.isPending || busy}
                    disabled={busy}
                    onClick={() => rerender.mutate({ id: clip.id })}
                  >
                    <RotateCcw /> {clip.status === 'failed' ? 'Retry render' : 'Re-render'}
                  </Button>
                  <StarButton
                    label={clip.title}
                    active={clip.favorite}
                    onToggle={() => fav.mutate({ ids: [clip.id], value: !clip.favorite })}
                    className="size-9 border border-border-strong"
                  />
                  <Tip content="Delete clip">
                    <Button
                      variant="danger-ghost"
                      size="icon"
                      aria-label="Delete"
                      onClick={() => setConfirmDelete(true)}
                    >
                      <Trash2 />
                    </Button>
                  </Tip>
                  <OpenInEditorButton
                    clipId={clip.id}
                    disabled={clip.status !== 'rendered' || !clip.hasRender}
                  />
                  <ChatLauncher videoId={clip.videoId} clipId={clip.id} />
                  <span className="ml-auto flex items-center gap-1 text-xs text-subtle">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Previous clip"
                      disabled={index <= 0}
                      onClick={() => step(-1)}
                    >
                      <ChevronLeft />
                    </Button>
                    <span className="min-w-12 text-center tabular-nums">
                      {index + 1} of {clips.length}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Next clip"
                      disabled={index >= clips.length - 1}
                      onClick={() => step(1)}
                    >
                      <ChevronRight />
                    </Button>
                  </span>
                </div>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this clip?"
        description="The rendered file and its captions are removed from your cloud storage. The source video is not affected."
        loading={del.isPending}
        onConfirm={() =>
          clip &&
          del.mutate(
            { ids: [clip.id] },
            {
              onSuccess: () => {
                setConfirmDelete(false);
                const next = clips[index + 1] ?? clips[index - 1];
                if (next) onClipChange(next.id);
                else onClose();
              },
            },
          )
        }
      />
    </>
  );
}
