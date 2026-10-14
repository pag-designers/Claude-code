'use client';

import * as React from 'react';
import type { Asset, Item, TrackKind } from '@shared/editor';
import { cn } from '@/lib/utils';
import { MIN_ITEM_PX, groupColorIndex, itemAriaLabel, type TimeWindow } from './geometry';
import {
  AudioWave,
  ItemLabel,
  SHAPE_ICON,
  SubtitleContent,
  TypeIcon,
  VideoStrip,
} from './item-content';
import { KeyframeDiamonds } from './keyframe-diamonds';
import { TransitionGlyph } from './transition-editor';

export interface ItemBlockProps {
  item: Item;
  trackId: string;
  trackKind: TrackKind;
  asset: Asset | undefined;
  pxPerSec: number;
  win: TimeWindow;
  selected: boolean;
  /** Show keyframe diamonds (only for a handful of selected items). */
  showKeyframes: boolean;
  trackLocked: boolean;
  trackMuted: boolean;
  /** Height of the block's content box. */
  height: number;
  tabbable: boolean;
}

/** One clip on the timeline. Memoised: re-renders only when its own data, zoom or window slice changes. */
export const ItemBlock = React.memo(function ItemBlock({
  item,
  trackId,
  trackKind,
  asset,
  pxPerSec,
  win,
  selected,
  showKeyframes,
  trackLocked,
  trackMuted,
  height,
  tabbable,
}: ItemBlockProps) {
  const left = item.startSec * pxPerSec;
  const width = Math.max(MIN_ITEM_PX, item.durationSec * pxPerSec);
  const contentH = Math.max(10, height - 8);
  const fadeIn = 'fadeInSec' in item ? item.fadeInSec : 0;
  const fadeOut = 'fadeOutSec' in item ? item.fadeOutSec : 0;
  const locked = trackLocked || item.locked;
  const overlay = trackKind === 'overlay';

  let body: React.ReactNode = null;
  switch (item.type) {
    case 'video':
      body = (
        <VideoStrip item={item} asset={asset} pxPerSec={pxPerSec} win={win} height={contentH} />
      );
      if (trackKind === 'audio' && asset?.hasAudio) {
        body = (
          <AudioWave
            item={item}
            asset={asset}
            pxPerSec={pxPerSec}
            win={win}
            height={contentH}
            muted={trackMuted}
            sfx={false}
          />
        );
      }
      break;
    case 'audio':
      body = (
        <AudioWave
          item={item}
          asset={asset}
          pxPerSec={pxPerSec}
          win={win}
          height={contentH}
          muted={trackMuted}
          sfx={trackKind === 'sfx'}
        />
      );
      break;
    case 'subtitle':
      body = <SubtitleContent item={item} pxWidth={width} />;
      break;
    case 'text':
      body = (
        <div className="pointer-events-none absolute inset-0 flex items-center gap-1.5 px-2">
          <TypeIcon item={item} className="size-3 shrink-0 text-[color:var(--tl-c)]" />
          <span className="truncate text-xs font-medium text-foreground">
            {item.text.replace(/\s+/g, ' ').trim() || 'Text'}
          </span>
        </div>
      );
      break;
    case 'shape': {
      const I = SHAPE_ICON[item.shape];
      body = (
        <div className="pointer-events-none absolute inset-0 flex items-center gap-1.5 px-2">
          <I className="size-3 shrink-0 text-[color:var(--tl-c)]" />
          <span className="truncate text-xs font-medium text-foreground">
            {item.name ?? item.shape}
          </span>
        </div>
      );
      break;
    }
    case 'image':
      body = (
        <div className="pointer-events-none absolute inset-0 flex items-center gap-1.5 px-2 pt-3">
          <TypeIcon item={item} className="size-3.5 shrink-0 text-[color:var(--tl-c)]" />
        </div>
      );
      break;
  }

  const showLabel = item.type !== 'subtitle' && item.type !== 'text' && item.type !== 'shape';

  return (
    <div
      role="option"
      aria-selected={selected}
      aria-label={itemAriaLabel(item, asset, selected)}
      tabIndex={tabbable ? 0 : -1}
      data-item-id={item.id}
      data-track-id={trackId}
      data-type={item.type}
      data-overlay={overlay || undefined}
      data-sfx={trackKind === 'sfx' || undefined}
      data-selected={selected}
      data-locked={locked || undefined}
      data-start={item.startSec}
      className={cn('tl-item select-none')}
      style={{ left, width }}
    >
      {body}
      {showLabel ? (
        <ItemLabel item={item} asset={asset} locked={trackLocked} pxWidth={width} />
      ) : null}
      {fadeIn > 0 ? (
        <div className="tl-fade-in" style={{ width: Math.min(width / 2, fadeIn * pxPerSec) }} />
      ) : null}
      {fadeOut > 0 ? (
        <div className="tl-fade-out" style={{ width: Math.min(width / 2, fadeOut * pxPerSec) }} />
      ) : null}
      {item.groupId ? (
        <div
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-[3px]"
          style={{ background: `var(--tl-group-${groupColorIndex(item.groupId)})` }}
        />
      ) : null}
      {showKeyframes ? <KeyframeDiamonds item={item} pxPerSec={pxPerSec} /> : null}
      {(item.type === 'video' || item.type === 'image') && item.transitionIn ? (
        <TransitionGlyph item={item} pxPerSec={pxPerSec} />
      ) : null}
      {!locked ? (
        <>
          <div className="tl-trim" data-trim="start" data-edge="start" data-item-id={item.id} aria-hidden />
          <div className="tl-trim" data-trim="end" data-edge="end" data-item-id={item.id} aria-hidden />
        </>
      ) : null}
    </div>
  );
});
