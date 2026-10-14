'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { gridWindow } from '@/lib/brand/helpers';

/**
 * A grid of fixed-height cards that stays cheap with hundreds of items: up to `threshold` items it is a plain CSS grid;
 * beyond that it gets its own scroll area and only the visible rows (plus overscan) are mounted.
 */
export function VirtualGrid<T extends { id: string }>({
  items,
  minItemWidth,
  rowHeight,
  gap = 12,
  threshold = 30,
  maxHeight = 480,
  label,
  render,
  className,
}: {
  items: readonly T[];
  minItemWidth: number;
  rowHeight: number;
  gap?: number;
  threshold?: number;
  maxHeight?: number;
  label: string;
  render: (item: T, index: number) => React.ReactNode;
  className?: string;
}) {
  const virtual = items.length > threshold;
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = React.useState(0);
  const [scrollTop, setScrollTop] = React.useState(0);
  const [viewport, setViewport] = React.useState(maxHeight);

  React.useEffect(() => {
    const el = ref.current;
    if (!el || !virtual) return;
    const ro = new ResizeObserver(() => {
      setWidth(el.clientWidth);
      setViewport(el.clientHeight);
    });
    ro.observe(el);
    setWidth(el.clientWidth);
    setViewport(el.clientHeight);
    return () => ro.disconnect();
  }, [virtual]);

  // rAF-throttled scroll position
  const raf = React.useRef(0);
  const onScroll = React.useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const top = e.currentTarget.scrollTop;
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => setScrollTop(top));
  }, []);
  React.useEffect(() => () => cancelAnimationFrame(raf.current), []);

  if (!virtual) {
    return (
      <div
        role="list"
        aria-label={label}
        className={cn('grid', className)}
        style={{
          gridTemplateColumns: `repeat(auto-fill, minmax(${minItemWidth}px, 1fr))`,
          gridAutoRows: rowHeight,
          gap,
        }}
      >
        {items.map((it, i) => (
          <div key={it.id} role="listitem" className="min-w-0">
            {render(it, i)}
          </div>
        ))}
      </div>
    );
  }

  const w = gridWindow({
    count: items.length,
    width: width || 800,
    minItemWidth,
    gap,
    rowHeight,
    scrollTop,
    viewport,
  });
  const slice = items.slice(w.startIndex, w.endIndex + 1);
  return (
    <div
      ref={ref}
      data-testid="virtual-grid"
      data-rendered={slice.length}
      data-total={items.length}
      onScroll={onScroll}
      tabIndex={0}
      aria-label={`${label} (${items.length})`}
      className={cn(
        'scrollbar-thin overflow-y-auto rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
      style={{ maxHeight }}
    >
      <div style={{ height: w.totalHeight, position: 'relative' }}>
        <div
          role="list"
          aria-label={label}
          aria-rowcount={w.rows}
          className="absolute inset-x-0 top-0 grid"
          style={{
            transform: `translateY(${w.offsetTop}px)`,
            gridTemplateColumns: `repeat(${w.cols}, minmax(0, 1fr))`,
            gridAutoRows: rowHeight,
            gap,
          }}
        >
          {slice.map((it, i) => (
            <div
              key={it.id}
              role="listitem"
              aria-posinset={w.startIndex + i + 1}
              aria-setsize={items.length}
              className="min-w-0"
            >
              {render(it, w.startIndex + i)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
