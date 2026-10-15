'use client';

import * as React from 'react';
import Link from 'next/link';
import { Film, Search } from 'lucide-react';
import type { PostSource } from '@shared/publish';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useExports } from '@/lib/editor-panels/projects';
import { formatSpan } from '@/lib/format';
import { libraryHref } from '@/lib/hrefs';
import { useAllClips } from '@/lib/library';
import { usePosts } from '@/lib/publish/queries';
import { cn } from '@/lib/utils';
import { SourceThumb, sourceKey } from './source';

const LIMIT = 120;

interface Item {
  source: PostSource;
  id: string;
  kind: 'clip' | 'export';
  title: string;
  detail: string;
}

function ItemRow({
  item,
  checked,
  scheduledCount,
  onToggle,
}: {
  item: Item;
  checked: boolean;
  scheduledCount: number;
  onToggle: () => void;
}) {
  const id = React.useId();
  return (
    <li>
      <div
        className={cn(
          'flex items-center gap-3 rounded-lg px-2.5 py-2 transition-colors duration-(--duration-fast) hover:bg-accent/60',
          checked && 'bg-primary-soft hover:bg-primary-soft',
        )}
      >
        <Checkbox
          id={id}
          checked={checked}
          onCheckedChange={onToggle}
          aria-label={`Select ${item.title}`}
          data-testid="pick-check"
        />
        <label htmlFor={id} className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
          <SourceThumb meta={item} className="w-9" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{item.title}</span>
            <span className="block truncate text-xs text-muted-foreground">{item.detail}</span>
          </span>
          {scheduledCount > 0 ? (
            <Badge variant="outline" className="shrink-0">
              Already posted or scheduled ×{scheduledCount}
            </Badge>
          ) : null}
        </label>
      </div>
    </li>
  );
}

/** "Pick a clip to schedule": rendered Library clips and finished editor exports, multi-select. */
export function PickSourceDialog({
  open,
  onOpenChange,
  onContinue,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onContinue: (sources: PostSource[]) => void;
}) {
  const clips = useAllClips();
  const exps = useExports();
  const posts = usePosts();
  const [query, setQuery] = React.useState('');
  const [tab, setTab] = React.useState<'clips' | 'exports'>('clips');
  const [picked, setPicked] = React.useState<Map<string, PostSource>>(new Map());

  const clipItems: Item[] = React.useMemo(
    () =>
      (clips.data?.items ?? [])
        .filter((c) => c.status === 'rendered' && c.hasRender)
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .map((c) => ({
          source: { clipId: c.id },
          id: c.id,
          kind: 'clip' as const,
          title: c.title,
          detail: [
            c.videoTitle,
            formatSpan(c.durationSec),
            c.score !== null ? `score ${Math.round(c.score)}` : null,
          ]
            .filter(Boolean)
            .join(' · '),
        })),
    [clips.data],
  );
  const exportItems: Item[] = React.useMemo(
    () =>
      (exps.data?.items ?? [])
        .filter((e) => e.status === 'done' && e.hasFile)
        .map((e) => ({
          source: { exportId: e.id },
          id: e.id,
          kind: 'export' as const,
          title: e.name,
          detail: [
            `${e.settings.width}×${e.settings.height}`,
            e.durationSec !== null ? formatSpan(e.durationSec) : null,
          ]
            .filter(Boolean)
            .join(' · '),
        })),
    [exps.data],
  );
  const countBySource = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const p of posts.data?.items ?? []) {
      if (p.status === 'canceled') continue;
      const key = p.clipId ? `c:${p.clipId}` : p.exportId ? `e:${p.exportId}` : null;
      if (key) m.set(key, (m.get(key) ?? 0) + 1);
    }
    return m;
  }, [posts.data]);

  const q = query.trim().toLowerCase();
  const filtered = (items: Item[]) =>
    q ? items.filter((i) => `${i.title} ${i.detail}`.toLowerCase().includes(q)) : items;
  const loading = clips.isPending || exps.isPending;

  const toggle = (item: Item) =>
    setPicked((prev) => {
      const next = new Map(prev);
      const k = sourceKey(item.source);
      if (next.has(k)) next.delete(k);
      else next.set(k, item.source);
      return next;
    });

  const renderList = (items: Item[], empty: React.ReactNode) => {
    const list = filtered(items);
    if (loading)
      return (
        <div className="flex flex-col gap-2" aria-busy aria-label="Loading">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12 rounded-lg" />
          ))}
        </div>
      );
    if (!items.length) return empty;
    if (!list.length)
      return (
        <p className="px-2 py-8 text-center text-sm text-muted-foreground">
          Nothing matches “{query}”.
        </p>
      );
    return (
      <>
        <ul className="flex flex-col gap-0.5" aria-label={tab === 'clips' ? 'Clips' : 'Exports'}>
          {list.slice(0, LIMIT).map((i) => (
            <ItemRow
              key={sourceKey(i.source)}
              item={i}
              checked={picked.has(sourceKey(i.source))}
              scheduledCount={countBySource.get(sourceKey(i.source)) ?? 0}
              onToggle={() => toggle(i)}
            />
          ))}
        </ul>
        {list.length > LIMIT ? (
          <p className="px-2 pt-3 text-center text-xs text-muted-foreground">
            Showing the top {LIMIT} of {list.length}. Search to narrow it down.
          </p>
        ) : null}
      </>
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setPicked(new Map());
          setQuery('');
        }
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-[620px]" data-testid="pick-dialog">
        <DialogHeader>
          <DialogTitle className="font-display text-xl font-semibold">
            Pick a clip to schedule
          </DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            Choose one clip, or several to space them out automatically.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search clips…"
            aria-label="Search clips"
            leading={<Search />}
          />
          <Tabs value={tab} onValueChange={(v) => setTab(v as 'clips' | 'exports')}>
            <TabsList aria-label="Source type">
              <TabsTrigger value="clips" data-testid="pick-tab-clips">
                Clips <span className="text-xs tabular-nums text-subtle">{clipItems.length}</span>
              </TabsTrigger>
              <TabsTrigger value="exports" data-testid="pick-tab-exports">
                Exports{' '}
                <span className="text-xs tabular-nums text-subtle">{exportItems.length}</span>
              </TabsTrigger>
            </TabsList>
            <TabsContent value="clips" className="mt-3">
              {renderList(
                clipItems,
                <EmptyState
                  size="sm"
                  icon={Film}
                  title="No rendered clips yet"
                  description="Clips appear here once the pipeline has rendered them."
                  actions={
                    <Button variant="outline" asChild>
                      <Link href={libraryHref('clips')} onClick={() => onOpenChange(false)}>
                        Open the Library
                      </Link>
                    </Button>
                  }
                />,
              )}
            </TabsContent>
            <TabsContent value="exports" className="mt-3">
              {renderList(
                exportItems,
                <EmptyState
                  size="sm"
                  icon={Film}
                  title="No finished exports"
                  description="Exports from the editor show up here when they are done."
                />,
              )}
            </TabsContent>
          </Tabs>
        </DialogBody>
        <DialogFooter className="justify-between">
          <span
            className="text-sm text-muted-foreground"
            aria-live="polite"
            data-testid="pick-count"
          >
            {picked.size ? `${picked.size} selected` : 'Nothing selected'}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={picked.size === 0}
              onClick={() => {
                const sources = [...picked.values()];
                setPicked(new Map());
                setQuery('');
                onContinue(sources);
              }}
              data-testid="pick-continue"
            >
              Continue
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
