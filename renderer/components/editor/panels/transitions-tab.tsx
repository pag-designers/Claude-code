'use client';

import * as React from 'react';
import { ArrowLeftRight, Info, X } from 'lucide-react';
import { toast } from 'sonner';
import type { TransitionType } from '@shared/editor';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { useEditorStore } from '@/lib/editor/core';
import { startTransitionDrag } from '@/lib/editor-panels/drag';
import { resolveTransitionTarget } from '@/lib/editor-panels/edit-targets';
import { DEFAULT_TRANSITION_SEC, TRANSITIONS, transitionLabel } from '@/lib/editor-panels/presets';
import { cn } from '@/lib/utils';
import { applyTransition } from './actions';
import { GroupLabel, tileBase } from './bits';

const DURATION_KEY = 'clipfern.editor.transition.sec';

function readDuration(): number {
  try {
    const v = Number(localStorage.getItem(DURATION_KEY));
    if (v >= 0.1 && v <= 2) return v;
  } catch {
    /* storage blocked */
  }
  return DEFAULT_TRANSITION_SEC;
}

/** Cheap, primitive summary of "where would a transition go right now" so the tab re-renders only when it changes. */
function useTargetInfo(): {
  ok: boolean;
  itemName: string;
  previousName: string;
  existing: TransitionType | null;
  maxSec: number;
  reason: string;
} {
  const json = useEditorStore((s) => {
    const t = resolveTransitionTarget(s.project, s.selection.itemIds, s.playheadSec);
    const nameOf = (i: { id: string; name?: string }) => i.name ?? 'Clip';
    return JSON.stringify(
      t.ok
        ? {
            ok: true,
            itemName: nameOf(t.item),
            previousName: nameOf(t.previous),
            existing: t.existing?.type ?? null,
            maxSec: t.maxSec,
          }
        : { ok: false, reason: t.reason },
    );
  });
  return React.useMemo(
    () => ({
      ok: false,
      itemName: '',
      previousName: '',
      existing: null,
      maxSec: 2,
      reason: '',
      ...JSON.parse(json),
    }),
    [json],
  );
}

/** Animated CSS preview (see panels.css): rests mid-transition, plays on hover / keyboard focus. */
function TransitionPreview({ type }: { type: TransitionType }) {
  return (
    <span className="tp block aspect-[16/10] w-full" data-t={type} aria-hidden>
      <span className="tp-layer tp-a" />
      <span className="tp-layer tp-b" />
      <span className="tp-veil" />
    </span>
  );
}

export function TransitionsTab() {
  const [sec, setSec] = React.useState(readDuration);
  const info = useTargetInfo();
  const maxSec = Math.min(2, info.ok ? info.maxSec : 2);
  const effective = Math.min(sec, maxSec);

  const setDuration = (v: number) => {
    setSec(v);
    try {
      localStorage.setItem(DURATION_KEY, String(v));
    } catch {
      /* not remembered */
    }
  };

  const apply = (type: TransitionType) => {
    const r = applyTransition(type, sec);
    if (r.ok) toast.success(r.label);
    else toast.info(r.reason);
  };

  return (
    <div className="flex flex-col gap-4" data-testid="bin-transitions">
      <section
        aria-label="Transition target and length"
        className="flex flex-col gap-2.5 rounded-xl border bg-muted/40 p-3"
      >
        <p
          className="flex items-start gap-2 text-xs leading-4"
          data-testid="bin-transition-target"
          data-ok={info.ok}
        >
          <Info
            className={cn('mt-px size-3.5 shrink-0', info.ok ? 'text-primary-text' : 'text-subtle')}
            aria-hidden
          />
          {info.ok ? (
            <span className="min-w-0 text-muted-foreground">
              Applies between{' '}
              <strong className="font-semibold text-foreground">{info.previousName}</strong> and{' '}
              <strong className="font-semibold text-foreground">{info.itemName}</strong>
              {info.existing ? (
                <>
                  {' '}
                  (now: <span className="text-foreground">{transitionLabel(info.existing)}</span>)
                </>
              ) : null}
              .
            </span>
          ) : (
            <span className="text-muted-foreground">{info.reason}</span>
          )}
        </p>
        <div className="flex items-center gap-3">
          <label htmlFor="bin-transition-sec" className="shrink-0 text-xs font-medium">
            Length
          </label>
          <Slider
            id="bin-transition-sec"
            value={effective}
            onValueChange={setDuration}
            min={0.1}
            max={Math.max(0.2, maxSec)}
            step={0.05}
            aria-label="Transition length in seconds"
            className="flex-1"
            data-testid="bin-transition-length"
          />
          <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
            {effective.toFixed(2)}s
          </span>
        </div>
        {info.ok && info.existing ? (
          <Button
            variant="ghost"
            size="xs"
            className="self-start"
            onClick={() => apply('cut')}
            data-testid="bin-transition-remove"
          >
            <X /> Remove {transitionLabel(info.existing).toLowerCase()}
          </Button>
        ) : null}
      </section>

      <section aria-label="Transitions" className="flex flex-col gap-2.5">
        <GroupLabel>All transitions</GroupLabel>
        <ul className="grid grid-cols-2 gap-2">
          {TRANSITIONS.map((t) => (
            <li key={t.type} className="min-w-0">
              <button
                type="button"
                draggable
                onDragStart={(e) => startTransitionDrag(e.dataTransfer, t.type)}
                onClick={() => apply(t.type)}
                aria-label={`${t.label}: ${t.hint}`}
                aria-pressed={info.ok && info.existing === t.type}
                data-testid="bin-transition"
                data-type={t.type}
                className={cn(
                  tileBase,
                  'ed-play w-full',
                  info.ok &&
                    info.existing === t.type &&
                    'border-primary bg-primary-soft hover:border-primary',
                )}
              >
                <TransitionPreview type={t.type} />
                <span className="flex items-center gap-1.5 px-0.5">
                  <ArrowLeftRight className="size-3 shrink-0 text-subtle" aria-hidden />
                  <span className="truncate text-xs font-medium">{t.label}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        <p className="text-2xs leading-4 text-subtle">
          Click to apply, or drag a tile onto the join between two clips on the timeline.
        </p>
      </section>
    </div>
  );
}
