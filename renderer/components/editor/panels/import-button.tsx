'use client';

import * as React from 'react';
import { Upload } from 'lucide-react';
import { toast } from 'sonner';
import type { Asset } from '@shared/editor';
import { Button, type ButtonProps } from '@/components/ui/button';
import { DisabledTip } from '@/components/ui/tooltip';
import { invoke, IpcCallError } from '@/lib/ipc';
import { useEditorStore } from '@/lib/editor/core';

type Kind = Asset['kind'];

/**
 * "Import" → `editor:importAssets` (native file dialog in main; the files are copied to storage and probed) →
 * `store.addAssets`. Returns the new assets through `onImported` so the caller can place them.
 */
export function ImportButton({
  kinds,
  label = 'Import',
  noun = 'media',
  onImported,
  variant = 'secondary',
  size = 'sm',
  className,
  'data-testid': testId,
}: {
  kinds: Kind[];
  label?: string;
  /** Used in the toast: "Imported 2 audio files". */
  noun?: string;
  onImported?: (assets: Asset[]) => void;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
  className?: string;
  'data-testid'?: string;
}) {
  const projectId = useEditorStore((s) => s.projectId);
  const [busy, setBusy] = React.useState(false);

  const run = async () => {
    if (!projectId || busy) return;
    setBusy(true);
    try {
      const r = await invoke('editor:importAssets', { projectId, kinds });
      if (r.canceled || r.assets.length === 0) return;
      useEditorStore.getState().addAssets(r.assets);
      toast.success(`Imported ${r.assets.length} ${noun}${r.assets.length === 1 ? '' : ' files'}`);
      onImported?.(r.assets);
    } catch (e) {
      toast.error('Import failed', {
        description: e instanceof IpcCallError ? e.message : 'The files could not be imported.',
      });
    } finally {
      setBusy(false);
    }
  };

  const button = (
    <Button
      variant={variant}
      size={size}
      loading={busy}
      disabled={!projectId}
      onClick={() => void run()}
      className={className}
      data-testid={testId}
    >
      <Upload /> {label}
    </Button>
  );
  return projectId ? (
    button
  ) : (
    <DisabledTip reason="Open a project to import files into it.">{button}</DisabledTip>
  );
}
