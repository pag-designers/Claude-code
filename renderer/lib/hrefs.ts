/**
 * Deep-link helpers. The renderer is a static export with `trailingSlash: true`, so a link coming from main
 * (notification, tray, OS click) may arrive as `/library/video?id=x` or the legacy `/settings?section=storage`;
 * both are normalised here to the exported route shape before navigating.
 */
export function videoHref(id: string, tab?: string): string {
  const q = new URLSearchParams({ id });
  if (tab) q.set('tab', tab);
  return `/library/video/?${q.toString()}`;
}

export function libraryHref(tab?: 'videos' | 'clips' | 'favorites' | 'edited' | 'exported'): string {
  return tab ? `/library/?tab=${tab}` : '/library/';
}

export function normalizeHref(href: string): string {
  const raw = href.trim();
  if (!raw.startsWith('/')) return raw;
  const hashAt = raw.indexOf('#');
  const hash = hashAt >= 0 ? raw.slice(hashAt) : '';
  const noHash = hashAt >= 0 ? raw.slice(0, hashAt) : raw;
  const qAt = noHash.indexOf('?');
  let path = qAt >= 0 ? noHash.slice(0, qAt) : noHash;
  let query = qAt >= 0 ? noHash.slice(qAt) : '';
  // legacy: /settings?section=storage -> /settings/storage/
  if (path === '/settings' || path === '/settings/') {
    const section = new URLSearchParams(query).get('section');
    if (section && /^[a-z-]+$/.test(section)) {
      path = `/settings/${section}/`;
      query = '';
    }
  }
  if (!path.endsWith('/')) path += '/';
  return `${path}${query}${hash}`;
}
