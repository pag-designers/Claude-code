/**
 * Pure logic of the stock B-roll dialog (no React): provider facts, result merging, grid geometry, keyboard
 * navigation, import-queue bookkeeping. Unit-tested in test/unit/broll-ui.test.ts.
 */
import type { BrollItem, BrollProvider } from '@shared/brand';

export type Orientation = 'any' | 'portrait' | 'landscape' | 'square';

export const ORIENTATIONS: { value: Orientation; label: string }[] = [
  { value: 'portrait', label: 'Portrait' },
  { value: 'landscape', label: 'Landscape' },
  { value: 'square', label: 'Square' },
  { value: 'any', label: 'Any' },
];

export const PROVIDERS: BrollProvider[] = ['pexels', 'pixabay'];

export interface ProviderInfo {
  name: string;
  /** Home page, used for the attribution link their terms require. */
  homeUrl: string;
  /** Where a free key is created. */
  keyUrl: string;
  /** The attribution sentence shown next to the results. */
  attribution: string;
}

export const PROVIDER_INFO: Record<BrollProvider, ProviderInfo> = {
  pexels: {
    name: 'Pexels',
    homeUrl: 'https://www.pexels.com',
    keyUrl: 'https://www.pexels.com/api/',
    attribution: 'Videos provided by',
  },
  pixabay: {
    name: 'Pixabay',
    homeUrl: 'https://pixabay.com',
    keyUrl: 'https://pixabay.com/api/docs/',
    attribution: 'Videos from',
  },
};

export const SETTINGS_API_KEYS_HREF = '/settings/api-keys/';

/** Appends pages in order and drops repeated ids (a provider may repeat a clip across pages). */
export function mergePages(pages: { items: BrollItem[] }[]): BrollItem[] {
  const seen = new Set<string>();
  const out: BrollItem[] = [];
  for (const p of pages)
    for (const it of p.items) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      out.push(it);
    }
  return out;
}

/** Thumbnail shape and minimum column width for the result grid, per orientation filter. */
export function gridSpec(o: Orientation): { aspect: string; minCol: number } {
  switch (o) {
    case 'portrait':
      return { aspect: '9 / 16', minCol: 148 };
    case 'landscape':
      return { aspect: '16 / 9', minCol: 236 };
    case 'square':
      return { aspect: '1 / 1', minCol: 188 };
    default:
      return { aspect: '4 / 5', minCol: 176 };
  }
}

export function shapeLabel(w: number, h: number): 'Portrait' | 'Landscape' | 'Square' {
  const r = w / h;
  return r < 0.9 ? 'Portrait' : r > 1.1 ? 'Landscape' : 'Square';
}

/** "0:14", "1:05", "12:03" (stock clips are short; hours are not expected). */
export function clipDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export const dimensionsLabel = (it: Pick<BrollItem, 'width' | 'height'>) =>
  `${it.width}×${it.height}`;

/**
 * Next focused index for a key press in a grid of `count` cells and `cols` columns, or null when the key does not
 * move focus (or the move would leave the grid).
 */
export function gridNavigate(
  key: string,
  index: number,
  cols: number,
  count: number,
): number | null {
  if (count <= 0) return null;
  const c = Math.max(1, cols);
  let next: number;
  switch (key) {
    case 'ArrowRight':
      next = index + 1;
      break;
    case 'ArrowLeft':
      next = index - 1;
      break;
    case 'ArrowDown':
      next = index + c;
      // below the last full row: land on the final cell when the row exists but the column does not
      if (next >= count && Math.floor(index / c) < Math.floor((count - 1) / c)) next = count - 1;
      break;
    case 'ArrowUp':
      next = index - c;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = count - 1;
      break;
    default:
      return null;
  }
  if (next < 0 || next >= count || next === index) return null;
  return next;
}

/** Columns of a rendered grid, read from the cells' vertical positions (cells wrap, so the first row is the answer). */
export function columnsFromOffsets(offsetTops: number[]): number {
  if (offsetTops.length === 0) return 1;
  const first = offsetTops[0]!;
  let n = 0;
  for (const t of offsetTops) {
    if (Math.abs(t - first) > 2) break;
    n += 1;
  }
  return Math.max(1, n);
}

export type ImportState =
  { status: 'busy' } | { status: 'done' } | { status: 'error'; message: string };

export function importSummary(done: number, failed: number, skipped = 0): string {
  const clips = (n: number) => `${n} clip${n === 1 ? '' : 's'}`;
  const parts = [`Added ${clips(done)}`];
  if (failed > 0) parts.push(`${failed} failed`);
  if (skipped > 0) parts.push(`${skipped} not started`);
  return parts.join(' · ');
}

/** The text sent to `broll:suggest`: the passage when there is one, else the query when it reads like a description. */
export function suggestSource(suggestFrom: string | undefined, query: string): string | null {
  const from = suggestFrom?.trim();
  if (from) return from.slice(0, 2000);
  const q = query.trim();
  return q.length >= 3 ? q : null;
}
