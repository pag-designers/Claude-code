'use client';

import * as React from 'react';
import { Blend, Trash2 } from 'lucide-react';
import type { Item, TransitionType } from '@shared/editor';
import { transitionTypeSchema } from '@shared/editor';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Slider } from '@/components/ui/slider';
import { useEditorStore } from '@/lib/editor/core';
import { cn } from '@/lib/utils';

export const TRANSITION_LABEL: Record<TransitionType, string> = {
  cut: 'Cut',
  crossfade: 'Crossfade',
  'dip-black': 'Dip to black',
  'dip-white': 'Dip to white',
  'slide-left': 'Slide left',
  'slide-right': 'Slide right',
  'slide-up': 'Slide up',
  'slide-down': 'Slide down',
  zoom: 'Zoom',
  blur: 'Blur',
  'whip-pan': 'Whip pan',
  glitch: 'Glitch',
};

type WithTransition = Extract<Item, { type: 'video' | 'image' }>;

/**
 * The overlap region between a clip and the one before it, drawn as a diagonal "X" with a glyph. Clicking opens the
 * editor (type + duration, or remove). The region is `durationSec` wide and starts at the later item's start.
 */
export function TransitionGlyph({ item, pxPerSec }: { item: WithTransition; pxPerSec: number }) {
  const tr = item.transitionIn;
  const [open, setOpen] = React.useState(false);
  if (!tr) return null;
  const w = Math.max(14, tr.durationSec * pxPerSec);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-transition={item.id}
          aria-label={`Transition: ${TRANSITION_LABEL[tr.type]}, ${tr.durationSec.toFixed(2)} seconds. Click to edit.`}
          className="tl-transition app-no-drag"
          style={{ left: -1, width: w }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <span className="flex size-4 items-center justify-center rounded-full border border-border-strong bg-popover text-foreground shadow-xs">
            <Blend className="size-2.5" aria-hidden />
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-3" data-testid="transition-editor">
        <TransitionForm
          itemId={item.id}
          type={tr.type}
          durationSec={tr.durationSec}
          onDone={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}

function TransitionForm({
  itemId,
  type,
  durationSec,
  onDone,
}: {
  itemId: string;
  type: TransitionType;
  durationSec: number;
  onDone: () => void;
}) {
  const setTransition = useEditorStore((s) => s.setTransition);
  /** null = not dragging (mirrors the store). */
  const [drag, setDrag] = React.useState<number | null>(null);
  const dur = drag ?? durationSec;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs font-semibold uppercase tracking-wider text-subtle">Transition</p>
      <div className="grid grid-cols-3 gap-1" role="radiogroup" aria-label="Transition type">
        {transitionTypeSchema.options.map((t) => (
          <button
            key={t}
            type="button"
            role="radio"
            aria-checked={t === type}
            onClick={() => setTransition(itemId, { type: t, durationSec: dur })}
            className={cn(
              'rounded-md border px-1.5 py-1.5 text-2xs font-medium leading-3 transition-colors',
              t === type
                ? 'border-ring bg-primary-soft text-primary-text'
                : 'border-border bg-muted text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            {TRANSITION_LABEL[t]}
          </button>
        ))}
      </div>
      <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
        <span className="flex justify-between">
          Duration <span className="tabular-nums text-foreground">{dur.toFixed(2)} s</span>
        </span>
        <Slider
          aria-label="Transition duration"
          value={dur}
          min={0.05}
          max={3}
          step={0.05}
          onValueChange={setDrag}
          onPointerUp={() => {
            setTransition(itemId, { type, durationSec: dur });
            setDrag(null);
          }}
          onKeyUp={() => {
            setTransition(itemId, { type, durationSec: dur });
            setDrag(null);
          }}
        />
      </label>
      <Button
        variant="danger-ghost"
        size="xs"
        className="self-start"
        onClick={() => {
          setTransition(itemId, null);
          onDone();
        }}
      >
        <Trash2 /> Remove transition
      </Button>
    </div>
  );
}
