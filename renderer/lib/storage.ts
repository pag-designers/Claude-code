import type { StorageCategory, StorageUsage } from '@shared/domain';

/** Main may count a "GB" as 10^9 or 2^30 bytes; infer which from limitBytes / configured free tier. */
export function gbUnit(limitBytes: number, freeTierGb: number): number {
  if (limitBytes > 0 && freeTierGb > 0) {
    const u = limitBytes / freeTierGb;
    if (Math.abs(u - 1073741824) / 1073741824 < 0.01) return 1073741824;
  }
  return 1e9;
}

export const CATEGORY_META: { key: StorageCategory; label: string; hint: string; color: string }[] =
  [
    {
      key: 'videos',
      label: 'Videos',
      hint: '480p proxies of imported sources',
      color: 'var(--primary-text)',
    },
    {
      key: 'clips',
      label: 'Clips',
      hint: 'AI-found clips at delivery resolution',
      color: 'var(--info)',
    },
    { key: 'renders', label: 'Renders', hint: 'Exports from the editor', color: 'var(--success)' },
    {
      key: 'assets',
      label: 'Brand assets',
      hint: 'Logos, fonts, music, overlays',
      color: 'var(--warning)',
    },
    {
      key: 'thumbs',
      label: 'Thumbnails',
      hint: 'Cover frames and previews',
      color: 'var(--viral-text)',
    },
    { key: 'other', label: 'Other', hint: 'Everything else in the bucket', color: 'var(--subtle)' },
  ];

export function storageTone(u: StorageUsage | undefined): 'primary' | 'warning' | 'danger' {
  const f = u?.fraction ?? 0;
  return f >= 0.95 ? 'danger' : f >= 0.8 ? 'warning' : 'primary';
}

export function providerName(p: StorageUsage['provider'] | undefined): string {
  return p === 'b2' ? 'Backblaze B2' : 'Cloudflare R2';
}
