/**
 * A tiny pub/sub for cross-section requests on the Brand Kit page ("Extract colors" from an asset's menu opens the
 * Colors section with that logo selected). No React state is shared on purpose: sections stay independent.
 */
type Handler = (assetId: string) => void;
const handlers = new Set<Handler>();

export function onExtractColorsRequest(h: Handler): () => void {
  handlers.add(h);
  return () => handlers.delete(h);
}

export function requestExtractColors(assetId: string): void {
  for (const h of [...handlers]) h(assetId);
}

/** Scrolls a section into view (used by "View" links in toasts and menus). */
export function goToSection(id: string): void {
  if (typeof document === 'undefined') return;
  const el = document.getElementById(id);
  if (!el) return;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  el.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
}
