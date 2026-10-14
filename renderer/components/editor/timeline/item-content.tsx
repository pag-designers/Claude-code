'use client';

import * as React from 'react';
import {
  Circle,
  Image as ImageIcon,
  Link2,
  Lock,
  Minus,
  MoveRight,
  RectangleHorizontal,
  Type,
  Gauge,
  Undo2,
  Video,
  Volume2,
  PanelLeftOpen,
} from 'lucide-react';
import type { Asset, Item, ShapeKind } from '@shared/editor';
import { itemGainAt, makeSourceTime } from '@shared/editor-eval';
import { getEngine } from '@/lib/editor/playback';
import { useEditorStore } from '@/lib/editor/core';
import { useEngineVersion, useSettled } from './engine-cache';
import { cueText, itemLabel, secToPx, visibleSpan, type TimeWindow } from './geometry';
import { readTokens, useThemeVersion } from './use-css-tokens';
import { useTimelineUi } from './timeline-ui';

const dpr = () => (typeof window === 'undefined' ? 1 : Math.min(2, window.devicePixelRatio || 1));

/* ------------------------------------------------------------------ source-time helper ------- */

type Media = Extract<Item, { type: 'video' | 'audio' }>;
const srcTimeCache = new WeakMap<Item, (tl: number) => number>();
/** Source time (asset seconds) shown at local item time `tl`; cached per immutable item object. */
export function sourceTimeFn(item: Media): (tl: number) => number {
  let f = srcTimeCache.get(item);
  if (!f) {
    f = makeSourceTime(item);
    srcTimeCache.set(item, f);
  }
  return f;
}

/* ------------------------------------------------------------------ canvas host -------------- */

/**
 * A canvas that covers the visible slice [fromSec, toSec] of an item (never the whole, possibly hour-long item).
 * It is positioned in item-local pixels and stretched with CSS while the zoom is settling.
 */
function SliceCanvas({
  fromSec,
  toSec,
  pxPerSec,
  height,
  draw,
  deps,
  className,
}: {
  fromSec: number;
  toSec: number;
  pxPerSec: number;
  /** Drawing scale: the zoom the bitmap is rendered at (may lag `pxPerSec` while zooming). */
  height: number;
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number, scale: number) => void;
  deps: readonly unknown[];
  className?: string;
}) {
  const ref = React.useRef<HTMLCanvasElement>(null);
  const drawPx = useSettled(pxPerSec, 140);
  const wDraw = Math.max(1, Math.round((toSec - fromSec) * drawPx));
  React.useLayoutEffect(() => {
    const c = ref.current;
    if (!c) return;
    const r = dpr();
    c.width = Math.min(16000, Math.ceil(wDraw * r));
    c.height = Math.ceil(height * r);
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(r, 0, 0, r, 0, 0);
    ctx.clearRect(0, 0, wDraw, height);
    draw(ctx, wDraw, height, drawPx);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `draw` is recreated every render; `deps` lists its inputs
  }, [wDraw, height, drawPx, fromSec, toSec, ...deps]);
  return (
    <canvas
      ref={ref}
      aria-hidden
      className={className}
      style={{
        position: 'absolute',
        left: secToPx(fromSec, pxPerSec),
        top: 0,
        width: Math.max(1, secToPx(toSec - fromSec, pxPerSec)),
        height,
      }}
    />
  );
}

/* ------------------------------------------------------------------ video thumbnails --------- */

const THUMB_TOKENS = ['--tl-video', '--muted', '--border-strong'] as const;

export function VideoStrip({
  item,
  asset,
  pxPerSec,
  win,
  height,
}: {
  item: Extract<Item, { type: 'video' }>;
  asset: Asset | undefined;
  pxPerSec: number;
  win: TimeWindow;
  height: number;
}) {
  const version = useEngineVersion();
  const theme = useThemeVersion();
  const span = visibleSpan(item, win);
  const tileH = Math.max(16, height - 2);
  const aspect = asset?.width && asset.height ? asset.width / asset.height : 16 / 9;
  const tileW = Math.max(24, Math.round(tileH * aspect));
  const settledPx = useSettled(pxPerSec, 140);
  // tile grid in LOCAL seconds, anchored at the item start so tiles do not slide while scrolling
  const tileSec = tileW / settledPx;
  const k0 = span ? Math.floor(span.from / tileSec) : 0;
  const k1 = span ? Math.ceil(span.to / tileSec) : 0;
  const fromSec = k0 * tileSec;
  const toSec = k1 * tileSec;
  if (!span || k1 <= k0) return null;
  return (
    <SliceCanvas
      fromSec={fromSec}
      toSec={Math.max(toSec, fromSec + 0.001)}
      pxPerSec={pxPerSec}
      height={tileH}
      deps={[version, theme, item, asset?.id, tileW, tileSec, k0, k1]}
      draw={(ctx, w, h) => {
        const tk = readTokens(document.documentElement, THUMB_TOKENS);
        const engine = getEngine();
        const src = sourceTimeFn(item);
        const times: number[] = [];
        for (let k = k0; k < k1; k++)
          times.push(src(Math.min(item.durationSec, (k + 0.5) * tileSec)));
        const lo = Math.max(0, Math.floor(Math.min(...times) * 4) / 4);
        const hi = Math.max(lo + 0.25, Math.ceil(Math.max(...times) * 4) / 4);
        const strip =
          asset && engine && item.freezeAtSec === null
            ? engine.thumbStrip(asset.id, lo, hi, Math.min(60, Math.max(1, k1 - k0)))
            : asset && engine
              ? engine.thumbStrip(
                  asset.id,
                  Math.max(0, item.freezeAtSec ?? 0),
                  (item.freezeAtSec ?? 0) + 0.25,
                  1,
                )
              : null;
        for (let i = 0; i < k1 - k0; i++) {
          const dx = (i * w) / (k1 - k0);
          const tw = w / (k1 - k0);
          if (strip && strip.times.length) {
            // nearest strip tile in time
            const want = times[i] ?? 0;
            let best = 0;
            let bd = Infinity;
            for (let j = 0; j < strip.times.length; j++) {
              const d = Math.abs((strip.times[j] ?? 0) - want);
              if (d < bd) {
                bd = d;
                best = j;
              }
            }
            const col = best % strip.cols;
            const row = Math.floor(best / strip.cols);
            // cover-fit the tile into the slot
            const slotAspect = tw / h;
            const tileAspect = strip.tileW / strip.tileH;
            let sw = strip.tileW;
            let sh = strip.tileH;
            let sx = col * strip.tileW;
            let sy = row * strip.tileH;
            if (tileAspect > slotAspect) {
              sw = strip.tileH * slotAspect;
              sx += (strip.tileW - sw) / 2;
            } else {
              sh = strip.tileW / slotAspect;
              sy += (strip.tileH - sh) / 2;
            }
            try {
              ctx.drawImage(strip.image, sx, sy, sw, sh, dx, 0, Math.ceil(tw), h);
            } catch {
              /* image not decodable yet: leave the placeholder */
            }
          } else {
            ctx.fillStyle = tk['--muted'] || 'transparent';
            ctx.globalAlpha = 0.55;
            ctx.fillRect(dx, 0, Math.ceil(tw), h);
            ctx.globalAlpha = 1;
          }
          ctx.fillStyle = tk['--border-strong'] || 'transparent';
          ctx.globalAlpha = 0.5;
          ctx.fillRect(dx, 0, 1, h);
          ctx.globalAlpha = 1;
        }
      }}
    />
  );
}

/* ------------------------------------------------------------------ audio waveform ----------- */

const WAVE_TOKENS = ['--tl-audio', '--tl-sfx', '--foreground', '--muted-foreground'] as const;

export function AudioWave({
  item,
  asset,
  pxPerSec,
  win,
  height,
  muted,
  sfx,
}: {
  item: Extract<Item, { type: 'audio' | 'video' }>;
  asset: Asset | undefined;
  pxPerSec: number;
  win: TimeWindow;
  height: number;
  muted: boolean;
  sfx: boolean;
}) {
  const version = useEngineVersion();
  const theme = useThemeVersion();
  const span = visibleSpan(item, win);
  if (!span) return null;
  const from = Math.floor(span.from * 4) / 4;
  const to = Math.min(item.durationSec, Math.ceil(span.to * 4) / 4);
  return (
    <SliceCanvas
      fromSec={from}
      toSec={Math.max(to, from + 0.01)}
      pxPerSec={pxPerSec}
      height={height}
      deps={[version, theme, item, asset?.id, asset?.beats, muted, sfx]}
      draw={(ctx, w, h, scale) => {
        const tk = readTokens(document.documentElement, WAVE_TOKENS);
        const color = (sfx ? tk['--tl-sfx'] : tk['--tl-audio']) || 'transparent';
        const engine = getEngine();
        const wf = asset && engine ? engine.waveform(asset.id) : null;
        const src = sourceTimeFn(item);
        const mid = h / 2;
        ctx.globalAlpha = muted ? 0.3 : 0.85;
        ctx.fillStyle = color;
        if (wf && wf.peaks.length) {
          const cols = Math.ceil(w);
          for (let x = 0; x < cols; x++) {
            const s0 = src(from + x / scale);
            const s1 = src(from + (x + 1) / scale);
            const a = Math.max(0, Math.floor(Math.min(s0, s1) * wf.rate));
            const b = Math.min(
              wf.peaks.length - 1,
              Math.max(a, Math.ceil(Math.max(s0, s1) * wf.rate)),
            );
            let peak = 0;
            for (let i = a; i <= b; i++) {
              const p = wf.peaks[i] ?? 0;
              if (p > peak) peak = p;
            }
            const amp = Math.max(1, Math.min(1, peak) * (h - 6));
            ctx.fillRect(x, mid - amp / 2, 1, amp);
          }
        } else {
          // waveform still loading: a quiet baseline so the block never looks empty
          ctx.globalAlpha = 0.35;
          ctx.fillRect(0, mid - 0.5, w, 1);
        }
        ctx.globalAlpha = 1;
        // beat ticks
        const beats = asset?.beats;
        if (beats && beats.length) {
          ctx.fillStyle = tk['--foreground'] || 'transparent';
          ctx.globalAlpha = 0.55;
          const speed = item.speed || 1;
          for (const bt of beats) {
            const t = (bt - item.inSec) / speed;
            if (t < from || t > to) continue;
            ctx.fillRect(Math.round((t - from) * scale), h - 8, 1, 8);
          }
          ctx.globalAlpha = 1;
        }
        // volume envelope (volume keyframes x fades)
        if (
          item.type === 'audio' ||
          item.volume.kf.length ||
          item.fadeInSec ||
          item.fadeOutSec ||
          item.volume.v !== 1
        ) {
          ctx.strokeStyle = tk['--foreground'] || 'transparent';
          ctx.globalAlpha = 0.75;
          ctx.lineWidth = 1.25;
          ctx.beginPath();
          const step = Math.max(2, Math.floor(w / 240));
          for (let x = 0; x <= w + step; x += step) {
            const g = itemGainAt(item, Math.min(item.durationSec, from + x / scale));
            const y = h - 3 - Math.min(1, g / 2) * (h - 8);
            if (x === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }}
    />
  );
}

/* ------------------------------------------------------------------ small content pieces ----- */

export const SHAPE_ICON: Record<ShapeKind, React.ComponentType<{ className?: string }>> = {
  rect: RectangleHorizontal,
  ellipse: Circle,
  line: Minus,
  arrow: MoveRight,
  'progress-bar': PanelLeftOpen,
};

export function TypeIcon({ item, className }: { item: Item; className?: string }) {
  switch (item.type) {
    case 'video':
      return <Video className={className} aria-hidden />;
    case 'audio':
      return <Volume2 className={className} aria-hidden />;
    case 'image':
      return <ImageIcon className={className} aria-hidden />;
    case 'text':
      return <Type className={className} aria-hidden />;
    case 'subtitle':
      return <Type className={className} aria-hidden />;
    case 'shape': {
      const I = SHAPE_ICON[item.shape];
      return <I className={className} />;
    }
  }
}

/** Speed (and reverse) badges for media items. */
export function MediaBadges({ item }: { item: Item }) {
  if (item.type !== 'video' && item.type !== 'audio') return null;
  const ramp = item.speedCurve.length > 0;
  const speed = item.speed;
  return (
    <>
      {ramp || Math.abs(speed - 1) > 1e-6 ? (
        <span className="tl-chip inline-flex shrink-0 items-center gap-0.5 rounded-xs px-1 text-2xs font-semibold tabular-nums text-foreground">
          <Gauge className="size-2.5" aria-hidden />
          {ramp ? 'Ramp' : `${+speed.toFixed(2)}×`}
        </span>
      ) : null}
      {item.reverse ? (
        <span
          className="tl-chip inline-flex shrink-0 items-center rounded-xs px-1 text-foreground"
          title="Reversed"
        >
          <Undo2 className="size-2.5" aria-label="Reversed" />
        </span>
      ) : null}
    </>
  );
}

/** Label row on top of an item (icon, name, badges). */
export function ItemLabel({
  item,
  asset,
  locked,
  pxWidth,
}: {
  item: Item;
  asset: Asset | undefined;
  locked: boolean;
  pxWidth: number;
}) {
  if (pxWidth < 22) return null;
  const compact = pxWidth < 64;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-[3] flex items-center gap-1 overflow-hidden px-1.5 pt-0.5">
      <span className="tl-chip flex min-w-0 items-center gap-1 rounded-xs px-1 text-2xs font-medium leading-4 text-foreground">
        <span className="text-[color:var(--tl-c)]">
          <TypeIcon item={item} className="size-2.5 shrink-0" />
        </span>
        {compact ? null : <span className="truncate">{itemLabel(item, asset)}</span>}
      </span>
      {compact ? null : <MediaBadges item={item} />}
      {item.groupId ? (
        <Link2 className="size-2.5 shrink-0 text-foreground" aria-label="Grouped" />
      ) : null}
      {locked || item.locked ? (
        <Lock className="size-2.5 shrink-0 text-foreground" aria-label="Locked" />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ subtitle cue ------------- */

export function SubtitleContent({
  item,
  pxWidth,
}: {
  item: Extract<Item, { type: 'subtitle' }>;
  pxWidth: number;
}) {
  const editing = useTimelineUi((s) => s.editingCueId === item.id);
  const text = cueText(item);
  if (editing) return <CueEditor itemId={item.id} text={text} pxWidth={pxWidth} />;
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center px-2">
      <span className="truncate text-xs font-medium leading-4 text-foreground">{text || '…'}</span>
    </div>
  );
}

/** Inline caption editor (double-click a cue). Enter commits, Esc / blur-without-change cancels. */
function CueEditor({ itemId, text, pxWidth }: { itemId: string; text: string; pxWidth: number }) {
  const setUi = useTimelineUi((s) => s.set);
  const [draft, setDraft] = React.useState(text);
  const done = React.useRef(false);
  const commit = () => {
    if (done.current) return;
    done.current = true;
    const next = draft.trim();
    if (next && next !== text) useEditorStore.getState().setCueText(itemId, next);
    setUi({ editingCueId: null });
  };
  return (
    <input
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      data-no-drag
      aria-label="Caption text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          done.current = true;
          setUi({ editingCueId: null });
        }
      }}
      className="absolute inset-x-1 top-1/2 z-10 h-6 -translate-y-1/2 rounded-xs border border-ring bg-field px-1.5 text-xs text-foreground outline-none"
      style={{ minWidth: Math.min(180, Math.max(60, pxWidth)) }}
    />
  );
}
