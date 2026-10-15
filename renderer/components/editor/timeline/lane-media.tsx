'use client';

/**
 * ONE canvas per track lane draws the media content (filmstrip thumbnails, waveforms, beat ticks, volume envelope) of
 * every visible clip. A canvas per clip would put dozens of composited layers into the scroller (each scroll frame
 * re-layerises all of them); a lane canvas keeps that at a handful no matter how many clips are on screen.
 */
import * as React from 'react';
import type { Asset, Item, Track } from '@shared/editor';
import { itemGainAt, makeSourceTime } from '@shared/editor-eval';
import { getEngine } from '@/lib/editor/playback';
import { useEngineVersion, useSettled, useSettledWindow } from './engine-cache';
import { cullItems, visibleSpan, type TimeWindow } from './geometry';
import { readTokens, useThemeVersion } from './use-css-tokens';

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

const TOKENS = ['--tl-audio', '--tl-sfx', '--foreground', '--muted', '--border-strong'] as const;
const ITEM_INSET = 1; // the clip's 1px border
const RADIUS = 5;

type Ctx = CanvasRenderingContext2D;
interface DrawEnv {
  tk: Record<(typeof TOKENS)[number], string>;
  win: TimeWindow;
  scale: number;
  laneH: number;
  muted: boolean;
  sfx: boolean;
  audioKind: boolean;
}

function drawFilmstrip(
  ctx: Ctx,
  item: Extract<Item, { type: 'video' }>,
  asset: Asset | undefined,
  env: DrawEnv,
) {
  const span = visibleSpan(item, env.win);
  if (!span) return;
  const { scale, win } = env;
  const h = env.laneH - 6 - ITEM_INSET * 2;
  const aspect = asset?.width && asset.height ? asset.width / asset.height : 16 / 9;
  const tileW = Math.max(24, Math.round(h * aspect));
  const tileSec = tileW / scale;
  const k0 = Math.floor(span.from / tileSec);
  const k1 = Math.ceil(span.to / tileSec);
  if (k1 <= k0) return;
  const engine = getEngine();
  const src = sourceTimeFn(item);
  const times: number[] = [];
  for (let k = k0; k < k1; k++) times.push(src(Math.min(item.durationSec, (k + 0.5) * tileSec)));
  const lo = Math.max(0, Math.floor(Math.min(...times) * 4) / 4);
  const hi = Math.max(lo + 0.25, Math.ceil(Math.max(...times) * 4) / 4);
  const frozen = item.freezeAtSec !== null;
  const strip =
    asset && engine
      ? frozen
        ? engine.thumbStrip(asset.id, item.freezeAtSec ?? 0, (item.freezeAtSec ?? 0) + 0.25, 1)
        : engine.thumbStrip(asset.id, lo, hi, Math.min(60, Math.max(1, k1 - k0)))
      : null;
  const y = 3 + ITEM_INSET;
  for (let k = k0; k < k1; k++) {
    const dx = (item.startSec + k * tileSec - win.start) * scale;
    const i = k - k0;
    if (strip && strip.times.length) {
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
      const slotAspect = tileW / h;
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
        ctx.drawImage(strip.image, sx, sy, sw, sh, dx, y, Math.ceil(tileW), h);
      } catch {
        /* image not decodable yet: the placeholder below stays */
      }
    } else {
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = env.tk['--muted'] || 'transparent';
      ctx.fillRect(dx, y, Math.ceil(tileW), h);
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = env.tk['--border-strong'] || 'transparent';
    ctx.globalAlpha = 0.5;
    ctx.fillRect(dx, y, 1, h);
    ctx.globalAlpha = 1;
  }
}

function drawWave(ctx: Ctx, item: Media, asset: Asset | undefined, env: DrawEnv) {
  const span = visibleSpan(item, env.win);
  if (!span) return;
  const { scale, win } = env;
  const h = env.laneH - 6 - ITEM_INSET * 2;
  const y0 = 3 + ITEM_INSET;
  const mid = y0 + h / 2;
  const x0 = (item.startSec + span.from - win.start) * scale;
  const cols = Math.ceil((span.to - span.from) * scale);
  const color = (env.sfx ? env.tk['--tl-sfx'] : env.tk['--tl-audio']) || 'transparent';
  const engine = getEngine();
  const wf = asset && engine ? engine.waveform(asset.id) : null;
  const src = sourceTimeFn(item);
  ctx.globalAlpha = env.muted ? 0.3 : 0.85;
  ctx.fillStyle = color;
  if (wf && wf.peaks.length) {
    for (let x = 0; x < cols; x++) {
      const s0 = src(span.from + x / scale);
      const s1 = src(span.from + (x + 1) / scale);
      const a = Math.max(0, Math.floor(Math.min(s0, s1) * wf.rate));
      const b = Math.min(wf.peaks.length - 1, Math.max(a, Math.ceil(Math.max(s0, s1) * wf.rate)));
      let peak = 0;
      for (let i = a; i <= b; i++) {
        const p = wf.peaks[i] ?? 0;
        if (p > peak) peak = p;
      }
      const amp = Math.max(1, Math.min(1, peak) * (h - 6));
      ctx.fillRect(x0 + x, mid - amp / 2, 1, amp);
    }
  } else {
    // waveform still loading: a quiet baseline so the block never looks empty
    ctx.globalAlpha = 0.35;
    ctx.fillRect(x0, mid - 0.5, cols, 1);
  }
  ctx.globalAlpha = 1;
  const beats = asset?.beats;
  if (beats && beats.length) {
    ctx.fillStyle = env.tk['--foreground'] || 'transparent';
    ctx.globalAlpha = 0.55;
    const speed = item.speed || 1;
    for (const bt of beats) {
      const t = (bt - item.inSec) / speed;
      if (t < span.from || t > span.to) continue;
      ctx.fillRect(Math.round(x0 + (t - span.from) * scale), y0 + h - 8, 1, 8);
    }
    ctx.globalAlpha = 1;
  }
  if (
    item.type === 'audio' ||
    item.volume.kf.length ||
    item.fadeInSec ||
    item.fadeOutSec ||
    item.volume.v !== 1
  ) {
    ctx.strokeStyle = env.tk['--foreground'] || 'transparent';
    ctx.globalAlpha = 0.75;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    const step = Math.max(2, Math.floor(cols / 240));
    for (let x = 0; x <= cols + step; x += step) {
      const g = itemGainAt(item, Math.min(item.durationSec, span.from + x / scale));
      const y = y0 + h - 3 - Math.min(1, g / 2) * (h - 8);
      if (x === 0) ctx.moveTo(x0 + x, y);
      else ctx.lineTo(x0 + x, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

export interface LaneMediaProps {
  track: Track;
  win: TimeWindow;
  pxPerSec: number;
  height: number;
  assets: ReadonlyMap<string, Asset>;
}

/** The lane's media canvas (null when the lane has no clip that needs one). */
export const LaneMedia = React.memo(function LaneMedia({
  track,
  win: liveWin,
  pxPerSec,
  height,
  assets,
}: LaneMediaProps) {
  const win = useSettledWindow(liveWin, 140);
  const ref = React.useRef<HTMLCanvasElement>(null);
  const version = useEngineVersion();
  const theme = useThemeVersion();
  const drawPx = useSettled(pxPerSec, 140);
  const audioKind = track.kind === 'audio' || track.kind === 'sfx';
  const items = React.useMemo(
    () =>
      cullItems(track.items, win.start, win.end).filter((it): it is Media => {
        if (it.type === 'audio') return true;
        if (it.type !== 'video') return false;
        return !audioKind || !!assets.get(it.assetId)?.hasAudio;
      }),
    [track.items, win.start, win.end, audioKind, assets],
  );
  const wDraw = Math.max(1, Math.round((win.end - win.start) * drawPx));
  const has = items.length > 0;
  React.useLayoutEffect(() => {
    const c = ref.current;
    if (!c || !has) return;
    const r = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.min(wDraw, 16000);
    c.width = Math.ceil(w * r);
    c.height = Math.ceil(height * r);
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(r, 0, 0, r, 0, 0);
    ctx.clearRect(0, 0, w, height);
    const env: DrawEnv = {
      tk: readTokens(null, TOKENS),
      win,
      scale: drawPx,
      laneH: height,
      muted: track.muted,
      sfx: track.kind === 'sfx',
      audioKind,
    };
    for (const it of items) {
      const x = (it.startSec - win.start) * drawPx;
      const iw = it.durationSec * drawPx;
      if (x + iw < 0 || x > w) continue;
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(
        x + ITEM_INSET,
        3 + ITEM_INSET,
        Math.max(1, iw - ITEM_INSET * 2),
        height - 6 - ITEM_INSET * 2,
        RADIUS,
      );
      ctx.clip();
      const asset = assets.get(it.assetId);
      if (it.type === 'video' && !audioKind) drawFilmstrip(ctx, it, asset, env);
      else drawWave(ctx, it, asset, env);
      ctx.restore();
    }
  }, [
    has,
    items,
    wDraw,
    height,
    drawPx,
    win,
    track.muted,
    track.kind,
    audioKind,
    assets,
    version,
    theme,
  ]);
  if (!has) return null;
  return (
    <canvas
      ref={ref}
      aria-hidden
      className="pointer-events-none absolute top-0"
      style={{ left: win.start * pxPerSec, width: (win.end - win.start) * pxPerSec, height }}
    />
  );
});
