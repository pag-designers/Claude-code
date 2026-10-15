'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { useCost } from '@/lib/queries';
import { useSettings, useUpdateSettings } from '@/lib/settings';
import { formatCompact, formatUsd } from '@/lib/format';
import type { CostSummary } from '@shared/domain';
import { SaveBar, SettingsCard } from './common';
import { SettingsHeading } from './settings-shell';

const schema = z
  .object({
    modelSmart: z.string().trim().min(1, 'Enter a model ID.'),
    modelFast: z.string().trim().min(1, 'Enter a model ID.'),
    budgetTargetUsd: z.number({ error: 'Enter an amount.' }).positive('Must be above $0.'),
    budgetHardCapUsd: z.number({ error: 'Enter an amount.' }).positive('Must be above $0.'),
  })
  .refine((v) => v.budgetHardCapUsd >= v.budgetTargetUsd, {
    path: ['budgetHardCapUsd'],
    message: 'The hard cap must be at least the monthly target.',
  });
type FormValues = z.infer<typeof schema>;

const LEVEL: Record<
  CostSummary['level'],
  { label: string; variant: 'success' | 'warning' | 'danger' }
> = {
  ok: { label: 'On track', variant: 'success' },
  warn: { label: 'Above 80% of target', variant: 'warning' },
  'over-target': { label: 'Over target', variant: 'danger' },
  'hard-cap': { label: 'Hard cap reached', variant: 'danger' },
};

function monthLabel(m: string): string {
  const [y, mo] = m.split('-').map(Number);
  if (!y || !mo) return m;
  return new Date(y, mo - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function CostTracker() {
  const { data: c, isPending, isError, refetch, isFetching } = useCost();
  const scale = c ? Math.max(c.hardCapUsd, c.spentUsd, c.projectedUsd) : 1;
  const pct = c ? (c.spentUsd / scale) * 100 : 0;
  const tone = !c
    ? 'primary'
    : c.level === 'ok'
      ? 'primary'
      : c.level === 'warn'
        ? 'warning'
        : 'danger';
  return (
    <SettingsCard
      title="Cost tracker"
      description={
        c
          ? `Claude spend for ${monthLabel(c.month)}. Everything else in Clipfern is free.`
          : 'Claude spend this month.'
      }
      action={
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Refresh cost"
          onClick={() => void refetch()}
          loading={isFetching}
        >
          <RefreshCw />
        </Button>
      }
    >
      {isPending ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-10 w-40" />
          <Skeleton className="h-3 w-full" />
        </div>
      ) : isError || !c ? (
        <p className="text-sm text-danger">Could not read the cost summary.</p>
      ) : (
        <>
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="font-display text-4xl font-semibold tabular-nums leading-none">
                {formatUsd(c.spentUsd)}
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                spent · projected{' '}
                <span className="font-medium text-foreground tabular-nums">
                  {formatUsd(c.projectedUsd)}
                </span>{' '}
                by month end
              </p>
            </div>
            <Badge variant={LEVEL[c.level].variant} dot>
              {LEVEL[c.level].label}
            </Badge>
          </div>
          <div className="flex flex-col gap-2">
            <Progress
              value={pct}
              tone={tone}
              className="h-2.5"
              aria-label={`Spent ${formatUsd(c.spentUsd)} of ${formatUsd(c.hardCapUsd)} hard cap`}
              markers={[
                { at: (c.targetUsd / scale) * 100, label: `Target ${formatUsd(c.targetUsd, 0)}` },
              ]}
            />
            <div className="relative flex justify-between text-xs tabular-nums text-subtle">
              <span>$0</span>
              <span
                className="absolute -translate-x-1/2"
                style={{ left: `${(c.targetUsd / scale) * 100}%` }}
              >
                Target {formatUsd(c.targetUsd, 0)}
              </span>
              <span>Hard cap {formatUsd(c.hardCapUsd, 0)}</span>
            </div>
          </div>
          <dl className="mt-1 grid grid-cols-4 gap-3 border-t pt-5">
            {[
              ['Calls', c.calls.toLocaleString()],
              ['Input tokens', formatCompact(c.inputTokens)],
              ['Output tokens', formatCompact(c.outputTokens)],
              ['Cached tokens', formatCompact(c.cachedTokens)],
            ].map(([k, v]) => (
              <div key={k}>
                <dt className="text-xs text-muted-foreground">{k}</dt>
                <dd className="mt-0.5 font-display text-lg font-semibold tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </SettingsCard>
  );
}

export function ModelsSettings() {
  const { settings } = useSettings();
  const { update, saving } = useUpdateSettings();
  const values: FormValues = {
    modelSmart: settings.modelSmart,
    modelFast: settings.modelFast,
    budgetTargetUsd: settings.budgetTargetUsd,
    budgetHardCapUsd: settings.budgetHardCapUsd,
  };
  const { register, handleSubmit, reset, formState } = useForm<FormValues>({
    resolver: zodResolver(schema),
    values,
    resetOptions: { keepDirtyValues: true },
    mode: 'onChange',
  });
  const { errors, isDirty } = formState;
  const onSave = handleSubmit(async (v) => {
    await update(v, { successMessage: 'Models and budget saved' });
    reset(v);
  });

  return (
    <>
      <SettingsHeading
        title="Models & Budget"
        description="Claude is the only paid service. Clipfern tracks every call against your monthly target."
      />
      <CostTracker />
      <SettingsCard
        title="Claude models"
        description="Use the smart model for moment-finding and scoring, the fast one for titles, hashtags and chat."
      >
        <div className="grid grid-cols-2 gap-4">
          <Field
            label="Smart model"
            htmlFor="modelSmart"
            error={errors.modelSmart?.message}
            description="Highest quality: ranking and hooks."
          >
            <Input
              id="modelSmart"
              className="font-mono"
              invalid={!!errors.modelSmart}
              autoComplete="off"
              spellCheck={false}
              {...register('modelSmart')}
            />
          </Field>
          <Field
            label="Fast model"
            htmlFor="modelFast"
            error={errors.modelFast?.message}
            description="Cheap tasks: titles, descriptions, retrieval."
          >
            <Input
              id="modelFast"
              className="font-mono"
              invalid={!!errors.modelFast}
              autoComplete="off"
              spellCheck={false}
              {...register('modelFast')}
            />
          </Field>
        </div>
      </SettingsCard>
      <SettingsCard
        title="Monthly budget"
        description="Clipfern warns at 80% of the target, then switches low-value tasks to the fast model and reduces candidates."
      >
        <div className="grid grid-cols-2 gap-4">
          <Field
            label="Target (USD / month)"
            htmlFor="budgetTargetUsd"
            error={errors.budgetTargetUsd?.message}
          >
            <Input
              id="budgetTargetUsd"
              type="number"
              min={1}
              step={1}
              leading={<span className="text-sm">$</span>}
              invalid={!!errors.budgetTargetUsd}
              {...register('budgetTargetUsd', { valueAsNumber: true })}
            />
          </Field>
          <Field
            label="Hard cap (USD / month)"
            htmlFor="budgetHardCapUsd"
            error={errors.budgetHardCapUsd?.message}
            description="Claude calls stop at this amount."
          >
            <Input
              id="budgetHardCapUsd"
              type="number"
              min={1}
              step={1}
              leading={<span className="text-sm">$</span>}
              invalid={!!errors.budgetHardCapUsd}
              {...register('budgetHardCapUsd', { valueAsNumber: true })}
            />
          </Field>
        </div>
      </SettingsCard>
      <SaveBar
        dirty={isDirty}
        saving={saving}
        onReset={() => reset(values)}
        onSave={() => void onSave()}
      />
    </>
  );
}
