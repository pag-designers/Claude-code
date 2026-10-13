'use client';

import * as React from 'react';
import Link from 'next/link';
import { Loader2, Scissors, SearchX, Star } from 'lucide-react';
import type { ClipView } from '@shared/pipeline';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import {
  useAllClips,
  useDeleteClips,
  useDownloadClips,
  useSetClipFavorite,
  useVideoClips,
  useVideos,
} from '@/lib/library';
import {
  DEFAULT_CLIP_FILTERS,
  filterClips,
  rangeBetween,
  type ClipFilters,
} from '@/lib/library-filters';
import { usePersistedChoice } from '@/lib/persist';
import { matchesRunFilter, useClipUi } from '@/lib/cp2-clips';
import { ClipCard, ClipRow } from './clip-card';
import { ClipDrawer } from './clip-drawer';
import { ClipFilterBar, ClipSortLayout, type Layout } from './clip-filters';
import { SelectionBar } from './selection-bar';

export type ClipsScope =
  { kind: 'all' } | { kind: 'favorites' } | { kind: 'video'; videoId: string };

const GRID = 'grid grid-cols-[repeat(auto-fill,minmax(188px,1fr))] gap-4';

function SkeletonGrid({ n = 6, label }: { n?: number; label?: string }) {
  return (
    <div className={GRID} aria-label={label} aria-busy>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="overflow-hidden rounded-xl border bg-card">
          <Skeleton className="aspect-[9/16] w-full rounded-none" />
          <div className="flex gap-3 p-3">
            <Skeleton className="size-10 shrink-0 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-3 w-2/3" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Clips grid/list with filters, sorting, multi-select + bulk actions and the clip detail dialog. Shared by the
 * Library (Clips, Favorites) and the video detail page (Clips tab), so a clip behaves the same everywhere.
 */
export function ClipsBrowser({
  scope,
  processing,
}: {
  scope: ClipsScope;
  /** The owning video is still being processed: clips arrive live and the empty state says so. */
  processing?: boolean;
}) {
  const all = useAllClips();
  const perVideo = useVideoClips(scope.kind === 'video' ? scope.videoId : null);
  const q = scope.kind === 'video' ? perVideo : all;
  const videos = useVideos();
  const clips = React.useMemo(() => q.data?.items ?? [], [q.data]);

  const [layout, setLayout] = usePersistedChoice<Layout>(
    'clipfern.clips.layout',
    ['grid', 'list'],
    'grid',
  );
  const [filters, setFilters] = React.useState<ClipFilters>({
    ...DEFAULT_CLIP_FILTERS,
    favoritesOnly: scope.kind === 'favorites',
  });
  const patchFilters = (p: Partial<ClipFilters>) => setFilters((f) => ({ ...f, ...p }));
  const resetFilters = () =>
    setFilters({ ...DEFAULT_CLIP_FILTERS, favoritesOnly: scope.kind === 'favorites' });

  // CP2: steering-run chips (ClipsExtras) narrow the grid to the clips one search found
  const videoScopeId = scope.kind === 'video' ? scope.videoId : null;
  const runFilter = useClipUi((s) => (videoScopeId ? (s.runFilter[videoScopeId] ?? null) : null));
  const visible = React.useMemo(
    () => filterClips(clips, filters).filter((c) => matchesRunFilter(c, runFilter)),
    [clips, filters, runFilter],
  );

  // clips that appear after the first load are "new": they get an arrival animation
  const [initial, setInitial] = React.useState<Set<string> | null>(null);
  if (q.data && initial === null) setInitial(new Set(q.data.items.map((c) => c.id)));

  const [selected, setSelected] = React.useState<Set<string>>(() => new Set());
  const lastIdx = React.useRef(-1);
  const sel = React.useMemo(() => visible.filter((c) => selected.has(c.id)), [visible, selected]);
  const selectionActive = sel.length > 0;

  const [openId, setOpenId] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState(false);
  const fav = useSetClipFavorite();
  const del = useDeleteClips();
  const download = useDownloadClips();

  const onSelect = React.useCallback(
    (clip: ClipView, e: { shiftKey: boolean }) => {
      const idx = visible.findIndex((c) => c.id === clip.id);
      setSelected((prev) => {
        const next = new Set(prev);
        if (e.shiftKey && lastIdx.current >= 0 && lastIdx.current !== idx) {
          const [a, b] = rangeBetween(lastIdx.current, idx);
          for (let i = a; i <= b; i++) {
            const c = visible[i];
            if (c) next.add(c.id);
          }
        } else if (next.has(clip.id)) next.delete(clip.id);
        else next.add(clip.id);
        return next;
      });
      lastIdx.current = idx;
    },
    [visible],
  );
  const onToggleFavorite = React.useCallback(
    (c: ClipView) => fav.mutate({ ids: [c.id], value: !c.favorite }),
    [fav],
  );
  const onOpen = React.useCallback((c: ClipView) => setOpenId(c.id), []);

  // CP2: deep links and action cards ask the drawer to open a clip (optionally on a tab)
  const openRequest = useClipUi((s) => s.openRequest);
  React.useEffect(() => {
    if (!openRequest) return;
    if (Date.now() - openRequest.at > 20_000) {
      useClipUi.getState().clearOpenRequest(); // nobody picked it up (different page): do not fire much later
      return;
    }
    if (!clips.some((c) => c.id === openRequest.clipId)) return; // the clip list may still be loading
    setOpenId(openRequest.clipId);
    if (openRequest.view) useClipUi.getState().setDrawerView(openRequest.view);
    useClipUi.getState().clearOpenRequest();
  }, [openRequest, clips]);
  const closeDrawer = React.useCallback(() => setOpenId(null), []);

  React.useEffect(() => {
    if (!selectionActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !(e.target instanceof HTMLInputElement))
        setSelected(new Set());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectionActive]);

  const allSelected = visible.length > 0 && sel.length === visible.length;
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(visible.map((c) => c.id)));

  if (q.isPending) return <SkeletonGrid label="Loading clips" />;
  if (q.isError)
    return (
      <EmptyState
        icon={Scissors}
        title="Could not load clips"
        description={q.error.message}
        actions={<Button onClick={() => void q.refetch()}>Try again</Button>}
      />
    );

  if (clips.length === 0) {
    if (processing)
      return (
        <div data-testid="clips-waiting">
          <div
            className="mb-4 flex items-center gap-2.5 text-sm text-muted-foreground"
            role="status"
          >
            <Loader2 className="size-4 animate-spin text-primary-text" aria-hidden />
            Looking for the strongest moments. Clips appear here the moment they are found.
          </div>
          <SkeletonGrid n={6} />
        </div>
      );
    return scope.kind === 'favorites' ? (
      <EmptyState
        size="md"
        icon={Star}
        title="No favorite clips yet"
        description="Star a clip and it is pinned here, so your best candidates are one click away."
      />
    ) : (
      <EmptyState
        size="lg"
        icon={Scissors}
        title={scope.kind === 'video' ? 'No clips for this video yet' : 'Your clips will land here'}
        description={
          scope.kind === 'video'
            ? 'This run did not produce any clips. Try again with a longer or lower-threshold setting, or a different steering prompt.'
            : 'Every AI-found moment shows up as a card with a virality score, hook and captions, appearing as soon as the first candidates are ready.'
        }
        steps={
          scope.kind === 'video'
            ? undefined
            : [
                'Paste a YouTube URL on Home to make your first clips.',
                'Sort by score to see the strongest first.',
                'Select several to download or favorite together.',
              ]
        }
        actions={
          scope.kind === 'video' ? undefined : (
            <Button variant="primary" asChild>
              <Link href="/">Paste a YouTube URL</Link>
            </Button>
          )
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* while a run is still producing its first few clips, filters would only be noise */}
      {processing && clips.length < 8 ? null : (
        <ClipFilterBar
          filters={filters}
          onChange={patchFilters}
          onReset={resetFilters}
          videos={videos.data?.items ?? []}
          hideVideo={scope.kind === 'video'}
          hideFavorites={scope.kind === 'favorites'}
        />
      )}
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <Checkbox
          checked={allSelected}
          indeterminate={selectionActive && !allSelected}
          aria-label="Select all clips"
          onCheckedChange={toggleAll}
          disabled={visible.length === 0}
        />
        <span className="tabular-nums" data-testid="clip-count" aria-live="polite">
          {visible.length === clips.length
            ? `${clips.length} ${clips.length === 1 ? 'clip' : 'clips'}`
            : `${visible.length} of ${clips.length} clips`}
        </span>
        {processing ? (
          <span className="flex items-center gap-1.5 text-primary-text">
            <Loader2 className="size-3.5 animate-spin" aria-hidden /> still finding more
          </span>
        ) : null}
        <ClipSortLayout
          sort={filters.sort}
          onSort={(sort) => patchFilters({ sort })}
          layout={layout}
          onLayout={setLayout}
        />
      </div>

      {visible.length === 0 ? (
        <EmptyState
          size="md"
          icon={SearchX}
          title="No clips match these filters"
          description="Loosen the minimum score or clear a filter to see more."
          actions={
            <Button variant="outline" onClick={resetFilters}>
              Clear filters
            </Button>
          }
        />
      ) : layout === 'grid' ? (
        <div className={GRID} data-testid="clip-grid">
          {visible.map((c) => (
            <ClipCard
              key={c.id}
              clip={c}
              selected={selected.has(c.id)}
              selectionActive={selectionActive}
              isNew={!!initial && !initial.has(c.id)}
              showVideo={scope.kind !== 'video'}
              onOpen={onOpen}
              onSelect={onSelect}
              onToggleFavorite={onToggleFavorite}
            />
          ))}
        </div>
      ) : (
        <ul className="divide-y overflow-hidden rounded-xl border bg-card" data-testid="clip-list">
          {visible.map((c) => (
            <ClipRow
              key={c.id}
              clip={c}
              selected={selected.has(c.id)}
              selectionActive={selectionActive}
              showVideo={scope.kind !== 'video'}
              onOpen={onOpen}
              onSelect={onSelect}
              onToggleFavorite={onToggleFavorite}
            />
          ))}
        </ul>
      )}

      <SelectionBar
        count={sel.length}
        allFavorite={sel.length > 0 && sel.every((c) => c.favorite)}
        downloading={download.isPending}
        onDownload={() => download.mutate({ ids: sel.map((c) => c.id) })}
        onFavorite={() =>
          fav.mutate({ ids: sel.map((c) => c.id), value: !sel.every((c) => c.favorite) })
        }
        onDelete={() => setConfirm(true)}
        onClear={() => setSelected(new Set())}
      />
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={sel.length === 1 ? 'Delete this clip?' : `Delete ${sel.length} clips?`}
        description="Rendered files and captions are removed from your cloud storage. Source videos are not affected."
        loading={del.isPending}
        onConfirm={() =>
          del.mutate(
            { ids: sel.map((c) => c.id) },
            {
              onSuccess: () => {
                setConfirm(false);
                setSelected(new Set());
              },
            },
          )
        }
      />
      <ClipDrawer clips={visible} clipId={openId} onClipChange={setOpenId} onClose={closeDrawer} />
    </div>
  );
}
