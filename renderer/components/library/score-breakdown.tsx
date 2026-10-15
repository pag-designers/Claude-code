import { Progress } from '@/components/ui/progress';
import type { ScoreBreakdown as Breakdown } from '@shared/pipeline';

export const BREAKDOWN_ROWS = [
  { key: 'hook', label: 'Hook', cap: 25, hint: 'Does the first 3 seconds stop the scroll?' },
  {
    key: 'retention',
    label: 'Retention arc',
    cap: 25,
    hint: 'Setup, tension and payoff that keep people watching.',
  },
  {
    key: 'emotion',
    label: 'Emotion & entertainment',
    cap: 20,
    hint: 'Humor, surprise, controversy or feeling.',
  },
  {
    key: 'clarity',
    label: 'Clarity',
    cap: 15,
    hint: 'Makes sense on its own, without the rest of the video.',
  },
  {
    key: 'shareability',
    label: 'Shareability',
    cap: 15,
    hint: 'Quotable, relatable, worth sending to a friend.',
  },
] as const satisfies readonly { key: keyof Breakdown; label: string; cap: number; hint: string }[];

/** The five virality sub-scores as labelled bars with their caps (25/25/20/15/15), plus model confidence. */
export function ScoreBreakdownBars({
  breakdown,
  confidence,
}: {
  breakdown: Breakdown;
  confidence: number | null;
}) {
  return (
    <div data-testid="score-breakdown">
      <ul className="flex flex-col gap-3">
        {BREAKDOWN_ROWS.map((r) => {
          const v = breakdown[r.key];
          const ratio = v / r.cap;
          return (
            <li key={r.key} title={r.hint} data-testid={`bd-${r.key}`}>
              <div className="mb-1.5 flex items-baseline justify-between gap-3">
                <span className="text-sm font-medium">{r.label}</span>
                <span className="text-sm tabular-nums text-muted-foreground">
                  <span className="font-semibold text-foreground">{Math.round(v * 10) / 10}</span>
                  <span className="text-subtle"> / {r.cap}</span>
                </span>
              </div>
              <Progress
                value={ratio * 100}
                tone={ratio >= 0.8 ? 'success' : ratio >= 0.5 ? 'primary' : 'warning'}
                className="h-1.5"
                aria-label={`${r.label}: ${v} of ${r.cap}`}
              />
            </li>
          );
        })}
      </ul>
      {confidence !== null ? (
        <div className="mt-4 flex items-center justify-between rounded-lg border bg-muted/50 px-3 py-2">
          <span className="text-xs text-muted-foreground">Model confidence in this score</span>
          <span className="text-sm font-semibold tabular-nums" data-testid="confidence">
            {Math.round(confidence * 100)}%
          </span>
        </div>
      ) : null}
    </div>
  );
}
