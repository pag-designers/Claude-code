'use client';

import * as React from 'react';
import Link from 'next/link';
import { Clapperboard, Copy, Download, FileText, Scissors } from 'lucide-react';
import { toast } from 'sonner';
import type { VideoAnalysis, VideoView } from '@shared/pipeline';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { Segmented } from '@/components/ui/segmented';
import { SubtitlesTab } from '@/components/subtitles/subtitles-tab';
import { ChaptersTab } from '@/components/video/chapters-tab';
import { NotesTab } from '@/components/video/notes-tab';
import { OverviewTab } from '@/components/video/overview-tab';
import { ProxyPlayer } from '@/components/video/proxy-player';
import { TranscriptTab } from '@/components/video/transcript-tab';
import { copyText } from '@/lib/clipboard';
import { invoke } from '@/lib/ipc';
import { useTranscript, useVideoClips } from '@/lib/library';
import { PlayerProvider } from '@/lib/player';
import { downloadText, slugify, summaryToMarkdown, toolHref } from '@/lib/cp2-tools';
import { transcriptToText } from '@/lib/transcript';

/** Two-column layout used by every tool that is driven by playback: content left, the proxy player right. */
export function WithPlayer({
  video,
  analysis,
  children,
}: {
  video: VideoView;
  analysis: VideoAnalysis | null;
  children: React.ReactNode;
}) {
  return (
    <PlayerProvider>
      <div className="grid grid-cols-[minmax(0,1fr)_380px] items-start gap-6 max-[1100px]:grid-cols-1">
        <div className="min-w-0">{children}</div>
        <aside
          aria-label="Source video"
          className="sticky top-4 max-[1100px]:static max-[1100px]:order-first"
        >
          <ProxyPlayer video={video} chapters={analysis?.chapters ?? []} />
          <p className="mt-3 flex items-center gap-1.5 px-1 text-xs text-subtle">
            <Clapperboard className="size-3.5" aria-hidden /> Timestamps here seek this player.
          </p>
        </aside>
      </div>
    </PlayerProvider>
  );
}

/* ------------------------------------------------------------ summary ---------------------------------------- */

type Section = 'overview' | 'chapters' | 'notes';

export function SummaryTool({
  video,
  analysis,
}: {
  video: VideoView;
  analysis: VideoAnalysis | null;
}) {
  const [section, setSection] = React.useState<Section>('overview');
  const clips = useVideoClips(video.id);
  const markdown = () =>
    analysis
      ? summaryToMarkdown(
          video.title,
          { channel: video.channel, sourceUrl: video.sourceUrl, durationSec: video.durationSec },
          analysis,
        )
      : '';
  const copy = async () => {
    if (await copyText(markdown())) toast.success('Summary copied as Markdown');
    else toast.error('Could not copy to the clipboard');
  };
  const download = () => {
    downloadText(`${slugify(video.title)}-summary.md`, markdown(), 'text/markdown');
    toast.success('Summary downloaded', { description: `${slugify(video.title)}-summary.md` });
  };
  return (
    <WithPlayer video={video} analysis={analysis}>
      <div className="flex flex-col gap-5" data-testid="summary-tool">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Segmented<Section>
            label="Summary section"
            value={section}
            onValueChange={setSection}
            options={[
              { value: 'overview', label: 'Overview' },
              { value: 'chapters', label: 'Chapters' },
              { value: 'notes', label: 'Notes' },
            ]}
          />
          <div className="flex items-center gap-2">
            <Button variant="outline" disabled={!analysis} onClick={() => void copy()}>
              <Copy /> Copy as Markdown
            </Button>
            <Button variant="outline" disabled={!analysis} onClick={download}>
              <Download /> Download .md
            </Button>
          </div>
        </div>
        {section === 'overview' ? (
          <OverviewTab video={video} analysis={analysis} />
        ) : section === 'chapters' ? (
          <ChaptersTab video={video} analysis={analysis} clips={clips.data?.items ?? []} />
        ) : (
          <NotesTab video={video} analysis={analysis} />
        )}
      </div>
    </WithPlayer>
  );
}

/* ---------------------------------------------------------- transcripts ---------------------------------------- */

export function TranscriptsTool({
  video,
  analysis,
}: {
  video: VideoView;
  analysis: VideoAnalysis | null;
}) {
  const t = useTranscript(video.id);
  const stem = slugify(video.title);
  const txt = () => {
    if (!t.data) return;
    downloadText(`${stem}-transcript.txt`, transcriptToText(t.data), 'text/plain');
    toast.success('Transcript downloaded', { description: `${stem}-transcript.txt` });
  };
  const exportCaptions = async (format: 'srt' | 'vtt') => {
    try {
      const r = await invoke('subtitles:export', { videoId: video.id, format });
      if (r.saved)
        toast.success(`Exported ${format.toUpperCase()}`, { description: r.path ?? undefined });
    } catch (e) {
      toast.error('Export failed', { description: e instanceof Error ? e.message : undefined });
    }
  };
  return (
    <WithPlayer video={video} analysis={analysis}>
      <div className="flex flex-col gap-4" data-testid="transcripts-tool">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            Click any line to play from there. Exports include your subtitle edits.
          </p>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" disabled={!t.data} data-testid="transcript-download">
                <Download /> Download
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuLabel>Format</DropdownMenuLabel>
              <DropdownMenuItem onSelect={txt}>
                <FileText /> Plain text (.txt)
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void exportCaptions('srt')}>
                <FileText /> SubRip (.srt)
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void exportCaptions('vtt')}>
                <FileText /> WebVTT (.vtt)
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <TranscriptTab video={video} />
      </div>
    </WithPlayer>
  );
}

/* ----------------------------------------------------------- subtitles --------------------------------------- */

export function SubtitlesTool({
  video,
  analysis,
}: {
  video: VideoView;
  analysis: VideoAnalysis | null;
}) {
  return (
    <WithPlayer video={video} analysis={analysis}>
      <div data-testid="subtitles-tool">
        <SubtitlesTab video={video} />
      </div>
    </WithPlayer>
  );
}

/* --------------------------------------------------- analysis-only videos -------------------------------------- */

/** A video analysed without clips has nothing for the clip tools; point at the tool that makes clips. */
export function NoClipsYet({ video, tool }: { video: VideoView; tool: string }) {
  return (
    <EmptyState
      size="md"
      icon={Scissors}
      title="This video has no clips yet"
      description={
        video.options.mode === 'analysis'
          ? `It was analysed without clips, so there is nothing to ${tool} yet. Find some moments first.`
          : `There is nothing to ${tool} until the video has clips. Find some moments first.`
      }
      actions={
        <>
          <Button variant="primary" asChild>
            <Link href={toolHref('find-moments', { video: video.id })}>Find moments</Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href={toolHref('highlights', { video: video.id })}>Build a highlight reel</Link>
          </Button>
        </>
      }
    />
  );
}
