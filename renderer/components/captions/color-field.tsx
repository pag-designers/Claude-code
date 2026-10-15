'use client';

import * as React from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Swatches come from the `--swatch-*` design tokens (globals.css), read once at runtime. */
const SWATCH_TOKENS = [
  'white',
  'black',
  'yellow',
  'orange',
  'red',
  'pink',
  'violet',
  'blue',
  'cyan',
  'green',
] as const;

function readSwatches(): { name: string; hex: string }[] {
  if (typeof document === 'undefined') return [];
  const cs = getComputedStyle(document.documentElement);
  return SWATCH_TOKENS.map((name) => ({
    name,
    hex: cs.getPropertyValue(`--swatch-${name}`).trim().toLowerCase(),
  })).filter((s) => /^#[0-9a-f]{6}$/.test(s.hex));
}

/** The studio only mounts after a user action (never during SSR), so tokens can be read on first render. */
export function useSwatches(): { name: string; hex: string }[] {
  const [list] = React.useState(readSwatches);
  return list;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * Compact colour control: a native colour well, a hex field and token swatches. No dependency. The hex field keeps what
 * the user types (even while invalid, so the inline error can point at it); the well only ever shows a valid colour.
 */
export function ColorField({
  id,
  label,
  value,
  onChange,
  error,
  disabled,
  compact,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (hex: string) => void;
  error?: string;
  disabled?: boolean;
  /** Hide the swatch row (used for secondary colours). */
  compact?: boolean;
}) {
  const swatches = useSwatches();
  const valid = HEX.test(value);
  const errId = `${id}-err`;
  return (
    <div className="flex flex-col gap-1.5" data-testid={`color-${id}`}>
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={`${id}-hex`} className="text-sm font-medium text-foreground">
          {label}
        </label>
        <div className="flex items-center gap-2">
          <label
            className={cn(
              'relative flex size-8 shrink-0 cursor-pointer overflow-hidden rounded-md border border-border-strong shadow-xs',
              disabled && 'pointer-events-none opacity-50',
            )}
            title={`Pick ${label.toLowerCase()}`}
          >
            <span
              className="size-full"
              style={{ background: valid ? value : 'transparent' }}
              aria-hidden
            />
            <input
              type="color"
              aria-label={`${label} colour picker`}
              value={valid ? value.toLowerCase() : (swatches[1]?.hex ?? value)}
              disabled={disabled}
              onChange={(e) => onChange(e.target.value.toUpperCase())}
              className="absolute inset-0 size-full cursor-pointer opacity-0"
            />
          </label>
          <input
            id={`${id}-hex`}
            type="text"
            inputMode="text"
            spellCheck={false}
            autoComplete="off"
            maxLength={7}
            disabled={disabled}
            value={value}
            aria-invalid={!valid || undefined}
            aria-describedby={error ? errId : undefined}
            onChange={(e) => {
              let v = e.target.value.trim();
              if (v && !v.startsWith('#')) v = `#${v}`;
              onChange(v.toUpperCase());
            }}
            className={cn(
              'h-8 w-[88px] rounded-md border border-input bg-field px-2 font-mono text-xs uppercase tabular-nums text-foreground outline-none',
              'transition-[border-color,box-shadow] duration-(--duration-fast) hover:border-border-strong focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25',
              'aria-invalid:border-danger aria-invalid:focus-visible:ring-danger/25 disabled:opacity-50',
            )}
          />
        </div>
      </div>
      {!compact && swatches.length > 0 ? (
        <div role="group" aria-label={`${label} swatches`} className="flex flex-wrap gap-1.5">
          {swatches.map((s) => {
            const active = valid && value.toLowerCase() === s.hex;
            return (
              <button
                key={s.name}
                type="button"
                disabled={disabled}
                title={`${s.name} ${s.hex.toUpperCase()}`}
                aria-label={`${label}: ${s.name}`}
                aria-pressed={active}
                onClick={() => onChange(s.hex.toUpperCase())}
                className={cn(
                  'relative flex size-5 items-center justify-center rounded-full border border-border-strong transition-transform duration-(--duration-fast) hover:scale-110 active:scale-95 disabled:opacity-50',
                  active && 'ring-2 ring-ring ring-offset-2 ring-offset-popover',
                )}
                style={{ background: s.hex }}
              >
                {active ? (
                  <Check
                    className="size-3 mix-blend-difference"
                    style={{ color: 'var(--swatch-white)' }}
                    aria-hidden
                  />
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
      {error ? (
        <p id={errId} role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
