'use client';

import * as React from 'react';
import { Check, Film, FolderPlus, Library, Plus, Search, Upload } from 'lucide-react';
import { toast } from 'sonner';
import type { Asset } from '@shared/editor';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { Tip } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatClock } from '@/lib/format';
import { useAllClips, useClipMediaUrl, useVideos } from '@/lib/library';
import { useInView } from '@/lib/use-in-view';
import { useEditorStore } from '@/lib/editor/core';
import { startAssetDrag } from '@/lib/editor-panels/drag';
import {
  findAssetBySource,
  libraryCounts,
  libraryRows,
  type LibraryKind,
  type LibraryRow,
} from '@/lib/editor-panels/library-assets';
import { addAssetToTimeline, ensureLibraryAsset } from './actions';
import { AssetThumb, KIND_ICON } from './asset-thumb';
import { GroupLabel, Note, tileBase } from './bits';
import { ImportButton } from './import-button';

const assetMeta = (a: Asset): string => {
  const parts: string[] = [];
  if (a.width && a.height) parts.push(`${a.width}×${a.height}`);
  if (a.durationSec !== null) parts.push(formatClock(a.durationSec));
  return parts.join(' · ');
};

/** One project asset: draggable thumbnail (drag payload `application/x-clipfern-asset`) with a "+" button. */
function AssetTile({ asset }: { asset: Asset }) {
  const Icon = KIND_ICON[asset.kind];
  return (
    <li data-testid="bin-asset" data-asset-id={asset.id} className="min-w-0">
      <div className={cn(tileBase, 'cursor-grab p-1.5 active:cursor-grabbing')}>
        <div
          draggable
          onDragStart={(e) => startAssetDrag(e.dataTransfer, asset.id, asset.name)}
          onDoubleClick={() => addAssetToTimeline(asset.id)}
          title="Drag to the timeline, or double-click to add at the playhead"
          data-testid="bin-asset-drag"
          className="relative aspect-video overflow-hidden rounded-md"
        >
          <AssetThumb asset={asset} className="size-full" />
          <span className="pointer-events-none absolute left-1 top-1 flex size-5 items-center justify-center rounded bg-black/60 text-white backdrop-blur-sm">
            <Icon className="size-3" aria-hidden />
          </span>
          {asset.durationSec !== null ? (
            <span className="pointer-events-none absolute bottom-1 right-1 rounded bg-black/60 px-1 text-2xs font-semibold tabular-nums text-white backdrop-blur-sm">
              {formatClock(asset.durationSec)}
            </span>
          ) : null}
          <Tip content="Add at playhead">
            <button
              type="button"
              aria-label={`Add ${asset.name} to the timeline`}
              data-testid="bin-asset-add"
              onClick={() => addAssetToTimeline(asset.id)}
              className="absolute right-1 top-1 flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground opacity-0 shadow-sm outline-none transition-opacity duration-(--duration-fast) hover:bg-primary-hover focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
            >
              <Plus className="size-3.5" aria-hidden />
            </button>
          </Tip>
        </div>
        <div className="min-w-0 px-0.5">
          <p className="truncate text-xs font-medium" title={asset.name}>
            {asset.name}
          </p>
          <p className="truncate text-2xs tabular-nums text-subtle">{assetMeta(asset) || ' '}</p>
        </div>
      </div>
    </li>
  );
}

/* ---------------------------------------------------------------------------- Library section */

function LibraryThumb({ row }: { row: LibraryRow }) {
  const [ref, inView] = useInView<HTMLDivElement>();
  const clipThumb = useClipMediaUrl(row.clip?.id ?? '', 'thumb', inView && !!row.clip?.hasThumb);
  const src = row.clip ? (clipThumb.data?.url ?? null) : (row.video?.thumbnail ?? null);
  return (
    <div ref={ref} className="relative size-12 shrink-0 overflow-hidden rounded-md bg-muted">
      {src ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          draggable={false}
          referrerPolicy="no-referrer"
          className="size-full object-cover"
        />
      ) : (
        <div className="flex size-full items-center justify-center bg-primary-soft text-primary-text">
          <Film className="size-4" aria-hidden />
        </div>
      )}
    </div>
  );
}

function LibraryRowItem({ row, inProject }: { row: LibraryRow; inProject: boolean }) {
  return (
    <li
      draggable
      onDragStart={(e) => {
        // the drop target needs a project asset id, so the asset is created the moment the drag starts
        const asset = ensureLibraryAsset(row, { defer: true });
        startAssetDrag(e.dataTransfer, asset.id, asset.name);
      }}
      onDoubleClick={() => addAssetToTimeline(ensureLibraryAsset(row).id)}
      data-testid="bin-library-row"
      data-library-id={row.key}
      className="group flex cursor-grab items-center gap-2.5 rounded-lg border bg-card p-1.5 pr-2 transition-colors duration-(--duration-fast) hover:border-border-strong hover:bg-accent/40 active:cursor-grabbing"
    >
      <LibraryThumb row={row} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium" title={row.title}>
          {row.title}
        </p>
        <p className="flex items-center gap-1.5 truncate text-2xs text-subtle">
          {row.durationSec !== null ? (
            <span className="tabular-nums">{formatClock(row.durationSec)}</span>
          ) : null}
          {row.subtitle ? <span className="truncate">· {row.subtitle}</span> : null}
        </p>
      </div>
      {inProject ? (
        <span
          title="Already in this project"
          className="flex size-5 shrink-0 items-center justify-center rounded-full bg-success-soft text-success"
          data-testid="bin-library-in-project"
        >
          <Check className="size-3" aria-hidden />
          <span className="sr-only">Already in this project</span>
        </span>
      ) : (
        <Tip content="Add to project media">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Add ${row.title} to project media`}
            data-testid="bin-library-add"
            onClick={() => {
              ensureLibraryAsset(row);
              toast.success('Added to project media', { description: row.title });
            }}
          >
            <FolderPlus />
          </Button>
        </Tip>
      )}
      <Tip content="Add to timeline at playhead">
        <Button
          variant="soft"
          size="icon-xs"
          aria-label={`Add ${row.title} to the timeline`}
          data-testid="bin-library-timeline"
          onClick={() => addAssetToTimeline(ensureLibraryAsset(row).id)}
        >
          <Plus />
        </Button>
      </Tip>
    </li>
  );
}

const PAGE = 24;

function LibrarySection() {
  const clips = useAllClips();
  const videos = useVideos();
  const assets = useEditorStore((s) => s.project.assets);
  const [kind, setKind] = React.useState<LibraryKind>('clips');
  const [query, setQuery] = React.useState('');
  const [shown, setShown] = React.useState(PAGE);
  const loading = clips.isPending || videos.isPending;
  const clipItems = React.useMemo(() => clips.data?.items ?? [], [clips.data]);
  const videoItems = React.useMemo(() => videos.data?.items ?? [], [videos.data]);
  const counts = libraryCounts(clipItems, videoItems);
  const rows = React.useMemo(
    () => libraryRows(kind, clipItems, videoItems, query),
    [kind, clipItems, videoItems, query],
  );
  const inProject = (r: LibraryRow) =>
    !!findAssetBySource(
      assets,
      r.clip ? { kind: 'clip', clipId: r.clip.id } : { kind: 'video', videoId: r.video!.id },
    );

  return (
    <section
      aria-label="From your Library"
      className="flex flex-col gap-2.5"
      data-testid="bin-library"
    >
      <GroupLabel
        action={
          <span className="text-2xs tabular-nums text-subtle">
            {counts.clips} clips · {counts.videos} videos
          </span>
        }
      >
        From your Library
      </GroupLabel>
      <Segmented<LibraryKind>
        label="Library source"
        size="sm"
        className="w-full [&>button]:flex-1"
        value={kind}
        onValueChange={(k) => {
          setKind(k);
          setShown(PAGE);
        }}
        options={[
          { value: 'clips', label: 'Clips' },
          { value: 'videos', label: 'Source videos' },
        ]}
      />
      <Input
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setShown(PAGE);
        }}
        placeholder={kind === 'clips' ? 'Search clips' : 'Search videos'}
        aria-label="Search your Library"
        leading={<Search />}
        className="h-8"
        data-testid="bin-library-search"
      />
      {loading ? (
        <div className="flex flex-col gap-1.5" aria-busy>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[60px] w-full rounded-lg" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <Note
          icon={Library}
          title={
            query ? 'No matches' : `No ${kind === 'clips' ? 'rendered clips' : 'source videos'} yet`
          }
        >
          {query
            ? 'Try a different word from the title.'
            : kind === 'clips'
              ? 'Clips appear here once Clipfern has rendered them. Paste a YouTube URL on Home to make some.'
              : 'Videos appear here once their 480p playback copy is ready.'}
        </Note>
      ) : (
        <>
          <ul
            className="flex flex-col gap-1.5"
            aria-label={kind === 'clips' ? 'Library clips' : 'Library videos'}
          >
            {rows.slice(0, shown).map((r) => (
              <LibraryRowItem key={r.key} row={r} inProject={inProject(r)} />
            ))}
          </ul>
          {rows.length > shown ? (
            <Button variant="ghost" size="sm" onClick={() => setShown((n) => n + PAGE)}>
              Show {Math.min(PAGE, rows.length - shown)} more
            </Button>
          ) : null}
        </>
      )}
    </section>
  );
}

/* --------------------------------------------------------------------------------- Media tab */

export function MediaTab() {
  const assets = useEditorStore((s) => s.project.assets);
  const media = React.useMemo(
    () => assets.filter((a) => a.kind === 'video' || a.kind === 'image'),
    [assets],
  );
  return (
    <div className="flex flex-col gap-5" data-testid="bin-media">
      <section aria-label="Project media" className="flex flex-col gap-2.5">
        <GroupLabel
          action={
            <ImportButton
              kinds={['video', 'audio', 'image']}
              noun="media"
              size="xs"
              data-testid="bin-import"
            />
          }
        >
          Project media
        </GroupLabel>
        {media.length === 0 ? (
          <Note icon={Upload} title="No media in this project">
            Import files from your computer, or add a clip or video from your Library below.
          </Note>
        ) : (
          <ul className="grid grid-cols-2 gap-2" aria-label="Project media">
            {media.map((a) => (
              <AssetTile key={a.id} asset={a} />
            ))}
          </ul>
        )}
      </section>
      <LibrarySection />
    </div>
  );
}
