import {
  CalendarClock,
  Clapperboard,
  Cpu,
  HardDrive,
  Home,
  Info,
  Keyboard,
  Library,
  type LucideIcon,
  Palette,
  Plug,
  Settings,
  Store,
  Sun,
  DownloadCloud,
  Wallet,
  KeyRound,
  Wrench,
  Bell,
} from 'lucide-react';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  description: string;
}

export const NAV_ITEMS: NavItem[] = [
  { href: '/', label: 'Home', icon: Home, description: 'Paste a URL, see setup and running jobs' },
  {
    href: '/library/',
    label: 'Library',
    icon: Library,
    description: 'Videos, clips, favorites, exports',
  },
  { href: '/editor/', label: 'Editor', icon: Clapperboard, description: 'Multi-track editor' },
  {
    href: '/scheduler/',
    label: 'Scheduler',
    icon: CalendarClock,
    description: 'Calendar and posting queue',
  },
  {
    href: '/brand-kit/',
    label: 'Brand Kit',
    icon: Palette,
    description: 'Logos, fonts, caption styles',
  },
  { href: '/whop/', label: 'Whop', icon: Store, description: 'Campaigns, submissions, earnings' },
  { href: '/tools/', label: 'Tools', icon: Wrench, description: 'Every Clipfern tool' },
];

export const SETTINGS_ITEM: NavItem = {
  href: '/settings/general/',
  label: 'Settings',
  icon: Settings,
  description: 'Keys, storage, models, compute',
};

export const NOTIFICATIONS_ITEM: NavItem = {
  href: '/notifications/',
  label: 'Notifications',
  icon: Bell,
  description: 'Everything that happened',
};

export const ALL_NAV = [...NAV_ITEMS, SETTINGS_ITEM];

export interface SettingsSection {
  slug: string;
  label: string;
  icon: LucideIcon;
  description: string;
  keywords?: string[];
}

export const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    slug: 'general',
    label: 'General',
    icon: Sun,
    description: 'Theme and window',
    keywords: ['appearance', 'theme', 'dark', 'light'],
  },
  {
    slug: 'api-keys',
    label: 'API Keys',
    icon: KeyRound,
    description: 'Anthropic, Pexels, Pixabay, Whop',
    keywords: ['anthropic', 'claude', 'pexels', 'pixabay', 'whop', 'secret'],
  },
  {
    slug: 'storage',
    label: 'Storage',
    icon: HardDrive,
    description: 'Cloudflare R2 or Backblaze B2',
    keywords: ['r2', 'b2', 'bucket', 'cloud', 'cache'],
  },
  {
    slug: 'models',
    label: 'Models & Budget',
    icon: Wallet,
    description: 'Claude models, cost tracker',
    keywords: ['cost', 'spend', 'budget', 'sonnet', 'haiku'],
  },
  {
    slug: 'compute',
    label: 'Compute',
    icon: Cpu,
    description: 'GPU, Whisper, transcription engine',
    keywords: ['gpu', 'cpu', 'whisper', 'sidecar', 'transcription', 'hardware'],
  },
  {
    slug: 'ingest',
    label: 'Ingest',
    icon: DownloadCloud,
    description: 'Download quality and defaults',
    keywords: ['resolution', 'cookies', 'yt-dlp', 'preset'],
  },
  {
    slug: 'integrations',
    label: 'Integrations',
    icon: Plug,
    description: 'YouTube, Instagram, TikTok',
    keywords: ['oauth', 'youtube', 'instagram', 'tiktok', 'social'],
  },
  {
    slug: 'diagnostics',
    label: 'Diagnostics',
    icon: Info,
    description: 'Binaries, versions, logs',
    keywords: ['ffmpeg', 'yt-dlp', 'logs', 'version', 'debug'],
  },
  {
    slug: 'shortcuts',
    label: 'Shortcuts',
    icon: Keyboard,
    description: 'Keyboard reference',
    keywords: ['hotkeys', 'keys'],
  },
];

export const settingsHref = (slug: string) => `/settings/${slug}/`;

/** Title shown in the top bar for a pathname. */
export function titleForPath(pathname: string): { title: string; parent?: string } {
  const p = pathname.endsWith('/') ? pathname : `${pathname}/`;
  if (p === '/') return { title: 'Home' };
  if (p.startsWith('/settings/')) {
    const slug = p.split('/')[2];
    const s = SETTINGS_SECTIONS.find((x) => x.slug === slug);
    return { title: s?.label ?? 'Settings', parent: 'Settings' };
  }
  if (p.startsWith('/notifications')) return { title: 'Notifications' };
  if (p.startsWith('/design')) return { title: 'Design system' };
  const item = NAV_ITEMS.find((n) => n.href !== '/' && p.startsWith(n.href));
  return { title: item?.label ?? 'Clipfern' };
}

export function isActivePath(pathname: string, href: string): boolean {
  const p = pathname.endsWith('/') ? pathname : `${pathname}/`;
  if (href === '/') return p === '/';
  if (href.startsWith('/settings/')) return p.startsWith('/settings/');
  return p.startsWith(href);
}
