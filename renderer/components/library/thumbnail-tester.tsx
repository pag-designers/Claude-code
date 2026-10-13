'use client';

import * as React from 'react';
import {
  Bookmark,
  ChevronLeft,
  Clapperboard,
  Compass,
  Grid3x3,
  Home,
  Lock,
  MessageCircle,
  MoreHorizontal,
  Play,
  Plus,
  Search,
  ThumbsUp,
  User,
  Users,
  Video,
  Wifi,
} from 'lucide-react';
import { Segmented } from '@/components/ui/segmented';
import { cn } from '@/lib/utils';

/**
 * Thumbnail Tester (BRIEF §4.12): the thumbnail inside three feed mockups side by side, plus a "small size" row.
 * The chrome is generic on purpose (no logos, neutral glyphs). Every colour is a token: the phone chrome uses the
 * `black` / `white` tokens at different opacities. View counts and neighbouring tiles are labelled placeholders.
 */

export interface TesterSource {
  src: string | null;
  /** Overlay text drawn over the frame with CSS (live preview of what `thumbs:choose` will burn in). */
  overlay: string | null;
  label: string;
}

type Chrome = 'dark' | 'light';

interface Tone {
  screen: string;
  fg: string;
  mute: string;
  line: string;
  tile: string;
  chip: string;
  /** Active-chip colours: the screen colour on the foreground colour. */
  invert: string;
}
const TONES: Record<Chrome, Tone> = {
  dark: {
    screen: 'bg-black',
    fg: 'text-white',
    mute: 'text-white/60',
    line: 'border-white/15',
    tile: 'bg-white/10',
    chip: 'bg-white/15',
    invert: 'bg-white text-black',
  },
  light: {
    screen: 'bg-white',
    fg: 'text-black',
    mute: 'text-black/55',
    line: 'border-black/10',
    tile: 'bg-black/8',
    chip: 'bg-black/8',
    invert: 'bg-black text-white',
  },
};

/** Natural (zoom = 1) phone screen width in CSS px. Everything inside is laid out at this size, then `zoom`ed. */
const PHONE_W = 264;
const SCREEN_H = 452;
const GAP = 16;

/* ---------------------------------------------------------------------------------------------- tile */

/** A feed tile showing `source`; the overlay text scales with the tile via container query units. */
function Frame({
  source,
  className,
  ratio,
  children,
  testId,
}: {
  source: TesterSource;
  className?: string;
  ratio: string;
  children?: React.ReactNode;
  testId?: string;
}) {
  return (
    <div
      className={cn('@container relative overflow-hidden bg-muted', className)}
      style={{ aspectRatio: ratio }}
      data-testid={testId}
    >
      {source.src ? (
        <img
          src={source.src}
          alt=""
          draggable={false}
          className="absolute inset-0 size-full object-cover"
        />
      ) : null}
      {source.overlay ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-[6%] bottom-[22%] text-center font-display text-[10cqw] font-extrabold uppercase leading-[1.05] text-white [text-shadow:0_0_0.12em_#000,0_0.05em_0.1em_#000]"
        >
          {source.overlay}
        </span>
      ) : null}
      {children}
    </div>
  );
}

function Pill({ tone, className }: { tone: Tone; className?: string }) {
  return <span aria-hidden className={cn('block h-2 rounded-full', tone.chip, className)} />;
}

function StatusBar({ tone }: { tone: Tone }) {
  return (
    <div
      className={cn(
        'flex h-[22px] items-center justify-between px-4 text-[9px] font-semibold',
        tone.fg,
      )}
    >
      <span className="tabular-nums">9:41</span>
      <span aria-hidden className="flex items-center gap-1">
        <Wifi className="size-2.5" />
        <span className="block h-1.5 w-3.5 rounded-[2px] border border-current" />
      </span>
    </div>
  );
}

function Phone({
  tone,
  title,
  children,
  zoom,
  testId,
}: {
  tone: Tone;
  title: string;
  children: React.ReactNode;
  zoom: number;
  testId: string;
}) {
  return (
    <figure className="flex shrink-0 flex-col items-center gap-2" data-testid={testId}>
      <div
        className="rounded-[26px] border border-border-strong bg-muted p-[5px] shadow-md"
        style={{ zoom }}
      >
        <div
          className={cn('relative overflow-hidden rounded-[21px]', tone.screen, tone.fg)}
          style={{ width: PHONE_W, height: SCREEN_H }}
        >
          <span
            aria-hidden
            className="absolute left-1/2 top-[5px] z-10 h-[7px] w-14 -translate-x-1/2 rounded-full bg-black"
          />
          {children}
        </div>
      </div>
      <figcaption className="text-xs font-medium text-muted-foreground">{title}</figcaption>
    </figure>
  );
}

function BottomNav({ tone, icons }: { tone: Tone; icons: React.ReactNode[] }) {
  return (
    <div
      className={cn(
        'absolute inset-x-0 bottom-0 z-10 flex h-11 items-start justify-around border-t pt-2.5',
        tone.screen,
        tone.line,
        tone.fg,
      )}
      aria-hidden
    >
      {icons.map((ic, i) => (
        <span key={i} className="[&_svg]:size-[18px]">
          {ic}
        </span>
      ))}
    </div>
  );
}

const PLACEHOLDER_VIEWS = ['3.1K', '918', '27K', '5.4K', '12K', '640'];

/* --------------------------------------------------------------------------------- TikTok-style profile */

function GridTile({
  source,
  tone,
  ratio,
  views,
  badge,
  glyph,
  testId,
}: {
  source: TesterSource | null;
  tone: Tone;
  ratio: string;
  views: string;
  badge?: string;
  glyph?: React.ReactNode;
  testId?: string;
}) {
  const inner = (
    <>
      <span className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/60 to-transparent" />
      <span className="absolute bottom-1 left-1.5 flex items-center gap-0.5 text-[9px] font-semibold text-white">
        <Play className="size-2.5 fill-current" aria-hidden />
        {views}
      </span>
      {badge ? (
        <span className="absolute left-1 top-1 rounded-[3px] bg-black/60 px-1 text-[8px] font-bold text-white">
          {badge}
        </span>
      ) : null}
      {glyph ? (
        <span className="absolute right-1 top-1 text-white [&_svg]:size-3">{glyph}</span>
      ) : null}
    </>
  );
  if (!source) return <div className={cn(tone.tile)} style={{ aspectRatio: ratio }} aria-hidden />;
  return (
    <Frame source={source} ratio={ratio} testId={testId}>
      {inner}
    </Frame>
  );
}

function TikTokMock({
  a,
  b,
  tone,
  zoom,
}: {
  a: TesterSource;
  b: TesterSource | null;
  tone: Tone;
  zoom: number;
}) {
  const ratio = '3 / 4';
  const tiles: (TesterSource | null)[] = [a, b, null, null, null, null];
  return (
    <Phone tone={tone} title="TikTok · profile grid" zoom={zoom} testId="tester-tiktok">
      <StatusBar tone={tone} />
      <div className="flex items-center justify-between px-3 py-1.5">
        <ChevronLeft className="size-4" aria-hidden />
        <span className="text-[11px] font-bold">@yourchannel</span>
        <MoreHorizontal className="size-4" aria-hidden />
      </div>
      <div className="flex flex-col items-center gap-1.5 pb-2">
        <span className={cn('size-12 rounded-full', tone.tile)} aria-hidden />
        <Pill tone={tone} className="w-20" />
        <div className="mt-0.5 flex gap-5">
          {[0, 1, 2].map((i) => (
            <span key={i} className="flex flex-col items-center gap-1" aria-hidden>
              <Pill tone={tone} className="h-2.5 w-6" />
              <Pill tone={tone} className="h-1.5 w-8" />
            </span>
          ))}
        </div>
      </div>
      <div className={cn('flex justify-around border-b', tone.line)} aria-hidden>
        <span className={cn('border-b-2 border-current px-5 pb-1.5 pt-1')}>
          <Grid3x3 className="size-4" />
        </span>
        <span className={cn('px-5 pb-1.5 pt-1', tone.mute)}>
          <Lock className="size-4" />
        </span>
        <span className={cn('px-5 pb-1.5 pt-1', tone.mute)}>
          <Bookmark className="size-4" />
        </span>
      </div>
      <div className="grid grid-cols-3 gap-px pt-px">
        {tiles.map((s, i) => (
          <GridTile
            key={i}
            source={s}
            tone={tone}
            ratio={ratio}
            views={PLACEHOLDER_VIEWS[i] ?? '1K'}
            badge={i === 0 && !b ? 'Pinned' : undefined}
            testId={
              i === 0 ? 'tester-tile-a-tiktok' : i === 1 && b ? 'tester-tile-b-tiktok' : undefined
            }
          />
        ))}
      </div>
      <BottomNav
        tone={tone}
        icons={[
          <Home key="h" />,
          <Users key="u" />,
          <Plus key="p" />,
          <MessageCircle key="m" />,
          <User key="a" />,
        ]}
      />
    </Phone>
  );
}

/* ----------------------------------------------------------------------------- Instagram-style reels tab */

function ReelsMock({
  a,
  b,
  tone,
  zoom,
}: {
  a: TesterSource;
  b: TesterSource | null;
  tone: Tone;
  zoom: number;
}) {
  const ratio = '9 / 16';
  const tiles: (TesterSource | null)[] = [a, b, null, null, null, null];
  return (
    <Phone tone={tone} title="Reels · profile Reels tab" zoom={zoom} testId="tester-reels">
      <StatusBar tone={tone} />
      <div className="flex items-center justify-between px-3 py-1.5">
        <span className="text-[11px] font-bold">yourchannel</span>
        <Plus className="size-4" aria-hidden />
      </div>
      <div className="flex items-center gap-4 px-3 pb-2" aria-hidden>
        <span className={cn('size-12 shrink-0 rounded-full', tone.tile)} />
        <div className="flex flex-1 justify-around">
          {[0, 1, 2].map((i) => (
            <span key={i} className="flex flex-col items-center gap-1">
              <Pill tone={tone} className="h-2.5 w-6" />
              <Pill tone={tone} className="h-1.5 w-8" />
            </span>
          ))}
        </div>
      </div>
      <div className={cn('flex justify-around border-b', tone.line)} aria-hidden>
        <span className={cn('px-5 pb-1.5 pt-1', tone.mute)}>
          <Grid3x3 className="size-4" />
        </span>
        <span className="border-b-2 border-current px-5 pb-1.5 pt-1">
          <Clapperboard className="size-4" />
        </span>
        <span className={cn('px-5 pb-1.5 pt-1', tone.mute)}>
          <User className="size-4" />
        </span>
      </div>
      <div className="grid grid-cols-3 gap-px pt-px">
        {tiles.map((s, i) => (
          <GridTile
            key={i}
            source={s}
            tone={tone}
            ratio={ratio}
            views={PLACEHOLDER_VIEWS[(i + 2) % 6] ?? '1K'}
            glyph={<Clapperboard />}
            testId={
              i === 0 ? 'tester-tile-a-reels' : i === 1 && b ? 'tester-tile-b-reels' : undefined
            }
          />
        ))}
      </div>
      <BottomNav
        tone={tone}
        icons={[
          <Home key="h" />,
          <Search key="s" />,
          <Plus key="p" />,
          <Clapperboard key="c" />,
          <User key="a" />,
        ]}
      />
    </Phone>
  );
}

/* ---------------------------------------------------------------------------- YouTube-style Shorts shelf */

function ShortsMock({
  a,
  b,
  tone,
  zoom,
  title,
}: {
  a: TesterSource;
  b: TesterSource | null;
  tone: Tone;
  zoom: number;
  title: string;
}) {
  const cards: { s: TesterSource | null; key: string }[] = [
    { s: a, key: 'a' },
    { s: b, key: 'b' },
    { s: null, key: 'c' },
  ];
  if (!b) cards.splice(1, 0, { s: null, key: 'n' });
  return (
    <Phone tone={tone} title="Shorts · shelf on Home" zoom={zoom} testId="tester-shorts">
      <StatusBar tone={tone} />
      <div className="flex items-center justify-between px-3 py-1.5" aria-hidden>
        <span className="flex items-center gap-1 text-[11px] font-bold">
          <Video className="size-4" /> Home
        </span>
        <Search className="size-4" />
      </div>
      <div className="flex gap-1.5 overflow-hidden px-3 pb-2" aria-hidden>
        {['All', 'New', 'Live', 'Music'].map((c, i) => (
          <span
            key={c}
            className={cn(
              'rounded-md px-2 py-0.5 text-[9px] font-semibold',
              i === 0 ? tone.invert : tone.chip,
            )}
          >
            {c}
          </span>
        ))}
      </div>
      <div className="flex items-center gap-1.5 px-3 pb-1.5 text-[11px] font-bold">
        <Clapperboard className="size-3.5" aria-hidden /> Shorts
      </div>
      <div className="flex gap-1.5 overflow-hidden pl-3">
        {cards.map(({ s, key }) => (
          <div key={key} className="w-[112px] shrink-0">
            {s ? (
              <Frame
                source={s}
                ratio="9 / 16"
                className="rounded-lg"
                testId={key === 'a' ? 'tester-tile-a-shorts' : 'tester-tile-b-shorts'}
              >
                <MoreHorizontal
                  className="absolute right-1 top-1 size-3.5 text-white"
                  aria-hidden
                />
              </Frame>
            ) : (
              <div
                className={cn('rounded-lg', tone.tile)}
                style={{ aspectRatio: '9 / 16' }}
                aria-hidden
              />
            )}
            {s ? (
              <div className="mt-1">
                <p className="line-clamp-2 text-[10px] font-semibold leading-[13px]">
                  {title || s.label}
                </p>
                <p className={cn('mt-0.5 text-[9px]', tone.mute)}>
                  {key === 'b' ? '8.2K' : '12K'} views
                </p>
              </div>
            ) : (
              <div className="mt-1 space-y-1" aria-hidden>
                <Pill tone={tone} className="h-1.5 w-full" />
                <Pill tone={tone} className="h-1.5 w-2/3" />
              </div>
            )}
          </div>
        ))}
      </div>
      <BottomNav
        tone={tone}
        icons={[
          <Home key="h" />,
          <Clapperboard key="c" />,
          <Plus key="p" />,
          <Compass key="o" />,
          <ThumbsUp key="t" />,
        ]}
      />
    </Phone>
  );
}

/* ----------------------------------------------------------------------------------------- small sizes */

function SmallSizes({ sources, tone }: { sources: TesterSource[]; tone: Tone }) {
  const specs = [
    { id: 'tiktok', label: 'TikTok 3:4', ratio: '3 / 4' },
    { id: 'reels', label: 'Reels 9:16', ratio: '9 / 16' },
    { id: 'shorts', label: 'Shorts 9:16', ratio: '9 / 16' },
  ];
  return (
    <div className="flex flex-col gap-3" data-testid="tester-small">
      <div className="flex items-baseline justify-between gap-3">
        <h4 className="text-sm font-semibold">Small size</h4>
        <p className="text-xs text-muted-foreground">
          How it reads at 80 px wide, the size of a tile in a crowded grid.
        </p>
      </div>
      <div
        className={cn(
          'flex flex-wrap items-end gap-x-6 gap-y-4 rounded-xl border p-4',
          tone.screen,
          tone.line,
        )}
      >
        {sources.map((s, si) => (
          <div key={si} className="flex flex-wrap items-end gap-3">
            {specs.map((sp) => (
              <figure key={sp.id} className="flex flex-col items-center gap-1.5">
                <Frame
                  source={s}
                  ratio={sp.ratio}
                  className="w-20 rounded-md"
                  testId={`tester-small-${sp.id}${sources.length > 1 ? (si === 0 ? '-a' : '-b') : ''}`}
                />
                <figcaption className={cn('text-2xs', tone.mute)}>
                  {sources.length > 1 ? `${si === 0 ? 'A' : 'B'} · ` : ''}
                  {sp.label}
                </figcaption>
              </figure>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------- tester */

export function ThumbnailTester({
  a,
  b,
  clipTitle,
  maxZoom = 0.95,
  hideSmall,
  actions,
}: {
  a: TesterSource;
  /** Second candidate for A/B: it sits next to A in every mockup, the way two posts sit next to each other. */
  b?: TesterSource | null;
  clipTitle: string;
  maxZoom?: number;
  hideSmall?: boolean;
  /** Extra controls pinned to the toolbar (the tab puts "Full size" here). */
  actions?: React.ReactNode;
}) {
  const [chrome, setChrome] = React.useState<Chrome>('dark');
  const host = React.useRef<HTMLDivElement | null>(null);
  const [zoom, setZoom] = React.useState(0.62);
  React.useEffect(() => {
    const el = host.current;
    if (!el) return;
    const fit = () => {
      const w = el.clientWidth;
      if (w <= 0) return;
      setZoom(Math.max(0.4, Math.min(maxZoom, (w - 2 * GAP - 40) / (3 * (PHONE_W + 10)))));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [maxZoom]);

  const tone = TONES[chrome];
  const second = b ?? null;
  return (
    <section
      className="flex flex-col gap-4"
      data-testid="thumbnail-tester"
      aria-label="Thumbnail tester"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-display text-lg font-semibold">Thumbnail Tester</h3>
          <p className="text-xs text-muted-foreground">
            {second
              ? 'A and B sit side by side in each feed, as two posts would.'
              : 'Your thumbnail in three feeds. Placeholder neighbours and view counts.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Segmented<Chrome>
            label="Phone chrome"
            size="sm"
            value={chrome}
            onValueChange={setChrome}
            options={[
              { value: 'dark', label: 'Dark' },
              { value: 'light', label: 'Light' },
            ]}
          />
          {actions}
        </div>
      </div>
      <div
        ref={host}
        className="flex flex-wrap items-start justify-center gap-4 rounded-2xl border bg-card/60 p-4"
        data-testid="tester-phones"
        data-chrome={chrome}
      >
        <TikTokMock a={a} b={second} tone={tone} zoom={zoom} />
        <ReelsMock a={a} b={second} tone={tone} zoom={zoom} />
        <ShortsMock a={a} b={second} tone={tone} zoom={zoom} title={clipTitle} />
      </div>
      {hideSmall ? null : <SmallSizes sources={second ? [a, second] : [a]} tone={tone} />}
      <p className="text-2xs text-subtle">
        Feed crops differ: TikTok’s profile grid shows the centre 3:4 of a 9:16 frame, so keep faces
        and text away from the top and bottom edges.
      </p>
    </section>
  );
}
