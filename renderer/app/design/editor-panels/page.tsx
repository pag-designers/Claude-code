'use client';

import * as React from 'react';
import { useSearchParams } from 'next/navigation';
import { History, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ExportPanel, MediaBin, VersionsPanel } from '@/components/editor/panels';
import { useEditorStore } from '@/lib/editor/core';
import {
  parseAssetDrag,
  parseTransitionDrag,
  ASSET_MIME,
  TRANSITION_MIME,
} from '@/lib/editor-panels/drag';
import { invoke } from '@/lib/ipc';

/**
 * Unlisted reference page for the editor's left dock and dialogs, wired to the REAL editor store (no timeline here).
 * `/design/editor-panels/?id=<projectId>` loads a project; the right-hand readout shows exactly what the store holds,
 * and the drop zone consumes both drag payloads the way the timeline does. Used by the stubbed-bridge e2e tests.
 */
function Readout() {
  const project = useEditorStore((s) => s.project);
  const selection = useEditorStore((s) => s.selection.itemIds);
  const playhead = useEditorStore((s) => s.playheadSec);
  const saveState = useEditorStore((s) => s.saveState);
  const select = useEditorStore((s) => s.select);
  const setPlayhead = useEditorStore((s) => s.setPlayhead);
  const items = project.tracks.flatMap((t) => t.items.map((i) => ({ t, i })));
  return (
    <div className="flex min-w-0 flex-col gap-4 text-sm" data-testid="host-state">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs">
          Playhead
          <input
            type="range"
            min={0}
            max={60}
            step={0.5}
            value={playhead}
            onChange={(e) => setPlayhead(Number(e.target.value))}
            aria-label="Playhead"
            data-testid="host-playhead"
          />
          <span className="tabular-nums" data-testid="host-playhead-value">
            {playhead.toFixed(1)}
          </span>
        </label>
        <span className="text-xs text-muted-foreground" data-testid="host-save-state">
          {saveState}
        </span>
        <span className="text-xs text-muted-foreground" data-testid="host-selection">
          {selection.join(',') || 'none'}
        </span>
      </div>
      <table className="w-full table-fixed border-collapse text-xs" aria-label="Timeline items">
        <thead>
          <tr className="text-left text-subtle">
            <th className="w-24">Track</th>
            <th className="w-16">Id</th>
            <th>Name</th>
            <th className="w-12">Start</th>
            <th className="w-12">Dur</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {items.map(({ t, i }) => (
            <tr
              key={i.id}
              data-testid="host-item"
              data-id={i.id}
              data-type={i.type}
              data-selected={selection.includes(i.id)}
              className="cursor-pointer border-t data-[selected=true]:bg-primary-soft"
              onClick={(e) =>
                select([i.id], e.ctrlKey || e.metaKey || e.shiftKey ? 'toggle' : 'replace')
              }
            >
              <td className="truncate">{t.name}</td>
              <td className="truncate">{i.id}</td>
              <td className="truncate">
                {i.name ?? ''}
                {i.type === 'text' ? ` “${i.text}”` : ''}
              </td>
              <td className="tabular-nums">{i.startSec.toFixed(2)}</td>
              <td className="tabular-nums">{i.durationSec.toFixed(2)}</td>
              <td className="truncate" data-testid="host-item-details">
                {JSON.stringify({
                  ...('transitionIn' in i && i.transitionIn ? { tr: i.transitionIn } : {}),
                  ...('color' in i && (i.color.filter || i.color.lutAssetId)
                    ? {
                        filter: i.color.filter,
                        lut: i.color.lutAssetId,
                        lutAmount: i.color.lutAmount,
                      }
                    : {}),
                  ...(i.type === 'text'
                    ? {
                        anim: i.animIn.type,
                        font: i.style.fontFamily,
                        size: i.style.size,
                        y: i.transform.y.v,
                        align: i.style.align,
                        box: !!i.style.box,
                      }
                    : {}),
                  ...(i.type === 'shape'
                    ? { shape: i.shape, w: i.width, h: i.height, y: i.transform.y.v }
                    : {}),
                  ...(i.groupId ? { group: i.groupId } : {}),
                })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-muted-foreground" data-testid="host-assets">
        {project.assets.map((a) => `${a.id}:${a.kind}:${a.name}`).join(' | ') || 'no assets'}
      </p>
    </div>
  );
}

function DropZone() {
  const [last, setLast] = React.useState('nothing dropped yet');
  const over = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes(ASSET_MIME) || e.dataTransfer.types.includes(TRANSITION_MIME))
      e.preventDefault();
  };
  return (
    <div
      onDragOver={over}
      onDrop={(e) => {
        e.preventDefault();
        const a = parseAssetDrag(e.dataTransfer.getData(ASSET_MIME));
        const t = parseTransitionDrag(e.dataTransfer.getData(TRANSITION_MIME));
        if (a) {
          useEditorStore
            .getState()
            .addAsset(a.assetId, { startSec: useEditorStore.getState().playheadSec });
          setLast(`asset ${a.assetId}`);
        } else if (t) setLast(`transition ${t.type}`);
        else setLast('ignored');
      }}
      data-testid="host-dropzone"
      className="flex h-16 items-center justify-center rounded-xl border border-dashed text-xs text-muted-foreground"
    >
      Drop an asset or transition here ·{' '}
      <span className="ml-1 font-semibold text-foreground" data-testid="host-dropped">
        {last}
      </span>
    </div>
  );
}

function Host() {
  const id = useSearchParams().get('id');
  const [loaded, setLoaded] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [exportOpen, setExportOpen] = React.useState(false);
  const [versionsOpen, setVersionsOpen] = React.useState(false);

  React.useEffect(() => {
    if (!id) return;
    let stop: (() => void) | undefined;
    let live = true;
    invoke('editor:get', { id })
      .then((doc) => {
        if (!live) return;
        useEditorStore.getState().load(doc);
        stop = useEditorStore.getState().startAutosave({
          save: (a) => invoke('editor:save', a),
        });
        setLoaded(doc.name);
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
      stop?.();
    };
  }, [id]);

  return (
    <div
      className="flex h-[calc(100vh-48px)] min-h-0"
      data-testid="panels-host"
      data-loaded={loaded ?? ''}
    >
      <div className="w-[360px] shrink-0 border-r">
        <MediaBin />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-6">
        <div className="flex items-center gap-2">
          <h1 className="font-display text-lg font-semibold">
            {loaded ?? (error ? 'Could not load' : 'No project (add ?id=)')}
          </h1>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setVersionsOpen(true)}
            data-testid="host-open-versions"
          >
            <History /> Versions
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => setExportOpen(true)}
            data-testid="host-open-export"
          >
            <Upload /> Export
          </Button>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        <DropZone />
        <Readout />
      </div>
      <ExportPanel open={exportOpen} onOpenChange={setExportOpen} />
      <VersionsPanel open={versionsOpen} onOpenChange={setVersionsOpen} />
    </div>
  );
}

export default function EditorPanelsReference() {
  return (
    <React.Suspense fallback={null}>
      <Host />
    </React.Suspense>
  );
}
