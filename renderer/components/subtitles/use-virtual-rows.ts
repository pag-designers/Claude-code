'use client';

import * as React from 'react';
import { computeOffsets, visibleRange } from '@/lib/virtual';

/**
 * Variable-height windowing for long lists (thousands of cues). Rows report their measured height through `measure`
 * (a ref callback that observes the element); heights not measured yet use `estimate`. Absolute-position each rendered
 * row at `offsets[i]` inside a container that is `total` px tall.
 */
export function useVirtualRows(
  count: number,
  keyOf: (i: number) => string,
  estimate: number,
  overscanPx = 480,
) {
  // a state-backed callback ref: the scroller element is needed by effects and handlers, never read during render
  const [scroller, setScroller] = React.useState<HTMLDivElement | null>(null);
  const [heights, setHeights] = React.useState<Map<string, number>>(() => new Map());
  const [scrollTop, setScrollTop] = React.useState(0);
  const [viewport, setViewport] = React.useState(520);

  // heights are keyed by a stable row key (cue id), so splits and merges do not shift measurements onto the wrong rows
  const offsets = React.useMemo(
    () => computeOffsets(count, (i) => heights.get(keyOf(i)), estimate),
    [count, heights, estimate, keyOf],
  );
  const range = React.useMemo(
    () => visibleRange(offsets, scrollTop, viewport, overscanPx),
    [offsets, scrollTop, viewport, overscanPx],
  );

  const pending = React.useRef(new Map<string, number>());
  const raf = React.useRef<number | null>(null);
  const ro = React.useRef<ResizeObserver | null>(null);
  const getObserver = React.useCallback(() => {
    if (ro.current) return ro.current;
    const flush = () => {
      raf.current = null;
      const batch = pending.current;
      if (batch.size === 0) return;
      setHeights((prev) => {
        let changed = false;
        const next = new Map(prev);
        batch.forEach((h, key) => {
          if (Math.abs((prev.get(key) ?? -1) - h) > 0.5) {
            next.set(key, h);
            changed = true;
          }
        });
        batch.clear();
        return changed ? next : prev;
      });
    };
    ro.current = new ResizeObserver((entries) => {
      for (const e of entries) {
        const el = e.target as HTMLElement;
        const key = el.dataset.rowKey;
        const h = e.borderBoxSize?.[0]?.blockSize ?? el.getBoundingClientRect().height;
        if (key !== undefined) pending.current.set(key, h);
      }
      if (raf.current === null) raf.current = requestAnimationFrame(flush);
    });
    return ro.current;
  }, []);
  React.useEffect(
    () => () => {
      ro.current?.disconnect();
      ro.current = null;
      if (raf.current !== null) cancelAnimationFrame(raf.current);
    },
    [],
  );
  const measure = React.useCallback(
    (el: HTMLElement | null) => {
      if (!el) return;
      const o = getObserver();
      o.observe(el);
      return () => o.unobserve(el);
    },
    [getObserver],
  );

  React.useEffect(() => {
    const el = scroller;
    if (!el) return;
    const sync = () => setViewport(el.clientHeight);
    sync();
    const o = new ResizeObserver(sync);
    o.observe(el);
    return () => o.disconnect();
  }, [scroller]);

  const scrollToIndex = React.useCallback(
    (i: number, opts?: { mode?: 'center' | 'nearest'; smooth?: boolean }) => {
      const el = scroller;
      if (!el) return;
      const top = offsets[i] ?? 0;
      const bottom = offsets[i + 1] ?? top;
      if (
        opts?.mode === 'nearest' &&
        top >= el.scrollTop + 8 &&
        bottom <= el.scrollTop + viewport - 8
      )
        return;
      const target = Math.max(0, Math.min(top - viewport * 0.35, (offsets[count] ?? 0) - viewport));
      el.scrollTo({ top: target, behavior: opts?.smooth ? 'smooth' : 'auto' });
    },
    [scroller, offsets, viewport, count],
  );

  return {
    scrollerRef: setScroller,
    offsets,
    range,
    total: offsets[count] ?? 0,
    scrollTop,
    viewport,
    onScroll: (e: React.UIEvent<HTMLDivElement>) => setScrollTop(e.currentTarget.scrollTop),
    measure,
    scrollToIndex,
  };
}
