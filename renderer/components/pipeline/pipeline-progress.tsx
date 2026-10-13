'use client';

import * as React from 'react';
import Link from 'next/link';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AudioLines,
  Check,
  ChevronDown,
  CircleAlert,
  CloudUpload,
  Download,
  Film,
  Layers,
  Lightbulb,
  Loader2,
  RotateCcw,
  Sparkles,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { PipelineStage, StageState, VideoView } from '@shared/pipeline';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import { duration, ease } from '@/lib/motion';
import { formatSpan } from '@/lib/format';
import {
  PIPELINE_STAGES,
  STAGE_LABELS,
  classifyFailure,
  currentStage,
  mergeStages,
  overallProgress,
  stagesFromVideo,
} from '@/lib/pipeline-ui';
import { usePipelineLog } from '@/lib/pipeline-log';
import { useCancelPipeline, useRetryStage } from '@/lib/library';

export const STAGE_ICONS: Record<PipelineStage, LucideIcon> = {
  ingest: Download,
  prepare: Layers,
  transcribe: AudioLines,
  understand: Lightbulb,
  moments: Sparkles,
  render: Film,
  finalize: CloudUpload,
};

/** Re-renders every second while `active`, so elapsed timers tick without a store. */
function useTicker(active: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

function stageDuration(s: StageState): string | null {
  if (s.startedAt === null || s.finishedAt === null) return null;
  const sec = (s.finishedAt - s.startedAt) / 1000;
  return sec < 1 ? '<1s' : formatSpan(sec);
}

/* ------------------------------------------------------ segments ------------------------------------------------ */

/** Seven slim bars, one per stage: the compact "where is it" glance. */
export function StageSegments({ stages, className }: { stages: StageState[]; className?: string }) {
  return (
    <ol className={cn('flex gap-1', className)} aria-label="Pipeline stages">
      {mergeStages(stages).map((s) => (
        <li
          key={s.stage}
          title={`${STAGE_LABELS[s.stage]}: ${s.status}`}
          data-stage={s.stage}
          data-status={s.status}
          className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
        >
          {s.status === 'done' || s.status === 'skipped' ? (
            <span className="absolute inset-0 rounded-full bg-success" />
          ) : s.status === 'running' ? (
            s.progress === null ? (
              <span className="absolute inset-y-0 left-0 w-1/2 animate-indeterminate rounded-full bg-primary" />
            ) : (
              <span
                className="absolute inset-y-0 left-0 rounded-full bg-primary transition-[width] duration-(--duration-slow) ease-(--ease-standard)"
                style={{ width: `${Math.round(s.progress * 100)}%` }}
              />
            )
          ) : s.status === 'failed' ? (
            <span className="absolute inset-0 rounded-full bg-danger" />
          ) : s.status === 'canceled' ? (
            <span className="absolute inset-0 rounded-full bg-border-strong" />
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/* ------------------------------------------------------- compact ------------------------------------------------ */

export function PipelineProgressCompact({
  video,
  stages,
  onCancel,
  className,
}: {
  video: Pick<VideoView, 'id' | 'status' | 'stage' | 'progress' | 'error'>;
  stages?: StageState[];
  onCancel?: () => void;
  className?: string;
}) {
  const merged = React.useMemo(
    () => (stages ? mergeStages(stages) : stagesFromVideo(video)),
    [stages, video],
  );
  const cur = currentStage(merged);
  const failed = video.status === 'failed';
  const curProgress = cur?.progress ?? null;
  const pct = curProgress === null ? null : Math.round(curProgress * 100);
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)} data-testid="pipeline-compact">
      <div className="flex items-center gap-2 text-xs">
        <span
          className={cn(
            'flex min-w-0 items-center gap-1.5 font-medium',
            failed ? 'text-danger' : 'text-foreground',
          )}
        >
          {failed ? (
            <CircleAlert className="size-3.5 shrink-0" aria-hidden />
          ) : video.status === 'canceled' ? null : (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-primary-text" aria-hidden />
          )}
          <span className="truncate">
            {failed
              ? `Failed at ${cur ? STAGE_LABELS[cur.stage] : 'a step'}`
              : video.status === 'canceled'
                ? 'Canceled'
                : cur
                  ? STAGE_LABELS[cur.stage]
                  : 'Starting…'}
          </span>
          {pct !== null && !failed ? (
            <span className="tabular-nums text-muted-foreground">{pct}%</span>
          ) : null}
        </span>
        {cur?.detail && !failed ? (
          <span className="ml-auto min-w-0 truncate tabular-nums text-subtle">{cur.detail}</span>
        ) : null}
        {onCancel && !failed && video.status !== 'canceled' ? (
          <Button
            variant="ghost"
            size="icon-xs"
            className={cn('size-6', cur?.detail ? '' : 'ml-auto')}
            aria-label="Cancel clipping"
            onClick={onCancel}
          >
            <X className="size-3.5" />
          </Button>
        ) : null}
      </div>
      <StageSegments stages={merged} />
    </div>
  );
}

/* --------------------------------------------------------- full -------------------------------------------------- */

function StageRow({ s, last, videoId }: { s: StageState; last: boolean; videoId: string }) {
  const retry = useRetryStage();
  const Icon = STAGE_ICONS[s.stage];
  const running = s.status === 'running';
  const failed = s.status === 'failed';
  const done = s.status === 'done' || s.status === 'skipped';
  const recovery = failed ? classifyFailure(s.error) : null;
  const dur = done ? stageDuration(s) : null;
  const text = [s.message, running ? s.detail : null].filter(Boolean).join(' · ');
  const compact = !running && !failed;
  return (
    <li
      data-stage={s.stage}
      data-status={s.status}
      aria-current={running ? 'step' : undefined}
      className={cn('relative flex gap-3.5', compact ? 'pb-2' : 'pb-4', last && 'pb-0')}
    >
      {!last ? (
        <span
          aria-hidden
          className={cn(
            'absolute left-[13px] top-8 bottom-0 w-px',
            done ? 'bg-success/40' : 'bg-border',
          )}
        />
      ) : null}
      <span
        className={cn(
          'relative z-[1] flex size-7 shrink-0 items-center justify-center rounded-full border transition-colors duration-(--duration-base)',
          done && 'border-transparent bg-success-soft text-success',
          running && 'border-transparent bg-primary text-primary-foreground',
          failed && 'border-transparent bg-danger-soft text-danger',
          (s.status === 'pending' || s.status === 'canceled') &&
            'border-border-strong bg-card text-subtle',
        )}
      >
        {done ? (
          <motion.span
            initial={{ scale: 0.4 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', stiffness: 520, damping: 18 }}
          >
            <Check className="size-3.5" strokeWidth={2.6} aria-hidden />
          </motion.span>
        ) : running ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
        ) : failed ? (
          <CircleAlert className="size-3.5" aria-hidden />
        ) : (
          <Icon className="size-3.5" aria-hidden />
        )}
      </span>
      <div className="min-w-0 flex-1 pt-1">
        <div className="flex items-baseline gap-2">
          <p
            className={cn(
              'shrink-0 text-sm font-semibold leading-5',
              s.status === 'pending' || s.status === 'canceled'
                ? 'text-muted-foreground'
                : 'text-foreground',
            )}
          >
            {STAGE_LABELS[s.stage]}
          </p>
          <span className="sr-only">{s.status}</span>
          {running && s.progress !== null ? (
            <span className="text-xs font-medium tabular-nums text-primary-text">
              {Math.round(s.progress * 100)}%
            </span>
          ) : null}
          {done && text ? (
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{text}</span>
          ) : null}
          <span className="ml-auto shrink-0 text-xs tabular-nums text-subtle">
            {dur ??
              (s.status === 'canceled' ? 'Canceled' : s.status === 'skipped' ? 'Skipped' : '')}
          </span>
        </div>
        {running ? (
          <div className="mt-1.5 flex flex-col gap-1.5">
            <Progress
              value={s.progress === null ? null : s.progress * 100}
              className="h-1.5"
              aria-label={`${STAGE_LABELS[s.stage]} progress`}
            />
            <p className="min-h-4 truncate text-xs text-muted-foreground tabular-nums">
              {text || 'Working…'}
            </p>
          </div>
        ) : null}
        {failed ? (
          <div
            role="alert"
            className="mt-2 rounded-lg border border-danger/35 bg-danger-soft px-3.5 py-3"
          >
            <p className="text-sm font-semibold text-foreground">{recovery?.title}</p>
            <p
              className="selectable mt-1 break-words text-xs text-muted-foreground"
              data-testid="stage-error"
            >
              {s.error ?? 'No error message was reported.'}
            </p>
            {recovery ? <p className="mt-1.5 text-xs text-foreground">{recovery.hint}</p> : null}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="primary"
                loading={retry.isPending}
                onClick={() => retry.mutate({ videoId, stage: s.stage })}
              >
                <RotateCcw /> Retry {STAGE_LABELS[s.stage].toLowerCase()}
              </Button>
              {recovery?.action ? (
                <Button size="sm" variant="outline" asChild>
                  <Link href={recovery.action.href}>{recovery.action.label}</Link>
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </li>
  );
}

function RunLog({ videoId }: { videoId: string }) {
  const entries = usePipelineLog((s) => s.byVideo[videoId]);
  const [open, setOpen] = React.useState(false);
  const endRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [open, entries?.length]);
  const first = entries?.[0]?.at ?? 0;
  return (
    <div className="border-t">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-5 py-2.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronDown
          className={cn(
            'size-3.5 transition-transform duration-(--duration-base)',
            open && 'rotate-180',
          )}
          aria-hidden
        />
        {open ? 'Hide run log' : 'Show run log'}
        <span className="tabular-nums text-subtle">{entries?.length ?? 0}</span>
      </button>
      {open ? (
        <div
          className="scrollbar-thin selectable max-h-48 overflow-y-auto border-t bg-field px-5 py-3 font-mono text-2xs leading-5 text-muted-foreground"
          role="log"
          aria-label="Run log"
        >
          {entries?.length ? (
            entries.map((e, i) => (
              <p key={i} className="whitespace-pre-wrap break-words">
                <span className="text-subtle">+{formatSpan((e.at - first) / 1000)}</span>{' '}
                <span
                  className={cn(
                    e.status === 'failed'
                      ? 'text-danger'
                      : e.status === 'done'
                        ? 'text-success'
                        : 'text-foreground',
                  )}
                >
                  {STAGE_LABELS[e.stage]}
                </span>{' '}
                <span>{e.status}</span>
                {e.text ? <span> · {e.text}</span> : null}
              </p>
            ))
          ) : (
            <p className="font-sans text-xs text-subtle">
              Log lines appear here as the pipeline reports progress while Clipfern is open.
            </p>
          )}
          <div ref={endRef} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The live pipeline view: 7 stages with status icon, determinate/indeterminate progress, message + ETA, an expandable
 * run log, per-stage Retry on failure (with a recovery action) and a whole-run Cancel.
 */
export function PipelineProgress({
  video,
  stages,
  className,
}: {
  video: VideoView;
  stages: StageState[];
  className?: string;
}) {
  const cancel = useCancelPipeline();
  const retry = useRetryStage();
  const merged = React.useMemo(() => mergeStages(stages), [stages]);
  const active =
    video.status === 'ingesting' || video.status === 'processing' || video.status === 'new';
  const now = useTicker(active);
  const cur = currentStage(merged);
  const overall = video.status === 'ready' ? 1 : overallProgress(merged);
  const started =
    merged.reduce<number | null>(
      (m, s) => (s.startedAt !== null && (m === null || s.startedAt < m) ? s.startedAt : m),
      null,
    ) ?? video.createdAt;
  const ended = merged.reduce<number | null>(
    (m, s) => (s.finishedAt !== null && (m === null || s.finishedAt > m) ? s.finishedAt : m),
    null,
  );
  const elapsedMs = Math.max(0, (active ? now : (ended ?? video.updatedAt)) - started);
  const [expanded, setExpanded] = React.useState<boolean | null>(null);
  const failedStage = merged.find((s) => s.status === 'failed');
  // once clips start arriving the stage list folds into a one-line summary so the live clip grid stays on screen
  const clipsStarted = active && video.clipCount > 0 && !failedStage;
  const collapsible = video.status === 'ready' || clipsStarted;
  const showRows = collapsible ? expanded === true : true;

  const title =
    video.status === 'ready'
      ? 'Clipping finished'
      : video.status === 'failed'
        ? `Stopped at ${STAGE_LABELS[(failedStage ?? cur)?.stage ?? 'ingest']}`
        : video.status === 'canceled'
          ? 'Clipping canceled'
          : 'Clipping in progress';
  const subtitle =
    video.status === 'ready'
      ? `Done in ${formatSpan(elapsedMs / 1000)} · ${video.clipCount} ${video.clipCount === 1 ? 'clip' : 'clips'}${video.topScore !== null ? ` · top score ${video.topScore}` : ''}`
      : video.status === 'failed'
        ? 'Everything finished before this point is kept, so a retry resumes here.'
        : video.status === 'canceled'
          ? 'Finished stages are kept. Resume to continue where it stopped.'
          : (cur?.message ?? cur?.detail ?? 'Starting…');

  const resumeStage: PipelineStage =
    merged.find((s) => s.status === 'canceled')?.stage ??
    merged.find((s) => s.status !== 'done' && s.status !== 'skipped')?.stage ??
    'ingest';

  return (
    <section
      aria-label="Pipeline progress"
      data-testid="pipeline-progress"
      data-status={video.status}
      className={cn('overflow-hidden rounded-xl border bg-card shadow-xs', className)}
    >
      <div className="flex items-center gap-4 px-5 py-4">
        <span
          className={cn(
            'flex size-10 shrink-0 items-center justify-center rounded-xl',
            video.status === 'ready' && 'bg-success-soft text-success',
            video.status === 'failed' && 'bg-danger-soft text-danger',
            video.status === 'canceled' && 'bg-muted text-muted-foreground',
            active && 'bg-primary-soft text-primary-text',
          )}
        >
          {video.status === 'ready' ? (
            <Check className="size-5" aria-hidden />
          ) : video.status === 'failed' ? (
            <CircleAlert className="size-5" aria-hidden />
          ) : video.status === 'canceled' ? (
            <X className="size-5" aria-hidden />
          ) : (
            <Sparkles className="size-5" aria-hidden />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="font-display text-lg font-semibold leading-6">{title}</h2>
            {active ? (
              <Badge variant="primary" dot className="tabular-nums">
                {Math.round(overall * 100)}%
              </Badge>
            ) : null}
          </div>
          <p className="truncate text-sm text-muted-foreground tabular-nums">{subtitle}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {active ? (
            <span
              className="mr-1 hidden text-xs tabular-nums text-subtle sm:inline"
              aria-label="Elapsed time"
            >
              {formatSpan(elapsedMs / 1000)} elapsed
            </span>
          ) : null}
          {active ? (
            <Button
              variant="outline"
              size="sm"
              loading={cancel.isPending}
              onClick={() => cancel.mutate({ videoId: video.id })}
            >
              <X /> Cancel
            </Button>
          ) : null}
          {video.status === 'canceled' ? (
            <Button
              variant="primary"
              size="sm"
              loading={retry.isPending}
              onClick={() => retry.mutate({ videoId: video.id, stage: resumeStage })}
            >
              <RotateCcw /> Resume from {STAGE_LABELS[resumeStage].toLowerCase()}
            </Button>
          ) : null}
          {collapsible ? (
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={showRows}
              onClick={() => setExpanded(!showRows)}
            >
              Details
              <ChevronDown
                className={cn(
                  'transition-transform duration-(--duration-base)',
                  showRows && 'rotate-180',
                )}
              />
            </Button>
          ) : null}
        </div>
      </div>
      {clipsStarted && !showRows ? (
        <div className="px-5 pb-4">
          <StageSegments stages={merged} />
        </div>
      ) : null}
      {!collapsible ? (
        <Progress
          value={overall * 100}
          tone={
            video.status === 'failed'
              ? 'danger'
              : video.status === 'canceled'
                ? 'warning'
                : 'primary'
          }
          className="h-1 rounded-none"
          aria-label="Overall progress"
        />
      ) : null}
      <AnimatePresence initial={false}>
        {showRows ? (
          <motion.div
            key="rows"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: duration.base, ease: ease.standard }}
            className="overflow-hidden"
          >
            <ol className="border-t px-5 pb-4 pt-5">
              {merged.map((s, i) => (
                <StageRow
                  key={s.stage}
                  s={s}
                  last={i === PIPELINE_STAGES.length - 1}
                  videoId={video.id}
                />
              ))}
            </ol>
            <RunLog videoId={video.id} />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </section>
  );
}
