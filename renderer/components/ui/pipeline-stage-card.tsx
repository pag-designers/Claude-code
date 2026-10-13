import * as React from 'react';
import { motion } from 'framer-motion';
import { Check, CircleAlert, Loader2, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Progress } from './progress';

export type StageStatus = 'pending' | 'active' | 'done' | 'error';

/** One step of a multi-stage pipeline (transcription engine setup now, clip pipeline from CP1). */
export function PipelineStageCard({
  icon: Icon,
  title,
  description,
  status,
  progress,
  meta,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  status: StageStatus;
  /** 0..1, or null when the stage is running but indeterminate. */
  progress?: number | null;
  meta?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      aria-current={status === 'active' ? 'step' : undefined}
      className={cn(
        'relative flex flex-col gap-2.5 overflow-hidden rounded-lg border bg-card px-3.5 py-3 transition-colors duration-(--duration-base)',
        status === 'active' && 'border-primary/60 bg-primary-soft',
        status === 'error' && 'border-danger/50 bg-danger-soft',
        status === 'pending' && 'opacity-70',
        className,
      )}
    >
      <div className="flex items-center gap-3">
        <span
          className={cn(
            'flex size-8 shrink-0 items-center justify-center rounded-md',
            status === 'done' && 'bg-success-soft text-success',
            status === 'active' && 'bg-primary text-primary-foreground',
            status === 'error' && 'bg-danger-soft text-danger',
            status === 'pending' && 'bg-muted text-muted-foreground',
          )}
        >
          {status === 'done' ? (
            <motion.span
              initial={{ scale: 0.4 }}
              animate={{ scale: 1 }}
              transition={{ type: 'spring', stiffness: 500, damping: 18 }}
            >
              <Check className="size-4" aria-hidden />
            </motion.span>
          ) : status === 'active' ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : status === 'error' ? (
            <CircleAlert className="size-4" aria-hidden />
          ) : (
            <Icon className="size-4" aria-hidden />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold leading-5">{title}</p>
          {description ? (
            <p className="truncate text-xs text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {meta ? (
          <div className="shrink-0 text-xs tabular-nums text-muted-foreground">{meta}</div>
        ) : null}
      </div>
      {status === 'active' ? (
        <Progress
          value={progress === undefined || progress === null ? null : progress * 100}
          className="h-1.5"
        />
      ) : null}
    </div>
  );
}
