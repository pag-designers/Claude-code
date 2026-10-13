import * as React from 'react';
import { REFRAME_MODE_LABELS, type ReframeMode } from '@shared/cp2';
import { cn } from '@/lib/utils';

export type RenderedLayout = 'single' | 'split' | 'screen-face';

export const LAYOUT_LABELS: Record<RenderedLayout, string> = {
  single: 'Single panel',
  split: 'Split screen',
  'screen-face': 'Screen + face',
};

export const MODE_HINTS: Record<ReframeMode, string> = {
  auto: 'Picks the best layout for each clip',
  'single-face': 'Smoothly follows the main speaker',
  'multi-face': 'Two people stacked, top and bottom',
  'screen-face': 'Shared screen on top, face below',
  center: 'A fixed crop from the middle, no tracking',
};

export const MODE_LAYOUT: Record<ReframeMode, RenderedLayout | 'auto'> = {
  auto: 'auto',
  'single-face': 'single',
  'multi-face': 'split',
  'screen-face': 'screen-face',
  center: 'single',
};

function Face({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('absolute rounded-full bg-primary-text/80', className)}
      style={{ width: '22%', aspectRatio: '1' }}
    />
  );
}

/**
 * A tiny 9:16 schematic of how a reframe layout cuts the frame (tokens only): one panel, two stacked faces, or a
 * screen with a face below. `auto` shows a dashed frame with a sparkle-less question of "best fit".
 */
export function LayoutGlyph({
  layout,
  className,
}: {
  layout: RenderedLayout | 'auto';
  className?: string;
}) {
  const panel = 'absolute inset-x-[10%] overflow-hidden rounded-[3px] bg-muted';
  return (
    <span
      aria-hidden
      className={cn(
        'relative inline-block aspect-[9/16] w-5 shrink-0 overflow-hidden rounded-[4px] border border-border-strong bg-card',
        layout === 'auto' && 'border-dashed',
        className,
      )}
    >
      {layout === 'single' || layout === 'auto' ? (
        <span className={cn(panel, 'inset-y-[8%]')}>
          <Face className="left-[39%] top-[26%]" />
          <span className="absolute inset-x-[22%] bottom-[10%] h-[24%] rounded-t-full bg-primary-text/45" />
        </span>
      ) : layout === 'split' ? (
        <>
          <span className={cn(panel, 'top-[6%] h-[43%]')}>
            <Face className="left-[39%] top-[24%]" />
          </span>
          <span className={cn(panel, 'bottom-[6%] h-[43%]')}>
            <Face className="left-[39%] top-[24%]" />
          </span>
        </>
      ) : (
        <>
          <span className={cn(panel, 'top-[6%] h-[50%]')}>
            <span className="absolute inset-x-[14%] top-[18%] h-[10%] rounded-full bg-border-strong" />
            <span className="absolute inset-x-[14%] top-[40%] h-[10%] rounded-full bg-border-strong" />
            <span className="absolute inset-x-[14%] top-[62%] h-[10%] w-[46%] rounded-full bg-border-strong" />
          </span>
          <span className={cn(panel, 'bottom-[6%] h-[34%]')}>
            <Face className="left-[39%] top-[16%]" />
          </span>
        </>
      )}
    </span>
  );
}

/** Radio group of all reframe modes with a glyph each (compact mode selector). */
export function ModeRadio({
  value,
  onChange,
  disabled,
  label,
  size = 'sm',
}: {
  value: ReframeMode;
  onChange: (m: ReframeMode) => void;
  disabled?: boolean;
  label: string;
  size?: 'sm' | 'lg';
}) {
  const modes = Object.keys(REFRAME_MODE_LABELS) as ReframeMode[];
  return (
    <div role="radiogroup" aria-label={label} className={cn('flex gap-1.5', size === 'lg' && 'gap-2')}>
      {modes.map((m) => {
        const active = m === value;
        return (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={REFRAME_MODE_LABELS[m]}
            title={`${REFRAME_MODE_LABELS[m]}: ${MODE_HINTS[m]}`}
            disabled={disabled}
            onClick={() => onChange(m)}
            data-mode={m}
            className={cn(
              'flex flex-col items-center justify-center gap-1.5 rounded-lg border outline-none transition-[background-color,border-color] duration-(--duration-fast)',
              'focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
              size === 'sm' ? 'h-12 w-9' : 'min-h-[88px] flex-1 px-2 py-2.5',
              active
                ? 'border-primary/70 bg-primary-soft'
                : 'border-border-strong hover:bg-accent',
            )}
          >
            <LayoutGlyph layout={MODE_LAYOUT[m]} className={size === 'lg' ? 'w-6' : 'w-4'} />
            {size === 'lg' ? (
              <span
                className={cn(
                  'text-center text-xs font-medium leading-4',
                  active ? 'text-primary-text' : 'text-muted-foreground',
                )}
              >
                {REFRAME_MODE_LABELS[m]}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
