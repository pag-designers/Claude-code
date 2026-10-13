'use client';

import { CalendarClock, DollarSign, Scissors, Wallet } from 'lucide-react';
import { StatCard } from '@/components/ui/stat-card';
import { useCost } from '@/lib/queries';
import { formatUsd } from '@/lib/format';

/** Zeros are real: nothing has been clipped, scheduled or earned yet. Hints say when each number starts moving. */
export function HomeStats() {
  const cost = useCost();
  const c = cost.data;
  return (
    <section aria-label="Stats" className="grid grid-cols-4 gap-4 max-[1180px]:grid-cols-2">
      <StatCard
        label="Clips this week"
        value="0"
        icon={Scissors}
        hint="Counting starts when the clip pipeline lands (checkpoint 1)."
      />
      <StatCard
        label="Posts scheduled"
        value="0"
        icon={CalendarClock}
        hint="Posting and scheduling arrive in checkpoint 5."
      />
      <StatCard
        label="Whop earnings"
        value="$0.00"
        icon={DollarSign}
        hint="Not connected yet. Whop sync arrives in checkpoint 6."
      />
      <StatCard
        label="AI spend this month"
        value={c ? formatUsd(c.spentUsd) : '$0.00'}
        loading={cost.isPending}
        icon={Wallet}
        tone={
          c?.level === 'hard-cap' || c?.level === 'over-target'
            ? 'danger'
            : c?.level === 'warn'
              ? 'warning'
              : 'default'
        }
        hint={
          c
            ? `${c.calls.toLocaleString()} Claude calls · target ${formatUsd(c.targetUsd, 0)}/month`
            : 'Live from your Claude usage.'
        }
      />
    </section>
  );
}
