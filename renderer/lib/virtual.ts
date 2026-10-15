/**
 * Minimal variable-height windowing maths (no dependency). A list of N rows has measured heights where known and an
 * estimate otherwise; `offsets[i]` is the top of row i and `offsets[N]` the total height.
 */
export function computeOffsets(
  count: number,
  heightOf: (i: number) => number | undefined,
  estimate: number,
): number[] {
  const offsets = new Array<number>(count + 1);
  let y = 0;
  for (let i = 0; i < count; i++) {
    offsets[i] = y;
    y += heightOf(i) ?? estimate;
  }
  offsets[count] = y;
  return offsets;
}

/** Largest i with offsets[i] <= y (binary search); clamps to [0, count-1]. */
export function indexAtOffset(offsets: readonly number[], y: number): number {
  const count = offsets.length - 1;
  if (count <= 0) return 0;
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((offsets[mid] ?? 0) <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function visibleRange(
  offsets: readonly number[],
  scrollTop: number,
  viewport: number,
  overscanPx = 600,
): { start: number; end: number } {
  const count = offsets.length - 1;
  if (count <= 0) return { start: 0, end: -1 };
  const start = indexAtOffset(offsets, Math.max(0, scrollTop - overscanPx));
  const end = indexAtOffset(offsets, scrollTop + viewport + overscanPx);
  return { start, end: Math.min(count - 1, end) };
}
