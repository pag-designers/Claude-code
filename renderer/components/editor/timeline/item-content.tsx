'use client';

import * as React from 'react';
import {
  Circle,
  Image as ImageIcon,
  Link2,
  Lock,
  Minus,
  MoveRight,
  RectangleHorizontal,
  Type,
  Gauge,
  Undo2,
  Video,
  Volume2,
  PanelLeftOpen,
} from 'lucide-react';
import type { Asset, Item, ShapeKind } from '@shared/editor';
import { useEditorStore } from '@/lib/editor/core';
import { cueText, itemLabel } from './geometry';
import { useTimelineUi } from './timeline-ui';

/* ------------------------------------------------------------------ small content pieces ----- */

export const SHAPE_ICON: Record<ShapeKind, React.ComponentType<{ className?: string }>> = {
  rect: RectangleHorizontal,
  ellipse: Circle,
  line: Minus,
  arrow: MoveRight,
  'progress-bar': PanelLeftOpen,
};

export function TypeIcon({ item, className }: { item: Item; className?: string }) {
  switch (item.type) {
    case 'video':
      return <Video className={className} aria-hidden />;
    case 'audio':
      return <Volume2 className={className} aria-hidden />;
    case 'image':
      return <ImageIcon className={className} aria-hidden />;
    case 'text':
      return <Type className={className} aria-hidden />;
    case 'subtitle':
      return <Type className={className} aria-hidden />;
    case 'shape': {
      const I = SHAPE_ICON[item.shape];
      return <I className={className} />;
    }
  }
}

/** Speed (and reverse) badges for media items. */
export function MediaBadges({ item }: { item: Item }) {
  if (item.type !== 'video' && item.type !== 'audio') return null;
  const ramp = item.speedCurve.length > 0;
  const speed = item.speed;
  return (
    <>
      {ramp || Math.abs(speed - 1) > 1e-6 ? (
        <span className="tl-chip inline-flex shrink-0 items-center gap-0.5 rounded-xs px-1 text-2xs font-semibold tabular-nums text-foreground">
          <Gauge className="size-2.5" aria-hidden />
          {ramp ? 'Ramp' : `${+speed.toFixed(2)}×`}
        </span>
      ) : null}
      {item.reverse ? (
        <span
          className="tl-chip inline-flex shrink-0 items-center rounded-xs px-1 text-foreground"
          title="Reversed"
        >
          <Undo2 className="size-2.5" aria-label="Reversed" />
        </span>
      ) : null}
    </>
  );
}

/** Label row on top of an item (icon, name, badges). */
export function ItemLabel({
  item,
  asset,
  locked,
  pxWidth,
}: {
  item: Item;
  asset: Asset | undefined;
  locked: boolean;
  pxWidth: number;
}) {
  if (pxWidth < 22) return null;
  const compact = pxWidth < 64;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-[3] flex items-center gap-1 overflow-hidden px-1.5 pt-0.5">
      <span className="tl-chip flex min-w-0 items-center gap-1 rounded-xs px-1 text-2xs font-medium leading-4 text-foreground">
        <span className="text-[color:var(--tl-c)]">
          <TypeIcon item={item} className="size-2.5 shrink-0" />
        </span>
        {compact ? null : <span className="truncate">{itemLabel(item, asset)}</span>}
      </span>
      {compact ? null : <MediaBadges item={item} />}
      {item.groupId ? (
        <Link2 className="size-2.5 shrink-0 text-foreground" aria-label="Grouped" />
      ) : null}
      {locked || item.locked ? (
        <Lock className="size-2.5 shrink-0 text-foreground" aria-label="Locked" />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ subtitle cue ------------- */

export function SubtitleContent({
  item,
  pxWidth,
}: {
  item: Extract<Item, { type: 'subtitle' }>;
  pxWidth: number;
}) {
  const editing = useTimelineUi((s) => s.editingCueId === item.id);
  const text = cueText(item);
  if (editing) return <CueEditor itemId={item.id} text={text} pxWidth={pxWidth} />;
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center px-2">
      <span className="truncate text-xs font-medium leading-4 text-foreground">{text || '…'}</span>
    </div>
  );
}

/** Inline caption editor (double-click a cue). Enter commits, Esc / blur-without-change cancels. */
function CueEditor({ itemId, text, pxWidth }: { itemId: string; text: string; pxWidth: number }) {
  const setUi = useTimelineUi((s) => s.set);
  const [draft, setDraft] = React.useState(text);
  const done = React.useRef(false);
  const commit = () => {
    if (done.current) return;
    done.current = true;
    const next = draft.trim();
    if (next && next !== text) useEditorStore.getState().setCueText(itemId, next);
    setUi({ editingCueId: null });
  };
  return (
    <input
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      data-no-drag
      aria-label="Caption text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          done.current = true;
          setUi({ editingCueId: null });
        }
      }}
      className="absolute inset-x-1 top-1/2 z-10 h-6 -translate-y-1/2 rounded-xs border border-ring bg-field px-1.5 text-xs text-foreground outline-none"
      style={{ minWidth: Math.min(180, Math.max(60, pxWidth)) }}
    />
  );
}
