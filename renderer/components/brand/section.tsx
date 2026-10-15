'use client';

import * as React from 'react';
import {
  AudioLines,
  Film,
  ImageIcon,
  Layers,
  Music2,
  Palette,
  Quote,
  Sliders,
  Stamp,
  Subtitles,
  Type,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SectionDef {
  id: string;
  label: string;
  /** Shorter text for the side navigation. */
  nav: string;
  icon: LucideIcon;
  group: 'Assets' | 'Style' | 'Branding' | 'Defaults';
}

/** Order = page order = navigation order. */
export const SECTIONS: readonly SectionDef[] = [
  { id: 'logos', label: 'Logos / Watermarks', nav: 'Logos', icon: Stamp, group: 'Assets' },
  { id: 'images', label: 'Images', nav: 'Images', icon: ImageIcon, group: 'Assets' },
  { id: 'videos', label: 'Videos', nav: 'Videos', icon: Film, group: 'Assets' },
  { id: 'audio', label: 'Audio', nav: 'Audio', icon: AudioLines, group: 'Assets' },
  { id: 'fonts', label: 'Fonts', nav: 'Fonts', icon: Type, group: 'Assets' },
  { id: 'colors', label: 'Colors', nav: 'Colors', icon: Palette, group: 'Style' },
  {
    id: 'subtitle-styles',
    label: 'Subtitle Styles',
    nav: 'Subtitle styles',
    icon: Subtitles,
    group: 'Style',
  },
  { id: 'text-styles', label: 'Text Styles', nav: 'Text styles', icon: Type, group: 'Style' },
  { id: 'hook', label: 'Hook card', nav: 'Hook card', icon: Quote, group: 'Style' },
  { id: 'watermark', label: 'Watermark', nav: 'Watermark', icon: Layers, group: 'Branding' },
  {
    id: 'intro-outro',
    label: 'Intro / Outro',
    nav: 'Intro / Outro',
    icon: Film,
    group: 'Branding',
  },
  { id: 'music', label: 'Music bed', nav: 'Music bed', icon: Music2, group: 'Branding' },
  { id: 'defaults', label: 'Defaults', nav: 'Defaults', icon: Sliders, group: 'Defaults' },
];

export const sectionDef = (id: string): SectionDef => SECTIONS.find((s) => s.id === id)!;

/** A section card. `id` is the scroll target of the side navigation. */
export function Section({
  id,
  title,
  description,
  actions,
  badge,
  children,
  className,
}: {
  id: string;
  title?: string;
  description: React.ReactNode;
  actions?: React.ReactNode;
  badge?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const def = sectionDef(id);
  const Icon = def.icon;
  const heading = `brand-sec-${id}`;
  return (
    <section
      id={id}
      aria-labelledby={heading}
      data-testid={`section-${id}`}
      className={cn(
        'scroll-mt-28 rounded-xl border bg-card text-foreground shadow-xs @container',
        className,
      )}
    >
      <header className="flex flex-wrap items-start gap-x-3 gap-y-2 px-5 pt-5">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary-text">
          <Icon className="size-[18px]" aria-hidden />
        </span>
        <div className="min-w-0 flex-[1_1_20rem]">
          <h2
            tabIndex={-1}
            className="flex items-center gap-2 font-display text-lg font-semibold outline-none"
          >
            <span id={heading}>{title ?? def.label}</span>
            {badge}
          </h2>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </header>
      <div className="flex flex-col gap-5 px-5 pb-5 pt-4">{children}</div>
    </section>
  );
}

/** Scroll-spy side navigation (a horizontal strip below 1100 px). */
export function SectionNav({
  counts,
  scrollRoot,
}: {
  counts: Partial<Record<string, number>>;
  scrollRoot: () => HTMLElement | null;
}) {
  const [active, setActive] = React.useState<string>(SECTIONS[0]!.id);
  const locked = React.useRef(false);

  React.useEffect(() => {
    const root = scrollRoot();
    if (!root || typeof IntersectionObserver === 'undefined') return;
    const visible = new Map<string, number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.set(e.target.id, e.boundingClientRect.top);
          else visible.delete(e.target.id);
        }
        if (locked.current || visible.size === 0) return;
        // the section nearest to the top of the viewport wins
        const first = SECTIONS.find((s) => visible.has(s.id));
        if (first) setActive(first.id);
      },
      { root, rootMargin: '-96px 0px -55% 0px', threshold: 0 },
    );
    for (const s of SECTIONS) {
      const el = document.getElementById(s.id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, [scrollRoot]);

  const go = (id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    setActive(id);
    locked.current = true;
    window.setTimeout(() => {
      locked.current = false;
    }, 700);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    el.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
  };

  const groups = ['Assets', 'Style', 'Branding', 'Defaults'] as const;
  return (
    <nav aria-label="Brand Kit sections" data-testid="section-nav" className="min-w-0">
      <ul className="flex flex-col gap-4 max-[1100px]:flex-row max-[1100px]:gap-1 max-[1100px]:overflow-x-auto max-[1100px]:pb-1 scrollbar-thin">
        {groups.map((g) => (
          <li key={g} className="max-[1100px]:contents">
            <p className="mb-1 px-2.5 text-2xs font-semibold uppercase tracking-wider text-subtle max-[1100px]:hidden">
              {g}
            </p>
            <ul className="flex flex-col gap-0.5 max-[1100px]:contents">
              {SECTIONS.filter((s) => s.group === g).map((s) => {
                const on = active === s.id;
                const n = counts[s.id];
                return (
                  <li key={s.id} className="max-[1100px]:shrink-0">
                    <button
                      type="button"
                      onClick={() => go(s.id)}
                      aria-current={on ? 'true' : undefined}
                      className={cn(
                        'group relative flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm font-medium transition-colors duration-(--duration-fast)',
                        'max-[1100px]:whitespace-nowrap max-[1100px]:rounded-full max-[1100px]:border max-[1100px]:px-3',
                        on
                          ? 'bg-primary-soft text-primary-text max-[1100px]:border-primary/50'
                          : 'text-muted-foreground hover:bg-accent hover:text-foreground max-[1100px]:border-border-strong',
                      )}
                    >
                      <s.icon className="size-4 shrink-0 max-[1100px]:hidden" aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{s.nav}</span>
                      {n ? (
                        <span
                          className={cn(
                            'rounded-full px-1.5 text-2xs font-semibold tabular-nums',
                            on ? 'text-primary-text' : 'text-subtle',
                          )}
                        >
                          {n}
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
    </nav>
  );
}
