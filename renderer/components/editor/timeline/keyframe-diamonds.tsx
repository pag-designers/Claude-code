'use client';

import * as React from 'react';
import type { Item } from '@shared/editor';
import { useEditorStore } from '@/lib/editor/core';
import { collectKeyframes, groupKeyframes } from './geometry';
import { useTimelineUi } from './timeline-ui';

const MAX_SELECTED_FOR_KEYFRAMES = 6;

/** Diamonds for the keyframes of a selected item. Click selects, dragging (handled by the gesture controller) retimes. */
export function KeyframeDiamonds({ item, pxPerSec }: { item: Item; pxPerSec: number }) {
  const drag = useTimelineUi((s) => (s.kfDrag?.itemId === item.id ? s.kfDrag : null));
  const selKf = useEditorStore((s) =>
    s.selection.keyframe?.itemId === item.id ? s.selection.keyframe : null,
  );
  const groups = React.useMemo(() => groupKeyframes(collectKeyframes(item)), [item]);
  if (groups.length === 0) return null;
  return (
    <>
      {groups.map((g) => {
        const first = g[0];
        if (!first) return null;
        const dragged = drag && g.some((e) => e.path === drag.path && e.index === drag.index);
        const t = dragged && drag ? drag.t : first.t;
        const selected = !!selKf && g.some((e) => e.path === selKf.prop && e.index === selKf.index);
        const label = g.map((e) => e.path).join(', ');
        return (
          <button
            key={`${first.path}:${first.index}`}
            type="button"
            tabIndex={-1}
            data-kf
            data-item-id={item.id}
            data-path={first.path}
            data-index={first.index}
            data-t={first.t}
            data-selected={selected || undefined}
            aria-label={`Keyframe at ${t.toFixed(2)} seconds: ${label}`}
            title={`${label} @ ${t.toFixed(2)}s`}
            className="tl-kf app-no-drag"
            style={{ left: t * pxPerSec }}
          />
        );
      })}
    </>
  );
}

export { MAX_SELECTED_FOR_KEYFRAMES };
