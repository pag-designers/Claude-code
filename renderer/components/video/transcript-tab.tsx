'use client';

import * as React from 'react';
import { useReducedMotion } from 'framer-motion';
import {
  ChevronDown,
  ChevronUp,
  Copy,
  FileText,
  Loader2,
  LocateFixed,
  Search,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import type { Sentence, Transcript, VideoView } from '@shared/pipeline';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { copyText } from '@/lib/clipboard';
import { formatClock, formatInt } from '@/lib/format';
import { useTranscript } from '@/lib/library';
import { isActiveVideo } from '@/lib/pipeline-ui';
import { usePlayer, usePlayerSelector } from '@/lib/player';
import {
  activeSentenceIndex,
  findMatches,
  transcriptToText,
  type TranscriptMatch,
} from '@/lib/transcript';
import { computeOffsets, visibleRange } from '@/lib/virtual';

const ESTIMATE = 64;

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
        data-testid="transcript-match"
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

const SentenceRow = React.memo(function SentenceRow({
  s,
  index,
  top,
  active,
  speakerHeader,
  ranges,
  currentMatch,
  measure,
  onSeek,
}: {
  s: Sentence;
  index: number;
  top: number;
  active: boolean;
  speakerHeader: boolean;
  ranges: [number, number][];
  currentMatch: boolean;
  measure: (el: HTMLElement | null) => void;
  onSeek: (t: number) => void;
}) {
  return (
    <div
      ref={measure}
      data-index={index}
      data-testid="transcript-row"
      data-active={active || undefined}
      className="absolute inset-x-0"
      style={{ transform: `translateY(${top}px)` }}
    >
      {speakerHeader && s.speaker ? (
        <p className="px-4 pb-0.5 pt-3 text-2xs font-semibold uppercase tracking-wider text-primary-text">
          {s.speaker}
        </p>
      ) : null}
      <button
        type="button"
        onClick={() => onSeek(s.s)}
        aria-label={`Play from ${formatClock(s.s)}`}
        className={cn(
          'group flex w-full items-start gap-3 border-l-2 px-4 py-1.5 text-left transition-colors duration-(--duration-fast)',
          active ? 'border-primary bg-primary-soft' : 'border-transparent hover:bg-accent/60',
        )}
      >
        <span className="mt-0.5 w-11 shrink-0 text-xs tabular-nums text-subtle group-hover:text-primary-text">
          {formatClock(s.s)}
        </span>
        <span
          className={cn(
            'selectable min-w-0 flex-1 text-base leading-6',
            active ? 'text-foreground' : 'text-muted-foreground',
          )}
        >
          <Highlighted text={s.text} ranges={ranges} current={currentMatch} />
        </span>
      </button>
    </div>
  );
});

function TranscriptPanel({ transcript }: { transcript: Transcript }) {
  const { seek } = usePlayer();
  const reduce = useReducedMotion();
  const sentences = transcript.sentences;
  const n = sentences.length;

  const [input, setInput] = React.useState('');
  const [query, setQuery] = React.useState('');
  React.useEffect(() => {
    const id = window.setTimeout(() => setQuery(input), 120);
    return () => window.clearTimeout(id);
  }, [input]);
  const matches = React.useMemo(() => findMatches(sentences, query), [sentences, query]);
  const totalHits = React.useMemo(
    () => matches.reduce((a, m) => a + m.ranges.length, 0),
    [matches],
  );
  const matchBySentence = React.useMemo(
    () => new Map<number, TranscriptMatch>(matches.map((m) => [m.sentence, m])),
    [matches],
  );
  const [matchPos, setMatchPos] = React.useState(0);
  const [lastQuery, setLastQuery] = React.useState(query);
  if (lastQuery !== query) {
    setLastQuery(query);
    setMatchPos(0);
  }
  const currentSentence = matches[matchPos]?.sentence ?? -1;

  const activeIdx = usePlayerSelector((s) => activeSentenceIndex(sentences, s.time));
  const playing = usePlayerSelector((s) => s.playing);
  const [follow, setFollow] = React.useState(true);

  /* ---- windowing ---- */
  const scroller = React.useRef<HTMLDivElement | null>(null);
  const [heights, setHeights] = React.useState<Map<number, number>>(() => new Map());
  const [scrollTop, setScrollTop] = React.useState(0);
  const [viewport, setViewport] = React.useState(520);
  const offsets = React.useMemo(
    () => computeOffsets(n, (i) => heights.get(i), ESTIMATE),
    [n, heights],
  );
  const range = React.useMemo(
    () => visibleRange(offsets, scrollTop, viewport, 500),
    [offsets, scrollTop, viewport],
  );

  const pending = React.useRef(new Map<number, number>());
  const raf = React.useRef<number | null>(null);
  const ro = React.useRef<ResizeObserver | null>(null);
  const getObserver = React.useCallback(() => {
    if (ro.current) return ro.current;
    const flush = () => {
      raf.current = null;
      const batch = pending.current;
      if (batch.size === 0) return;
      setHeights((prev) => {
        let changed = false;
        const next = new Map(prev);
        batch.forEach((h, i) => {
          if (Math.abs((prev.get(i) ?? -1) - h) > 0.5) {
            next.set(i, h);
            changed = true;
          }
        });
        batch.clear();
        return changed ? next : prev;
      });
    };
    ro.current = new ResizeObserver((entries) => {
      for (const e of entries) {
        const i = Number((e.target as HTMLElement).dataset.index);
        const h =
          e.borderBoxSize?.[0]?.blockSize ??
          (e.target as HTMLElement).getBoundingClientRect().height;
        if (Number.isFinite(i)) pending.current.set(i, h);
      }
      if (raf.current === null) raf.current = requestAnimationFrame(flush);
    });
    return ro.current;
  }, []);
  React.useEffect(
    () => () => {
      ro.current?.disconnect();
      ro.current = null;
      if (raf.current !== null) cancelAnimationFrame(raf.current);
    },
    [],
  );
  const measure = React.useCallback(
    (el: HTMLElement | null) => {
      if (!el) return;
      const o = getObserver();
      o.observe(el);
      return () => o.unobserve(el);
    },
    [getObserver],
  );

  React.useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const sync = () => setViewport(el.clientHeight);
    sync();
    const o = new ResizeObserver(sync);
    o.observe(el);
    return () => o.disconnect();
  }, []);

  const scrollToIndex = React.useCallback(
    (i: number, mode: 'center' | 'nearest' = 'center') => {
      const el = scroller.current;
      if (!el) return;
      const top = offsets[i] ?? 0;
      const bottom = offsets[i + 1] ?? top;
      let target = top - viewport * 0.35;
      if (mode === 'nearest' && top >= el.scrollTop + 8 && bottom <= el.scrollTop + viewport - 8)
        return;
      target = Math.max(0, Math.min(target, (offsets[n] ?? 0) - viewport));
      el.scrollTo({ top: target, behavior: reduce ? 'auto' : 'smooth' });
    },
    [offsets, viewport, n, reduce],
  );

  // follow playback
  const lastFollowed = React.useRef(-2);
  React.useEffect(() => {
    if (!follow || !playing || activeIdx < 0 || lastFollowed.current === activeIdx) return;
    lastFollowed.current = activeIdx;
    scrollToIndex(activeIdx, 'nearest');
  }, [activeIdx, follow, playing, scrollToIndex]);

  // jump to the current search hit
  React.useEffect(() => {
    if (currentSentence >= 0) scrollToIndex(currentSentence);
    // only when the hit changes, not when row heights get measured
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSentence, matchPos, query]);

  const activeOffscreen =
    activeIdx >= 0 && (offsets[activeIdx + 1] ?? 0) < scrollTop - 40
      ? 'above'
      : activeIdx >= 0 && (offsets[activeIdx] ?? 0) > scrollTop + viewport + 40
        ? 'below'
        : null;

  const stepMatch = (d: 1 | -1) => {
    if (!matches.length) return;
    setMatchPos((p) => (p + d + matches.length) % matches.length);
  };

  const onSeek = React.useCallback(
    (t: number) => {
      setFollow(true);
      lastFollowed.current = -2;
      if (!seek(t, { play: true }))
        toast.info('No playable proxy yet', {
          description: 'The 480p proxy is created in the Prepare media stage.',
        });
    },
    [seek],
  );

  const copy = async () => {
    const ok = await copyText(transcriptToText(transcript));
    if (ok)
      toast.success('Transcript copied', {
        description: `${formatInt(transcript.words.length)} words with timestamps.`,
      });
    else toast.error('Could not copy to the clipboard');
  };

  const rows: React.ReactNode[] = [];
  for (let i = range.start; i <= range.end; i++) {
    const s = sentences[i];
    if (!s) continue;
    const m = matchBySentence.get(i);
    rows.push(
      <SentenceRow
        key={s.id}
        s={s}
        index={i}
        top={offsets[i] ?? 0}
        active={i === activeIdx}
        speakerHeader={i === 0 || sentences[i - 1]?.speaker !== s.speaker}
        ranges={m?.ranges ?? []}
        currentMatch={i === currentSentence}
        measure={measure}
        onSeek={onSeek}
      />,
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="transcript-panel">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Search transcript"
          placeholder="Search the transcript"
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
          wrapperClassName="w-64"
        />
        {query.trim().length >= 2 ? (
          <div className="flex items-center gap-1 text-xs text-muted-foreground" aria-live="polite">
            <span className="tabular-nums" data-testid="match-count">
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
        <Button variant="outline" size="sm" className="ml-auto" onClick={() => void copy()}>
          <Copy /> Copy transcript
        </Button>
      </div>
      <div className="relative overflow-hidden rounded-xl border bg-card">
        <div
          ref={scroller}
          data-testid="transcript-scroller"
          className="scrollbar-thin h-[clamp(380px,calc(100dvh-380px),720px)] overflow-y-auto"
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          onWheel={() => setFollow(false)}
          onTouchMove={() => setFollow(false)}
          onPointerDown={(e) => {
            // grabbing the scrollbar (not a sentence) also means "I'm browsing"
            if (e.target === e.currentTarget) setFollow(false);
          }}
        >
          <div className="relative" style={{ height: offsets[n] ?? 0 }}>
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
              scrollToIndex(activeIdx);
            }}
          >
            <LocateFixed /> Jump to current {activeOffscreen === 'above' ? '↑' : '↓'}
          </Button>
        ) : null}
      </div>
      <p className="px-1 text-xs tabular-nums text-subtle">
        {formatInt(transcript.words.length)} words · {formatInt(n)} sentences ·{' '}
        {transcript.language.toUpperCase()} · {transcript.model}
        {totalHits > matches.length ? ` · ${formatInt(totalHits)} hits for “${query.trim()}”` : ''}
      </p>
    </div>
  );
}

export function TranscriptTab({ video }: { video: VideoView }) {
  const q = useTranscript(video.id);
  const active = isActiveVideo(video);
  if (q.isPending)
    return (
      <div
        className="space-y-3 rounded-xl border bg-card p-5"
        aria-busy
        aria-label="Loading transcript"
      >
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-4 w-full" style={{ width: `${70 + ((i * 13) % 30)}%` }} />
        ))}
      </div>
    );
  if (q.isError)
    return (
      <EmptyState
        icon={FileText}
        title="Could not load the transcript"
        description={q.error.message}
        actions={<Button onClick={() => void q.refetch()}>Try again</Button>}
      />
    );
  if (!q.data)
    return (
      <EmptyState
        size="md"
        icon={active ? Loader2 : FileText}
        title={active ? 'Transcribing…' : 'No transcript for this video'}
        description={
          active
            ? 'The word-timed transcript appears here as soon as the Transcribe stage finishes.'
            : video.status === 'failed'
              ? 'The run stopped before transcription finished. Retry the failed stage from the pipeline card above.'
              : 'Re-run the Transcribe stage to generate it.'
        }
      />
    );
  return <TranscriptPanel transcript={q.data} />;
}
