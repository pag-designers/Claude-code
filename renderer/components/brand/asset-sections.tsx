'use client';

import * as React from 'react';
import { Clapperboard, Trash2, X } from 'lucide-react';
import type { BrandAssetKind, BrandAssetView } from '@shared/brand';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { KIND_NOUN, refsOfAssets } from '@/lib/brand/helpers';
import { useKitSession } from '@/lib/brand/kit-session';
import { useBrandFonts } from '@/lib/brand/fonts';
import { StockBrollDialog } from '@/components/broll/stock-dialog';
import { AudioCard, FontCard, ImageCard, VideoCard, type CardActions } from './asset-cards';
import { Section } from './section';
import { UploadPanel } from './upload-panel';
import { VirtualGrid } from './virtual-grid';

const SECTION_COPY: Record<BrandAssetKind, { id: string; description: string; empty: string }> = {
  logo: {
    id: 'logos',
    description:
      'PNG or SVG marks. Pick one as the watermark below; its colors can seed your palette.',
    empty: 'No logos yet. Add your mark and use it as the watermark on every clip.',
  },
  image: {
    id: 'images',
    description: 'Stickers, call-to-action graphics and end cards for the editor.',
    empty: 'No images yet. Stickers and end cards you add show up in the editor’s Stickers tab.',
  },
  video: {
    id: 'videos',
    description: 'Intros, outros, transitions and B-roll packs.',
    empty: 'No videos yet. Add an intro or outro, or pull stock B-roll in.',
  },
  audio: {
    id: 'audio',
    description:
      'Music beds, sound effects and stingers. Previews are loudness-normalised so you can compare them fairly.',
    empty: 'No audio yet. Add a music bed to duck under your speech.',
  },
  font: {
    id: 'fonts',
    description: 'Registered for the editor canvas and for caption rendering.',
    empty: 'No fonts yet. Uploaded fonts appear in every font picker.',
  },
};

const GRID: Record<BrandAssetKind, { min: number; row: number }> = {
  logo: { min: 168, row: 188 },
  image: { min: 168, row: 188 },
  video: { min: 220, row: 196 },
  audio: { min: 340, row: 112 },
  font: { min: 290, row: 138 },
};

/** One asset section: upload panel, progress rows, a (virtualised) grid, selection + delete with a "what it clears" warning. */
export function AssetSection({ kind }: { kind: BrandAssetKind }) {
  const s = useKitSession();
  const copy = SECTION_COPY[kind];
  const noun = KIND_NOUN[kind];
  const assets = s.byKind[kind];
  const [pickedIds, setSelected] = React.useState<ReadonlySet<string>>(new Set());
  const [target, setTarget] = React.useState<BrandAssetView[] | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const [stockOpen, setStockOpen] = React.useState(false);
  const [sample, setSample] = React.useState('Pack my box with five dozen liquor jugs');
  const lastIdx = React.useRef<number | null>(null);

  // fonts: register every uploaded font with document.fonts so the cards render in their own typeface
  useBrandFonts();

  // ids of assets that vanished (deleted elsewhere) drop out of the selection
  const selected = React.useMemo(() => {
    const ids = new Set(assets.map((a) => a.id));
    return new Set([...pickedIds].filter((id) => ids.has(id)));
  }, [pickedIds, assets]);

  const onSelect = React.useCallback(
    (id: string, on: boolean, e: React.MouseEvent) => {
      const idx = assets.findIndex((a) => a.id === id);
      setSelected((cur) => {
        const next = new Set(cur);
        if (e.shiftKey && lastIdx.current !== null && idx >= 0) {
          const [a, b] = [Math.min(lastIdx.current, idx), Math.max(lastIdx.current, idx)];
          for (let i = a; i <= b; i++) {
            const item = assets[i];
            if (item) next.add(item.id);
          }
        } else if (on) next.add(id);
        else next.delete(id);
        return next;
      });
      lastIdx.current = idx;
    },
    [assets],
  );

  const actionsFor = React.useCallback(
    (a: BrandAssetView): CardActions => ({
      selected: selected.has(a.id),
      anySelected: selected.size > 0,
      onSelect,
      onDelete: (x) => setTarget([x]),
    }),
    [selected, onSelect],
  );

  const confirmDelete = async () => {
    if (!target) return;
    setDeleting(true);
    const names = target.map((t) => t.name);
    const cleared = await s.deleteAssets(target.map((t) => t.id));
    setDeleting(false);
    setTarget(null);
    if (cleared === null) return;
    setSelected(new Set());
    toast.success(
      names.length === 1 ? `Deleted “${names[0]}”` : `Deleted ${names.length} ${noun.many}`,
      cleared.length ? { description: `Also cleared: ${cleared.join(', ')}.` } : undefined,
    );
  };

  const clears = target
    ? refsOfAssets(
        s.spec,
        target.map((t) => t.id),
      )
    : [];
  const g = GRID[kind];

  const actions =
    kind === 'video' ? (
      <>
        <Button variant="outline" size="sm" onClick={() => setStockOpen(true)}>
          <Clapperboard /> Find stock footage
        </Button>
        <StockBrollDialog
          open={stockOpen}
          onOpenChange={setStockOpen}
          target={{ kind: 'kit', kitId: s.kit.id }}
          onImported={() => s.refreshAssets()}
        />
      </>
    ) : null;

  const render = (a: BrandAssetView) => {
    const act = actionsFor(a);
    switch (kind) {
      case 'logo':
      case 'image':
        return <ImageCard asset={a} actions={act} />;
      case 'video':
        return <VideoCard asset={a} actions={act} />;
      case 'audio':
        return <AudioCard asset={a} actions={act} />;
      case 'font':
        return <FontCard asset={a} actions={act} sample={sample} />;
    }
  };

  return (
    <Section
      id={copy.id}
      description={copy.description}
      actions={actions}
      badge={
        assets.length ? (
          <span className="rounded-full bg-muted px-2 py-0.5 font-sans text-2xs font-semibold tabular-nums text-muted-foreground">
            {assets.length}
          </span>
        ) : null
      }
    >
      <UploadPanel kind={kind} compact={assets.length > 0} />

      {kind === 'font' && assets.length > 0 ? (
        <div className="flex items-center gap-3">
          <label htmlFor="font-sample-input" className="shrink-0 text-sm font-medium">
            Preview text
          </label>
          <Input
            id="font-sample-input"
            value={sample}
            maxLength={80}
            onChange={(e) => setSample(e.target.value)}
            placeholder="Type to preview your fonts"
            className="h-8"
          />
        </div>
      ) : null}

      {selected.size > 0 ? (
        <div
          role="toolbar"
          aria-label={`Selected ${noun.many}`}
          className="flex items-center gap-3 rounded-lg border border-primary/40 bg-primary-soft px-3 py-2 text-sm"
        >
          <span className="font-medium text-primary-text">{selected.size} selected</span>
          <span className="flex-1" />
          <Button
            size="xs"
            variant="danger-ghost"
            onClick={() => setTarget(assets.filter((a) => selected.has(a.id)))}
          >
            <Trash2 /> Delete
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setSelected(new Set())}>
            <X /> Clear
          </Button>
        </div>
      ) : null}

      {assets.length ? (
        <VirtualGrid
          items={assets}
          minItemWidth={g.min}
          rowHeight={g.row}
          label={noun.section}
          render={render}
        />
      ) : (
        <p className="-mt-1 text-sm text-muted-foreground">{copy.empty}</p>
      )}

      <ConfirmDialog
        open={target !== null}
        onOpenChange={(o) => !o && !deleting && setTarget(null)}
        title={
          target && target.length === 1
            ? `Delete “${target[0]!.name}”?`
            : `Delete ${target?.length ?? 0} ${noun.many}?`
        }
        description="The file is removed from this kit and from storage. This cannot be undone."
        confirmLabel="Delete"
        loading={deleting}
        onConfirm={() => void confirmDelete()}
      >
        {clears.length ? (
          <Banner tone="warning" title="This also clears">
            <ul className="list-disc pl-4" data-testid="clears-list">
              {clears.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <p className="mt-1">The kit keeps working; you can pick another file afterwards.</p>
          </Banner>
        ) : null}
      </ConfirmDialog>
    </Section>
  );
}
