'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import {
  BookOpen,
  ChevronLeft,
  CircleAlert,
  Clapperboard,
  ExternalLink,
  FileText,
  Film,
  ListTree,
  MoreHorizontal,
  NotebookPen,
  RotateCcw,
  Scissors,
  Sparkles,
  Subtitles,
  Trash2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import type { PipelineStage, VideoView } from '@shared/pipeline';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { Page } from '@/components/ui/page';
import { ScoreChip } from '@/components/ui/score-badge';
import { Skeleton } from '@/components/ui/skeleton';
import { StarButton } from '@/components/ui/star-button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DisabledTip, Tip } from '@/components/ui/tooltip';
import { ChatLauncher } from '@/components/chat/chat-launcher';
import { OpenInEditorButton } from '@/components/editor/panels/open-in-editor';
import { VideoCaptionStyleControl } from '@/components/captions/video-caption-style';
import { ClipsBrowser } from '@/components/library/clips-browser';
import { DeleteVideoDialog, StatusBadge, VideoThumb } from '@/components/library/video-card';
import { PipelineProgress } from '@/components/pipeline/pipeline-progress';
import { ChaptersTab } from '@/components/video/chapters-tab';
import { NotesTab } from '@/components/video/notes-tab';
import { SubtitlesTab } from '@/components/subtitles/subtitles-tab';
import { ClipsExtras } from '@/components/video/clips-extras';
import { OverviewTab } from '@/components/video/overview-tab';
import { ProxyPlayer } from '@/components/video/proxy-player';
import { TranscriptTab } from '@/components/video/transcript-tab';
import { formatClock, timeAgo } from '@/lib/format';
import { libraryHref } from '@/lib/hrefs';
import { invoke } from '@/lib/ipc';
import { useRetryStage, useSetVideoFavorite, useVideo, useVideoClips } from '@/lib/library';
import { PIPELINE_STAGES, STAGE_LABELS, isActiveVideo, mergeStages } from '@/lib/pipeline-ui';
import { PlayerProvider, usePlayer } from '@/lib/player';
import { duration, ease } from '@/lib/motion';
import type { ClipView } from '@shared/pipeline';

const TABS = ['overview', 'transcript', 'chapters', 'clips', 'notes', 'subtitles'] as const;
type Tab = (typeof TABS)[number];
const isTab = (v: string | null): v is Tab => !!v && (TABS as readonly string[]).includes(v);

/** Announces the first clip of a live run: it appears the moment moment-finding produces it. */
function FirstClipMoment({
  videoId,
  active,
  onView,
}: {
  videoId: string;
  active: boolean;
  onView: () => void;
}) {
  const q = useVideoClips(videoId);
  const clips = q.data?.items;
  const count = clips?.length ?? 0;
  const [prev, setPrev] = React.useState<number | null>(null);
  const [shown, setShown] = React.useState<ClipView | null>(null);
  if (clips && prev !== count) {
    setPrev(count);
    if (prev === 0 && count > 0 && active) {
      const first = [...clips].sort((a, b) => a.createdAt - b.createdAt)[0];
      if (first) setShown(first);
    }
  }
  React.useEffect(() => {
    if (!shown) return;
    const id = window.setTimeout(() => setShown(null), 9000);
    return () => window.clearTimeout(id);
  }, [shown]);
  return (
    <AnimatePresence>
      {shown ? (
        <motion.div
          key="first"
          initial={{ opacity: 0, y: -8, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: duration.base, ease: ease.out }}
          role="status"
          data-testid="first-clip"
          className="flex items-center gap-3 rounded-xl border border-primary/40 bg-primary-soft px-4 py-3"
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Sparkles className="size-4" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">First clip ready</p>
            <p className="truncate text-xs text-muted-foreground">
              “{shown.title}” is in the grid below. More keep arriving while Clipfern works.
            </p>
          </div>
          {shown.score !== null ? <ScoreChip score={shown.score} /> : null}
          <Button size="sm" variant="soft" onClick={onView}>
            View clips
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Dismiss"
            onClick={() => setShown(null)}
          >
            <X />
          </Button>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function RerunMenu({
  video,
  stages,
}: {
  video: VideoView;
  stages: ReturnType<typeof mergeStages>;
}) {
  const retry = useRetryStage();
  const active = isActiveVideo(video);
  const trigger = (
    <Button variant="outline" disabled={active} loading={retry.isPending}>
      <RotateCcw /> Re-run stage
    </Button>
  );
  if (active)
    return (
      <DisabledTip reason="Wait for the current run to finish, or cancel it first.">
        {trigger}
      </DisabledTip>
    );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent className="w-60">
        <DropdownMenuLabel>Re-run a stage</DropdownMenuLabel>
        {PIPELINE_STAGES.map((st: PipelineStage) => {
          const state = stages.find((s) => s.stage === st);
          return (
            <DropdownMenuItem
              key={st}
              onSelect={() => retry.mutate({ videoId: video.id, stage: st })}
              data-testid={`rerun-${st}`}
            >
              <span className="flex-1">{STAGE_LABELS[st]}</span>
              {state?.status === 'failed' ? (
                <span className="text-2xs font-semibold text-danger">failed</span>
              ) : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Header({
  video,
  stages,
  onDelete,
}: {
  video: VideoView;
  stages: ReturnType<typeof mergeStages>;
  onDelete: () => void;
}) {
  const fav = useSetVideoFavorite();
  const openSource = () =>
    void invoke('shell:openExternal', { url: video.sourceUrl }).catch((e: Error) =>
      toast.error('Could not open the link', { description: e.message }),
    );
  return (
    <header className="flex items-start gap-5" data-testid="video-header">
      <div className="w-44 shrink-0 overflow-hidden rounded-xl border shadow-xs max-[900px]:hidden">
        <VideoThumb video={video} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          <StatusBadge video={video} />
          {video.clipCount > 0 ? (
            <Badge variant="neutral" className="tabular-nums">
              {video.clipCount} {video.clipCount === 1 ? 'clip' : 'clips'}
            </Badge>
          ) : null}
          {video.topScore !== null ? (
            <span className="flex items-center gap-1.5 text-2xs text-subtle">
              Top <ScoreChip score={video.topScore} />
            </span>
          ) : null}
        </div>
        <h1
          className="line-clamp-2 font-display text-2xl font-semibold leading-8"
          data-testid="video-title"
        >
          {video.title}
        </h1>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
          <span>{video.channel ?? 'Unknown channel'}</span>
          {video.durationSec !== null ? (
            <>
              <span aria-hidden>·</span>
              <span className="tabular-nums">{formatClock(video.durationSec)}</span>
            </>
          ) : null}
          <span aria-hidden>·</span>
          <span>Added {timeAgo(video.createdAt)}</span>
          <span aria-hidden>·</span>
          <button
            type="button"
            onClick={openSource}
            className="inline-flex items-center gap-1 font-medium text-primary-text hover:underline"
          >
            Watch on YouTube <ExternalLink className="size-3" aria-hidden />
          </button>
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <StarButton
          label={video.title}
          active={video.favorite}
          onToggle={() => fav.mutate({ id: video.id, value: !video.favorite })}
          className="size-9 border border-border-strong"
        />
        <OpenInEditorButton videoId={video.id} disabled={!video.hasProxy} />
        <ChatLauncher videoId={video.id} />
        <VideoCaptionStyleControl video={video} />
        <RerunMenu video={video} stages={stages} />
        <DropdownMenu>
          <Tip content="More">
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" aria-label="More actions">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
          </Tip>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={openSource}>
              <ExternalLink /> Open on YouTube
            </DropdownMenuItem>
            <DropdownMenuItem className="text-danger [&_svg]:text-danger" onSelect={onDelete}>
              <Trash2 /> Delete video…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}

type Detail = NonNullable<ReturnType<typeof useVideo>['data']>;

function Loaded({ id, data }: { id: string; data: Detail }) {
  const router = useRouter();
  const params = useSearchParams();
  const clips = useVideoClips(id);
  const { videoRef } = usePlayer();
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const urlTab = params.get('tab');
  const { video, analysis } = data;
  const stages = mergeStages(data.stages);
  const active = isActiveVideo(video);
  // The default tab is decided once, when the page opens: a live run lands on Clips, a finished video on Overview.
  // It must NOT flip when the run completes, or the content would jump out from under the user.
  const [tab, setTab] = React.useState<Tab>(() =>
    isTab(urlTab) ? urlTab : active ? 'clips' : 'overview',
  );
  const activeTab = tab;
  const clipItems = clips.data?.items ?? [];
  const changeTab = (v: string) => {
    if (!isTab(v)) return;
    if (v === 'clips') videoRef.current?.pause(); // the player is hidden on this tab: do not leave audio running
    setTab(v);
    const url = new URL(window.location.href);
    url.searchParams.set('tab', v);
    window.history.replaceState(null, '', `${url.pathname}${url.search}`);
  };
  const showPlayer = activeTab !== 'clips';
  // The URL is the source of truth once the page is open: the AI Chat (and other deep links) switch tabs through it.
  const [seenUrlTab, setSeenUrlTab] = React.useState(urlTab);
  if (seenUrlTab !== urlTab) {
    setSeenUrlTab(urlTab);
    if (isTab(urlTab)) setTab(urlTab);
  }

  return (
    <>
      <Page wide className="gap-6">
        <Link
          href={libraryHref('videos')}
          className="-mb-2 inline-flex w-fit items-center gap-1 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="size-4" aria-hidden /> Library
        </Link>
        <Header video={video} stages={stages} onDelete={() => setDeleteOpen(true)} />
        <PipelineProgress video={video} stages={stages} />
        <FirstClipMoment videoId={id} active={active} onView={() => changeTab('clips')} />

        <Tabs value={activeTab} onValueChange={changeTab} className="flex flex-col gap-6">
          <TabsList aria-label="Video sections" className="w-full overflow-x-auto">
            <TabsTrigger value="overview">
              <BookOpen /> Overview
            </TabsTrigger>
            <TabsTrigger value="transcript">
              <FileText /> Transcript
            </TabsTrigger>
            <TabsTrigger value="chapters">
              <ListTree /> Chapters
            </TabsTrigger>
            <TabsTrigger value="clips">
              <Scissors /> Clips
              {clipItems.length > 0 ? (
                <span className="rounded-full bg-muted px-1.5 text-2xs font-semibold tabular-nums text-muted-foreground">
                  {clipItems.length}
                </span>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="notes">
              <NotebookPen /> Notes
            </TabsTrigger>
            <TabsTrigger value="subtitles">
              <Subtitles /> Subtitles
            </TabsTrigger>
          </TabsList>

          <div
            className={
              showPlayer
                ? 'grid grid-cols-[minmax(0,1fr)_380px] items-start gap-6 max-[1100px]:grid-cols-1'
                : ''
            }
          >
            <div className="min-w-0">
              <TabsContent value="overview">
                <OverviewTab video={video} analysis={analysis} />
              </TabsContent>
              <TabsContent value="transcript">
                <TranscriptTab video={video} />
              </TabsContent>
              <TabsContent value="chapters">
                <ChaptersTab video={video} analysis={analysis} clips={clipItems} />
              </TabsContent>
              <TabsContent value="clips" className="flex flex-col gap-6">
                <ClipsExtras videoId={id} />
                <ClipsBrowser scope={{ kind: 'video', videoId: id }} processing={active} />
              </TabsContent>
              <TabsContent value="notes">
                <NotesTab video={video} analysis={analysis} />
              </TabsContent>
              <TabsContent value="subtitles">
                <SubtitlesTab video={video} />
              </TabsContent>
            </div>
            {/* stays mounted on the Clips tab (hidden) so the playhead survives tab switches */}
            <aside
              aria-label="Source video"
              hidden={!showPlayer}
              className="sticky top-4 max-[1100px]:static max-[1100px]:order-first"
            >
              <ProxyPlayer video={video} chapters={analysis?.chapters ?? []} />
              <p className="mt-3 flex items-center gap-1.5 px-1 text-xs text-subtle">
                <Clapperboard className="size-3.5" aria-hidden /> Timestamps in any tab seek this
                player.
              </p>
            </aside>
          </div>
        </Tabs>
      </Page>
      <DeleteVideoDialog
        video={video}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onDeleted={() => router.push(libraryHref('videos'))}
      />
    </>
  );
}

function Body({ id }: { id: string }) {
  const q = useVideo(id);
  if (q.isPending)
    return (
      <Page wide>
        <Skeleton className="h-6 w-24" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-64 w-full" />
      </Page>
    );
  if (q.isError)
    return (
      <Page>
        <EmptyState
          size="lg"
          icon={q.error.code === 'NOT_FOUND' ? Film : CircleAlert}
          title={
            q.error.code === 'NOT_FOUND'
              ? 'This video is not in your library'
              : 'Could not open this video'
          }
          description={
            q.error.code === 'NOT_FOUND'
              ? 'It may have been deleted. Your other videos are still in the Library.'
              : q.error.message
          }
          actions={
            <>
              <Button variant="primary" asChild>
                <Link href={libraryHref('videos')}>Back to Library</Link>
              </Button>
              {q.error.code !== 'NOT_FOUND' ? (
                <Button variant="outline" onClick={() => void q.refetch()}>
                  Try again
                </Button>
              ) : null}
            </>
          }
        />
      </Page>
    );
  return (
    <PlayerProvider>
      <Loaded id={id} data={q.data} />
    </PlayerProvider>
  );
}

export function VideoDetail() {
  const params = useSearchParams();
  const id = params.get('id');
  if (!id)
    return (
      <Page>
        <EmptyState
          size="lg"
          icon={Film}
          title="No video selected"
          description="Open a video from the Library to see its transcript, chapters and clips."
          actions={
            <Button variant="primary" asChild>
              <Link href={libraryHref('videos')}>Go to Library</Link>
            </Button>
          }
        />
      </Page>
    );
  return <Body key={id} id={id} />;
}
