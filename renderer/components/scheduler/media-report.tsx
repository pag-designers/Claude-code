'use client';

import * as React from 'react';
import { CircleAlert, CircleCheck, FileVideo, TriangleAlert, Wand2 } from 'lucide-react';
import type { Platform } from '@shared/cp2';
import type { MediaReport } from '@shared/publish';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { PLATFORM_INFO, describeMedia, reportBlocks, reportNeedsFix } from '@/lib/publish/model';
import { cn } from '@/lib/utils';

/**
 * The ffprobe-based spec check of a clip for one platform: what the file is, what is out of spec, and the Auto-fix
 * switch (re-encode a compliant copy before posting). `autoFix` undefined hides the switch (read-only history).
 */
export function MediaReportView({
  platform,
  report,
  loading,
  error,
  autoFix,
  onAutoFixChange,
  disabled,
  className,
  switchId = 'media-autofix',
}: {
  platform: Platform;
  report: MediaReport | undefined | null;
  loading?: boolean;
  error?: string | null;
  autoFix?: boolean;
  onAutoFixChange?: (v: boolean) => void;
  disabled?: boolean;
  className?: string;
  switchId?: string;
}) {
  const name = PLATFORM_INFO[platform].name;
  if (loading && !report)
    return (
      <div
        className={cn('flex flex-col gap-2', className)}
        aria-busy
        aria-label="Checking the video"
      >
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  if (error && !report)
    return (
      <p className={cn('flex items-center gap-2 text-xs text-muted-foreground', className)}>
        <TriangleAlert className="size-3.5 text-warning" aria-hidden />
        Could not check the video against {name}&apos;s limits: {error}
      </p>
    );
  if (!report) return null;

  const fixOn = autoFix ?? true;
  const blocked = reportBlocks(report, fixOn);
  const needsFix = reportNeedsFix(report);
  const hasFixable = report.issues.some((i) => i.fixable);

  return (
    <div
      className={cn('flex flex-col gap-3', className)}
      data-testid="media-report"
      data-platform={platform}
      data-blocked={blocked || undefined}
    >
      <div className="flex items-start gap-2.5">
        {blocked ? (
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
        ) : report.issues.length ? (
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
        ) : (
          <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
        )}
        <div className="min-w-0">
          <p className="text-sm font-medium">
            {blocked
              ? `Doesn't meet ${name}'s requirements`
              : needsFix
                ? `Needs a re-encode for ${name}`
                : report.issues.length
                  ? `Meets ${name}'s requirements, with advice`
                  : `Meets ${name}'s requirements`}
          </p>
          <p
            className="mt-0.5 flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground"
            data-testid="media-facts"
          >
            <FileVideo className="size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 truncate">{describeMedia(report.media)}</span>
          </p>
        </div>
      </div>

      {report.issues.length ? (
        <ul className="flex flex-col gap-1.5" aria-label={`${name} media issues`}>
          {report.issues.map((i) => (
            <li
              key={`${i.code}-${i.message}`}
              data-severity={i.severity}
              data-code={i.code}
              className={cn(
                'flex items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-4',
                i.severity === 'error'
                  ? 'border-danger/35 bg-danger-soft'
                  : 'border-warning/35 bg-warning-soft',
              )}
            >
              {i.severity === 'error' ? (
                <CircleAlert className="mt-px size-3.5 shrink-0 text-danger" aria-hidden />
              ) : (
                <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
              )}
              <span className="min-w-0 flex-1 text-foreground">{i.message}</span>
              {i.fixable ? (
                <Badge variant="outline" className="shrink-0">
                  Fixable
                </Badge>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {onAutoFixChange && (hasFixable || needsFix) ? (
        <div className="flex items-start justify-between gap-4 rounded-lg border bg-muted/40 px-3 py-2.5">
          <div className="min-w-0">
            <label htmlFor={switchId} className="flex items-center gap-1.5 text-sm font-medium">
              <Wand2 className="size-3.5 text-primary-text" aria-hidden /> Auto-fix
            </label>
            <p className="mt-0.5 text-xs leading-4 text-muted-foreground">
              {fixOn
                ? 'Clipfern re-encodes a compliant copy right before posting. Your original clip is not changed.'
                : 'Off: a post with fixable problems is refused until you fix the clip yourself.'}
            </p>
          </div>
          <Switch
            id={switchId}
            checked={fixOn}
            onCheckedChange={onAutoFixChange}
            disabled={disabled}
            className="mt-0.5"
          />
        </div>
      ) : null}
    </div>
  );
}
