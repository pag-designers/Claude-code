'use client';

import { Hash, Users } from 'lucide-react';
import type { VideoAnalysis, VideoView } from '@shared/pipeline';
import { Badge } from '@/components/ui/badge';
import { formatClock } from '@/lib/format';
import { AnalysisPending } from './analysis-states';

function Section({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={className}>
      <h3 className="mb-2.5 text-2xs font-semibold uppercase tracking-wider text-subtle">
        {title}
      </h3>
      {children}
    </section>
  );
}

export function OverviewTab({
  video,
  analysis,
}: {
  video: VideoView;
  analysis: VideoAnalysis | null;
}) {
  if (!analysis) return <AnalysisPending video={video} what="Overview and takeaways" />;
  const { overview } = analysis;
  return (
    <div className="flex flex-col gap-6" data-testid="overview-tab">
      <div className="rounded-xl border bg-card p-6">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="font-display text-lg font-semibold">What this video is about</h2>
          {overview.tone ? <Badge variant="primary">{overview.tone}</Badge> : null}
          {video.durationSec !== null ? (
            <Badge variant="neutral" className="tabular-nums">
              {formatClock(video.durationSec)}
            </Badge>
          ) : null}
        </div>
        <p
          className="selectable max-w-3xl text-md leading-7 text-foreground/90"
          data-testid="overview-summary"
        >
          {overview.summary}
        </p>
        {overview.participants.length ? (
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Users className="size-3.5" aria-hidden /> Participants
            </span>
            {overview.participants.map((p) => (
              <Badge key={p} variant="outline" className="text-xs">
                {p}
              </Badge>
            ))}
          </div>
        ) : null}
      </div>

      <div className="grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-6 max-[1100px]:grid-cols-1">
        <Section title="Key takeaways">
          <ol className="flex flex-col gap-2" data-testid="takeaways">
            {overview.takeaways.map((t, i) => (
              <li key={i} className="flex gap-3 rounded-xl border bg-card p-3.5">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary-soft text-xs font-bold tabular-nums text-primary-text">
                  {i + 1}
                </span>
                <span className="selectable text-sm leading-6">{t}</span>
              </li>
            ))}
          </ol>
        </Section>
        <div className="flex flex-col gap-6">
          {analysis.topics.length ? (
            <Section title="Topics">
              <div className="flex flex-wrap gap-2">
                {analysis.topics.map((t) => (
                  <Badge key={t} variant="primary" className="px-2.5 py-1 text-xs">
                    {t}
                  </Badge>
                ))}
              </div>
            </Section>
          ) : null}
          {analysis.keywords.length ? (
            <Section title="Keywords">
              <div className="flex flex-wrap gap-1.5">
                {analysis.keywords.map((k) => (
                  <Badge key={k} variant="neutral" className="text-xs">
                    <Hash aria-hidden /> {k}
                  </Badge>
                ))}
              </div>
            </Section>
          ) : null}
          {analysis.entities.length ? (
            <Section title="People & places">
              <div className="flex flex-wrap gap-1.5">
                {analysis.entities.map((k) => (
                  <Badge key={k} variant="outline" className="text-xs">
                    {k}
                  </Badge>
                ))}
              </div>
            </Section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
