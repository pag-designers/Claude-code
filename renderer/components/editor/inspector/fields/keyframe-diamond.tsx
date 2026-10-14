'use client';

import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { DiamondState } from '../lib/animated';

/** The keyframe toggle: hollow = not animated, ring = animated elsewhere, solid = a keyframe sits at the playhead. */
export function KeyframeDiamond({
  state,
  label,
  disabledReason,
  onToggle,
}: {
  state: DiamondState;
  /** Property name for the accessible label. */
  label: string;
  disabledReason?: string;
  onToggle: () => void;
}) {
  const disabled = !!disabledReason;
  const tip =
    disabledReason ?? (state === 'on' ? `Remove keyframe (${label})` : `Add keyframe (${label})`);
  return (
    <Tip content={tip} side="left">
      <button
        type="button"
        aria-label={state === 'on' ? `Remove keyframe: ${label}` : `Add keyframe: ${label}`}
        aria-pressed={state === 'on'}
        aria-disabled={disabled || undefined}
        data-state={state}
        data-testid="kf-toggle"
        onClick={() => {
          if (!disabled) onToggle();
        }}
        className={cn(
          'flex size-6 shrink-0 items-center justify-center rounded-md outline-none transition-colors duration-(--duration-fast)',
          'hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
          disabled && 'opacity-40',
        )}
      >
        <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden>
          <path
            d="M8 1.5 14.5 8 8 14.5 1.5 8Z"
            strokeWidth="1.5"
            strokeLinejoin="round"
            className={cn(
              'transition-[fill,stroke] duration-(--duration-fast)',
              state === 'on' && 'fill-primary stroke-primary',
              state === 'animated' && 'fill-primary-soft stroke-primary-text',
              state === 'none' && 'fill-transparent stroke-subtle',
            )}
          />
        </svg>
      </button>
    </Tip>
  );
}
