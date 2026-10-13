'use client';

import { CheckCircle2, Copy, Quote } from 'lucide-react';
import { toast } from 'sonner';
import type { VideoAnalysis, VideoView } from '@shared/pipeline';
import { Button } from '@/components/ui/button';
import { copyText } from '@/lib/clipboard';
import { formatClock } from '@/lib/format';
import { notesToMarkdown } from '@/lib/transcript';
import { AnalysisPending } from './analysis-states';
import { useSeekWithHint } from './chapters-tab';

function Stamp({ at, onSeek }: { at: number; onSeek: (t: number) => void }) {
  return (
    <button
      type="button"
      onClick={() => onSeek(at)}
      aria-label={`Play from ${formatClock(at)}`}
      className="mt-0.5 h-5 shrink-0 rounded-md bg-primary-soft px-1.5 text-2xs font-semibold tabular-nums text-primary-text transition-colors hover:bg-primary hover:text-primary-foreground"
    >
      {formatClock(at)}
    </button>
  );
}

function Group({
  title,
  children,
  count,
}: {
  title: string;
  children: React.ReactNode;
  count: number;
}) {
  if (count === 0) return null;
  return (
    <section className="rounded-xl border bg-card p-5">
      <h3 className="mb-3 flex items-center gap-2 text-2xs font-semibold uppercase tracking-wider text-subtle">
        {title}
        <span className="rounded-full bg-muted px-1.5 tabular-nums">{count}</span>
      </h3>
      {children}
    </section>
  );
}

function Stamped({
  items,
  onSeek,
  quote,
}: {
  items: { text: string; at: number }[];
  onSeek: (t: number) => void;
  quote?: boolean;
}) {
  return (
    <ul className="flex flex-col gap-3">
      {items.map((it, i) => (
        <li key={i} className="flex items-start gap-3">
          <Stamp at={it.at} onSeek={onSeek} />
          <span className="selectable flex-1 text-sm leading-6">
            {quote ? (
              <Quote
                className="mr-1.5 inline size-3.5 -translate-y-px text-primary-text"
                aria-hidden
              />
            ) : null}
            {quote ? `“${it.text}”` : it.text}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function NotesTab({
  video,
  analysis,
}: {
  video: VideoView;
  analysis: VideoAnalysis | null;
}) {
  const seek = useSeekWithHint();
  if (!analysis) return <AnalysisPending video={video} what="Notes" />;
  const n = analysis.notes;
  const copyAll = async () => {
    const ok = await copyText(notesToMarkdown(video.title, analysis));
    if (ok) toast.success('Notes copied as Markdown');
    else toast.error('Could not copy to the clipboard');
  };
  return (
    <div className="flex flex-col gap-4" data-testid="notes-tab">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Structured notes Claude took while reading the transcript. Click a timestamp to jump
          there.
        </p>
        <Button variant="outline" size="sm" onClick={() => void copyAll()}>
          <Copy /> Copy all notes
        </Button>
      </div>
      <Group title="Key points" count={n.keyPoints.length}>
        <ul className="flex flex-col gap-2.5">
          {n.keyPoints.map((p, i) => (
            <li key={i} className="flex items-start gap-3 text-sm leading-6">
              <span aria-hidden className="mt-2.5 size-1.5 shrink-0 rounded-full bg-primary-text" />
              <span className="selectable">{p}</span>
            </li>
          ))}
        </ul>
      </Group>
      <div className="grid grid-cols-2 gap-4 max-[1100px]:grid-cols-1">
        <Group title="Quotes" count={n.quotes.length}>
          <Stamped items={n.quotes} onSeek={seek} quote />
        </Group>
        <Group title="Numbers" count={n.numbers.length}>
          <Stamped items={n.numbers} onSeek={seek} />
        </Group>
      </div>
      <Group title="Claims" count={n.claims.length}>
        <Stamped items={n.claims} onSeek={seek} />
      </Group>
      <Group title="Action items" count={n.actionItems.length}>
        <ul className="flex flex-col gap-2.5">
          {n.actionItems.map((a, i) => (
            <li key={i} className="flex items-start gap-3 text-sm leading-6">
              <CheckCircle2 className="mt-1 size-4 shrink-0 text-success" aria-hidden />
              <span className="selectable">{a}</span>
            </li>
          ))}
        </ul>
      </Group>
    </div>
  );
}
