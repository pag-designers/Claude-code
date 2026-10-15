'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  CircleAlert,
  CircleCheck,
  Clock,
  Download,
  Loader2,
  Play,
  SquarePen,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import type { ExportJob } from '@shared/editor';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Tip } from '@/components/ui/tooltip';
import { ScheduleButton } from '@/components/scheduler';
import { formatBytes, formatClock, timeAgo } from '@/lib/format';
import { editorHref, libraryHref } from '@/lib/hrefs';
import { invoke, IpcCallError } from '@/lib/ipc';
import { presetLabel } from '@/lib/editor-panels/export-logic';
import {
  isActiveExport,
  removeExports,
  useExports,
  useExportUrl,
} from '@/lib/editor-panels/projects';
import { useInView } from '@/lib/use-in-view';
import { useQueryClient } from '@tanstack/react-query';
import { cn } from '@/lib/utils';

const GRID = 'grid grid-cols-[repeat(auto-fill,minmax(236px,1fr))] gap-4';

function StatusChip({ job, className }: { job: ExportJob; className?: string }) {
  const base =
    'inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-full px-2 text-2xs font-semibold backdrop-blur-sm';
  switch (job.status) {
    case 'rendering':
      return (
        <span
          className={cn(base, 'bg-primary text-primary-foreground', className)}
          data-testid="export-status"
        >
          <Loader2 className="size-3 animate-spin" aria-hidden />
          Rendering{job.progress !== null ? ` ${Math.round(job.progress * 100)}%` : ''}
        </span>
      );
    case 'queued':
      return (
        <span
          className={cn(base, 'bg-card/90 text-muted-foreground', className)}
          data-testid="export-status"
        >
          <Clock className="size-3" aria-hidden /> Queued
        </span>
      );
    case 'done':
      return (
        <span
          className={cn(base, 'bg-success-soft text-success', className)}
          data-testid="export-status"
        >
          <CircleCheck className="size-3" aria-hidden /> Ready
        </span>
      );
    case 'failed':
      return (
        <span
          className={cn(base, 'bg-danger-solid text-white', className)}
          data-testid="export-status"
        >
          <CircleAlert className="size-3" aria-hidden /> Failed
        </span>
      );
    case 'canceled':
      return (
        <span
          className={cn(base, 'bg-card/90 text-muted-foreground', className)}
          data-testid="export-status"
        >
          <X className="size-3" aria-hidden /> Canceled
        </span>
      );
  }
}

function PlayDialog({ job, onClose }: { job: ExportJob | null; onClose: () => void }) {
  const video = useExportUrl(job?.id ?? '', 'video', !!job);
  return (
    <Dialog open={!!job} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[min(92vw,720px)]" data-testid="export-play-dialog">
        <div className="border-b px-6 pb-3 pt-4 pr-14">
          <DialogTitle className="truncate font-display text-md font-semibold">
            {job?.name}
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {job ? `${job.settings.width}×${job.settings.height} · ${job.settings.fps} fps` : ''}
          </DialogDescription>
        </div>
        <div className="flex min-h-0 items-center justify-center bg-black">
          {video.data?.url ? (
            <video
              key={job?.id}
              src={video.data.url}
              controls
              autoPlay
              playsInline
              data-testid="export-play-video"
              className="max-h-[68vh] w-full object-contain"
              style={
                job ? { aspectRatio: `${job.settings.width} / ${job.settings.height}` } : undefined
              }
              onError={() => void video.refetch()}
            />
          ) : (
            <div className="flex h-64 items-center justify-center text-white/70">
              {video.isPending ? (
                <Loader2 className="size-5 animate-spin" aria-hidden />
              ) : (
                <p className="text-sm">The video file is not available.</p>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ExportCard({
  job,
  onPlay,
  onDelete,
}: {
  job: ExportJob;
  onPlay: (j: ExportJob) => void;
  onDelete: (j: ExportJob) => void;
}) {
  const [ref, inView] = useInView<HTMLDivElement>();
  const thumb = useExportUrl(job.id, 'thumb', inView && job.hasThumb);
  const [saving, setSaving] = React.useState(false);
  const [canceling, setCanceling] = React.useState(false);
  const active = isActiveExport(job);
  const s = job.settings;

  const download = async () => {
    setSaving(true);
    try {
      const r = await invoke('exports:download', { ids: [job.id] });
      if (r.canceled) return;
      if (r.saved > 0) toast.success('Export saved', { description: r.dir ?? undefined });
      else toast.error('Nothing was saved', { description: 'This export has no finished file.' });
    } catch (e) {
      toast.error('Download failed', {
        description: e instanceof IpcCallError ? e.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  };
  const cancel = async () => {
    setCanceling(true);
    try {
      await invoke('editor:exportCancel', { id: job.id });
    } catch (e) {
      setCanceling(false);
      toast.error('Could not cancel', {
        description: e instanceof IpcCallError ? e.message : undefined,
      });
    }
  };

  return (
    <li
      data-testid="export-card"
      data-export-id={job.id}
      data-status={job.status}
      className="group flex flex-col overflow-hidden rounded-xl border bg-card shadow-xs transition-[border-color,box-shadow] duration-(--duration-base) ease-(--ease-standard) hover:border-border-strong hover:shadow-sm"
    >
      <div ref={ref} className="relative aspect-[4/3] bg-muted">
        <button
          type="button"
          disabled={job.status !== 'done' || !job.hasFile}
          onClick={() => onPlay(job)}
          aria-label={job.status === 'done' ? `Play export: ${job.name}` : job.name}
          className="absolute inset-0 flex items-center justify-center p-3 outline-offset-[-2px] disabled:cursor-default"
        >
          {thumb.data?.url ? (
            <img
              src={thumb.data.url}
              alt=""
              draggable={false}
              loading="lazy"
              onError={() => void thumb.refetch()}
              className="max-h-full max-w-full rounded-md object-contain shadow-sm"
            />
          ) : (
            <span className="flex size-12 items-center justify-center rounded-xl border border-border-strong bg-raised text-primary-text">
              <Upload className="size-5" strokeWidth={1.75} aria-hidden />
            </span>
          )}
          {job.status === 'done' && job.hasFile ? (
            <span
              aria-hidden
              className="absolute left-1/2 top-1/2 flex size-11 -translate-x-1/2 -translate-y-1/2 scale-90 items-center justify-center rounded-full bg-black/55 text-white opacity-0 backdrop-blur-sm transition-[opacity,transform] duration-(--duration-base) group-hover:scale-100 group-hover:opacity-100"
            >
              <Play className="size-5 fill-current" />
            </span>
          ) : null}
        </button>
        <StatusChip job={job} className="absolute left-2 top-2" />
        {job.durationSec !== null ? (
          <span className="absolute bottom-2 right-2 rounded-md bg-black/60 px-1.5 py-0.5 text-2xs font-semibold tabular-nums text-white backdrop-blur-sm">
            {formatClock(job.durationSec)}
          </span>
        ) : null}
      </div>
      <div className="flex flex-1 flex-col gap-2.5 p-3">
        <div className="min-w-0">
          <h3
            className="line-clamp-2 font-sans text-sm font-semibold leading-[18px] tracking-normal"
            title={job.name}
          >
            {job.name}
          </h3>
          <p className="mt-1 line-clamp-2 text-2xs tabular-nums text-subtle">
            {presetLabel(s.preset)} · {s.width}×{s.height}
            {job.sizeBytes !== null ? ` · ${formatBytes(job.sizeBytes)}` : ''} ·{' '}
            {timeAgo(job.finishedAt ?? job.createdAt)}
          </p>
        </div>

        {active ? (
          <div className="flex flex-col gap-1.5" data-testid="export-card-progress">
            <Progress
              value={job.progress === null ? null : job.progress * 100}
              className="h-1.5"
              aria-label={`Export progress for ${job.name}`}
            />
            <p className="truncate text-2xs text-muted-foreground">
              {canceling
                ? 'Canceling…'
                : (job.message ?? (job.status === 'queued' ? 'Waiting in the queue' : 'Rendering'))}
            </p>
            <Button
              variant="outline"
              size="xs"
              disabled={canceling}
              onClick={() => void cancel()}
              data-testid="export-card-cancel"
            >
              <X /> Cancel
            </Button>
          </div>
        ) : null}

        {job.status === 'failed' ? (
          <p className="line-clamp-3 text-xs leading-4 text-danger" data-testid="export-card-error">
            {job.error ?? job.message ?? 'The render stopped unexpectedly.'}
          </p>
        ) : null}

        {!active ? (
          <div className="mt-auto flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5">
              {job.status === 'done' ? (
                <>
                  <Button
                    variant="soft"
                    size="sm"
                    className="flex-1"
                    disabled={!job.hasFile}
                    onClick={() => onPlay(job)}
                    data-testid="export-play"
                  >
                    <Play /> Play
                  </Button>
                  <Tip content="Save a copy">
                    <Button
                      variant="outline"
                      size="icon-sm"
                      aria-label={`Download ${job.name}`}
                      loading={saving}
                      disabled={!job.hasFile}
                      onClick={() => void download()}
                      data-testid="export-download"
                    >
                      <Download />
                    </Button>
                  </Tip>
                </>
              ) : null}
              {job.projectId ? (
                <Tip content="Open the project">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Open the project in the editor"
                    asChild
                  >
                    <Link href={editorHref(job.projectId)}>
                      <SquarePen />
                    </Link>
                  </Button>
                </Tip>
              ) : null}
              <Tip content="Delete export">
                <Button
                  variant="danger-ghost"
                  size="icon-sm"
                  aria-label={`Delete ${job.name}`}
                  className={job.status === 'done' ? undefined : 'ml-auto'}
                  onClick={() => onDelete(job)}
                  data-testid="export-delete"
                >
                  <Trash2 />
                </Button>
              </Tip>
            </div>
            <ScheduleButton
              sources={[{ exportId: job.id }]}
              label="Schedule"
              variant="ghost"
              size="xs"
              className="w-full"
              testId="export-card-schedule"
              disabledReason={
                job.status === 'done' && job.hasFile
                  ? undefined
                  : 'Only finished exports can be posted'
              }
            />
          </div>
        ) : null}
      </div>
    </li>
  );
}

/** Library → Exported: finished and running renders, live from `editor:export`. */
export function ExportedTab() {
  const q = useExports();
  const qc = useQueryClient();
  const [playing, setPlaying] = React.useState<ExportJob | null>(null);
  const [deleting, setDeleting] = React.useState<ExportJob | null>(null);
  const [busy, setBusy] = React.useState(false);
  const items = q.data?.items ?? [];

  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await invoke('exports:delete', { ids: [deleting.id] });
      removeExports(qc, [deleting.id]);
      void qc.invalidateQueries({ queryKey: ['storage:usage'] });
      toast.success('Export deleted');
      setDeleting(null);
    } catch (e) {
      toast.error('Could not delete the export', {
        description: e instanceof IpcCallError ? e.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-5" data-testid="exported-tab">
      {q.isError ? (
        <Banner
          tone="danger"
          title="Could not load your exports"
          action={
            <Button size="sm" variant="outline" onClick={() => void q.refetch()}>
              Retry
            </Button>
          }
        >
          {q.error.message}
        </Banner>
      ) : q.isPending ? (
        <div className={GRID} aria-busy aria-label="Loading exports">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="overflow-hidden rounded-xl border bg-card">
              <Skeleton className="aspect-[4/3] w-full rounded-none" />
              <div className="space-y-2 p-3">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          size="lg"
          icon={Upload}
          title="No exports yet"
          description="Finished renders you export from the editor (MP4, plus optional SRT/VTT) are listed here, ready to play, download or post."
          actions={
            <Button variant="outline" asChild>
              <Link href={libraryHref('edited')}>
                <SquarePen /> Open an edited project
              </Link>
            </Button>
          }
        />
      ) : (
        <>
          <p className="text-sm text-muted-foreground" data-testid="exported-count">
            {items.length} {items.length === 1 ? 'export' : 'exports'}
            {items.some(isActiveExport) ? ', rendering now' : ''}
          </p>
          <ul className={GRID} aria-label="Exports">
            {items.map((j) => (
              <ExportCard key={j.id} job={j} onPlay={setPlaying} onDelete={setDeleting} />
            ))}
          </ul>
        </>
      )}
      <PlayDialog job={playing} onClose={() => setPlaying(null)} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && !busy && setDeleting(null)}
        title="Delete this export?"
        description={
          <>
            “{deleting?.name}” and its caption files are removed from your cloud storage. The
            project it came from is not affected.
          </>
        }
        loading={busy}
        onConfirm={() => void remove()}
      />
    </div>
  );
}
