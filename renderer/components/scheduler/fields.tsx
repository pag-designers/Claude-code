'use client';

import * as React from 'react';
import { AlertCircle, X } from 'lucide-react';
import { Input, inputBase } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { counterState, type Counter } from '@/lib/publish/model';
import { localZoneLabel, toLocalInput, fromLocalInput } from '@/lib/publish/dates';
import { cn } from '@/lib/utils';

/* -------------------------------------------------------------------------------- counter ----- */

/** "42 / 100" that turns amber near the limit and red over it (announced politely once it is over). */
export function CounterText({ counter, className }: { counter: Counter; className?: string }) {
  const st = counterState(counter);
  return (
    <span
      className={cn(
        'text-2xs font-medium tabular-nums',
        st === 'ok' && 'text-subtle',
        st === 'near' && 'text-warning',
        st === 'over' && 'text-danger',
        className,
      )}
      data-state={st}
      aria-live={st === 'over' ? 'polite' : undefined}
    >
      {counter.value.toLocaleString('en-US')} / {counter.max.toLocaleString('en-US')}
      <span className="sr-only"> {counter.unit}</span>
    </span>
  );
}

/* ------------------------------------------------------------------------------- text field ----- */

export function TextArea({
  className,
  invalid,
  ...props
}: React.ComponentProps<'textarea'> & { invalid?: boolean }) {
  return (
    <textarea
      aria-invalid={invalid || undefined}
      className={cn(inputBase, 'h-auto min-h-20 resize-y py-2 leading-5', className)}
      {...props}
    />
  );
}

/** Label row (with live counter on the right), control, then the inline issue or hint. */
export function FormField({
  id,
  label,
  counter,
  hint,
  error,
  required,
  children,
  className,
}: {
  id: string;
  label: React.ReactNode;
  counter?: Counter;
  hint?: React.ReactNode;
  error?: string;
  required?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div className="flex items-end justify-between gap-3">
        <Label htmlFor={id} className="text-sm">
          {label}
          {required ? (
            <span className="ml-0.5 text-danger" aria-hidden>
              *
            </span>
          ) : null}
        </Label>
        {counter ? <CounterText counter={counter} /> : null}
      </div>
      {children}
      {error ? (
        <p
          role="alert"
          id={`${id}-error`}
          data-testid="field-issue"
          className="flex items-start gap-1.5 text-xs text-danger"
        >
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------------------------- switch ----- */

export function ToggleRow({
  id,
  label,
  description,
  checked,
  onCheckedChange,
  disabled,
  className,
}: {
  id: string;
  label: React.ReactNode;
  description?: React.ReactNode;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('flex items-start justify-between gap-4', className)}>
      <div className="min-w-0">
        <Label htmlFor={id} className="text-sm">
          {label}
        </Label>
        {description ? (
          <p className="mt-0.5 text-xs leading-4 text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        className="mt-0.5"
      />
    </div>
  );
}

/* ------------------------------------------------------------------------------ token input ----- */

/**
 * Chips + a text box: Enter, comma or Tab commits the typed token, Backspace on an empty box removes the last chip.
 * `normalize` cleans a token ("#fun" -> "fun"); duplicates and empty tokens are ignored.
 */
export function TokenInput({
  id,
  value,
  onChange,
  normalize = (t) => t.trim(),
  max,
  placeholder,
  disabled,
  invalid,
  prefix,
  label,
}: {
  id: string;
  value: readonly string[];
  onChange: (next: string[]) => void;
  normalize?: (raw: string) => string;
  max?: number;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  /** Shown before each chip ("#" or "@"). */
  prefix?: string;
  label: string;
}) {
  const [draft, setDraft] = React.useState('');
  const commit = (raw: string) => {
    const parts = raw.split(',').map(normalize).filter(Boolean);
    if (!parts.length) {
      setDraft('');
      return;
    }
    const next = [...value];
    for (const p of parts) {
      if (max !== undefined && next.length >= max) break;
      if (!next.some((x) => x.toLowerCase() === p.toLowerCase())) next.push(p);
    }
    onChange(next);
    setDraft('');
  };
  return (
    <div
      className={cn(
        inputBase,
        'h-auto min-h-9 flex-wrap items-center gap-1.5 py-1.5',
        disabled && 'pointer-events-none opacity-50',
      )}
      aria-invalid={invalid || undefined}
      data-invalid={invalid || undefined}
      onClick={(e) => (e.currentTarget.querySelector('input') as HTMLInputElement | null)?.focus()}
    >
      {value.map((t) => (
        <span
          key={t}
          className="inline-flex h-6 items-center gap-1 rounded-full bg-muted pl-2.5 pr-1 text-xs font-medium text-foreground"
        >
          {prefix}
          {t}
          <button
            type="button"
            aria-label={`Remove ${prefix ?? ''}${t}`}
            disabled={disabled}
            onClick={(e) => {
              e.stopPropagation();
              onChange(value.filter((x) => x !== t));
            }}
            className="flex size-4 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-3" aria-hidden />
          </button>
        </span>
      ))}
      <input
        id={id}
        aria-label={label}
        value={draft}
        disabled={disabled || (max !== undefined && value.length >= max)}
        placeholder={value.length ? undefined : placeholder}
        onChange={(e) => {
          const v = e.target.value;
          if (v.includes(',')) commit(v);
          else setDraft(v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || (e.key === 'Tab' && draft.trim())) {
            if (draft.trim()) {
              e.preventDefault();
              commit(draft);
            }
          } else if (e.key === 'Backspace' && !draft && value.length) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={() => draft.trim() && commit(draft)}
        className="min-w-24 flex-1 bg-transparent text-sm outline-none placeholder:text-subtle"
      />
    </div>
  );
}

/* ------------------------------------------------------------------------------- date + time ----- */

/** Native date-time picker (keyboard friendly, localised) with the viewer's time zone spelled out underneath. */
export function DateTimeField({
  id,
  value,
  onChange,
  min,
  disabled,
  invalid,
  label = 'Date and time',
  className,
  hideZone,
}: {
  id: string;
  /** Epoch ms or null (empty). */
  value: number | null;
  onChange: (ms: number | null) => void;
  min?: number;
  disabled?: boolean;
  invalid?: boolean;
  label?: string;
  className?: string;
  hideZone?: boolean;
}) {
  // keep what the user is typing even while it is momentarily incomplete
  const [text, setText] = React.useState(value === null ? '' : toLocalInput(value));
  const [prev, setPrev] = React.useState(value);
  if (value !== prev) {
    setPrev(value);
    setText(value === null ? '' : toLocalInput(value));
  }
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <Input
        id={id}
        type="datetime-local"
        aria-label={label}
        value={text}
        min={min === undefined ? undefined : toLocalInput(min)}
        disabled={disabled}
        invalid={invalid}
        onChange={(e) => {
          setText(e.target.value);
          const ms = fromLocalInput(e.target.value);
          if (ms !== null) {
            setPrev(ms);
            onChange(ms);
          } else if (e.target.value === '') {
            setPrev(null);
            onChange(null);
          }
        }}
        className="tabular-nums [color-scheme:light_dark]"
      />
      {hideZone ? null : (
        <p className="text-2xs text-subtle" data-testid="time-zone">
          Your local time zone: {localZoneLabel(value ?? undefined)}
        </p>
      )}
    </div>
  );
}
