'use client';

import { Grid2x2, List, Search, Star, X } from 'lucide-react';
import type { VideoView } from '@shared/pipeline';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/utils';
import {
  DATE_LABELS,
  DURATION_LABELS,
  SORT_LABELS,
  activeFilterCount,
  type ClipFilters,
  type ClipSort,
  type DateRange,
  type DurationBucket,
} from '@/lib/library-filters';

export type Layout = 'grid' | 'list';

function Pick<T extends string>({
  label,
  value,
  onChange,
  options,
  className,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  className?: string;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as T)}>
      <SelectTrigger aria-label={label} className={cn('h-9 w-auto min-w-32', className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Library clip filters: search, min-score slider, duration, video, date, favorites, sort and layout. */
export function ClipFilterBar({
  filters,
  onChange,
  onReset,
  videos,
  hideVideo,
  hideFavorites,
}: {
  filters: ClipFilters;
  onChange: (patch: Partial<ClipFilters>) => void;
  onReset: () => void;
  videos: Pick<VideoView, 'id' | 'title'>[];
  hideVideo?: boolean;
  hideFavorites?: boolean;
}) {
  const active = activeFilterCount(filters) - (hideFavorites ? Number(filters.favoritesOnly) : 0);
  return (
    <div className="flex flex-wrap items-center gap-2.5" role="group" aria-label="Clip filters">
      <Input
        aria-label="Search clips"
        placeholder="Search titles and hooks"
        leading={<Search />}
        value={filters.query}
        onChange={(e) => onChange({ query: e.target.value })}
        className="h-9 w-60"
        wrapperClassName="w-60"
      />
      <div className="flex h-9 items-center gap-3 rounded-md border border-input bg-field px-3 shadow-[inset_0_1px_2px_rgb(0_0_0/0.12)]">
        <label htmlFor="min-score" className="text-sm text-muted-foreground">
          Score
        </label>
        <Slider
          id="min-score"
          aria-label="Minimum score"
          value={filters.minScore}
          onValueChange={(v) => onChange({ minScore: v })}
          step={5}
          className="w-28"
        />
        <span
          className="w-8 text-right text-sm font-semibold tabular-nums"
          data-testid="min-score-value"
        >
          {filters.minScore > 0 ? `≥${filters.minScore}` : 'Any'}
        </span>
      </div>
      <Pick<DurationBucket>
        label="Duration"
        value={filters.duration}
        onChange={(duration) => onChange({ duration })}
        options={(Object.keys(DURATION_LABELS) as DurationBucket[]).map((v) => ({
          value: v,
          label: DURATION_LABELS[v],
        }))}
      />
      {hideVideo ? null : (
        <Pick<string>
          label="Video"
          value={filters.videoId}
          onChange={(videoId) => onChange({ videoId })}
          className="max-w-56"
          options={[
            { value: 'all', label: 'All videos' },
            ...videos.map((v) => ({ value: v.id, label: v.title })),
          ]}
        />
      )}
      <Pick<DateRange>
        label="Date"
        value={filters.date}
        onChange={(date) => onChange({ date })}
        options={(Object.keys(DATE_LABELS) as DateRange[]).map((v) => ({
          value: v,
          label: DATE_LABELS[v],
        }))}
      />
      {hideFavorites ? null : (
        <Button
          variant={filters.favoritesOnly ? 'soft' : 'outline'}
          aria-pressed={filters.favoritesOnly}
          onClick={() => onChange({ favoritesOnly: !filters.favoritesOnly })}
          className="h-9"
        >
          <Star className={cn(filters.favoritesOnly && 'fill-current')} /> Favorites
        </Button>
      )}
      {active > 0 ? (
        <Button variant="ghost" size="sm" onClick={onReset}>
          <X /> Clear filters
        </Button>
      ) : null}
    </div>
  );
}

/** Sort + grid/list toggle: sits on the results row, not in the filter bar. */
export function ClipSortLayout({
  sort,
  onSort,
  layout,
  onLayout,
}: {
  sort: ClipSort;
  onSort: (s: ClipSort) => void;
  layout: Layout;
  onLayout: (l: Layout) => void;
}) {
  return (
    <div className="ml-auto flex items-center gap-2.5">
      <Pick<ClipSort>
        label="Sort by"
        value={sort}
        onChange={onSort}
        options={(Object.keys(SORT_LABELS) as ClipSort[]).map((v) => ({
          value: v,
          label: `Sort: ${SORT_LABELS[v]}`,
        }))}
        className="min-w-40"
      />
      <Segmented<Layout>
        label="Layout"
        size="sm"
        value={layout}
        onValueChange={onLayout}
        options={[
          { value: 'grid', label: <Grid2x2 className="size-4" />, hint: 'Grid' },
          { value: 'list', label: <List className="size-4" />, hint: 'List' },
        ]}
      />
    </div>
  );
}
