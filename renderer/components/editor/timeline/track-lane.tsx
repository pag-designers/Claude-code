'use client';

import * as React from 'react';
import type { Asset, Track } from '@shared/editor';
import { cullItems, type RowLayout, type TimeWindow } from './geometry';
import { ItemBlock, type ItemBlockProps } from './item-block';
import { cn } from '@/lib/utils';

const KEYFRAME_SELECTION_LIMIT = 6;

export interface TrackLaneProps {
  track: Track;
  row: RowLayout;
  alt: boolean;
  contentW: number;
  pxPerSec: number;
  win: TimeWindow;
  assets: ReadonlyMap<string, Asset>;
  selectedIds: ReadonlySet<string>;
  selectionCount: number;
  dropTarget: boolean;
}

/**
 * One track's lane. Only the items intersecting the render window are in the DOM (binary-search culling), so a project
 * with thousands of items costs the same as one with a few dozen.
 */
export const TrackLane = React.memo(function TrackLane({
  track,
  row,
  alt,
  contentW,
  pxPerSec,
  win,
  assets,
  selectedIds,
  selectionCount,
  dropTarget,
}: TrackLaneProps) {
  const visible = React.useMemo(
    () => cullItems(track.items, win.start, win.end),
    [track.items, win.start, win.end],
  );
  // roving tabindex: the (first) selected visible item, else the first visible one
  let tabbableId: string | null = null;
  for (const it of visible) {
    if (selectedIds.has(it.id)) {
      tabbableId = it.id;
      break;
    }
  }
  if (!tabbableId) tabbableId = visible[0]?.id ?? null;
  const showKf = selectionCount > 0 && selectionCount <= KEYFRAME_SELECTION_LIMIT;
  const blockProps: Pick<
    ItemBlockProps,
    'trackId' | 'trackKind' | 'pxPerSec' | 'win' | 'trackLocked' | 'trackMuted' | 'height'
  > = {
    trackId: track.id,
    trackKind: track.kind,
    pxPerSec,
    win,
    trackLocked: track.locked,
    trackMuted: track.muted,
    height: row.height - 6,
  };
  return (
    <div
      className="tl-lane relative"
      role="listbox"
      aria-multiselectable
      aria-orientation="horizontal"
      aria-label={`${track.name}, ${track.kind} track, ${track.items.length} item${track.items.length === 1 ? '' : 's'}${track.locked ? ', locked' : ''}${track.hidden ? ', hidden' : ''}`}
      tabIndex={visible.length === 0 ? 0 : -1}
      data-lane
      data-track-id={track.id}
      data-alt={alt || undefined}
      data-locked={track.locked || undefined}
      data-hidden={track.hidden || undefined}
      data-drop={dropTarget || undefined}
      style={{ width: contentW, height: row.height }}
    >
      <div className={cn('tl-lane-items absolute inset-0')}>
        {visible.map((item) => {
          const selected = selectedIds.has(item.id);
          return (
            <ItemBlock
              key={item.id}
              item={item}
              asset={'assetId' in item ? assets.get(item.assetId) : undefined}
              selected={selected}
              showKeyframes={selected && showKf}
              tabbable={item.id === tabbableId}
              {...blockProps}
            />
          );
        })}
      </div>
    </div>
  );
});
