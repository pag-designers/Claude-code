'use client';

import * as React from 'react';
import { Check } from 'lucide-react';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { isHex, isLightColor, normalizeHex } from '@/lib/brand/helpers';
import { useKitSession } from '@/lib/brand/kit-session';

/** A group heading inside a section card ("Position", "Safe area" …). */
export function SubHeading({
  children,
  className,
  id,
}: {
  children: React.ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <h4
      id={id}
      className={cn(
        'font-sans text-2xs font-semibold uppercase tracking-wider text-subtle',
        className,
      )}
    >
      {children}
    </h4>
  );
}

export function FieldRow({
  label,
  htmlFor,
  hint,
  right,
  children,
  className,
}: {
  label: React.ReactNode;
  htmlFor?: string;
  hint?: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={htmlFor} className="text-sm font-medium text-foreground">
          {label}
        </label>
        {right}
      </div>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** Number input that keeps what is typed while it is partial and clamps on blur / Enter. */
export function NumberBox({
  value,
  onChange,
  min,
  max,
  step = 1,
  unit,
  label,
  width = 'w-20',
  decimals,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  label: string;
  width?: string;
  decimals?: number;
}) {
  const fmt = (v: number) => (decimals !== undefined ? v.toFixed(decimals) : String(v));
  const [text, setText] = React.useState<string | null>(null);
  const commit = () => {
    if (text === null) return;
    const n = Number(text.replace(',', '.'));
    setText(null);
    if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n)));
  };
  return (
    <span className="relative inline-flex items-center">
      <input
        type="text"
        inputMode="decimal"
        aria-label={label}
        value={text ?? fmt(value)}
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const d = (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
            setText(null);
            onChange(Math.min(max, Math.max(min, Math.round((value + d) / step) * step)));
          } else if (e.key === 'Escape') setText(null);
        }}
        className={cn(
          'h-8 rounded-md border border-input bg-field px-2 text-right font-mono text-xs tabular-nums text-foreground outline-none',
          'transition-[border-color,box-shadow] duration-(--duration-fast) hover:border-border-strong focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25',
          unit ? 'pr-7' : '',
          width,
        )}
      />
      {unit ? (
        <span className="pointer-events-none absolute right-2 text-2xs text-subtle" aria-hidden>
          {unit}
        </span>
      ) : null}
    </span>
  );
}

/** Label + number box on one line, slider underneath. */
export function SliderRow({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  unit,
  decimals,
  hint,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  decimals?: number;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <div className={cn('flex flex-col gap-0.5', disabled && 'pointer-events-none opacity-50')}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <NumberBox
          label={`${label} value`}
          value={value}
          onChange={onChange}
          min={min}
          max={max}
          step={step}
          unit={unit}
          decimals={decimals}
        />
      </div>
      <Slider
        aria-label={label}
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onValueChange={onChange}
      />
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function SwitchRow({
  label,
  description,
  checked,
  onChange,
  disabled,
  ariaLabel,
  className,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}) {
  const id = React.useId();
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-4 rounded-lg border bg-muted/30 px-3.5 py-2.5',
        disabled && 'opacity-60',
        className,
      )}
    >
      <label htmlFor={id} className="min-w-0 cursor-pointer">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        {description ? (
          <span className="block text-xs text-muted-foreground">{description}</span>
        ) : null}
      </label>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        aria-label={ariaLabel ?? label}
      />
    </div>
  );
}

export interface Option<T extends string> {
  value: T;
  label: React.ReactNode;
  disabled?: boolean;
}

/** Thin wrapper over the Radix select with an accessible name. */
export function SelectField<T extends string>({
  value,
  onChange,
  options,
  label,
  placeholder,
  className,
  triggerClassName,
  disabled,
  id,
}: {
  value: T | '';
  onChange: (v: T) => void;
  options: Option<T>[];
  label: string;
  placeholder?: string;
  className?: string;
  triggerClassName?: string;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <Select value={value === '' ? undefined : value} onValueChange={(v) => onChange(v as T)} disabled={disabled}>
      <SelectTrigger id={id} aria-label={label} className={cn(className, triggerClassName)}>
        <SelectValue placeholder={placeholder ?? 'Choose…'} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Colour control: native colour well + hex field + the kit's own swatches (so styles reuse brand colours). The hex
 * field keeps partial input while typing; only complete colours are reported.
 */
export function HexField({
  label,
  value,
  onChange,
  showBrand = true,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (hex: string) => void;
  showBrand?: boolean;
  disabled?: boolean;
}) {
  const { spec } = useKitSession();
  const id = React.useId();
  const [text, setText] = React.useState<string | null>(null);
  const shown = text ?? value;
  const valid = isHex(value);
  const palette = showBrand ? spec.colors : [];
  const apply = (v: string) => {
    setText(v);
    const n = normalizeHex(v);
    // 3-digit shorthand is only expanded on blur, so typing "abc" can continue to "abcdef"
    if (n && v.replace('#', '').length === 6) onChange(n);
  };
  return (
    <div className="flex flex-col gap-1.5" data-testid="hex-field">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id} className="text-sm font-medium text-foreground">
          {label}
        </label>
        <div className="flex items-center gap-2">
          <label
            className={cn(
              'relative flex size-8 shrink-0 cursor-pointer overflow-hidden rounded-md border border-border-strong shadow-xs',
              disabled && 'pointer-events-none opacity-50',
            )}
          >
            <span
              className="size-full"
              style={{ background: valid ? value : 'transparent' }}
              aria-hidden
            />
            <input
              type="color"
              aria-label={`${label} colour picker`}
              value={valid ? value.toLowerCase() : '#000000'}
              disabled={disabled}
              onChange={(e) => {
                setText(null);
                onChange(e.target.value.toUpperCase());
              }}
              className="absolute inset-0 size-full cursor-pointer opacity-0"
            />
          </label>
          <input
            id={id}
            type="text"
            spellCheck={false}
            autoComplete="off"
            maxLength={7}
            disabled={disabled}
            value={shown}
            aria-invalid={!isHex(shown) && text !== null ? true : undefined}
            onChange={(e) => apply(e.target.value.trim())}
            onBlur={() => {
              const n = text === null ? null : normalizeHex(text);
              if (n) onChange(n);
              setText(null);
            }}
            className={cn(
              'h-8 w-[88px] rounded-md border border-input bg-field px-2 font-mono text-xs uppercase tabular-nums text-foreground outline-none',
              'transition-[border-color,box-shadow] duration-(--duration-fast) hover:border-border-strong focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25',
              'aria-invalid:border-danger disabled:opacity-50',
            )}
          />
        </div>
      </div>
      {palette.length > 0 ? (
        <div role="group" aria-label={`${label}: brand colours`} className="flex flex-wrap gap-1.5">
          {palette.map((c) => {
            const active = valid && c.hex.toLowerCase() === value.toLowerCase();
            return (
              <button
                key={c.id}
                type="button"
                disabled={disabled}
                title={`${c.name} ${c.hex.toUpperCase()}`}
                aria-label={`${label}: ${c.name}`}
                aria-pressed={active}
                onClick={() => {
                  setText(null);
                  onChange(c.hex.toUpperCase());
                }}
                className={cn(
                  'flex size-5 items-center justify-center rounded-full border border-border-strong transition-transform duration-(--duration-fast) hover:scale-110 active:scale-95 disabled:opacity-50',
                  active && 'ring-2 ring-ring ring-offset-2 ring-offset-card',
                )}
                style={{ background: c.hex }}
              >
                {active ? (
                  <Check
                    className="size-3"
                    style={{ color: isLightColor(c.hex) ? 'var(--swatch-black)' : 'var(--swatch-white)' }}
                    aria-hidden
                  />
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/** A coloured dot for lists of swatches. */
export function Dot({ color, className }: { color: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('inline-block size-3 shrink-0 rounded-full border border-border-strong', className)}
      style={{ background: color }}
    />
  );
}
