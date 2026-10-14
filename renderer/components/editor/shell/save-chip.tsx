'use client';

import * as React from 'react';
import { AlertTriangle, Check, CloudOff, Loader2, PencilLine } from 'lucide-react';
import { useEditorStore } from '@/lib/editor/core';
import { cn } from '@/lib/utils';

/** "Saved just now" / "Saved 5 s ago" / "Saved 3 min ago" / "Saved 14:02". */
export function savedAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 3) return 'Saved just now';
  if (s < 60) return `Saved ${s} s ago`;
  if (s < 3600) return `Saved ${Math.floor(s / 60)} min ago`;
  return `Saved ${new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

const subscribeSecond = (cb: () => void) => {
  const id = window.setInterval(cb, 1000);
  return () => window.clearInterval(id);
};
const secondNow = () => Math.floor(Date.now() / 1000) * 1000;
/** Wall clock that ticks once per second (client only). */
function useSecondClock(): number {
  return React.useSyncExternalStore(subscribeSecond, secondNow, () => 0);
}

export function SaveChip() {
  const saveState = useEditorStore((s) => s.saveState);
  const lastSavedAt = useEditorStore((s) => s.lastSavedAt);
  const saveError = useEditorStore((s) => s.saveError);
  const now = useSecondClock();

  let text: string;
  let Icon = Check;
  let tone = 'text-muted-foreground';
  switch (saveState) {
    case 'dirty':
      text = 'Unsaved changes';
      Icon = PencilLine;
      break;
    case 'saving':
      text = 'Saving…';
      Icon = Loader2;
      break;
    case 'error':
      text = 'Save failed';
      Icon = CloudOff;
      tone = 'text-danger';
      break;
    case 'conflict':
      text = 'Conflict';
      Icon = AlertTriangle;
      tone = 'text-warning';
      break;
    default:
      text = lastSavedAt !== null ? savedAgo(lastSavedAt, now) : 'All changes saved';
      tone = 'text-success';
  }
  const body = (
    <>
      <Icon className={cn('size-3.5', saveState === 'saving' && 'animate-spin')} aria-hidden />
      <span className="tabular-nums">{text}</span>
    </>
  );
  const common = cn(
    'inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium',
    tone,
  );
  if (saveState === 'error') {
    return (
      <button
        type="button"
        data-testid="save-state"
        data-state={saveState}
        title={saveError ?? 'Click to retry'}
        onClick={() =>
          void useEditorStore
            .getState()
            .saveNow()
            .catch(() => {})
        }
        className={cn(common, 'hover:bg-danger-soft')}
      >
        {body}
        <span className="underline underline-offset-2">Retry</span>
      </button>
    );
  }
  return (
    <span
      data-testid="save-state"
      data-state={saveState}
      role="status"
      aria-live="polite"
      className={common}
    >
      {body}
    </span>
  );
}
