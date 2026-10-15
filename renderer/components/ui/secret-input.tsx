'use client';

import * as React from 'react';
import { Check, ExternalLink, Eye, EyeOff, KeyRound, Trash2, X } from 'lucide-react';
import type { ValidationResult } from '@shared/domain';
import type { SecretStatus } from '@shared/secrets';
import { cn } from '@/lib/utils';
import { Button } from './button';
import { Input } from './input';
import { Badge } from './badge';
import { Label } from './label';
import { Skeleton } from './skeleton';
import { Tip } from './tooltip';

export interface SecretInputProps {
  id: string;
  label: string;
  description?: React.ReactNode;
  placeholder?: string;
  /** Status from `secrets:status`; undefined while loading. */
  status?: SecretStatus;
  loading?: boolean;
  onSave: (value: string) => Promise<void>;
  onClear: () => Promise<void>;
  /** When provided, a Test button appears (needs the secret saved first). */
  onTest?: () => Promise<ValidationResult>;
  help?: { label: string; onClick: () => void };
  className?: string;
}

type TestState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; result: ValidationResult }
  | { kind: 'error'; message: string };

/**
 * Masked secret field. The secret value never comes back from main: when set we only ever show
 * `status.masked` (last 4 chars). Typing a new value replaces it; Clear removes it from the OS keystore.
 */
export function SecretInput({
  id,
  label,
  description,
  placeholder,
  status,
  loading,
  onSave,
  onClear,
  onTest,
  help,
  className,
}: SecretInputProps) {
  const [editing, setEditing] = React.useState(false);
  const [value, setValue] = React.useState('');
  const [reveal, setReveal] = React.useState(false);
  const [busy, setBusy] = React.useState<null | 'save' | 'clear'>(null);
  const [confirmClear, setConfirmClear] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [test, setTest] = React.useState<TestState>({ kind: 'idle' });
  const inputRef = React.useRef<HTMLInputElement>(null);

  const isSet = status?.set === true;
  const fromEnv = status?.source === 'env';
  const showField = !isSet || editing;

  React.useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const save = async () => {
    const v = value.trim();
    if (!v) {
      setError('Paste a value first.');
      return;
    }
    setBusy('save');
    setError(null);
    try {
      await onSave(v);
      setValue('');
      setEditing(false);
      setReveal(false);
      setTest({ kind: 'idle' });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setBusy(null);
    }
  };

  const clear = async () => {
    setBusy('clear');
    setError(null);
    try {
      await onClear();
      setConfirmClear(false);
      setTest({ kind: 'idle' });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not clear.');
    } finally {
      setBusy(null);
    }
  };

  const runTest = async () => {
    if (!onTest) return;
    setTest({ kind: 'running' });
    try {
      setTest({ kind: 'done', result: await onTest() });
    } catch (e) {
      setTest({ kind: 'error', message: e instanceof Error ? e.message : 'Test failed.' });
    }
  };

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={id}>{label}</Label>
        <div className="flex items-center gap-2">
          {isSet ? (
            <Badge variant="success" dot>
              {fromEnv ? 'From .env' : 'Saved'}
            </Badge>
          ) : loading ? null : (
            <Badge variant="neutral">Not set</Badge>
          )}
          {help ? (
            <button
              type="button"
              onClick={help.onClick}
              className="inline-flex items-center gap-1 rounded-xs text-xs font-medium text-primary-text hover:underline"
            >
              {help.label}
              <ExternalLink className="size-3" aria-hidden />
            </button>
          ) : null}
        </div>
      </div>

      {loading && !status ? (
        <Skeleton className="h-9 w-full" />
      ) : showField ? (
        <div className="flex items-center gap-2">
          <Input
            id={id}
            ref={inputRef}
            type={reveal ? 'text' : 'password'}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save();
              if (e.key === 'Escape' && isSet) {
                setEditing(false);
                setValue('');
              }
            }}
            placeholder={
              isSet ? 'Paste a new value to replace it' : (placeholder ?? 'Paste your key')
            }
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            invalid={!!error}
            aria-describedby={`${id}-help`}
            leading={<KeyRound />}
            trailing={
              <button
                type="button"
                aria-label={reveal ? 'Hide value' : 'Show value'}
                onClick={() => setReveal((r) => !r)}
                className="flex size-7 items-center justify-center rounded-md text-subtle transition-colors hover:bg-accent hover:text-foreground"
              >
                {reveal ? (
                  <EyeOff className="size-4" aria-hidden />
                ) : (
                  <Eye className="size-4" aria-hidden />
                )}
              </button>
            }
          />
          <Button
            variant="primary"
            onClick={save}
            loading={busy === 'save'}
            disabled={!value.trim()}
          >
            Save
          </Button>
          {isSet ? (
            <Button
              variant="ghost"
              onClick={() => {
                setEditing(false);
                setValue('');
                setError(null);
              }}
            >
              Cancel
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <div
            id={id}
            role="textbox"
            aria-readonly
            aria-label={`${label} (saved, ${status?.masked ?? 'hidden'})`}
            className="flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-md border border-input bg-field px-3 font-mono text-sm tracking-wide text-muted-foreground"
          >
            <KeyRound className="size-4 shrink-0 text-subtle" aria-hidden />
            <span className="truncate selectable">{status?.masked ?? '••••••••'}</span>
          </div>
          <Button onClick={() => setEditing(true)}>{fromEnv ? 'Override' : 'Replace'}</Button>
          {onTest ? (
            <Button variant="soft" onClick={runTest} loading={test.kind === 'running'}>
              Test
            </Button>
          ) : null}
          {confirmClear ? (
            <span className="inline-flex items-center gap-1.5">
              <Button variant="danger" size="sm" onClick={clear} loading={busy === 'clear'}>
                <Trash2 /> Confirm clear
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Cancel clear"
                onClick={() => setConfirmClear(false)}
              >
                <X />
              </Button>
            </span>
          ) : fromEnv ? (
            <Tip content="This value comes from your .env file. Override it here, or remove it from .env.">
              <span tabIndex={0} className="inline-flex rounded-md">
                <Button variant="danger-ghost" disabled>
                  <Trash2 /> Clear
                </Button>
              </span>
            </Tip>
          ) : (
            <Button variant="danger-ghost" onClick={() => setConfirmClear(true)}>
              <Trash2 /> Clear
            </Button>
          )}
        </div>
      )}

      <div
        id={`${id}-help`}
        className={cn(
          'flex flex-wrap items-center gap-x-3 gap-y-1 text-xs',
          (error || description || test.kind !== 'idle') && 'min-h-5',
        )}
      >
        {error ? (
          <p role="alert" className="text-danger">
            {error}
          </p>
        ) : description ? (
          <p className="text-muted-foreground">{description}</p>
        ) : null}
        <TestChip state={test} />
      </div>
    </div>
  );
}

function TestChip({ state }: { state: TestState }) {
  if (state.kind === 'idle') return null;
  if (state.kind === 'running')
    return (
      <Badge variant="info" role="status">
        Testing…
      </Badge>
    );
  if (state.kind === 'error')
    return (
      <Badge variant="danger" role="status" className="max-w-full whitespace-normal">
        {state.message}
      </Badge>
    );
  const r = state.result;
  return (
    <span role="status" className="inline-flex flex-wrap items-center gap-2">
      <Badge variant={r.ok ? 'success' : 'danger'}>
        {r.ok ? <Check /> : <X />}
        {r.ok ? 'Connected' : 'Failed'} · {Math.round(r.latencyMs)} ms
      </Badge>
      <span className={cn('text-xs', r.ok ? 'text-muted-foreground' : 'text-danger')}>
        {r.message}
      </span>
    </span>
  );
}
