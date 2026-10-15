'use client';

import * as React from 'react';
import {
  Bookmark,
  CircleAlert,
  CircleCheck,
  History,
  Loader2,
  RotateCcw,
  Save,
  Undo2,
} from 'lucide-react';
import { toast } from 'sonner';
import type { ProjectVersion } from '@shared/editor';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useNow } from '@/lib/clock';
import { useEditorStore } from '@/lib/editor/core';
import { invoke, IpcCallError, useIpcQuery } from '@/lib/ipc';
import { timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import { GroupLabel, Note } from './bits';

const KIND: Record<
  ProjectVersion['kind'],
  { label: string; variant: 'neutral' | 'primary' | 'warning'; fallback: string }
> = {
  auto: { label: 'Auto', variant: 'neutral', fallback: 'Autosave snapshot' },
  manual: { label: 'Manual', variant: 'primary', fallback: 'Saved version' },
  restore: { label: 'Restore point', variant: 'warning', fallback: 'Taken before a restore' },
};

/** Autosave state line, from the store's `saveState` (the store owns the 5 s autosave loop). */
function AutosaveState() {
  const state = useEditorStore((s) => s.saveState);
  const lastSavedAt = useEditorStore((s) => s.lastSavedAt);
  const error = useEditorStore((s) => s.saveError);
  const now = useNow();
  const info =
    state === 'saving'
      ? { icon: Loader2, text: 'Saving…', tone: 'text-muted-foreground', spin: true }
      : state === 'dirty'
        ? {
            icon: Save,
            text: 'Unsaved changes. Autosave runs every 5 seconds.',
            tone: 'text-warning',
          }
        : state === 'error'
          ? { icon: CircleAlert, text: error ?? 'The last save failed.', tone: 'text-danger' }
          : state === 'conflict'
            ? {
                icon: CircleAlert,
                text: 'Changed in another window. Reload the project to keep editing.',
                tone: 'text-danger',
              }
            : {
                icon: CircleCheck,
                text: lastSavedAt
                  ? `All changes saved ${timeAgo(lastSavedAt, now?.getTime() ?? lastSavedAt)}`
                  : 'All changes saved',
                tone: 'text-success',
              };
  return (
    <p
      className={cn('flex items-center gap-2 text-xs', info.tone)}
      data-testid="versions-autosave"
      data-state={state}
      role="status"
    >
      <info.icon className={cn('size-3.5 shrink-0', info.spin && 'animate-spin')} aria-hidden />
      {info.text}
    </p>
  );
}

function VersionRow({
  v,
  now,
  onRestore,
}: {
  v: ProjectVersion;
  now: number;
  onRestore: (v: ProjectVersion) => void;
}) {
  const k = KIND[v.kind];
  return (
    <li
      data-testid="version-row"
      data-kind={v.kind}
      className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Badge variant={k.variant} data-testid="version-kind">
            {k.label}
          </Badge>
          <p className="truncate text-sm font-medium" title={v.label ?? k.fallback}>
            {v.label ?? k.fallback}
          </p>
        </div>
        <p
          className="mt-0.5 text-2xs tabular-nums text-subtle"
          title={new Date(v.createdAt).toLocaleString()}
        >
          {timeAgo(v.createdAt, now)} · revision {v.rev}
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={() => onRestore(v)}
        data-testid="version-restore"
        aria-label={`Restore ${v.label ?? k.fallback} from ${timeAgo(v.createdAt, now)}`}
      >
        <RotateCcw /> Restore
      </Button>
    </li>
  );
}

export function VersionsPanel({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const projectId = useEditorStore((s) => s.projectId);
  const now = useNow();
  const list = useIpcQuery(
    'editor:versions',
    { id: projectId ?? '' },
    { enabled: open && !!projectId, staleTime: 0, refetchOnMount: 'always' },
  );
  const [label, setLabel] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [pending, setPending] = React.useState<ProjectVersion | null>(null);
  const [restoring, setRestoring] = React.useState(false);

  const items = React.useMemo(
    () => [...(list.data?.items ?? [])].sort((a, b) => b.createdAt - a.createdAt),
    [list.data],
  );

  const saveVersion = async () => {
    if (!projectId || saving) return;
    setSaving(true);
    try {
      // snapshot what is on screen, not what was last autosaved
      await useEditorStore.getState().saveNow();
      const trimmed = label.trim();
      await invoke('editor:saveVersion', { id: projectId, label: trimmed || undefined });
      setLabel('');
      toast.success('Version saved', { description: trimmed || undefined });
      await list.refetch();
    } catch (e) {
      toast.error('Could not save a version', {
        description: e instanceof IpcCallError ? e.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  };

  const restore = async () => {
    if (!projectId || !pending) return;
    setRestoring(true);
    try {
      await useEditorStore.getState().saveNow();
      const doc = await invoke('editor:restoreVersion', { id: projectId, versionId: pending.id });
      useEditorStore.getState().load(doc);
      toast.success('Version restored', {
        description: 'Your previous state was kept as a restore point.',
      });
      setPending(null);
      onOpenChange(false);
    } catch (e) {
      toast.error('Could not restore that version', {
        description: e instanceof IpcCallError ? e.message : undefined,
      });
    } finally {
      setRestoring(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className="min-h-[420px] max-h-[min(80vh,640px)] max-w-lg"
          data-testid="versions-panel"
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 font-display text-xl font-semibold">
              <History className="size-5 text-primary-text" aria-hidden /> Version history
            </DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground">
              Clipfern snapshots your project as you edit. Restore any snapshot; your current state
              is kept as a restore point first.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="flex min-h-0 flex-col gap-5">
            <AutosaveState />
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void saveVersion();
              }}
            >
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                maxLength={80}
                placeholder="Label (optional), e.g. “before the b-roll pass”"
                aria-label="Version label"
                leading={<Bookmark />}
                className="h-9"
                data-testid="versions-label"
              />
              <Button
                type="submit"
                variant="primary"
                loading={saving}
                disabled={!projectId}
                data-testid="versions-save"
              >
                <Save /> Save version
              </Button>
            </form>

            <section className="flex min-h-0 flex-1 flex-col gap-2.5" aria-label="Saved versions">
              <GroupLabel
                action={
                  list.data ? (
                    <span className="text-2xs tabular-nums text-subtle">
                      {items.length} {items.length === 1 ? 'version' : 'versions'}
                    </span>
                  ) : null
                }
              >
                Snapshots
              </GroupLabel>
              {list.isPending ? (
                <div className="flex flex-col gap-2" aria-busy>
                  {[0, 1, 2].map((i) => (
                    <Skeleton key={i} className="h-14 w-full rounded-lg" />
                  ))}
                </div>
              ) : list.isError ? (
                <Note icon={CircleAlert} title="Could not load the history">
                  {list.error.message}
                </Note>
              ) : items.length === 0 ? (
                <Note icon={Undo2} title="No versions yet">
                  Autosave adds a snapshot as you edit. Use Save version to mark a moment you want
                  to come back to.
                </Note>
              ) : (
                <ul
                  className="scrollbar-thin -mr-2 flex min-h-0 flex-col gap-2 overflow-y-auto pr-2"
                  aria-label="Versions"
                >
                  {items.map((v) => (
                    <VersionRow
                      key={v.id}
                      v={v}
                      now={now?.getTime() ?? v.createdAt}
                      onRestore={setPending}
                    />
                  ))}
                </ul>
              )}
            </section>
          </DialogBody>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={!!pending}
        onOpenChange={(o) => !o && !restoring && setPending(null)}
        title="Restore this version?"
        description={
          <>
            The project goes back to{' '}
            <strong className="font-semibold text-foreground">
              {pending?.label ?? (pending ? KIND[pending.kind].fallback : '')}
            </strong>
            . Everything you have now is saved as a restore point first, so you can undo this from
            the history.
          </>
        }
        confirmLabel="Restore"
        loading={restoring}
        onConfirm={() => void restore()}
      />
    </>
  );
}
