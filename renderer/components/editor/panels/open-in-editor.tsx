'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { FilePlus2, Loader2, PencilRuler } from 'lucide-react';
import { toast } from 'sonner';
import type { EditorProjectSummary } from '@shared/editor';
import { Banner } from '@/components/ui/banner';
import { Button, type ButtonProps } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { timeAgo } from '@/lib/format';
import { editorHref } from '@/lib/hrefs';
import { invoke, ipcKey } from '@/lib/ipc';

export type EditorSource = { clipId: string } | { videoId: string };

type Phase =
  | { kind: 'idle' }
  /** Looking for an existing project (instant; no dialog). */
  | { kind: 'checking' }
  | { kind: 'choose'; from: EditorSource; existing: EditorProjectSummary[] }
  | { kind: 'preparing'; from: EditorSource }
  | { kind: 'error'; from: EditorSource; message: string };

const isClip = (f: EditorSource): f is { clipId: string } => 'clipId' in f;

function matches(p: EditorProjectSummary, from: EditorSource): boolean {
  return isClip(from) ? p.clipId === from.clipId : p.videoId === from.videoId && !p.clipId;
}

/**
 * "Open in editor" flow for a Library clip or source video: reuse-or-create (`editor:create` takes 10-30 s because
 * it loads the transcript, captions and reframe path), a progress dialog, then navigation to `/editor/?id=`.
 *
 * Cancel-safe: closing the dialog does not abort main; the project still finishes, shows up in Library → Edited and a
 * toast offers to open it. Render `dialog` once next to wherever you call `open`.
 */
export function useOpenInEditor() {
  const router = useRouter();
  const qc = useQueryClient();
  const [phase, setPhase] = React.useState<Phase>({ kind: 'idle' });
  /** Bumped on every start and on cancel; a result from an older run is announced with a toast instead. */
  const run = React.useRef(0);

  const create = React.useCallback(
    async (from: EditorSource, mine: number) => {
      setPhase({ kind: 'preparing', from });
      try {
        const doc = await invoke('editor:create', { from });
        void qc.invalidateQueries({ queryKey: ['editor:list'] });
        if (run.current === mine) {
          setPhase({ kind: 'idle' });
          router.push(editorHref(doc.id));
        } else {
          toast.success(`“${doc.name}” is ready`, {
            description: 'Find it in Library → Edited.',
            duration: 15_000,
            action: { label: 'Open', onClick: () => router.push(editorHref(doc.id)) },
          });
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : 'The project could not be created.';
        if (run.current === mine) setPhase({ kind: 'error', from, message });
        else toast.error('Could not prepare the project', { description: message });
      }
    },
    [qc, router],
  );

  const open = React.useCallback(
    async (from: EditorSource) => {
      if (phase.kind !== 'idle') return;
      const mine = ++run.current;
      setPhase({ kind: 'checking' });
      try {
        const list = await qc.fetchQuery({
          queryKey: ipcKey('editor:list'),
          queryFn: () => invoke('editor:list'),
          staleTime: 0,
        });
        const existing = list.items
          .filter((p) => matches(p, from))
          .sort((a, b) => b.updatedAt - a.updatedAt);
        if (run.current !== mine) return;
        if (existing.length > 0) {
          setPhase({ kind: 'choose', from, existing });
          return;
        }
      } catch {
        /* the list is a convenience: creating still works */
      }
      if (run.current === mine) await create(from, mine);
    },
    [phase.kind, qc, create],
  );

  const cancel = React.useCallback(() => {
    run.current += 1;
    setPhase({ kind: 'idle' });
  }, []);

  const dialog = (
    <OpenInEditorDialog
      phase={phase}
      onCancel={cancel}
      onOpenExisting={(id) => {
        run.current += 1;
        setPhase({ kind: 'idle' });
        router.push(editorHref(id));
      }}
      onCreateNew={(from) => void create(from, run.current)}
      onRetry={(from) => void create(from, run.current)}
    />
  );
  return { open, busy: phase.kind !== 'idle', dialog };
}

export function OpenInEditorDialog({
  phase,
  onCancel,
  onOpenExisting,
  onCreateNew,
  onRetry,
}: {
  phase: Phase;
  onCancel: () => void;
  onOpenExisting: (projectId: string) => void;
  onCreateNew: (from: EditorSource) => void;
  onRetry: (from: EditorSource) => void;
}) {
  const visible = phase.kind === 'choose' || phase.kind === 'preparing' || phase.kind === 'error';
  const what =
    phase.kind !== 'idle' && phase.kind !== 'checking' && isClip(phase.from) ? 'clip' : 'video';
  return (
    <Dialog open={visible} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-md" data-testid="open-in-editor" data-phase={phase.kind}>
        {phase.kind === 'preparing' ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2.5 font-display text-lg font-semibold">
                <Loader2 className="size-4.5 animate-spin text-primary-text" aria-hidden />
                Preparing your project…
              </DialogTitle>
              <DialogDescription className="text-sm text-muted-foreground">
                Loading the {what}&apos;s transcript, captions and reframe path into the editor.
                This can take up to 30 seconds for a long video.
              </DialogDescription>
            </DialogHeader>
            <div className="px-6 py-5">
              <Progress value={null} aria-label="Preparing the project" />
            </div>
            <DialogFooter className="justify-between">
              <p className="text-2xs leading-4 text-subtle">
                Cancelling only hides this window. The project still finishes and is kept in Library
                → Edited.
              </p>
              <Button variant="ghost" onClick={onCancel} data-testid="open-in-editor-cancel">
                Cancel
              </Button>
            </DialogFooter>
          </>
        ) : phase.kind === 'choose' ? (
          <>
            <DialogHeader>
              <DialogTitle className="font-display text-lg font-semibold">
                You already edited this {what}
              </DialogTitle>
              <DialogDescription className="text-sm text-muted-foreground">
                Pick up where you left off, or start again from the original.
              </DialogDescription>
            </DialogHeader>
            <ul className="flex flex-col gap-2 px-6 py-5" aria-label="Existing projects">
              {phase.existing.slice(0, 3).map((p) => (
                <li
                  key={p.id}
                  className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{p.name}</p>
                    <p className="text-2xs text-subtle">Edited {timeAgo(p.updatedAt)}</p>
                  </div>
                  <Button
                    variant="soft"
                    size="sm"
                    onClick={() => onOpenExisting(p.id)}
                    data-testid="open-existing"
                  >
                    <PencilRuler /> Open
                  </Button>
                </li>
              ))}
            </ul>
            <DialogFooter>
              <Button variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
              <Button
                variant="outline"
                onClick={() => onCreateNew(phase.from)}
                data-testid="open-create-new"
              >
                <FilePlus2 /> Start a new project
              </Button>
            </DialogFooter>
          </>
        ) : phase.kind === 'error' ? (
          <>
            <DialogHeader>
              <DialogTitle className="font-display text-lg font-semibold">
                Could not open the editor
              </DialogTitle>
              <DialogDescription className="sr-only">
                The project could not be created.
              </DialogDescription>
            </DialogHeader>
            <div className="px-6 py-5">
              <Banner tone="danger" title="Something went wrong">
                <span data-testid="open-error">{phase.message}</span>
              </Banner>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={onCancel}>
                Close
              </Button>
              <Button
                variant="primary"
                onClick={() => onRetry(phase.from)}
                data-testid="open-retry"
              >
                Try again
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** Ready-made button: `<OpenInEditorButton clipId="…" />` or `videoId`. */
export function OpenInEditorButton({
  clipId,
  videoId,
  label = 'Open in editor',
  variant = 'outline',
  size,
  iconOnly,
  className,
  disabled,
}: {
  clipId?: string;
  videoId?: string;
  label?: string;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
  iconOnly?: boolean;
  className?: string;
  disabled?: boolean;
}) {
  const { open, busy, dialog } = useOpenInEditor();
  const from: EditorSource | null = clipId ? { clipId } : videoId ? { videoId } : null;
  return (
    <>
      <Button
        variant={variant}
        size={size ?? (iconOnly ? 'icon-sm' : 'md')}
        className={className}
        loading={busy}
        disabled={disabled || !from}
        aria-label={iconOnly ? label : undefined}
        onClick={() => from && void open(from)}
        data-testid="open-in-editor-button"
      >
        {busy ? null : <PencilRuler />}
        {iconOnly ? null : label}
      </Button>
      {dialog}
    </>
  );
}
