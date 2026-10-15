'use client';

import * as React from 'react';
import { useReducedMotion } from 'framer-motion';
import {
  ChevronDown,
  ChevronUp,
  CircleAlert,
  CircleCheck,
  Download,
  Loader2,
  LocateFixed,
  Merge,
  Minus,
  Play,
  Plus,
  Redo2,
  RefreshCw,
  Scissors,
  Search,
  Subtitles as SubtitlesIcon,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { DEFAULT_STYLE_ID, type Cue } from '@shared/cp2';
import type { VideoView } from '@shared/pipeline';
import { Badge } from '@/components/ui/badge';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { Tip } from '@/components/ui/tooltip';
import { VideoCaptionStyleControl } from '@/components/captions/video-caption-style';
import { formatInt } from '@/lib/format';
import { invoke } from '@/lib/ipc';
import { useVideoClips } from '@/lib/library';
import { useRestyleClips } from '@/lib/cp2-captions';
import { isActiveVideo } from '@/lib/pipeline-ui';
import { usePlayer, usePlayerSelector } from '@/lib/player';
import { cn } from '@/lib/utils';
import {
  NUDGE_STEP,
  activeCueIndex,
  findCueMatches,
  formatCueTime,
  parseCueTime,
  tokenize,
  wordsBeforeCaret,
  type CueMatch,
} from './edits';
import { useSubtitleEditor, type SaveStatus } from './use-subtitle-editor';
import { useVirtualRows } from './use-virtual-rows';

const ESTIMATE = 60;

function Highlighted({
  text,
  ranges,
  current,
}: {
  text: string;
  ranges: [number, number][];
  current: boolean;
}) {
  if (!ranges.length) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let at = 0;
  ranges.forEach(([a, b], i) => {
    if (a > at) parts.push(text.slice(at, a));
    parts.push(
      <mark
        key={i}
        data-testid="cue-match"
        className={cn(
          'rounded-xs px-0.5 text-foreground',
          current ? 'bg-warning-soft ring-1 ring-warning' : 'bg-primary-soft',
        )}
      >
        {text.slice(a, b)}
      </mark>,
    );
    at = b;
  });
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

/* ------------------------------------------------------------ retime popover ----------------------------------- */

function RetimePopover({
  cue,
  onApply,
  children,
}: {
  cue: Cue;
  onApply: (start: number) => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const [value, setValue] = React.useState('');
  const parsed = parseCueTime(value);
  const submit = () => {
    if (parsed === null) return;
    onApply(parsed);
    setOpen(false);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setValue(formatCueTime(cue.s));
      }}
    >
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-3.5" data-testid="retime-popover">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="flex flex-col gap-2.5"
        >
          <label htmlFor={`retime-${cue.id}`} className="text-sm font-medium">
            Start time
          </label>
          <Input
            id={`retime-${cue.id}`}
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            invalid={parsed === null}
            inputMode="decimal"
            spellCheck={false}
            className="h-9 font-mono tabular-nums"
            aria-describedby={`retime-${cue.id}-hint`}
          />
          <p
            id={`retime-${cue.id}-hint`}
            className={cn('text-xs', parsed === null ? 'text-danger' : 'text-muted-foreground')}
          >
            {parsed === null
              ? 'Use seconds or m:ss.s, for example 1:12.5.'
              : 'The whole caption moves; its length stays the same.'}
          </p>
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" variant="primary" disabled={parsed === null}>
              Retime
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

/* ------------------------------------------------------------ one row ----------------------------------------- */

interface Editing {
  id: number;
  text: string;
}

interface RowProps {
  cue: Cue;
  index: number;
  top: number;
  isLast: boolean;
  active: boolean;
  match: CueMatch | undefined;
  currentMatch: boolean;
  editing: Editing | null;
  measure: (el: HTMLElement | null) => void;
  onPlay: (cue: Cue) => void;
  onBeginEdit: (cue: Cue, caret?: 'end' | 'middle') => void;
  onChangeText: (text: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  onSplit: (cue: Cue, text: string, caret: number) => void;
  onMerge: (cue: Cue) => void;
  onNudge: (cue: Cue, delta: number) => void;
  onRetime: (cue: Cue, start: number) => void;
  onDelete: (cue: Cue) => void;
}

const CueRow = React.memo(function CueRow(props: RowProps) {
  const {
    cue,
    editing,
    measure,
    index,
    top,
    isLast,
    active,
    match,
    currentMatch,
    onPlay,
    onBeginEdit,
    onChangeText,
    onCommit,
    onCancel,
    onSplit,
    onMerge,
    onNudge,
    onRetime,
    onDelete,
  } = props;
  const isEditing = editing?.id === cue.id;
  const area = React.useRef<HTMLTextAreaElement | null>(null);
  const skipBlur = React.useRef(false);

  React.useEffect(() => {
    if (isEditing && area.current) {
      area.current.focus();
      const len = area.current.value.length;
      area.current.setSelectionRange(len, len);
    }
  }, [isEditing]);

  const caretNow = () => area.current?.selectionStart ?? editing?.text.length ?? cue.text.length;
  const actions = (
    <div
      className={cn(
        'flex shrink-0 items-center gap-0.5 self-start transition-opacity duration-(--duration-fast)',
        isEditing || active
          ? 'opacity-100'
          : 'opacity-0 focus-within:opacity-100 group-hover:opacity-100',
      )}
      // keep the textarea focused (and its caret) while an action button is pressed
      onMouseDown={(e) => {
        if (isEditing) e.preventDefault();
      }}
    >
      <Tip content="Split at the caret (Alt+Enter)">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Split at caret"
          onClick={() => {
            if (isEditing) {
              onSplit(cue, editing!.text, caretNow());
            } else {
              onBeginEdit(cue, 'middle');
              toast.info('Move the caret between two words, then press Split again');
            }
          }}
        >
          <Scissors />
        </Button>
      </Tip>
      <Tip content={isLast ? 'This is the last caption' : 'Merge with the next caption'}>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Merge with next"
          disabled={isLast}
          onClick={() => onMerge(cue)}
        >
          <Merge />
        </Button>
      </Tip>
      <Tip content={`Nudge ${NUDGE_STEP} s earlier`}>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Nudge 0.1 seconds earlier"
          onClick={() => onNudge(cue, -NUDGE_STEP)}
        >
          <Minus />
        </Button>
      </Tip>
      <Tip content={`Nudge ${NUDGE_STEP} s later`}>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Nudge 0.1 seconds later"
          onClick={() => onNudge(cue, NUDGE_STEP)}
        >
          <Plus />
        </Button>
      </Tip>
      <Tip content="Remove this caption">
        <Button
          variant="danger-ghost"
          size="icon-xs"
          aria-label="Delete caption"
          onClick={() => onDelete(cue)}
        >
          <Trash2 />
        </Button>
      </Tip>
    </div>
  );

  return (
    <div
      ref={measure}
      data-row-key={String(cue.id)}
      data-index={index}
      data-testid="cue-row"
      data-active={active || undefined}
      data-editing={isEditing || undefined}
      className="absolute inset-x-0"
      style={{ transform: `translateY(${top}px)` }}
    >
      <div
        className={cn(
          'group flex items-start gap-3 border-l-2 px-3 py-2 transition-colors duration-(--duration-fast)',
          active ? 'border-primary bg-primary-soft' : 'border-transparent hover:bg-accent/50',
          isEditing && 'bg-accent/70',
        )}
      >
        <div className="flex w-[112px] shrink-0 flex-col items-start gap-0.5 pt-1.5">
          <span className="flex items-center gap-1 font-mono text-xs tabular-nums text-muted-foreground">
            <RetimePopover cue={cue} onApply={(s) => onRetime(cue, s)}>
              <button
                type="button"
                aria-label={`Retime caption starting at ${formatCueTime(cue.s)}`}
                data-testid="cue-time"
                className="-mx-1 rounded-xs px-1 hover:bg-accent hover:text-foreground"
              >
                {formatCueTime(cue.s)}
              </button>
            </RetimePopover>
            <span aria-hidden className="text-subtle">
              –
            </span>
            <span data-testid="cue-end" className="text-subtle">
              {formatCueTime(cue.e)}
            </span>
          </span>
          <button
            type="button"
            onClick={() => onPlay(cue)}
            aria-label={`Play from ${formatCueTime(cue.s)}`}
            className="inline-flex items-center gap-1 rounded-xs text-2xs tabular-nums text-subtle hover:text-primary-text"
          >
            <Play className="size-3 fill-current" aria-hidden />
            {(cue.e - cue.s).toFixed(1)}s
          </button>
        </div>

        <div className="min-w-0 flex-1">
          {isEditing ? (
            <textarea
              ref={area}
              rows={1}
              value={editing.text}
              aria-label={`Edit caption at ${formatCueTime(cue.s)}`}
              data-testid="cue-input"
              spellCheck
              onChange={(e) => onChangeText(e.target.value.replace(/\n/g, ' '))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && e.altKey) {
                  e.preventDefault();
                  onSplit(cue, editing.text, e.currentTarget.selectionStart);
                } else if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  skipBlur.current = true;
                  onCommit();
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  skipBlur.current = true;
                  onCancel();
                }
              }}
              onBlur={() => {
                if (skipBlur.current) {
                  skipBlur.current = false;
                  return;
                }
                onCommit();
              }}
              className="selectable block w-full resize-none rounded-md border border-ring bg-field px-2 py-1 text-base leading-6 text-foreground outline-none ring-3 ring-ring/25 [field-sizing:content]"
            />
          ) : (
            <button
              type="button"
              data-testid="cue-text"
              aria-label={`Edit caption: ${cue.text}`}
              onClick={() => onBeginEdit(cue, 'end')}
              className={cn(
                'block w-full cursor-text rounded-md border border-transparent px-2 py-1 text-left text-base leading-6',
                active ? 'text-foreground' : 'text-foreground/90',
                'hover:border-border-strong',
              )}
            >
              <Highlighted text={cue.text} ranges={match?.ranges ?? []} current={currentMatch} />
            </button>
          )}
        </div>
        {actions}
      </div>
    </div>
  );
});

/* ------------------------------------------------------------ status pill ------------------------------------- */

function SaveState({
  status,
  error,
  onRetry,
}: {
  status: SaveStatus;
  error: string | null;
  onRetry: () => void;
}) {
  // fixed-width slot: the toolbar must not reflow when the state changes (Unsaved / Saving / Saved / Not saved + Retry)
  if (status === 'idle') return <span className="w-[116px]" aria-hidden />;
  return (
    <span
      role="status"
      aria-live="polite"
      data-testid="save-state"
      data-status={status}
      className={cn(
        'inline-flex w-[116px] items-center justify-end gap-1.5 whitespace-nowrap text-xs font-medium',
        status === 'error' ? 'text-danger' : 'text-muted-foreground',
      )}
      title={error ?? undefined}
    >
      {status === 'saving' ? (
        <>
          <Loader2 className="size-3.5 animate-spin" aria-hidden /> Saving…
        </>
      ) : status === 'saved' ? (
        <>
          <CircleCheck className="size-3.5 text-success" aria-hidden /> Saved
        </>
      ) : status === 'dirty' ? (
        <>
          <span className="size-1.5 rounded-full bg-warning" aria-hidden /> Unsaved changes
        </>
      ) : (
        <>
          <CircleAlert className="size-3.5" aria-hidden /> Not saved
          <button type="button" onClick={onRetry} className="underline underline-offset-2">
            Retry
          </button>
        </>
      )}
    </span>
  );
}

/* ------------------------------------------------------------ panel ------------------------------------------ */

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return (
    t.isContentEditable ||
    t.tagName === 'INPUT' ||
    t.tagName === 'TEXTAREA' ||
    t.tagName === 'SELECT'
  );
}

function SubtitlesPanel({ video }: { video: VideoView }) {
  const reduce = useReducedMotion();
  const { seek } = usePlayer();
  const ed = useSubtitleEditor(video.id);
  const clipsQ = useVideoClips(video.id);
  const restyle = useRestyleClips();
  const { cues } = ed;
  const n = cues.length;

  /* search */
  const [input, setInput] = React.useState('');
  const [query, setQuery] = React.useState('');
  React.useEffect(() => {
    const id = window.setTimeout(() => setQuery(input), 120);
    return () => window.clearTimeout(id);
  }, [input]);
  const matches = React.useMemo(() => findCueMatches(cues, query), [cues, query]);
  const matchByCue = React.useMemo(() => new Map(matches.map((m) => [m.cue, m])), [matches]);
  const [matchPos, setMatchPos] = React.useState(0);
  const [lastQuery, setLastQuery] = React.useState(query);
  if (lastQuery !== query) {
    setLastQuery(query);
    setMatchPos(0);
  }
  const currentCue = matches[matchPos]?.cue ?? -1;

  /* playback sync */
  const activeIdx = usePlayerSelector((s) => activeCueIndex(cues, s.time));
  const playing = usePlayerSelector((s) => s.playing);
  const [follow, setFollow] = React.useState(true);

  const keyOf = React.useCallback((i: number) => String(cues[i]?.id ?? i), [cues]);
  const {
    scrollerRef,
    onScroll,
    total,
    range,
    offsets,
    scrollTop,
    viewport,
    measure,
    scrollToIndex,
  } = useVirtualRows(n, keyOf, ESTIMATE);

  const lastFollowed = React.useRef(-2);
  React.useEffect(() => {
    if (!follow || !playing || activeIdx < 0 || lastFollowed.current === activeIdx) return;
    lastFollowed.current = activeIdx;
    scrollToIndex(activeIdx, { mode: 'nearest', smooth: !reduce });
  }, [activeIdx, follow, playing, scrollToIndex, reduce]);
  React.useEffect(() => {
    if (currentCue >= 0) scrollToIndex(currentCue, { smooth: !reduce });
    // only when the hit changes, not when row heights get measured
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentCue, matchPos, query]);

  /* inline editing */
  const [editing, setEditing] = React.useState<Editing | null>(null);
  const editingRef = React.useRef(editing);
  React.useEffect(() => {
    editingRef.current = editing;
  });

  const beginEdit = React.useCallback(
    (cue: Cue, caret?: 'end' | 'middle') => {
      setEditing({ id: cue.id, text: cue.text });
      seek(cue.s, { play: false });
      if (caret === 'middle') {
        // caret handled after mount: put it on the word boundary closest to the middle
        window.setTimeout(() => {
          const ta = document.querySelector<HTMLTextAreaElement>('[data-testid="cue-input"]');
          if (!ta) return;
          const words = tokenize(cue.text);
          const mid = Math.max(1, Math.floor(words.length / 2));
          const pos = words.slice(0, mid).join(' ').length;
          ta.setSelectionRange(pos, pos);
        }, 0);
      }
    },
    [seek],
  );
  const commitEdit = React.useCallback(() => {
    const cur = editingRef.current;
    if (!cur) return;
    setEditing(null);
    const cue = cues.find((c) => c.id === cur.id);
    if (cue && cur.text.trim() !== cue.text) ed.setText(cur.id, cur.text);
  }, [cues, ed]);
  const cancelEdit = React.useCallback(() => setEditing(null), []);

  const onSplit = React.useCallback(
    (cue: Cue, text: string, caret: number) => {
      const keep = wordsBeforeCaret(text, caret);
      setEditing(null);
      ed.textAndSplit(cue.id, text, keep);
    },
    [ed],
  );
  const onPlay = React.useCallback(
    (cue: Cue) => {
      setFollow(true);
      lastFollowed.current = -2;
      if (!seek(cue.s, { play: true }))
        toast.info('No playable proxy yet', {
          description: 'The 480p proxy is created in the Prepare media stage.',
        });
    },
    [seek],
  );
  const onMerge = React.useCallback((cue: Cue) => ed.merge(cue.id), [ed]);
  const onNudge = React.useCallback((cue: Cue, d: number) => ed.nudge(cue.id, d), [ed]);
  const onRetime = React.useCallback((cue: Cue, s: number) => ed.setStart(cue.id, s), [ed]);
  const onDelete = React.useCallback(
    (cue: Cue) => {
      if (ed.remove(cue.id))
        toast.success('Caption removed', { description: 'Undo with Ctrl/⌘ Z.' });
    },
    [ed],
  );

  /* undo / redo (outside of text fields) */
  const { undo, redo } = ed;
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || isTypingTarget(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((k === 'z' && e.shiftKey) || k === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  /* outdated clips banner */
  const rev = ed.edits?.rev ?? 0;
  const [dismissedRev, setDismissedRev] = React.useState<number | null>(null);
  const styleId = video.options.captionStyleId || DEFAULT_STYLE_ID;
  const rendered = React.useMemo(
    () => (clipsQ.data?.items ?? []).filter((c) => c.hasRender),
    [clipsQ.data],
  );
  const staleStrict = React.useMemo(() => {
    const target = Math.max(rev, video.subtitleRev);
    return rendered.filter((c) => c.subtitleRev < target).map((c) => c.id);
  }, [rendered, rev, video.subtitleRev]);
  // the API count says "something is outdated"; the clip list (kept live by clips:updated) says how many still are, so the
  // banner disappears by itself as the re-renders land. Before the clip list is known, trust the API.
  const outdatedNow = clipsQ.isSuccess ? staleStrict.length : ed.outdated;
  const staleIds = staleStrict;
  const showBanner =
    ed.outdated > 0 && outdatedNow > 0 && dismissedRev !== rev && staleIds.length > 0;
  const rerender = () =>
    restyle.mutate(
      { ids: staleIds, styleId },
      {
        onSuccess: () => {
          setDismissedRev(rev);
          toast.success(
            `Re-rendering ${staleIds.length} ${staleIds.length === 1 ? 'clip' : 'clips'}`,
            { description: 'They pick up your subtitle edits as each render finishes.' },
          );
        },
      },
    );

  /* export */
  const [exporting, setExporting] = React.useState<'srt' | 'vtt' | null>(null);
  const exportAs = async (format: 'srt' | 'vtt') => {
    setExporting(format);
    try {
      if (!(await ed.flush())) {
        toast.error('Fix the save error before exporting');
        return;
      }
      const r = await invoke('subtitles:export', { videoId: video.id, format });
      if (r.saved)
        toast.success(`Exported ${format.toUpperCase()}`, { description: r.path ?? undefined });
    } catch (e) {
      toast.error('Export failed', { description: e instanceof Error ? e.message : undefined });
    } finally {
      setExporting(null);
    }
  };

  const stepMatch = (d: 1 | -1) => {
    if (!matches.length) return;
    setMatchPos((p) => (p + d + matches.length) % matches.length);
  };

  const activeOffscreen =
    activeIdx >= 0 && (offsets[activeIdx + 1] ?? 0) < scrollTop - 40
      ? 'above'
      : activeIdx >= 0 && (offsets[activeIdx] ?? 0) > scrollTop + viewport + 40
        ? 'below'
        : null;

  /* ---- states ---- */
  if (ed.query.isPending || (ed.query.isSuccess && ed.transcriptQuery.isPending))
    return (
      <div
        className="space-y-3 rounded-xl border bg-card p-5"
        aria-busy
        aria-label="Loading subtitles"
      >
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-5 w-full" style={{ width: `${55 + ((i * 17) % 40)}%` }} />
        ))}
      </div>
    );
  if (ed.query.isError)
    return (
      <EmptyState
        icon={SubtitlesIcon}
        title="Could not load the subtitles"
        description={ed.query.error.message}
        actions={<Button onClick={() => void ed.query.refetch()}>Try again</Button>}
      />
    );
  if (ed.transcriptQuery.isError)
    return (
      <EmptyState
        icon={SubtitlesIcon}
        title="Could not load the transcript"
        description={`${ed.transcriptQuery.error.message} Subtitle editing needs the word timings.`}
        actions={<Button onClick={() => void ed.transcriptQuery.refetch()}>Try again</Button>}
      />
    );
  if (ed.transcriptQuery.isSuccess && ed.transcriptQuery.data === null)
    return (
      <EmptyState
        size="md"
        icon={isActiveVideo(video) ? Loader2 : SubtitlesIcon}
        title={isActiveVideo(video) ? 'Transcribing…' : 'No transcript for this video'}
        description={
          isActiveVideo(video)
            ? 'Captions appear here as soon as the Transcribe stage finishes.'
            : video.status === 'failed'
              ? 'The run stopped before transcription finished. Retry the failed stage from the pipeline card.'
              : 'Re-run the Transcribe stage to generate it.'
        }
      />
    );
  if (n === 0 && ed.ready)
    return (
      <EmptyState
        size="md"
        icon={isActiveVideo(video) ? Loader2 : SubtitlesIcon}
        title={isActiveVideo(video) ? 'Transcribing…' : 'No captions yet'}
        description={
          isActiveVideo(video)
            ? 'Captions appear here as soon as the Transcribe stage finishes.'
            : 'This video has no speech to caption, or every caption was removed. Undo with Ctrl/⌘ Z if you removed them by mistake.'
        }
        actions={
          ed.canUndo ? (
            <Button variant="outline" onClick={ed.undo}>
              <Undo2 /> Undo last change
            </Button>
          ) : undefined
        }
      />
    );

  const rows: React.ReactNode[] = [];
  for (let i = range.start; i <= range.end; i++) {
    const cue = cues[i];
    if (!cue) continue;
    rows.push(
      <CueRow
        key={cue.id}
        cue={cue}
        index={i}
        top={offsets[i] ?? 0}
        isLast={i === n - 1}
        active={i === activeIdx}
        match={matchByCue.get(i)}
        currentMatch={i === currentCue}
        editing={editing}
        measure={measure}
        onPlay={onPlay}
        onBeginEdit={beginEdit}
        onChangeText={(text) => setEditing((e) => (e ? { ...e, text } : e))}
        onCommit={commitEdit}
        onCancel={cancelEdit}
        onSplit={onSplit}
        onMerge={onMerge}
        onNudge={onNudge}
        onRetime={onRetime}
        onDelete={onDelete}
      />,
    );
  }
  const totalWords = cues.reduce((a, c) => a + tokenize(c.text).length, 0);

  return (
    <div className="flex flex-col gap-3" data-testid="subtitles-panel">
      {showBanner ? (
        <Banner
          tone="warning"
          title={`${outdatedNow} rendered ${outdatedNow === 1 ? 'clip uses' : 'clips use'} older captions`}
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={rerender}
              loading={restyle.isPending}
              data-testid="rerender-outdated"
            >
              <RefreshCw /> Re-render {staleIds.length === 1 ? 'it' : `${staleIds.length} clips`}
            </Button>
          }
        >
          Subtitle edits apply to new renders. Re-render to burn them in.
        </Banner>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Search subtitles"
          placeholder="Search captions"
          leading={<Search />}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              stepMatch(e.shiftKey ? -1 : 1);
            }
            if (e.key === 'Escape') setInput('');
          }}
          trailing={
            input ? (
              <button
                type="button"
                aria-label="Clear search"
                className="rounded p-1 hover:text-foreground"
                onClick={() => setInput('')}
              >
                <X className="size-3.5" />
              </button>
            ) : undefined
          }
          className="h-9"
          wrapperClassName="min-w-40 max-w-60 flex-1"
        />
        {query.trim().length >= 2 ? (
          <div className="flex items-center gap-1 text-xs text-muted-foreground" aria-live="polite">
            <span className="tabular-nums" data-testid="cue-match-count">
              {matches.length ? `${matchPos + 1} of ${matches.length}` : 'No matches'}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Previous match"
              disabled={!matches.length}
              onClick={() => stepMatch(-1)}
            >
              <ChevronUp />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Next match"
              disabled={!matches.length}
              onClick={() => stepMatch(1)}
            >
              <ChevronDown />
            </Button>
          </div>
        ) : null}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <SaveState status={ed.status} error={ed.saveError} onRetry={ed.retry} />
          <div className="flex items-center gap-0.5" role="group" aria-label="History">
            <Tip content="Undo (Ctrl/⌘ Z)">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Undo"
                disabled={!ed.canUndo}
                onClick={ed.undo}
              >
                <Undo2 />
              </Button>
            </Tip>
            <Tip content="Redo (Ctrl/⌘ Shift Z)">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Redo"
                disabled={!ed.canRedo}
                onClick={ed.redo}
              >
                <Redo2 />
              </Button>
            </Tip>
          </div>
          {ed.language ? (
            <Badge variant="neutral" data-testid="cue-language" title="Spoken language">
              {ed.language.toUpperCase()}
            </Badge>
          ) : null}
          <VideoCaptionStyleControl video={video} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" loading={exporting !== null} data-testid="export-menu">
                <Download /> Export <ChevronDown className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuLabel>Whole video</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => void exportAs('srt')}>
                SubRip (.srt)
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void exportAs('vtt')}>
                WebVTT (.vtt)
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="relative overflow-hidden rounded-xl border bg-card">
        <div
          ref={scrollerRef}
          data-testid="cue-scroller"
          className="scrollbar-thin h-[clamp(380px,calc(100dvh-400px),720px)] overflow-y-auto"
          onScroll={onScroll}
          onWheel={() => setFollow(false)}
          onTouchMove={() => setFollow(false)}
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) setFollow(false);
          }}
        >
          <div className="relative" style={{ height: total }}>
            {rows}
          </div>
        </div>
        {activeOffscreen && !follow ? (
          <Button
            size="sm"
            variant="primary"
            className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-md"
            onClick={() => {
              setFollow(true);
              lastFollowed.current = -2;
              scrollToIndex(activeIdx, { smooth: !reduce });
            }}
          >
            <LocateFixed /> Jump to current {activeOffscreen === 'above' ? '↑' : '↓'}
          </Button>
        ) : null}
      </div>
      <p className="px-1 text-xs tabular-nums text-subtle">
        {formatInt(n)} captions · {formatInt(totalWords)} words · click a caption to edit, Enter
        saves, Esc cancels, Alt+Enter splits at the caret
      </p>
    </div>
  );
}

export function SubtitlesTab({ video }: { video: VideoView }) {
  return <SubtitlesPanel video={video} />;
}
