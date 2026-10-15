'use client';

import Link from 'next/link';
import { ProgressRing } from '@/components/ui/progress-ring';
import { Skeleton } from '@/components/ui/skeleton';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { formatUsd } from '@/lib/format';
import { settingsHref } from '@/lib/nav';
import { useCost } from '@/lib/queries';
import { useSettings } from '@/lib/settings';
import type { CostSummary } from '@shared/domain';

const TONE: Record<
  CostSummary['level'],
  { box: string; ring: 'primary' | 'warning' | 'danger'; label: string }
> = {
  ok: {
    box: 'border-input bg-field text-muted-foreground hover:border-border-strong hover:text-foreground',
    ring: 'primary',
    label: 'On track',
  },
  warn: {
    box: 'border-warning/40 bg-warning-soft text-warning',
    ring: 'warning',
    label: 'Above 80% of target',
  },
  'over-target': {
    box: 'border-danger/40 bg-danger-soft text-danger',
    ring: 'danger',
    label: 'Over target',
  },
  'hard-cap': {
    box: 'border-danger/60 bg-danger-soft text-danger',
    ring: 'danger',
    label: 'Hard cap reached',
  },
};

/** Top-bar cost tracker: "AI $12.84 / $30", coloured by budget level, links to Settings → Models & Budget. */
export function CostChip() {
  const { data: c, isPending } = useCost();
  const { settings } = useSettings();
  if (isPending) return <Skeleton className="mr-1 h-8 w-32 rounded-md" />;
  const target = c?.targetUsd ?? settings.budgetTargetUsd;
  const spent = c?.spentUsd ?? 0;
  const level = c?.level ?? 'ok';
  const tone = TONE[level];
  const text = `AI ${formatUsd(spent)} / ${formatUsd(target, 0)}`;
  return (
    <Tip
      side="bottom"
      content={
        <span className="flex flex-col gap-0.5">
          <span className="font-semibold">AI spend this month: {tone.label}</span>
          {c ? (
            <span className="text-muted-foreground">
              Projected {formatUsd(c.projectedUsd)} · hard cap {formatUsd(c.hardCapUsd, 0)}
            </span>
          ) : null}
          <span className="text-muted-foreground">Click for Models &amp; Budget</span>
        </span>
      }
    >
      <Link
        href={settingsHref('models')}
        data-testid="cost-chip"
        data-level={level}
        aria-label={`AI spend this month: ${formatUsd(spent)} of ${formatUsd(target, 0)} target. ${tone.label}. Open Models and Budget settings.`}
        className={cn(
          'mr-1 flex h-8 items-center gap-2 rounded-md border px-2.5 text-sm font-medium tabular-nums transition-colors duration-(--duration-fast)',
          tone.box,
        )}
      >
        <ProgressRing
          value={target > 0 ? spent / target : 0}
          size={16}
          stroke={2.5}
          tone={tone.ring}
        />
        <span>{text}</span>
      </Link>
    </Tip>
  );
}
