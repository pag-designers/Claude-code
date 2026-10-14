/**
 * Small LRU cache with an entry cap and an optional cost cap (bytes, pixels, …). Insertion order of a `Map` is the
 * recency order: the first key is the least recently used. `onEvict` runs for every removal (eviction, delete, clear)
 * so owners can free resources (ImageBitmap.close(), decoded AudioBuffers, …).
 */
export interface LruOptions<K, V> {
  maxEntries: number;
  /** Total cost cap; needs `cost`. The entry that was just set is never evicted by the cost cap. */
  maxCost?: number;
  cost?: (value: V) => number;
  onEvict?: (key: K, value: V) => void;
}

export class LruCache<K, V> {
  private readonly map = new Map<K, V>();
  private costSum = 0;

  constructor(private readonly opts: LruOptions<K, V>) {
    if (opts.maxEntries < 1) throw new Error('LruCache.maxEntries must be >= 1');
  }

  get size(): number {
    return this.map.size;
  }
  get totalCost(): number {
    return this.costSum;
  }

  /** Read and mark as most recently used. */
  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const v = this.map.get(key) as V;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  /** Read without touching recency. */
  peek(key: K): V | undefined {
    return this.map.get(key);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.remove(key, false);
    this.map.set(key, value);
    this.costSum += this.costOf(value);
    this.trim(key);
  }

  delete(key: K): boolean {
    if (!this.map.has(key)) return false;
    this.remove(key, true);
    return true;
  }

  clear(): void {
    for (const k of [...this.map.keys()]) this.remove(k, true);
  }

  /** Keys from least to most recently used. */
  keys(): K[] {
    return [...this.map.keys()];
  }

  /** Removes every entry whose key fails the predicate (project change housekeeping). */
  retain(keep: (key: K, value: V) => boolean): void {
    for (const [k, v] of [...this.map.entries()]) if (!keep(k, v)) this.remove(k, true);
  }

  private costOf(v: V): number {
    return this.opts.cost ? this.opts.cost(v) : 0;
  }

  private remove(key: K, notify: boolean): void {
    const v = this.map.get(key) as V;
    this.map.delete(key);
    this.costSum -= this.costOf(v);
    if (notify) this.opts.onEvict?.(key, v);
  }

  private trim(justSet: K): void {
    const { maxEntries, maxCost } = this.opts;
    while (this.map.size > maxEntries) this.evictOldest(justSet);
    if (maxCost !== undefined && this.opts.cost) {
      while (this.costSum > maxCost && this.map.size > 1) this.evictOldest(justSet);
    }
  }

  private evictOldest(protect: K): void {
    for (const k of this.map.keys()) {
      if (k === protect) continue;
      this.remove(k, true);
      return;
    }
  }
}
