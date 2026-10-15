'use client';

import * as React from 'react';
import { useReducedMotion } from 'framer-motion';
import { toast } from 'sonner';
import { AlertCircle, ExternalLink, Film, Loader2, Search, Sparkles, X } from 'lucide-react';
import type { Asset } from '@shared/editor';
import type { BrandAssetView, BrollItem, BrollProvider } from '@shared/brand';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Kbd } from '@/components/ui/kbd';
import { Segmented } from '@/components/ui/segmented';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tip } from '@/components/ui/tooltip';
import { invoke } from '@/lib/ipc';
import {
  ORIENTATIONS,
  PROVIDERS,
  PROVIDER_INFO,
  columnsFromOffsets,
  gridNavigate,
  gridSpec,
  importSummary,
  suggestSource,
  type ImportState,
  type Orientation,
} from '@/lib/broll/model';
import { useBrollSearch, useBrollStatus } from '@/lib/broll/queries';
import { cn } from '@/lib/utils';
import { MissingKey } from './missing-key';
import { ResultCard, ResultCardSkeleton } from './result-card';

/** Where an imported stock clip goes: a project's media bin, or a Brand Kit's Videos section. */
export type StockTarget = { kind: 'project'; projectId: string } | { kind: 'kit'; kitId: string };

export interface StockBrollDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: StockTarget;
  /** Pre-filled search (e.g. a keyword suggested from the clip's transcript). */
  initialQuery?: string;
  /** Text (e.g. the selected transcript passage) that "Suggest with AI" turns into search ideas. */
  suggestFrom?: string;
  /** Called once per imported clip (project asset for `project` targets, brand asset for `kit` targets). */
  onImported?: (r: { asset: Asset } | { brandAsset: BrandAssetView }) => void;
}

/**
 * Stock B-roll picker (Pexels / Pixabay). The inner body mounts only while the dialog is open, so every opening
 * starts clean (selection, import marks, ideas).
 */
export function StockBrollDialog(props: StockBrollDialogProps) {
  const { open, onOpenChange } = props;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="h-[min(88vh,860px)] w-[calc(100vw-48px)] max-w-[min(1200px,calc(100vw-48px))]"
        data-testid="broll-dialog"
        aria-describedby="broll-desc"
        // Land in the search box (the base dialog focuses its own frame, which would hide the first keystrokes).
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          const box = e.currentTarget as HTMLElement | null;
          const input = box?.querySelector<HTMLInputElement>('[data-testid="broll-query"]');
          if (input && !input.disabled) input.focus();
          else box?.focus();
        }}
      >
        <StockBody {...props} />
      </DialogContent>
    </Dialog>
  );
}

type Suggest =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; queries: string[] }
  | { status: 'error'; message: string };

const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');

function StockBody({
  onOpenChange,
  target,
  initialQuery,
  suggestFrom,
  onImported,
}: StockBrollDialogProps) {
  const reduced = !!useReducedMotion();
  const status = useBrollStatus();

  const [pickedProvider, setPickedProvider] = React.useState<BrollProvider | null>(null);
  const [orientation, setOrientation] = React.useState<Orientation>('portrait');
  const [draft, setDraft] = React.useState(initialQuery?.trim() ?? '');
  const [committed, setCommitted] = React.useState(initialQuery?.trim() ?? '');
  const [selected, setSelected] = React.useState<Map<string, BrollItem>>(() => new Map());
  const [marks, setMarks] = React.useState<Record<string, ImportState>>({});
  const [importing, setImporting] = React.useState<{ at: number; total: number } | null>(null);
  const [focusIndex, setFocusIndex] = React.useState(0);
  const [previewId, setPreviewId] = React.useState<string | null>(null);
  const [suggest, setSuggest] = React.useState<Suggest>({ status: 'idle' });

  const stopRef = React.useRef(false);
  const importingRef = React.useRef(false);
  const onImportedRef = React.useRef(onImported);
  React.useEffect(() => {
    onImportedRef.current = onImported;
  });
  const gridRef = React.useRef<HTMLDivElement | null>(null);
  const suggestSeq = React.useRef(0);

  // Closing while clips are being added stops the queue after the clip in flight.
  React.useEffect(
    () => () => {
      if (importingRef.current) stopRef.current = true;
    },
    [],
  );

  const keys = status.data;
  const provider: BrollProvider =
    pickedProvider ?? (keys && !keys.pexels && keys.pixabay ? 'pixabay' : 'pexels');
  const hasKey = keys ? keys[provider] : false;
  const otherProvider: BrollProvider = provider === 'pexels' ? 'pixabay' : 'pexels';
  const info = PROVIDER_INFO[provider];
  const spec = gridSpec(orientation);

  const search = useBrollSearch({ provider, query: committed, orientation, enabled: hasKey });
  const items = search.items;

  // keep the roving index inside the list when results change
  React.useEffect(() => {
    setFocusIndex((i) => Math.min(i, Math.max(0, items.length - 1)));
  }, [items.length]);
  React.useEffect(() => {
    setFocusIndex(0);
    setPreviewId(null);
  }, [provider, committed, orientation]);

  const openLink = React.useCallback((url: string) => {
    invoke('shell:openExternal', { url }).catch((e: unknown) =>
      toast.error(`Could not open the link. ${errMsg(e)}`),
    );
  }, []);

  const runSearch = (q: string) => {
    const text = q.trim();
    if (!text) return;
    setDraft(text);
    setCommitted(text);
  };

  const toggle = React.useCallback((item: BrollItem) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(item.id)) next.delete(item.id);
      else next.set(item.id, item);
      return next;
    });
  }, []);

  /* ----------------------------------------------------------------------------- import ------ */

  const importAll = async (list: BrollItem[]) => {
    if (importingRef.current || list.length === 0) return;
    importingRef.current = true;
    stopRef.current = false;
    let ok = 0;
    let bad = 0;
    let skipped = 0;
    for (let i = 0; i < list.length; i++) {
      const item = list[i]!;
      if (stopRef.current) {
        skipped = list.length - i;
        break;
      }
      setImporting({ at: i + 1, total: list.length });
      setMarks((m) => ({ ...m, [item.id]: { status: 'busy' } }));
      try {
        if (target.kind === 'project') {
          const r = await invoke('broll:importToProject', { projectId: target.projectId, item });
          onImportedRef.current?.({ asset: r.asset });
        } else {
          const r = await invoke('broll:importToKit', { kitId: target.kitId, item });
          onImportedRef.current?.({ brandAsset: r.asset });
        }
        ok += 1;
        setMarks((m) => ({ ...m, [item.id]: { status: 'done' } }));
        setSelected((prev) => {
          const next = new Map(prev);
          next.delete(item.id);
          return next;
        });
      } catch (e) {
        bad += 1;
        setMarks((m) => ({ ...m, [item.id]: { status: 'error', message: errMsg(e) } }));
      }
    }
    importingRef.current = false;
    setImporting(null);
    if (ok > 0 && bad === 0 && skipped === 0) toast.success(importSummary(ok, 0));
    else if (ok > 0) toast.warning(importSummary(ok, bad, skipped));
    else if (bad > 0) toast.error(importSummary(0, bad, skipped));
  };

  const addSelected = () => void importAll([...selected.values()]);

  /* ----------------------------------------------------------------------------- suggest ------ */

  const source = suggestSource(suggestFrom, draft);
  const askSuggest = async () => {
    if (!source) return;
    const seq = ++suggestSeq.current;
    setSuggest({ status: 'loading' });
    try {
      const r = await invoke('broll:suggest', { text: source });
      if (seq !== suggestSeq.current) return;
      const queries = [...new Set(r.queries.map((q) => q.trim()).filter(Boolean))].slice(0, 6);
      setSuggest(
        queries.length > 0
          ? { status: 'done', queries }
          : { status: 'error', message: 'No ideas came back. Try a longer passage.' },
      );
    } catch (e) {
      if (seq === suggestSeq.current) setSuggest({ status: 'error', message: errMsg(e) });
    }
  };

  /* ----------------------------------------------------------------------------- keyboard ------ */

  const focusCell = (index: number) => {
    setFocusIndex(index);
    const el = gridRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`);
    el?.focus();
    el?.scrollIntoView({ block: 'nearest' });
  };

  const onGridKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-index]');
    if (!target) return;
    const index = Number(target.dataset.index);
    const item = items[index];
    if (!item) return;
    if (e.key === ' ') {
      e.preventDefault();
      if (!marks[item.id] || marks[item.id]!.status === 'error') toggle(item);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (importingRef.current) return;
      const m = marks[item.id];
      if (selected.size > 0) addSelected();
      else if (m?.status !== 'done') void importAll([item]);
      return;
    }
    const cells = [...(gridRef.current?.querySelectorAll<HTMLElement>('[data-index]') ?? [])];
    const cols = columnsFromOffsets(cells.map((c) => c.getBoundingClientRect().top));
    const next = gridNavigate(e.key, index, cols, items.length);
    if (next !== null) {
      e.preventDefault();
      focusCell(next);
    }
  };

  /* ----------------------------------------------------------------------------- render ------ */

  const count = selected.size;
  const searching = search.isPending && search.fetchStatus !== 'idle';
  const firstPageFailed = search.isError && items.length === 0;

  return (
    <>
      <DialogHeader className="gap-1 pb-3">
        <DialogTitle className="font-display text-xl font-semibold">Stock B-roll</DialogTitle>
        <DialogDescription id="broll-desc">
          {target.kind === 'project'
            ? "Free stock footage from Pexels and Pixabay. Clips you add land in this project's media bin, ready for the timeline."
            : "Free stock footage from Pexels and Pixabay. Clips you add are saved to this Brand Kit's Videos section."}
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-3 border-b px-6 pb-4 pt-3">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <Tabs value={provider} onValueChange={(v) => setPickedProvider(v as BrollProvider)}>
            <TabsList variant="pill" aria-label="Footage provider">
              {PROVIDERS.map((p) => {
                const ready = keys ? keys[p] : null;
                return (
                  <TabsTrigger key={p} value={p} variant="pill" data-testid={`broll-tab-${p}`}>
                    {PROVIDER_INFO[p].name}
                    <span
                      data-testid={`broll-key-${p}`}
                      data-ready={ready === null ? 'unknown' : String(ready)}
                      className={cn(
                        'size-1.5 rounded-full',
                        ready === null ? 'bg-border-strong' : ready ? 'bg-success' : 'bg-warning',
                      )}
                      aria-hidden
                    />
                    <span className="sr-only">
                      {ready === null ? '' : ready ? '(API key set)' : '(API key missing)'}
                    </span>
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </Tabs>
          <Segmented
            label="Orientation"
            size="sm"
            value={orientation}
            onValueChange={setOrientation}
            options={ORIENTATIONS}
          />
        </div>

        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            runSearch(draft);
          }}
          role="search"
        >
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Search stock footage, e.g. city night timelapse"
            aria-label="Search stock footage"
            maxLength={120}
            leading={<Search />}
            wrapperClassName="min-w-56 flex-1"
            data-testid="broll-query"
            disabled={!!keys && !hasKey}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' && items.length > 0) {
                e.preventDefault();
                focusCell(Math.min(focusIndex, items.length - 1));
              }
            }}
          />
          <Button
            type="submit"
            variant="primary"
            disabled={!draft.trim() || !hasKey}
            data-testid="broll-search"
          >
            Search
          </Button>
          <Tip
            content={
              source
                ? `Asks Claude for search ideas from: “${source.slice(0, 80)}${source.length > 80 ? '…' : ''}”`
                : 'Type a description, or open this from a selected passage, to get search ideas'
            }
          >
            <span className="inline-flex">
              <Button
                type="button"
                variant="soft"
                disabled={!source || suggest.status === 'loading'}
                loading={suggest.status === 'loading'}
                onClick={() => void askSuggest()}
                data-testid="broll-suggest"
              >
                {suggest.status === 'loading' ? null : <Sparkles aria-hidden />}
                Suggest with AI
              </Button>
            </span>
          </Tip>
        </form>

        {suggest.status === 'done' ? (
          <div className="flex flex-wrap items-center gap-1.5" data-testid="broll-ideas">
            <span className="mr-1 text-xs font-semibold uppercase tracking-wider text-subtle">
              Ideas
            </span>
            {suggest.queries.map((q) => (
              <button
                key={q}
                type="button"
                data-testid="broll-chip"
                onClick={() => runSearch(q)}
                className={cn(
                  'inline-flex h-7 items-center rounded-full border px-3 text-sm transition-colors duration-(--duration-fast)',
                  q === committed
                    ? 'border-primary bg-primary-soft text-primary-text'
                    : 'border-border-strong bg-muted text-foreground hover:bg-accent',
                )}
              >
                {q}
              </button>
            ))}
          </div>
        ) : null}
        {suggest.status === 'error' ? (
          <p
            role="alert"
            className="flex items-start gap-1.5 text-sm text-danger"
            data-testid="broll-suggest-error"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
            {suggest.message}
          </p>
        ) : null}
      </div>

      <div
        className="scrollbar-thin relative min-h-0 flex-1 overflow-y-auto px-6 py-5"
        role="tabpanel"
        aria-label={`${info.name} results`}
        data-testid="broll-results"
      >
        {status.isError ? (
          <Banner tone="danger" title="Could not read your API key status">
            {status.error.message}
          </Banner>
        ) : !keys ? (
          <SkeletonGrid aspect={spec.aspect} minCol={spec.minCol} />
        ) : !hasKey ? (
          <MissingKey
            provider={provider}
            otherReady={keys[otherProvider] ? otherProvider : null}
            onOpenLink={openLink}
            onNavigate={() => onOpenChange(false)}
            onSwitch={setPickedProvider}
          />
        ) : !committed ? (
          <EmptyState
            icon={Film}
            size="sm"
            title="Find a clip to cut to"
            description={`Search ${info.name}'s free stock footage. Try a single concrete subject, like "ocean waves" or "typing on laptop".`}
          />
        ) : searching ? (
          <SkeletonGrid aspect={spec.aspect} minCol={spec.minCol} />
        ) : firstPageFailed ? (
          <div className="mx-auto flex max-w-xl flex-col gap-3" data-testid="broll-search-error">
            <Banner
              tone="danger"
              title={`${info.name} search failed`}
              action={
                <Button size="sm" variant="outline" onClick={() => void search.refetch()}>
                  Try again
                </Button>
              }
            >
              {search.error?.message}
            </Banner>
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={Search}
            size="sm"
            title="No clips found"
            description={
              orientation === 'any'
                ? `${info.name} has nothing for “${committed}”. Try a simpler or more general word.`
                : `${info.name} has no ${orientation} clips for “${committed}”. Try another orientation or a more general word.`
            }
            actions={
              orientation !== 'any' ? (
                <Button variant="outline" onClick={() => setOrientation('any')}>
                  Search any orientation
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <p className="sr-only" role="status" aria-live="polite">
              {items.length} clips from {info.name}
            </p>
            {provider === 'pixabay' && orientation !== 'any' ? (
              <p className="mb-3 text-xs text-subtle" data-testid="broll-pixabay-note">
                Pixabay cannot filter videos by shape, so Clipfern filters the results itself.
                Expect fewer clips per page.
              </p>
            ) : null}
            <div
              ref={gridRef}
              role="listbox"
              aria-multiselectable
              aria-label={`${info.name} clips`}
              data-testid="broll-grid"
              onKeyDown={onGridKeyDown}
              className="grid gap-x-4 gap-y-5"
              style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${spec.minCol}px, 1fr))` }}
            >
              {items.map((item, i) => (
                <ResultCard
                  key={item.id}
                  item={item}
                  index={i}
                  aspect={spec.aspect}
                  selected={selected.has(item.id)}
                  focusable={i === focusIndex}
                  importState={marks[item.id]}
                  previewing={previewId === item.id}
                  reducedMotion={reduced}
                  onToggle={toggle}
                  onPreview={setPreviewId}
                  onFocusCell={setFocusIndex}
                  onOpenLink={openLink}
                />
              ))}
            </div>
            <div className="mt-6 flex flex-col items-center gap-2">
              {search.isFetchNextPageError ? (
                <p
                  role="alert"
                  className="flex items-start gap-1.5 text-sm text-danger"
                  data-testid="broll-more-error"
                >
                  <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
                  {search.error?.message}
                </p>
              ) : null}
              {search.hasNextPage ? (
                <Button
                  variant="outline"
                  loading={search.isFetchingNextPage}
                  onClick={() => void search.fetchNextPage()}
                  data-testid="broll-more"
                >
                  {search.isFetchNextPageError ? 'Try again' : 'Load more'}
                </Button>
              ) : (
                <p className="text-xs text-subtle" data-testid="broll-end">
                  That is every clip {info.name} has for this search.
                </p>
              )}
            </div>
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t bg-card/60 px-6 py-3.5">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-xs text-muted-foreground" data-testid="broll-attribution">
            {info.attribution}{' '}
            <a
              href={info.homeUrl}
              onClick={(e) => {
                e.preventDefault();
                openLink(info.homeUrl);
              }}
              className="inline-flex items-center gap-0.5 font-medium text-primary-text underline-offset-4 hover:underline"
            >
              {info.name}
              <ExternalLink className="size-3" aria-hidden />
            </a>
            . Authors are credited on every clip.
          </p>
          <p className="hidden items-center gap-1.5 text-2xs text-subtle lg:flex">
            <Kbd keys={['←', '→', '↑', '↓']} /> move
            <Kbd keys={['Space']} /> select
            <Kbd keys={['enter']} /> add
            <Kbd keys={['esc']} /> close
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className="text-sm text-muted-foreground"
            aria-live="polite"
            data-testid="broll-count"
          >
            {importing
              ? `Adding ${importing.at} of ${importing.total}…`
              : count > 0
                ? `${count} selected`
                : 'Nothing selected'}
          </span>
          {count > 0 && !importing ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelected(new Map())}
              data-testid="broll-clear"
            >
              <X aria-hidden />
              Clear
            </Button>
          ) : null}
          {importing ? (
            <Button
              variant="outline"
              onClick={() => (stopRef.current = true)}
              data-testid="broll-stop"
            >
              Stop after this clip
            </Button>
          ) : null}
          <Button
            variant="primary"
            disabled={count === 0 || !!importing}
            onClick={addSelected}
            data-testid="broll-add"
          >
            {importing ? <Loader2 className="animate-spin" aria-hidden /> : null}
            {count > 0 ? `Add ${count} clip${count === 1 ? '' : 's'}` : 'Add clips'}
          </Button>
        </div>
      </div>
    </>
  );
}

function SkeletonGrid({ aspect, minCol }: { aspect: string; minCol: number }) {
  return (
    <div
      className="grid gap-x-4 gap-y-5"
      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${minCol}px, 1fr))` }}
      data-testid="broll-skeleton"
      role="status"
      aria-label="Loading clips"
    >
      {Array.from({ length: 12 }, (_, i) => (
        <ResultCardSkeleton key={i} aspect={aspect} />
      ))}
    </div>
  );
}
