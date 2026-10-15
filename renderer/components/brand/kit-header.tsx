'use client';

import * as React from 'react';
import {
  AlertTriangle,
  Check,
  CloudOff,
  Copy,
  Loader2,
  PencilLine,
  Star,
  Trash2,
} from 'lucide-react';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { timeAgo } from '@/lib/format';
import { useKitSession } from '@/lib/brand/kit-session';
import { BufferedInput } from './controls';

/** "Saved" / "Saving…" / "Unsaved changes" / "Couldn’t save": always visible while editing a kit. */
export function SaveChip() {
  const s = useKitSession();
  let Icon = Check;
  let text = 'Saved';
  let tone = 'text-muted-foreground';
  let title = s.savedAt ? `Saved ${timeAgo(s.savedAt)}` : 'All changes are saved';
  switch (s.status) {
    case 'dirty':
      Icon = PencilLine;
      text = 'Unsaved changes';
      title = 'Saving in a moment';
      break;
    case 'saving':
      Icon = Loader2;
      text = 'Saving…';
      break;
    case 'error':
      Icon = CloudOff;
      text = 'Couldn’t save';
      tone = 'text-danger';
      title = s.saveError ?? 'Could not save';
      break;
    case 'conflict':
      Icon = AlertTriangle;
      text = 'Not saved';
      tone = 'text-warning';
      title = 'This kit changed somewhere else';
      break;
    default:
      tone = 'text-success';
  }
  return (
    <span
      role="status"
      aria-live="polite"
      data-testid="save-chip"
      data-status={s.status}
      title={title}
      className={cn('inline-flex items-center gap-1.5 text-xs font-medium', tone)}
    >
      <Icon className={cn('size-3.5', s.status === 'saving' && 'animate-spin')} aria-hidden />
      {text}
    </span>
  );
}

/** Banners about saving problems: CONFLICT ("changed elsewhere") and failures with a retry. */
export function SaveBanners() {
  const s = useKitSession();
  const [busy, setBusy] = React.useState<'reload' | 'keep' | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const run = async (which: 'reload' | 'keep') => {
    setBusy(which);
    setErr(null);
    try {
      await (which === 'reload' ? s.reload() : s.keepMine());
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not reach the app. Try again.');
    } finally {
      setBusy(null);
    }
  };
  if (s.status === 'conflict')
    return (
      <div data-testid="conflict-banner">
        <Banner
          tone="warning"
          title="This kit changed somewhere else"
          action={
            <div className="flex items-center gap-2">
              <Button
                size="xs"
                variant="secondary"
                loading={busy === 'reload'}
                disabled={busy !== null}
                onClick={() => void run('reload')}
                data-testid="conflict-reload"
              >
                Reload
              </Button>
              <Button
                size="xs"
                variant="primary"
                loading={busy === 'keep'}
                disabled={busy !== null}
                onClick={() => void run('keep')}
                data-testid="conflict-keep"
              >
                Keep my changes
              </Button>
            </div>
          }
        >
          {err ??
            'Another window saved a newer version while you had unsaved edits. Reload to see it (your edits are dropped), or keep your changes to overwrite it. Saving is paused until you choose.'}
        </Banner>
      </div>
    );
  if (s.status === 'error')
    return (
      <div data-testid="save-error-banner">
        <Banner
          tone="danger"
          title="Your latest changes are not saved yet"
          action={
            <Button size="xs" variant="outline" onClick={s.retry}>
              Try again
            </Button>
          }
        >
          {s.saveError ?? 'Something went wrong while saving.'} Your edits are kept on this page.
        </Banner>
      </div>
    );
  return null;
}

/** The sticky bar of the selected kit: inline rename, default star, duplicate, delete, save state. */
export function KitHeader({
  onDuplicate,
  onDelete,
  onMakeDefault,
}: {
  onDuplicate: () => void;
  onDelete: () => void;
  onMakeDefault: () => void;
}) {
  const s = useKitSession();
  const k = s.kit;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2" data-testid="kit-header">
      <BufferedInput
        aria-label="Kit name"
        value={k.name}
        maxLength={60}
        onValue={s.rename}
        style={{ width: `${Math.min(32, Math.max(10, k.name.length + 3))}ch` }}
        className="h-9 max-w-[min(30rem,100%)] border-transparent bg-transparent font-display text-xl font-semibold shadow-none hover:bg-field focus-visible:bg-field"
      />
      {k.isDefault ? (
        <span
          className="inline-flex items-center gap-1.5 rounded-full bg-warning-soft px-2.5 py-1 text-xs font-semibold text-warning"
          data-testid="default-badge"
        >
          <Star className="size-3.5 fill-current" aria-hidden /> Default kit
        </span>
      ) : (
        <Button size="sm" variant="outline" onClick={onMakeDefault}>
          <Star /> Make default
        </Button>
      )}
      <span className="flex-1" />
      <SaveChip />
      <Button size="sm" variant="ghost" onClick={onDuplicate}>
        <Copy /> Duplicate
      </Button>
      <Button size="sm" variant="danger-ghost" onClick={onDelete}>
        <Trash2 /> Delete
      </Button>
    </div>
  );
}
