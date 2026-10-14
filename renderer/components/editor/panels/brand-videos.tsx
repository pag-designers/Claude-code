'use client';

import * as React from 'react';
import { Clapperboard, Film, Lightbulb, Plus, Search } from 'lucide-react';
import { toast } from 'sonner';
import type { Asset } from '@shared/editor';
import type { BrandAssetView } from '@shared/brand';
import { brandProjectAssetId } from '@shared/brand-apply';
import { StockBrollDialog } from '@/components/broll/stock-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DisabledTip, Tip } from '@/components/ui/tooltip';
import { formatClock } from '@/lib/format';
import { invoke, IpcCallError } from '@/lib/ipc';
import { useEditorStore } from '@/lib/editor/core';
import { groupBrandAssets, selectionTranscript, videoRole } from '@/lib/editor-panels/brand';
import { useBrandPanelKit } from '@/lib/editor-panels/brand-hooks';
import { startAssetDrag } from '@/lib/editor-panels/drag';
import { cn } from '@/lib/utils';
import { addBrandClip, ensureBrandAsset } from './brand-actions';
import { BrandSection } from './brand-bits';
import { GroupLabel, tileBase } from './bits';

function BrandVideoTile({
  asset,
  role,
}: {
  asset: BrandAssetView;
  role: 'intro' | 'outro' | null;
}) {
  const [hover, setHover] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  return (
    <li
      className="min-w-0"
      data-testid="bin-brand-video"
      data-asset-id={asset.id}
      data-project-asset-id={brandProjectAssetId(asset.id)}
    >
      <div
        className={cn(tileBase, 'cursor-grab p-1.5 active:cursor-grabbing')}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        <div
          draggable
          onDragStart={(e) => {
            const a = ensureBrandAsset(asset, { defer: true });
            startAssetDrag(e.dataTransfer, a.id, a.name);
          }}
          onDoubleClick={() => addBrandClip(asset)}
          title="Drag to the timeline, or double-click to add at the playhead"
          className="relative aspect-video overflow-hidden rounded-md bg-muted"
        >
          {asset.thumbUrl && !failed ? (
            <img
              src={asset.thumbUrl}
              alt=""
              loading="lazy"
              draggable={false}
              referrerPolicy="no-referrer"
              onError={() => setFailed(true)}
              className="size-full object-cover"
            />
          ) : (
            <span className="flex size-full items-center justify-center bg-primary-soft text-primary-text">
              <Film className="size-5" strokeWidth={1.6} aria-hidden />
            </span>
          )}
          {hover && asset.previewUrl ? (
            <video
              src={asset.previewUrl}
              muted
              loop
              autoPlay
              playsInline
              aria-hidden
              tabIndex={-1}
              className="absolute inset-0 size-full object-cover"
            />
          ) : null}
          {role ? (
            <Badge variant="primary" className="absolute left-1 top-1 h-4 px-1.5 capitalize">
              {role}
            </Badge>
          ) : null}
          {asset.durationSec !== null ? (
            <span className="pointer-events-none absolute bottom-1 right-1 rounded bg-black/60 px-1 text-2xs font-semibold tabular-nums text-white backdrop-blur-sm">
              {formatClock(asset.durationSec)}
            </span>
          ) : null}
          <Tip content="Add at playhead">
            <button
              type="button"
              aria-label={`Add ${asset.name} to the timeline`}
              data-testid="bin-brand-video-add"
              onClick={() => {
                if (addBrandClip(asset)) toast.success(`${asset.name} added at the playhead`);
              }}
              className={cn(
                'absolute right-1 top-1 flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground opacity-0 shadow-sm outline-none transition-opacity duration-(--duration-fast) hover:bg-primary-hover focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring',
                hover && 'opacity-100',
              )}
            >
              <Plus className="size-3.5" aria-hidden />
            </button>
          </Tip>
        </div>
        <div className="min-w-0 px-0.5">
          <p className="truncate text-xs font-medium" title={asset.name}>
            {asset.name}
          </p>
          <p className="truncate text-2xs tabular-nums text-subtle">
            {asset.width && asset.height ? `${asset.width}×${asset.height}` : ' '}
            {asset.credit ? ` · ${asset.credit.source}` : ''}
          </p>
        </div>
      </div>
    </li>
  );
}

/** Media tab: the kit's videos (intros, outros, transitions, B-roll packs). */
export function BrandVideosSection() {
  const panel = useBrandPanelKit();
  const videos = React.useMemo(() => groupBrandAssets(panel.assets).videos, [panel.assets]);
  return (
    <BrandSection
      title="Brand Kit videos"
      testId="bin-brandkit-videos"
      panel={panel}
      isEmpty={videos.length === 0}
      emptyTitle="No videos in this kit"
      emptyHint="Intros, outros, transitions and B-roll packs from the kit show up here."
    >
      <ul className="grid grid-cols-2 gap-2" aria-label="Brand Kit videos">
        {videos.map((v) => (
          <BrandVideoTile
            key={v.id}
            asset={v}
            role={panel.kit ? videoRole(panel.kit, v.id) : null}
          />
        ))}
      </ul>
    </BrandSection>
  );
}

/* ------------------------------------------------------------------------------ stock footage -- */

/** Adds an imported stock clip to the project's media (once), and says so. */
function adoptImported(asset: Asset): void {
  const st = useEditorStore.getState();
  if (st.project.assets.some((a) => a.id === asset.id)) return;
  st.addAssets([asset]);
  toast.success('Stock clip added to project media', { description: asset.name });
}

/**
 * Asks Claude for stock-footage search ideas for what is said in the selection (selected caption lines, or the lines
 * under selected clips). Returns the queries; throws a readable Error when there is nothing to read or it fails.
 */
export async function suggestBrollFor(ids: readonly string[]): Promise<string[]> {
  const text = selectionTranscript(useEditorStore.getState().project, ids);
  if (!text) throw new Error('Select caption lines, or a clip with captions under it.');
  try {
    const r = await invoke('broll:suggest', { text });
    return r.queries;
  } catch (e) {
    throw new Error(
      e instanceof IpcCallError ? e.message : 'Could not get B-roll ideas right now.',
      { cause: e },
    );
  }
}

/** Media tab: stock footage search (Pexels / Pixabay) and Claude's B-roll ideas for the selection. */
export function StockFootageSection() {
  const projectId = useEditorStore((s) => s.projectId);
  const selection = useEditorStore((s) => s.selection.itemIds);
  const transcript = useEditorStore((s) => selectionTranscript(s.project, s.selection.itemIds));
  const [dialog, setDialog] = React.useState<{ open: boolean; query?: string }>({ open: false });
  const [busy, setBusy] = React.useState(false);
  const [ideas, setIdeas] = React.useState<string[]>([]);
  const canSuggest = !!projectId && transcript.length > 0;

  const suggest = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const queries = await suggestBrollFor(selection);
      setIdeas(queries);
      if (queries.length === 0) toast.info('No B-roll ideas for that passage');
      else setDialog({ open: true, query: queries[0] });
    } catch (e) {
      toast.error('Suggest B-roll failed', {
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  const open = (
    <Button
      variant="secondary"
      size="sm"
      disabled={!projectId}
      onClick={() => setDialog({ open: true })}
      data-testid="bin-stock-open"
      className="w-full justify-start"
    >
      <Search /> Search stock footage
    </Button>
  );
  const suggestBtn = (
    <Button
      variant="soft"
      size="sm"
      loading={busy}
      disabled={!canSuggest}
      onClick={() => void suggest()}
      data-testid="bin-stock-suggest"
      className="w-full justify-start"
    >
      <Lightbulb /> Suggest B-roll for selection
    </Button>
  );

  return (
    <section className="flex flex-col gap-2.5" aria-label="Stock footage" data-testid="bin-stock">
      <GroupLabel>Stock footage</GroupLabel>
      {projectId ? (
        open
      ) : (
        <DisabledTip reason="Open a project first." className="w-full">
          {open}
        </DisabledTip>
      )}
      {canSuggest ? (
        suggestBtn
      ) : (
        <DisabledTip
          reason="Select caption lines, or a clip that has captions under it, and Claude suggests what to search for."
          className="w-full"
        >
          {suggestBtn}
        </DisabledTip>
      )}
      {ideas.length > 0 ? (
        <ul
          className="flex flex-wrap gap-1.5"
          aria-label="B-roll ideas"
          data-testid="bin-stock-ideas"
        >
          {ideas.map((q) => (
            <li key={q}>
              <button
                type="button"
                onClick={() => setDialog({ open: true, query: q })}
                className="inline-flex h-6 items-center gap-1 rounded-full border bg-card px-2.5 text-2xs font-medium outline-none transition-colors duration-(--duration-fast) hover:border-border-strong hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Clapperboard className="size-3 text-subtle" aria-hidden /> {q}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="text-2xs leading-4 text-subtle">
        Free clips from Pexels and Pixabay (keys in Settings). Imported clips land in Project media,
        credit kept.
      </p>
      {projectId ? (
        <StockBrollDialog
          open={dialog.open}
          onOpenChange={(o) => setDialog((d) => ({ ...d, open: o }))}
          target={{ kind: 'project', projectId }}
          initialQuery={dialog.query}
          onImported={(r) => {
            if ('asset' in r) adoptImported(r.asset);
          }}
        />
      ) : null}
    </section>
  );
}
