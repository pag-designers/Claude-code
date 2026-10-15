'use client';

import * as React from 'react';
import Link from 'next/link';
import { Film, Grid2x2, List, Search, SearchX, Star } from 'lucide-react';
import type { VideoView } from '@shared/pipeline';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useVideos } from '@/lib/library';
import { filterVideos, type VideoSort } from '@/lib/library-filters';
import { usePersistedChoice } from '@/lib/persist';
import { DeleteVideoDialog, VideoCard, VideoRow } from './video-card';
import type { Layout } from './clip-filters';

const SORTS: { value: VideoSort; label: string }[] = [
  { value: 'newest', label: 'Sort: Newest' },
  { value: 'oldest', label: 'Sort: Oldest' },
  { value: 'clips', label: 'Sort: Most clips' },
  { value: 'title', label: 'Sort: Title A–Z' },
];

export function VideosBrowser({ favoritesOnly }: { favoritesOnly?: boolean }) {
  const q = useVideos();
  const [layout, setLayout] = usePersistedChoice<Layout>(
    'clipfern.videos.layout',
    ['grid', 'list'],
    'grid',
  );
  const [query, setQuery] = React.useState('');
  const [sort, setSort] = React.useState<VideoSort>('newest');
  const [toDelete, setToDelete] = React.useState<VideoView | null>(null);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const all = q.data?.items;
  const items = React.useMemo(
    () => filterVideos(all ?? [], { query, sort, favoritesOnly }),
    [all, query, sort, favoritesOnly],
  );
  const onDelete = React.useCallback((v: VideoView) => {
    setToDelete(v);
    setDialogOpen(true);
  }, []);

  if (q.isPending)
    return (
      <div
        className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4"
        aria-busy
        aria-label="Loading videos"
      >
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="overflow-hidden rounded-xl border bg-card">
            <Skeleton className="aspect-video w-full rounded-none" />
            <div className="space-y-2 p-3.5">
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          </div>
        ))}
      </div>
    );
  if (q.isError)
    return (
      <EmptyState
        icon={Film}
        title="Could not load videos"
        description={q.error.message}
        actions={<Button onClick={() => void q.refetch()}>Try again</Button>}
      />
    );

  if ((all ?? []).filter((v) => !favoritesOnly || v.favorite).length === 0)
    return favoritesOnly ? (
      <EmptyState
        size="md"
        icon={Star}
        title="No favorite videos yet"
        description="Star a video in your library to keep it close."
      />
    ) : (
      <EmptyState
        size="lg"
        icon={Film}
        title="No videos imported yet"
        description="Imported YouTube videos live here as lightweight 480p proxies, with their transcript, chapters and AI notes."
        steps={[
          'Paste a YouTube URL on Home to make your first clips.',
          'Clipfern downloads, transcribes and understands it.',
          'Open the video to browse chapters and clips.',
        ]}
        actions={
          <Button variant="primary" asChild>
            <Link href="/">Paste a YouTube URL</Link>
          </Button>
        }
      />
    );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2.5" role="group" aria-label="Video filters">
        <Input
          aria-label="Search videos"
          placeholder="Search titles and channels"
          leading={<Search />}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-9 w-64"
          wrapperClassName="w-64"
        />
        <span className="text-sm tabular-nums text-muted-foreground" data-testid="video-count">
          {items.length} {items.length === 1 ? 'video' : 'videos'}
        </span>
        <div className="ml-auto flex items-center gap-2.5">
          <Select value={sort} onValueChange={(v) => setSort(v as VideoSort)}>
            <SelectTrigger aria-label="Sort videos" className="h-9 w-auto min-w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORTS.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Segmented<Layout>
            label="Video layout"
            size="sm"
            value={layout}
            onValueChange={setLayout}
            options={[
              { value: 'grid', label: <Grid2x2 className="size-4" />, hint: 'Grid' },
              { value: 'list', label: <List className="size-4" />, hint: 'List' },
            ]}
          />
        </div>
      </div>
      {items.length === 0 ? (
        <EmptyState
          size="md"
          icon={SearchX}
          title="No videos match"
          description="Try a different search."
          actions={
            <Button variant="outline" onClick={() => setQuery('')}>
              Clear search
            </Button>
          }
        />
      ) : layout === 'grid' ? (
        <div
          className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4"
          data-testid="video-grid"
        >
          {items.map((v) => (
            <VideoCard key={v.id} video={v} onDelete={onDelete} />
          ))}
        </div>
      ) : (
        <ul className="divide-y overflow-hidden rounded-xl border bg-card" data-testid="video-list">
          {items.map((v) => (
            <VideoRow key={v.id} video={v} onDelete={onDelete} />
          ))}
        </ul>
      )}
      <DeleteVideoDialog video={toDelete} open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  );
}
