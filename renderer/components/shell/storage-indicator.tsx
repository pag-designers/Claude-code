'use client';

import { CloudOff } from 'lucide-react';
import { ProgressRing } from '@/components/ui/progress-ring';
import { Skeleton } from '@/components/ui/skeleton';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useStorageUsage } from '@/lib/queries';
import { useSettings } from '@/lib/settings';
import { useUi } from '@/lib/store';
import { formatGb } from '@/lib/format';
import { gbUnit, storageTone } from '@/lib/storage';
import { useSidebarCollapsed } from '@/lib/prefs';

/** Pinned at the bottom of the sidebar: ring + "X.XX GB / 10 GB" + Manage. Real bucket usage, live via storage:updated. */
export function StorageIndicator() {
  const { data, isPending, isError } = useStorageUsage();
  const { settings } = useSettings();
  const open = useUi((s) => s.setStorageDialogOpen);
  const collapsed = useSidebarCollapsed();

  const configured = data?.configured === true;
  const unit = data ? gbUnit(data.limitBytes, settings.storageFreeTierGb) : 1e9;
  const limitLabel = data ? Math.round(data.limitBytes / unit) : settings.storageFreeTierGb;
  const usedLabel = data ? formatGb(data.usedBytes, unit) : '0.00';
  const tone = storageTone(data);

  const summary = isPending
    ? 'Loading storage'
    : !configured
      ? 'Storage not connected'
      : `${usedLabel} GB of ${limitLabel} GB used`;

  return (
    <Tip content={summary} side="right" disabled={!collapsed}>
      <button
        type="button"
        onClick={() => open(true)}
        aria-label={`Storage: ${summary}. Manage storage`}
        className={cn(
          'group flex w-full items-center gap-3 rounded-lg border bg-card p-2.5 text-left transition-colors duration-(--duration-fast) hover:border-border-strong hover:bg-raised',
          'collapsed:justify-center collapsed:border-transparent collapsed:bg-transparent collapsed:p-0 collapsed:py-1.5',
        )}
      >
        {isPending ? (
          <Skeleton className="size-9 rounded-full" />
        ) : (
          <ProgressRing
            value={configured ? (data?.fraction ?? 0) : 0}
            size={36}
            stroke={4}
            tone={configured && !isError ? tone : 'muted'}
            dashed={!configured}
          >
            {!configured ? (
              <CloudOff className="size-3.5 text-subtle" aria-hidden />
            ) : (
              <span className="text-2xs font-semibold tabular-nums">
                {Math.round((data?.fraction ?? 0) * 100)}
              </span>
            )}
          </ProgressRing>
        )}
        <span className="min-w-0 flex-1 collapsed:hidden">
          <span className="block text-xs font-semibold leading-4 text-foreground">Storage</span>
          <span className="block truncate text-2xs leading-4 tabular-nums text-muted-foreground">
            {isPending
              ? 'Checking…'
              : !configured
                ? 'Not connected'
                : `${usedLabel} GB / ${limitLabel} GB`}
          </span>
        </span>
        <span className="text-xs font-medium text-primary-text group-hover:underline collapsed:hidden">
          {configured ? 'Manage' : 'Connect'}
        </span>
      </button>
    </Tip>
  );
}
