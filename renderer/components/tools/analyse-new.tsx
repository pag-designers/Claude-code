'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { CircleCheck, FileSearch, Link2, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { parseYouTubeId } from '@shared/pipeline';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DisabledTip } from '@/components/ui/tooltip';
import {
  LiveRejected,
  PreviewSkeleton,
  ProbeError,
  UrlPreviewCard,
} from '@/components/home/url-preview';
import { videoHref } from '@/lib/hrefs';
import { invoke, useIpcQuery, type IpcCallError } from '@/lib/ipc';
import { useVideos } from '@/lib/library';
import { usePipelineReadiness } from '@/lib/readiness';
import { useDebounced } from '@/lib/use-debounced';
import { parseYoutubeUrl } from '@/lib/urls';

/**
 * "Analyse a new video": paste a YouTube link and run the pipeline in `analysis` mode (download, transcribe, summary,
 * chapters and notes; no clips are cut or rendered). Same URL rules and probe preview as Home.
 */
export function AnalyseNewVideo({
  onStarted,
}: {
  onStarted: (videoId: string) => void;
}) {
  const qc = useQueryClient();
  const readiness = usePipelineReadiness();
  const videos = useVideos();
  const [url, setUrl] = React.useState('');
  const [touched, setTouched] = React.useState(false);
  const [starting, setStarting] = React.useState(false);

  const raw = url.trim();
  const normalized = raw && !/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? `https://${raw}` : raw;
  const parsed = parseYoutubeUrl(raw);
  const videoId = parsed.ok ? parseYouTubeId(normalized) : null;
  const valid = parsed.ok && videoId !== null;
  const showError = touched && raw.length > 0 && !valid;

  const probeUrl = useDebounced(valid ? normalized : '', 350);
  const probeActive = valid && probeUrl === normalized;
  const probe = useIpcQuery(
    'pipeline:probe',
    { url: probeUrl },
    { enabled: probeActive, staleTime: Infinity, gcTime: 10 * 60_000, retry: false },
  );
  const probing = valid && (!probeActive || probe.isFetching);
  const live = probeActive && probe.data?.isLive === true;
  const probeFailed = probeActive && probe.isError;
  const existing = videoId
    ? videos.data?.items.find(
        (v) => v.sourceId === videoId && v.status !== 'failed' && v.status !== 'canceled',
      )
    : undefined;

  const first = readiness.blockers[0];
  const disabledReason = !valid
    ? 'Paste a valid YouTube link first.'
    : readiness.loading
      ? 'Checking your setup…'
      : first
        ? first.message
        : live
          ? 'Live streams cannot be analysed until they have ended.'
          : probeFailed
            ? 'Fix the link problem above, then try again.'
            : null;

  const submit = async () => {
    setTouched(true);
    if (disabledReason || starting) return;
    setStarting(true);
    try {
      const { videoId: id } = await invoke('pipeline:start', {
        url: normalized,
        options: { mode: 'analysis' },
      });
      void qc.invalidateQueries({ queryKey: ['videos:list'] });
      toast.success('Analysis started', {
        description: 'Transcript, summary and chapters appear as each step finishes.',
      });
      onStarted(id);
    } catch (e) {
      toast.error('Could not start the analysis', { description: (e as IpcCallError).message });
    } finally {
      setStarting(false);
    }
  };

  return (
    <section
      aria-labelledby="analyse-title"
      className="rounded-2xl border bg-card p-5"
      data-testid="analyse-new"
    >
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary-text">
          <FileSearch className="size-4.5" aria-hidden />
        </span>
        <div className="min-w-0">
          <h2 id="analyse-title" className="font-display text-md font-semibold">
            Analyse a new video
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Paste a YouTube link to get its transcript, summary and chapters. No clips are rendered, so it
            is quick and cheap.
          </p>
        </div>
      </div>

      <form
        className="mt-4 flex flex-col gap-2"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="flex items-start gap-3">
          <div className="flex-1">
            <Input
              aria-label="YouTube URL to analyse"
              aria-describedby="analyse-url-status"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onBlur={() => setTouched(true)}
              placeholder="https://www.youtube.com/watch?v=…"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              invalid={showError}
              leading={<Link2 />}
              className="h-10"
            />
          </div>
          {disabledReason ? (
            <DisabledTip reason={disabledReason} side="bottom">
              <Button type="submit" variant="primary" size="md" disabled className="h-10">
                Analyse
              </Button>
            </DisabledTip>
          ) : (
            <Button type="submit" variant="primary" className="h-10" loading={starting}>
              Analyse
            </Button>
          )}
        </div>
        <div id="analyse-url-status" className="min-h-5 text-sm" aria-live="polite">
          {showError && !parsed.ok ? (
            <p className="flex items-center gap-1.5 text-danger">
              <TriangleAlert className="size-4 shrink-0" aria-hidden />
              {parsed.reason}
            </p>
          ) : valid && !probeFailed ? (
            <p className="flex items-center gap-1.5 text-success">
              <CircleCheck className="size-4 shrink-0" aria-hidden />
              Valid YouTube link · ID <span className="selectable font-mono">{videoId}</span>
            </p>
          ) : (
            <p className="text-subtle">Supports youtube.com/watch, youtu.be, /shorts and /live links.</p>
          )}
        </div>
      </form>

      {valid ? (
        <div className="mt-2 flex flex-col gap-3">
          {probing && !probe.data ? <PreviewSkeleton /> : null}
          {probeActive && probe.data ? <UrlPreviewCard info={probe.data} /> : null}
          {live ? <LiveRejected /> : null}
          {probeFailed ? (
            <ProbeError
              message={probe.error.message}
              onRetry={() => void probe.refetch()}
              retrying={probe.isFetching}
            />
          ) : null}
          {existing ? (
            <Banner
              tone="info"
              title="This video is already in your library"
              action={
                <Button size="sm" variant="outline" onClick={() => onStarted(existing.id)}>
                  Use it
                </Button>
              }
            >
              Choose it from the list below, or analyse it again to refresh the transcript.{' '}
              <Link className="font-medium text-primary-text hover:underline" href={videoHref(existing.id)}>
                Open the video
              </Link>
            </Banner>
          ) : null}
        </div>
      ) : null}

      {first && valid ? (
        <Banner
          tone="warning"
          title="Finish setup to analyse a video"
          className="mt-3"
          action={
            <Button size="sm" variant="outline" asChild>
              <Link href={first.href}>{first.action}</Link>
            </Button>
          }
        >
          {first.message}
        </Banner>
      ) : null}
    </section>
  );
}
