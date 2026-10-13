'use client';

import * as React from 'react';
import Link from 'next/link';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Check,
  ChevronDown,
  CircleAlert,
  Film,
  Loader2,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import type { MomentRun } from '@shared/cp2';
import { Button } from '@/components/ui/button';
import { ChipGroup } from '@/components/ui/chip-group';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Progress } from '@/components/ui/progress';
import { DisabledTip } from '@/components/ui/tooltip';
import { CharCounter, ErrorBlock, TextArea } from '@/components/library/drawer-fields';
import {
  COUNT_OPTIONS,
  LENGTH_OPTIONS,
  STEER_CHIPS,
  runStatusLabel,
  steerOptions,
  useCancelRun,
  useClipLookup,
  useClipUi,
  useCreateHighlight,
  useFindMoments,
  useMomentRuns,
  type CountChoice,
  type LengthChoice,
} from '@/lib/cp2-clips';
import { timeAgo } from '@/lib/format';
import { useVideo } from '@/lib/library';
import { classifyFailure, isActiveVideo } from '@/lib/pipeline-ui';
import { duration, ease } from '@/lib/motion';
import { cn } from '@/lib/utils';

const MAX_PROMPT = 500;

/* ----------------------------------------------------------------------------------------- run rows */

function RunRow({ run, onCancel, canceling }: { run: MomentRun; onCancel: () => void; canceling: boolean }) {
  const rec = run.status === 'failed' ? classifyFailure(run.error) : null;
  const tone =
    run.status === 'running'
      ? 'text-primary-text'
      : run.status === 'failed'
        ? 'text-danger'
        : run.status === 'done'
          ? 'text-success'
          : 'text-subtle';
  return (
    <li
      className="flex items-start gap-3 py-2.5"
      data-testid="moment-run"
      data-run-id={run.id}
      data-status={run.status}
    >
      <span className={cn('mt-0.5 flex size-5 shrink-0 items-center justify-center', tone)}>
        {run.status === 'running' ? (
          <Loader2 className="size-4 animate-spin" aria-label="Running" />
        ) : run.status === 'failed' ? (
          <CircleAlert className="size-4" aria-label="Failed" />
        ) : run.status === 'done' ? (
          <Check className="size-4" aria-label="Done" />
        ) : (
          <X className="size-4" aria-label="Canceled" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium" title={run.prompt} data-testid="run-prompt">
          “{run.prompt}”
        </p>
        <p className="text-xs text-muted-foreground">
          <span className={cn('font-medium', tone)} data-testid="run-status">
            {runStatusLabel(run)}
          </span>
          <span aria-hidden> · </span>
          {timeAgo(run.createdAt)}
        </p>
        {rec ? (
          <div className="mt-1.5 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-xs" data-testid="run-error">
            <p className="font-semibold text-foreground">{rec.kind === 'other' ? 'The search failed' : rec.title}</p>
            <p className="mt-0.5 text-muted-foreground">{rec.kind === 'other' ? run.error : rec.hint}</p>
            {rec.action ? (
              <Button asChild size="xs" variant="outline" className="mt-2">
                <Link href={rec.action.href}>{rec.action.label}</Link>
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      {run.status === 'running' ? (
        <Button
          size="xs"
          variant="outline"
          loading={canceling}
          onClick={onCancel}
          data-testid="run-cancel"
          aria-label={`Cancel search “${run.prompt}”`}
        >
          Cancel
        </Button>
      ) : null}
    </li>
  );
}

/** Filter chips: show only the clips one steering run found (the grid reads `useClipUi.runFilter`). */
function RunFilter({ videoId, runs }: { videoId: string; runs: MomentRun[] }) {
  const value = useClipUi((s) => s.runFilter[videoId] ?? null);
  const setFilter = useClipUi((s) => s.setRunFilter);
  const withClips = runs.filter((r) => r.found > 0);
  if (withClips.length === 0) return null;
  const chip = (id: string | null, label: string, count?: number) => (
    <button
      key={id ?? 'all'}
      type="button"
      aria-pressed={value === id}
      onClick={() => setFilter(videoId, value === id ? null : id)}
      data-testid={`run-filter-${id ?? 'all'}`}
      className={cn(
        'inline-flex h-7 max-w-56 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors duration-(--duration-fast)',
        value === id
          ? 'border-primary/70 bg-primary-soft text-primary-text'
          : 'border-border-strong text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      <span className="truncate">{label}</span>
      {count !== undefined ? <span className="tabular-nums text-subtle">{count}</span> : null}
    </button>
  );
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter clips by search" data-testid="run-filters">
      <span className="mr-1 text-xs font-medium text-subtle">Found by</span>
      {chip(null, 'Everything')}
      {chip('auto', 'Automatic run')}
      {withClips.map((r) => chip(r.id, r.prompt, r.found))}
    </div>
  );
}

/* ------------------------------------------------------------------------------------- highlights */

function HighlightProgress({
  clipId,
  creating,
  failure,
  onOpen,
  onDismiss,
  onRetry,
}: {
  clipId: string | null;
  creating: boolean;
  failure: string | null;
  onOpen: (id: string) => void;
  onDismiss: () => void;
  onRetry: () => void;
}) {
  const clip = useClipLookup(clipId ?? '');
  const failed = !!failure || clip?.status === 'failed';
  const done = clip?.status === 'rendered';
  const pct = clip?.renderProgress ?? null;
  const rec = failure ? classifyFailure(failure) : null;
  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: duration.base, ease: ease.out }}
      className={cn(
        'flex items-center gap-3 rounded-xl border px-4 py-3',
        failed ? 'border-danger/35 bg-danger-soft' : done ? 'border-success/35 bg-success-soft' : 'border-primary/35 bg-primary-soft',
      )}
      role="status"
      data-testid="highlight-progress"
      data-state={failed ? 'failed' : done ? 'done' : 'working'}
    >
      <span
        className={cn(
          'flex size-9 shrink-0 items-center justify-center rounded-lg',
          failed ? 'bg-danger-solid text-white' : done ? 'bg-success text-black' : 'bg-primary text-primary-foreground',
        )}
      >
        {failed ? <CircleAlert className="size-4" aria-hidden /> : done ? <Check className="size-4" aria-hidden /> : <Film className="size-4" aria-hidden />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">
          {failed
            ? 'The highlight reel could not be built'
            : done
              ? 'Highlight reel ready'
              : creating || !clip
                ? 'Picking the best beats and ordering the story…'
                : clip.status === 'rendering'
                  ? 'Rendering the highlight reel…'
                  : 'Highlight reel is queued'}
        </p>
        <p className="truncate text-xs text-muted-foreground" data-testid="highlight-detail">
          {failed
            ? rec && rec.kind !== 'other'
              ? rec.hint
              : (failure ?? clip?.error ?? 'Rendering failed.')
            : done
              ? `“${clip.title}”`
              : 'It appears in the grid as soon as the plan is written.'}
        </p>
        {!failed && !done ? (
          <Progress
            value={pct === null ? null : pct * 100}
            className="mt-2 h-1.5"
            aria-label="Highlight progress"
          />
        ) : null}
      </div>
      {done && clip ? (
        <Button size="sm" variant="primary" onClick={() => onOpen(clip.id)} data-testid="highlight-open">
          Open
        </Button>
      ) : null}
      {failed ? (
        <>
          {rec?.action ? (
            <Button asChild size="sm" variant="outline">
              <Link href={rec.action.href}>{rec.action.label}</Link>
            </Button>
          ) : null}
          <Button size="sm" variant="outline" onClick={onRetry}>
            Try again
          </Button>
        </>
      ) : null}
      <Button size="icon-sm" variant="ghost" aria-label="Dismiss" onClick={onDismiss}>
        <X />
      </Button>
    </motion.div>
  );
}

/* ----------------------------------------------------------------------------------------- main panel */

/**
 * Steering panel + One-Click Highlights above the clips grid. Moments found by a steered run land in the grid live
 * (main pushes `clips:updated`), tagged with the prompt that found them.
 */
export function ClipsExtras({ videoId }: { videoId: string }) {
  const video = useVideo(videoId);
  const runsQ = useMomentRuns(videoId);
  const find = useFindMoments(videoId);
  const cancel = useCancelRun(videoId);
  const highlight = useCreateHighlight(videoId);
  const requestOpen = useClipUi((s) => s.requestOpen);

  const [prompt, setPrompt] = React.useState('');
  const [showOptions, setShowOptions] = React.useState(false);
  const [length, setLength] = React.useState<LengthChoice>('default');
  const [count, setCount] = React.useState<CountChoice>('default');
  const [hlOpen, setHlOpen] = React.useState(false);
  const [hlPrompt, setHlPrompt] = React.useState('');
  const [hlClipId, setHlClipId] = React.useState<string | null>(null);
  const [hlShown, setHlShown] = React.useState(false);
  const [hlFailure, setHlFailure] = React.useState<string | null>(null);
  const [showAll, setShowAll] = React.useState(false);
  const input = React.useRef<HTMLInputElement | null>(null);

  const runs = React.useMemo(() => runsQ.data?.items ?? [], [runsQ.data]);
  const running = runs.some((r) => r.status === 'running');

  // toast when a run finishes while the user is looking at this page
  const seen = React.useRef<Map<string, MomentRun['status']>>(new Map());
  React.useEffect(() => {
    for (const r of runs) {
      const was = seen.current.get(r.id);
      seen.current.set(r.id, r.status);
      if (was === 'running' && r.status === 'done')
        toast.success(
          r.found > 0 ? `${r.found} new ${r.found === 1 ? 'clip' : 'clips'} found` : 'No new moments matched',
          { description: `“${r.prompt}”` },
        );
    }
  }, [runs]);

  const v = video.data?.video;
  const transcribed = !!video.data?.stages.some(
    (s) => s.stage === 'transcribe' && (s.status === 'done' || s.status === 'skipped'),
  );
  const reason: string | null = !v
    ? 'Loading the video…'
    : isActiveVideo(v)
      ? 'This video is still being processed. Steering opens once the current run has finished.'
      : !transcribed
        ? 'There is no transcript yet. Moments can be searched after transcription finishes.'
        : null;

  const trimmed = prompt.trim();
  const canFind = !reason && trimmed.length >= 2 && trimmed.length <= MAX_PROMPT;

  const submit = () => {
    if (!canFind) return;
    find.mutate(
      { prompt: trimmed, options: steerOptions(length, count) },
      {
        onSuccess: () => {
          setPrompt('');
          setShowAll(false);
        },
      },
    );
  };

  const createHighlight = (text: string) => {
    setHlShown(true);
    setHlFailure(null);
    setHlClipId(null);
    setHlOpen(false);
    highlight.mutate(
      { prompt: text.trim() || undefined },
      {
        onSuccess: (r) => setHlClipId(r.clipId),
        onError: (e) => setHlFailure(e.message),
      },
    );
  };

  const shown = showAll ? runs : runs.slice(0, 3);

  return (
    <section
      aria-label="Find more moments"
      data-testid="clips-extras"
      data-video-id={videoId}
      className="flex flex-col gap-4 rounded-2xl border bg-card p-4 shadow-xs"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary-text">
            <Sparkles className="size-4.5" aria-hidden />
          </span>
          <div>
            <h2 className="font-display text-lg font-semibold leading-6">Find more moments</h2>
            <p className="text-xs text-muted-foreground">
              Tell Claude what to look for. New clips join this grid, tagged with your request.
            </p>
          </div>
        </div>
        <Popover open={hlOpen} onOpenChange={setHlOpen}>
          {reason ? (
            <DisabledTip reason={reason} side="left">
              <Button variant="outline" disabled data-testid="highlight-button">
                <Film /> One-Click Highlights
              </Button>
            </DisabledTip>
          ) : (
            <PopoverTrigger asChild>
              <Button variant="outline" loading={highlight.isPending} data-testid="highlight-button">
                <Film /> One-Click Highlights
              </Button>
            </PopoverTrigger>
          )}
          <PopoverContent align="end" className="w-[360px] p-4" data-testid="highlight-popover">
            <p className="text-sm font-semibold">A highlight reel in one click</p>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
              Claude picks the best 3–5 micro-moments, orders them as a story and stitches them with
              transitions into one reel of about 60–90 seconds.
            </p>
            <label htmlFor="hl-prompt" className="mt-3 block text-xs font-medium">
              Steer it (optional)
            </label>
            <TextArea
              id="hl-prompt"
              rows={2}
              maxLength={300}
              value={hlPrompt}
              onChange={(e) => setHlPrompt(e.target.value)}
              placeholder="e.g. focus on the pricing story"
              className="mt-1.5 min-h-14"
              data-testid="highlight-prompt"
            />
            <div className="mt-1 flex justify-end">
              <CharCounter value={hlPrompt.length} max={300} />
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setHlOpen(false)}>
                Cancel
              </Button>
              <Button variant="primary" size="sm" onClick={() => createHighlight(hlPrompt)} data-testid="highlight-create">
                <Film /> Create highlight
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </div>

      <AnimatePresence initial={false}>
        {hlShown ? (
          <HighlightProgress
            key="hl"
            clipId={hlClipId}
            creating={highlight.isPending}
            failure={hlFailure}
            onOpen={(id) => requestOpen(id)}
            onDismiss={() => setHlShown(false)}
            onRetry={() => createHighlight(hlPrompt)}
          />
        ) : null}
      </AnimatePresence>

      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="flex gap-2">
          <Input
            ref={input}
            value={prompt}
            maxLength={MAX_PROMPT}
            onChange={(e) => setPrompt(e.target.value)}
            leading={<Search />}
            disabled={!!reason}
            aria-label="What should Claude look for?"
            placeholder="e.g. only the funny parts, the guest speaking, anything about pricing"
            data-testid="steer-input"
          />
          {reason ? (
            <DisabledTip reason={reason} side="left">
              <Button variant="primary" disabled data-testid="steer-submit">
                <Sparkles /> Find moments
              </Button>
            </DisabledTip>
          ) : (
            <Button
              type="submit"
              variant="primary"
              disabled={!canFind}
              loading={find.isPending}
              data-testid="steer-submit"
            >
              <Sparkles /> Find moments
            </Button>
          )}
        </div>
        {find.isError ? (
          <div data-testid="steer-error">
            <ErrorBlock
              error={find.error}
              title="Could not start the search"
              onRetry={submit}
              retrying={find.isPending}
            />
          </div>
        ) : null}
        {reason ? (
          <p className="text-xs text-muted-foreground" data-testid="steer-disabled-reason">
            {reason}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Quick prompts">
          {STEER_CHIPS.map((c) => (
            <button
              key={c}
              type="button"
              disabled={!!reason}
              onClick={() => {
                setPrompt(c);
                input.current?.focus();
              }}
              data-testid="steer-chip"
              className="h-7 rounded-full border border-border-strong px-3 text-xs font-medium text-muted-foreground transition-colors duration-(--duration-fast) hover:border-primary/60 hover:bg-primary-soft hover:text-primary-text disabled:pointer-events-none disabled:opacity-45"
            >
              {c}
            </button>
          ))}
          <button
            type="button"
            aria-expanded={showOptions}
            onClick={() => setShowOptions((o) => !o)}
            data-testid="steer-options-toggle"
            className="ml-auto inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            Options
            <ChevronDown
              className={cn('size-3.5 transition-transform duration-(--duration-fast)', showOptions && 'rotate-180')}
              aria-hidden
            />
          </button>
        </div>

        {showOptions ? (
          <div className="grid gap-4 rounded-xl border bg-muted/40 p-3.5 sm:grid-cols-2" data-testid="steer-options">
            <ChipGroup<LengthChoice>
              label="Clip length"
              value={length}
              onValueChange={setLength}
              options={LENGTH_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            />
            <ChipGroup<CountChoice>
              label="How many"
              value={count}
              onValueChange={setCount}
              options={COUNT_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            />
            <p className="text-xs text-muted-foreground sm:col-span-2">
              “Same as before” and “Auto” keep the settings this video was processed with.
            </p>
          </div>
        ) : null}
      </form>

      {runsQ.isPending ? null : runsQ.isError ? (
        <p className="text-xs text-danger" role="alert">
          Could not load earlier searches: {runsQ.error.message}
        </p>
      ) : runs.length > 0 ? (
        <div className="flex flex-col gap-2 border-t pt-3" data-testid="moment-runs">
          <div className="flex items-center justify-between">
            <h3 className="text-2xs font-semibold uppercase tracking-wider text-subtle">
              Searches{running ? ' · running' : ''}
            </h3>
            {runs.length > 3 ? (
              <button
                type="button"
                onClick={() => setShowAll((s) => !s)}
                className="text-xs font-medium text-primary-text hover:underline"
              >
                {showAll ? 'Show fewer' : `Show all ${runs.length}`}
              </button>
            ) : null}
          </div>
          <ul className="divide-y">
            {shown.map((r) => (
              <RunRow
                key={r.id}
                run={r}
                canceling={cancel.isPending && cancel.variables?.runId === r.id}
                onCancel={() => cancel.mutate({ runId: r.id })}
              />
            ))}
          </ul>
          <RunFilter videoId={videoId} runs={runs} />
        </div>
      ) : null}
    </section>
  );
}
