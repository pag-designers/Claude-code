'use client';

import * as React from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { DisabledTip, Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { Row } from './section';

/** Label on the left, switch on the right. A disabled switch explains itself in a tooltip. */
export function SwitchRow({
  label,
  checked,
  onChange,
  hint,
  disabled,
  disabledReason,
  mixed,
  testId,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: React.ReactNode;
  disabled?: boolean;
  disabledReason?: string;
  mixed?: boolean;
  testId?: string;
}) {
  const id = React.useId();
  const sw = (
    <Switch
      id={id}
      data-testid={testId}
      aria-label={label}
      checked={checked}
      disabled={disabled || !!disabledReason}
      onCheckedChange={onChange}
      className={cn(mixed && 'opacity-60')}
    />
  );
  return (
    <div className="flex min-h-7 items-center justify-between gap-2">
      <label htmlFor={id} className="flex min-w-0 flex-col text-xs leading-4 text-muted-foreground">
        <span className="truncate">{label}</span>
        {hint ? <span className="text-2xs leading-4 text-subtle">{hint}</span> : null}
      </label>
      {disabledReason ? <DisabledTip reason={disabledReason}>{sw}</DisabledTip> : sw}
    </div>
  );
}

export interface Option<T extends string> {
  value: T;
  label: React.ReactNode;
  /** Plain-text label for the closed trigger when `label` is rich. */
  text?: string;
}

/** Compact select (28 px) for enumerations. */
export function DenseSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  mixed,
  disabled,
  className,
  testId,
}: {
  label: string;
  value: T;
  options: Option<T>[];
  onChange: (v: T) => void;
  mixed?: boolean;
  disabled?: boolean;
  className?: string;
  testId?: string;
}) {
  return (
    <Select value={mixed ? '' : value} onValueChange={(v) => onChange(v as T)} disabled={disabled}>
      <SelectTrigger
        aria-label={label}
        data-testid={testId}
        className={cn('h-7 min-w-0 flex-1 px-2 text-xs', className)}
      >
        <SelectValue placeholder={mixed ? 'Mixed' : undefined} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} className="min-h-7 text-xs">
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Square 28 px icon button with a tooltip. */
export function IconButton({
  label,
  children,
  onClick,
  disabled,
  pressed,
  className,
  testId,
  side = 'top',
}: {
  label: string;
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  pressed?: boolean;
  className?: string;
  testId?: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
}) {
  return (
    <Tip content={label} side={side}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        data-testid={testId}
        disabled={disabled}
        onClick={onClick}
        className={cn(
          'flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors duration-(--duration-fast)',
          'hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-3.5',
          pressed &&
            'bg-primary-soft text-primary-text hover:bg-primary-soft hover:text-primary-text',
          className,
        )}
      >
        {children}
      </button>
    </Tip>
  );
}

/** Row whose control is a select. */
export function SelectRow<T extends string>(props: {
  label: string;
  value: T;
  options: Option<T>[];
  onChange: (v: T) => void;
  mixed?: boolean;
  testId?: string;
}) {
  return (
    <Row label={props.label}>
      <DenseSelect {...props} />
    </Row>
  );
}

/** Equal-width radio buttons that fit many short options on one line (easing picker, text align). */
export function MiniSegmented<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
  testId,
}: {
  label: string;
  value: T | null;
  options: { value: T; label: React.ReactNode; title?: string; disabled?: boolean }[];
  onChange: (v: T) => void;
  className?: string;
  testId?: string;
}) {
  const refs = React.useRef<(HTMLButtonElement | null)[]>([]);
  const move = (from: number, dir: 1 | -1) => {
    const n = options.length;
    for (let s = 1; s <= n; s++) {
      const i = (from + dir * s + n * 2) % n;
      const o = options[i];
      if (o && !o.disabled) {
        onChange(o.value);
        refs.current[i]?.focus();
        return;
      }
    }
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      data-testid={testId}
      className={cn(
        'flex min-w-0 gap-px rounded-md border border-border bg-muted p-0.5',
        className,
      )}
    >
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            title={o.title}
            tabIndex={on || (value === null && i === 0) ? 0 : -1}
            disabled={o.disabled}
            data-value={o.value}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                e.preventDefault();
                move(i, 1);
              } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault();
                move(i, -1);
              }
            }}
            className={cn(
              'flex h-6 min-w-0 flex-1 items-center justify-center gap-1 rounded px-1.5 text-2xs font-medium outline-none transition-[background-color,color] duration-(--duration-fast)',
              'focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-3.5',
              on
                ? 'bg-card text-foreground shadow-xs'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
