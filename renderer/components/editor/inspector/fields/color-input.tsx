'use client';

import * as React from 'react';
import { Check } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { useSwatches } from '@/components/captions/color-field';

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * Compact colour control: a swatch button (opens token swatches + the native colour well) and a hex field.
 * `value` is `#RRGGBB`. The hex field keeps invalid text while typing and only commits a valid colour.
 */
export function ColorInput({
  label,
  value,
  onChange,
  onCommit,
  disabled,
  allowClear,
  onClear,
  className,
  compact,
  empty,
}: {
  label: string;
  value: string;
  onChange: (hex: string) => void;
  onCommit?: (hex: string) => void;
  disabled?: boolean;
  /** Shows a "None" entry in the popover (per-word highlight colours). */
  allowClear?: boolean;
  onClear?: () => void;
  className?: string;
  /** Only the swatch button (the popover still has the hex-capable colour well). `empty` draws it as "no colour". */
  compact?: boolean;
  empty?: boolean;
}) {
  const swatches = useSwatches();
  const [text, setText] = React.useState<string | null>(null);
  const valid = HEX.test(value);
  const apply = (hex: string, final: boolean) => {
    onChange(hex);
    if (final) onCommit?.(hex);
  };
  return (
    <div className={cn('flex min-w-0 items-center gap-1.5', className)}>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            aria-label={`${label}: pick colour`}
            className={cn(
              'shrink-0 border shadow-xs outline-none transition-transform duration-(--duration-fast) hover:scale-105 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
              compact ? 'size-5 rounded-full' : 'size-7 rounded-md',
              empty ? 'border-dashed border-border-strong bg-transparent' : 'border-border-strong',
            )}
            style={empty ? undefined : { background: valid ? value : 'transparent' }}
          />
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-52 p-2.5"
          onEscapeKeyDown={(e) => e.stopPropagation()}
        >
          <div role="group" aria-label={`${label} swatches`} className="flex flex-wrap gap-1.5">
            {swatches.map((s) => {
              const active = valid && value.toLowerCase() === s.hex;
              return (
                <button
                  key={s.name}
                  type="button"
                  title={`${s.name} ${s.hex.toUpperCase()}`}
                  aria-label={`${label}: ${s.name}`}
                  aria-pressed={active}
                  onClick={() => apply(s.hex.toUpperCase(), true)}
                  className={cn(
                    'relative flex size-6 items-center justify-center rounded-full border border-border-strong outline-none transition-transform duration-(--duration-fast) hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring',
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
          <label className="mt-2.5 flex items-center gap-2 text-xs text-muted-foreground">
            Custom
            <input
              type="color"
              aria-label={`${label}: custom colour`}
              value={valid ? value.toLowerCase() : '#ffffff'}
              onChange={(e) => apply(e.target.value.toUpperCase(), false)}
              onBlur={(e) => onCommit?.(e.target.value.toUpperCase())}
              className="h-7 w-full cursor-pointer rounded-md border border-border-strong bg-field p-0.5"
            />
          </label>
          {allowClear ? (
            <button
              type="button"
              onClick={onClear}
              className="mt-2 h-7 w-full rounded-md border border-border-strong text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              Use caption colour
            </button>
          ) : null}
        </PopoverContent>
      </Popover>
      {compact ? null : (
        <input
          type="text"
          aria-label={`${label} hex`}
          spellCheck={false}
          autoComplete="off"
          maxLength={7}
          disabled={disabled}
          value={text ?? value}
          aria-invalid={text !== null && !HEX.test(text) ? true : undefined}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => {
            let v = e.target.value.trim().toUpperCase();
            if (v && !v.startsWith('#')) v = `#${v}`;
            setText(v);
            if (HEX.test(v)) onChange(v);
          }}
          onBlur={() => {
            if (text !== null && HEX.test(text)) onCommit?.(text);
            setText(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              setText(null);
              e.currentTarget.blur();
            }
          }}
          className="h-7 w-[4.75rem] min-w-0 rounded-md border border-input bg-field px-1.5 font-mono text-2xs uppercase tabular-nums text-foreground outline-none transition-[border-color,box-shadow] duration-(--duration-fast) hover:border-border-strong focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 aria-invalid:border-danger disabled:opacity-50"
        />
      )}
    </div>
  );
}
