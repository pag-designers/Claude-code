'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { CircleAlert, Film } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Page } from '@/components/ui/page';
import { Skeleton } from '@/components/ui/skeleton';
import { PipelineProgress } from '@/components/pipeline/pipeline-progress';
import { useAllClips, useVideo } from '@/lib/library';
import { isActiveVideo, mergeStages } from '@/lib/pipeline-ui';
import { TOOL_ROUTE_META, rememberVideo, toolHref, type ToolRouteId } from '@/lib/cp2-tools';
import { ClipTool, MomentsTool } from './clip-tools';
import { ReframeTool } from './reframe-tool';
import { NoClipsYet, SubtitlesTool, SummaryTool, TranscriptsTool } from './tool-bodies';
import { ToolShell } from './tool-shell';
import { VideoPicker } from './video-picker';

type Detail = NonNullable<ReturnType<typeof useVideo>['data']>;

function Workspace({
  tool,
  videoId,
  clipId,
}: {
  tool: ToolRouteId;
  videoId: string;
  clipId: string | null;
}) {
  const router = useRouter();
  const q = useVideo(videoId);
  const change = React.useCallback(() => router.push(toolHref(tool)), [router, tool]);
  const selectClip = React.useCallback(
    (id: string) => router.replace(toolHref(tool, { video: videoId, clip: id })),
    [router, tool, videoId],
  );

  if (q.isPending)
    return (
      <ToolShell tool={tool} wide>
        <Skeleton className="h-20 w-full rounded-xl" />
        <Skeleton className="h-72 w-full rounded-xl" />
      </ToolShell>
    );
  if (q.isError)
    return (
      <ToolShell tool={tool}>
        <EmptyState
          size="md"
          icon={q.error.code === 'NOT_FOUND' ? Film : CircleAlert}
          title={
            q.error.code === 'NOT_FOUND'
              ? 'This video is not in your library'
              : 'Could not open this video'
          }
          description={
            q.error.code === 'NOT_FOUND'
              ? 'It may have been deleted. Choose another video to continue.'
              : q.error.message
          }
          actions={
            <>
              <Button variant="primary" onClick={change}>
                Choose a video
              </Button>
              {q.error.code !== 'NOT_FOUND' ? (
                <Button variant="outline" onClick={() => void q.refetch()}>
                  Try again
                </Button>
              ) : null}
            </>
          }
        />
      </ToolShell>
    );
  return (
    <Loaded tool={tool} data={q.data} clipId={clipId} onChange={change} onSelectClip={selectClip} />
  );
}

function Loaded({
  tool,
  data,
  clipId,
  onChange,
  onSelectClip,
}: {
  tool: ToolRouteId;
  data: Detail;
  clipId: string | null;
  onChange: () => void;
  onSelectClip: (id: string) => void;
}) {
  const { video, analysis } = data;
  const stages = mergeStages(data.stages);
  const progress = isActiveVideo(video) || video.status === 'failed' || video.status === 'canceled';
  const meta = TOOL_ROUTE_META[tool];
  const waiting = isActiveVideo(video);
  // clip tools cannot work on a video that has finished without any clips
  const clipsMissing =
    meta.needs === 'clips' && !waiting && video.status === 'ready' && video.clipCount === 0;

  let body: React.ReactNode;
  if (tool === 'summary') body = <SummaryTool video={video} analysis={analysis} />;
  else if (tool === 'transcripts') body = <TranscriptsTool video={video} analysis={analysis} />;
  else if (tool === 'subtitles') body = <SubtitlesTool video={video} analysis={analysis} />;
  else if (clipsMissing)
    body = <NoClipsYet video={video} tool={tool === 'reframe' ? 're-frame' : tool} />;
  else if (tool === 'reframe') body = <ReframeTool video={video} />;
  else if (tool === 'find-moments' || tool === 'highlights')
    body = <MomentsTool video={video} tool={tool} />;
  else body = <ClipTool video={video} tool={tool} clipId={clipId} onSelectClip={onSelectClip} />;

  return (
    <ToolShell tool={tool} video={video} onChange={onChange} wide>
      {progress ? <PipelineProgress video={video} stages={stages} /> : null}
      {body}
    </ToolShell>
  );
}

/** `/tools/<tool>/?video=<id>&clip=<id>`: picker first, then the tool on the chosen library item. */
export function ToolRoute({ tool }: { tool: ToolRouteId }) {
  const router = useRouter();
  const params = useSearchParams();
  const urlVideo = params.get('video');
  const urlClip = params.get('clip');
  const meta = TOOL_ROUTE_META[tool];

  // a clip link alone is enough: its video is looked up
  const clips = useAllClips();
  const clipOwner =
    !urlVideo && urlClip ? clips.data?.items.find((c) => c.id === urlClip)?.videoId : undefined;
  const resolvingClip = !urlVideo && !!urlClip && clips.isPending;
  const videoId = urlVideo ?? clipOwner ?? null;

  React.useEffect(() => {
    if (videoId) rememberVideo(videoId);
  }, [videoId]);

  const pick = React.useCallback(
    (id: string) => {
      rememberVideo(id);
      router.push(toolHref(tool, { video: id }));
    },
    [router, tool],
  );

  if (resolvingClip)
    return (
      <Page>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </Page>
    );

  if (videoId)
    return <Workspace key={`${tool}:${videoId}`} tool={tool} videoId={videoId} clipId={urlClip} />;

  return (
    <ToolShell tool={tool}>
      {urlClip ? (
        <EmptyState
          size="sm"
          icon={CircleAlert}
          title="That clip is not in your library"
          description="It may have been deleted. Choose a video below to continue."
        />
      ) : null}
      <VideoPicker tool={tool} meta={meta} onPick={pick} />
    </ToolShell>
  );
}
