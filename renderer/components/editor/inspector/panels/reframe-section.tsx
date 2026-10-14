'use client';

import * as React from 'react';
import { Crosshair, ScanFace, Trash2 } from 'lucide-react';
import type { VideoItem } from '@shared/editor';
import { resolveCrop } from '@shared/editor-eval';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { invoke } from '@/lib/ipc';
import { DenseSelect } from '../fields/controls';
import { Hint, Notice, Row, Section } from '../fields/section';
import { asPatch, useInspector } from '../context';
import { useEditorStore } from '../store';
import { localTime } from '../lib/animated';
import { aspectCropRect, reframeToCropTracks, reframeWindow, upsertKeyframe } from '../lib/retime';
import { makeSourceTime } from '@shared/editor-eval';

type Aspect = '9:16' | '1:1' | '16:9' | '4:5';
const ASPECTS: Record<Aspect, number> = { '9:16': 9 / 16, '1:1': 1, '16:9': 16 / 9, '4:5': 4 / 5 };

/** The supported aspect nearest to the canvas (custom canvases are tracked at the closest standard shape). */
export function nearestAspect(w: number, h: number): Aspect {
  const r = w / h;
  let best: Aspect = '9:16';
  let bd = Infinity;
  for (const [id, v] of Object.entries(ASPECTS) as [Aspect, number][]) {
    const d = Math.abs(Math.log(v / r));
    if (d < bd) {
      bd = d;
      best = id;
    }
  }
  return best;
}

type Mode = 'auto' | 'single-face' | 'center';

const thumbCache = new Map<string, string | null>();

/** A still of the source around `srcSec` for the mini-map background (best effort: no image on failure). */
function useSourceFrame(projectId: string | null, assetId: string, srcSec: number): string | null {
  const key = `${assetId}@${Math.round(srcSec * 2) / 2}`;
  const [fetched, setFetched] = React.useState<{ key: string; url: string | null } | null>(null);
  React.useEffect(() => {
    if (!projectId || thumbCache.has(key)) return;
    let live = true;
    const tm = setTimeout(() => {
      const t = Math.round(srcSec * 2) / 2;
      invoke('editor:thumbStrip', {
        projectId,
        assetId,
        startSec: t,
        endSec: t + 0.5,
        count: 1,
        height: 120,
      })
        .then((r) => {
          thumbCache.set(key, r.dataUrl);
          if (live) setFetched({ key, url: r.dataUrl });
        })
        .catch(() => {
          thumbCache.set(key, null);
        });
    }, 250);
    return () => {
      live = false;
      clearTimeout(tm);
    };
  }, [projectId, assetId, key, srcSec]);
  const cached = thumbCache.get(key);
  if (cached !== undefined) return cached;
  return fetched && fetched.key === key ? fetched.url : null;
}

const MAP_MAX_H = 150;

/**
 * The source frame with the crop rectangle at the playhead (drag it), the path of the crop centre as a line with a dot
 * per keyframe (click = jump there, drag = move that keyframe's rectangle) and dashed rectangles for the keyframes just
 * before / after the playhead.
 */
function ReframeMap({ item, srcW, srcH }: { item: VideoItem; srcW: number; srcH: number }) {
  const ctx = useInspector();
  const playhead = useEditorStore((s) => s.playheadSec);
  const wrap = React.useRef<HTMLDivElement>(null);
  const [avail, setAvail] = React.useState(280);
  React.useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(
      ([e]) => e && setAvail(Math.max(120, Math.round(e.contentRect.width))),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const aspect = srcW / srcH;
  const W = Math.min(avail, MAP_MAX_H * aspect);
  const H = W / aspect;
  const lt = localTime(item, playhead);
  const cur = resolveCrop(item.crop, lt.t);
  const srcT = makeSourceTime(item)(lt.t);
  const frame = useSourceFrame(ctx.projectId, item.assetId, srcT);
  const tol = 0.5 / ctx.fps;

  // keyframe times of the crop path (union over the four channels)
  const times = React.useMemo(() => {
    const set = new Set<number>();
    for (const ch of [item.crop.x, item.crop.y, item.crop.w, item.crop.h])
      for (const k of ch.kf) set.add(Math.round(k.t * 1000) / 1000);
    return [...set].sort((a, b) => a - b);
  }, [item.crop]);
  const rects = React.useMemo(
    () => times.map((t) => ({ t, r: resolveCrop(item.crop, t) })),
    [times, item.crop],
  );
  const prev = [...rects].reverse().find((k) => k.t < lt.t - tol);
  const next = rects.find((k) => k.t > lt.t + tol);

  type Drag = { sx: number; sy: number; x0: number; y0: number; w: number; h: number; t: number };
  const drag = React.useRef<Drag | null>(null);

  const write = (d: Drag, x: number, y: number) => {
    const c = item.crop;
    const nx = Math.min(Math.max(x, 0), 1 - d.w);
    const ny = Math.min(Math.max(y, 0), 1 - d.h);
    const ch = (a: typeof c.x, v: number) =>
      a.kf.length ? { kf: upsertKeyframe(a.kf, d.t, v) } : { v };
    useEditorStore
      .getState()
      .updateItem(item.id, asPatch({ crop: { x: ch(c.x, nx), y: ch(c.y, ny) } }), {
        label: 'Move crop',
        coalesceKey: `${item.id}:reframe-drag`,
      });
  };

  const begin = (
    e: React.PointerEvent<SVGElement>,
    r: { x: number; y: number; w: number; h: number },
    t: number,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.ownerSVGElement?.setPointerCapture(e.pointerId);
    if (Math.abs(t - lt.t) > 1e-3) useEditorStore.getState().setPlayhead(item.startSec + t);
    drag.current = { sx: e.clientX, sy: e.clientY, x0: r.x, y0: r.y, w: r.w, h: r.h, t };
  };
  const move = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d) return;
    const box = e.currentTarget.getBoundingClientRect();
    write(d, d.x0 + (e.clientX - d.sx) / box.width, d.y0 + (e.clientY - d.sy) / box.height);
  };
  const end = () => {
    drag.current = null;
  };

  const centre = (r: { x: number; y: number; w: number; h: number }) => ({
    cx: (r.x + r.w / 2) * W,
    cy: (r.y + r.h / 2) * H,
  });
  const path = rects
    .map((k, i) => {
      const c = centre(k.r);
      return `${i ? 'L' : 'M'}${c.cx.toFixed(1)},${c.cy.toFixed(1)}`;
    })
    .join('');
  const rectProps = (r: { x: number; y: number; w: number; h: number }) => ({
    x: r.x * W,
    y: r.y * H,
    width: r.w * W,
    height: r.h * H,
  });

  return (
    <div ref={wrap} className="flex justify-center" data-testid="reframe-map">
      <svg
        role="group"
        aria-label="Source frame with the crop path"
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        className="touch-none select-none overflow-hidden rounded-md border border-border-strong bg-muted"
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      >
        {frame ? <image href={frame} width={W} height={H} preserveAspectRatio="none" /> : null}
        {/* dim everything outside the current crop */}
        <path
          d={`M0 0H${W}V${H}H0Z M${cur.x * W} ${cur.y * H}V${(cur.y + cur.h) * H}H${(cur.x + cur.w) * W}V${cur.y * H}Z`}
          fillRule="evenodd"
          className="fill-background/60"
        />
        {rects.length > 1 ? (
          <path
            d={path}
            fill="none"
            strokeWidth={1.5}
            className="pointer-events-none stroke-primary-text/70"
          />
        ) : null}
        {[prev, next].map((k) =>
          k ? (
            <rect
              key={k.t}
              data-testid="reframe-ghost"
              {...rectProps(k.r)}
              strokeWidth={1}
              strokeDasharray="3 3"
              className="pointer-events-none fill-transparent stroke-primary-text/80"
            />
          ) : null,
        )}
        <rect
          data-testid="reframe-rect"
          {...rectProps(cur)}
          strokeWidth={2}
          className="cursor-move fill-primary/10 stroke-primary"
          onPointerDown={(e) => begin(e, cur, lt.t)}
        />
        {rects.map((k, i) => {
          const c = centre(k.r);
          const here = Math.abs(k.t - lt.t) <= tol;
          return (
            <g
              key={k.t}
              data-testid="reframe-key"
              data-t={k.t}
              className="cursor-grab"
              onPointerDown={(e) => begin(e, k.r, k.t)}
            >
              <title>{`Keyframe ${i + 1} at ${k.t.toFixed(2)} s`}</title>
              <circle cx={c.cx} cy={c.cy} r={9} fill="transparent" />
              <circle
                cx={c.cx}
                cy={c.cy}
                r={here ? 4.5 : 3}
                strokeWidth={1.5}
                className={cn(here ? 'fill-primary stroke-foreground' : 'fill-card stroke-primary')}
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** Face-tracked reframing: run the tracker, see the path as keyframe rectangles, override by dragging. */
export function ReframeSection() {
  const ctx = useInspector();
  const item = ctx.primary as VideoItem;
  const asset = ctx.assetOf(item);
  const srcW = asset?.width ?? 1920;
  const srcH = asset?.height ?? 1080;
  const [mode, setMode] = React.useState<Mode>('auto');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [coverage, setCoverage] = React.useState<number | null>(null);
  const aspect = nearestAspect(ctx.project.canvas.width, ctx.project.canvas.height);
  const animated = [item.crop.x, item.crop.y, item.crop.w, item.crop.h].some(
    (a) => a.kf.length > 0,
  );
  const nKeys = Math.max(item.crop.x.kf.length, item.crop.y.kf.length);

  const track = async () => {
    if (!ctx.projectId) return;
    const win = reframeWindow(item);
    if (!win) {
      setError('A freeze frame has no motion to track. Unfreeze the clip first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await invoke('editor:reframe', {
        projectId: ctx.projectId,
        assetId: item.assetId,
        startSec: win.startSec,
        endSec: win.endSec,
        aspect,
        mode,
      });
      const tracks = reframeToCropTracks(item, res.keyframes, win.startSec);
      if (!tracks) {
        setError('The tracker found no usable path for this part of the video.');
        return;
      }
      const ch = (kf: typeof tracks.x) => ({ v: kf[0]?.v ?? 0, kf });
      ctx.set(
        { crop: { x: ch(tracks.x), y: ch(tracks.y), w: ch(tracks.w), h: ch(tracks.h) } },
        'Face-track reframe',
      );
      setCoverage(res.faceCoverage);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const setStatic = (r: { x: number; y: number; w: number; h: number }, label: string) => {
    const one = (v: number) => ({ v, kf: [] });
    ctx.set({ crop: { x: one(r.x), y: one(r.y), w: one(r.w), h: one(r.h) } }, label);
    setCoverage(null);
  };

  return (
    <Section title="Reframe" testId="section-reframe">
      <Row label="Tracking">
        <DenseSelect<Mode>
          label="Tracking mode"
          testId="reframe-mode"
          value={mode}
          options={[
            { value: 'auto', label: 'Auto (all faces)' },
            { value: 'single-face', label: 'Follow one face' },
            { value: 'center', label: 'Centre only' },
          ]}
          onChange={setMode}
        />
      </Row>
      <div className="flex flex-wrap gap-1.5">
        <Button
          size="xs"
          variant="primary"
          data-testid="face-track"
          loading={busy}
          disabled={ctx.multi || !ctx.projectId || !asset}
          onClick={() => void track()}
        >
          <ScanFace aria-hidden /> {busy ? 'Tracking…' : 'Face-track'}
        </Button>
        <Button
          size="xs"
          variant="secondary"
          data-testid="centre-crop"
          disabled={busy}
          onClick={() =>
            setStatic(
              aspectCropRect(srcW, srcH, ctx.project.canvas.width / ctx.project.canvas.height),
              'Centre crop',
            )
          }
        >
          <Crosshair aria-hidden /> Centre crop
        </Button>
        <Button
          size="xs"
          variant="ghost"
          data-testid="clear-reframe"
          disabled={busy || (!animated && item.crop.w.v === 1 && item.crop.h.v === 1)}
          onClick={() => setStatic({ x: 0, y: 0, w: 1, h: 1 }, 'Clear reframe')}
        >
          <Trash2 aria-hidden /> Clear
        </Button>
      </div>
      {error ? (
        <Notice
          tone="danger"
          title="Face tracking failed"
          testId="reframe-error"
          action={
            <Button size="xs" variant="secondary" onClick={() => void track()}>
              Retry
            </Button>
          }
        >
          {error}
        </Notice>
      ) : null}
      {ctx.multi ? (
        <Hint>Select one clip to see its crop path.</Hint>
      ) : (
        <>
          <ReframeMap item={item} srcW={srcW} srcH={srcH} />
          <Hint testId="reframe-status">
            {animated
              ? `${nKeys} crop keyframe${nKeys === 1 ? '' : 's'}${coverage !== null ? ` · face found in ${Math.round(coverage * 100)}% of frames` : ''}. Drag the rectangle to override the path at the playhead; click a dashed one to jump to it.`
              : 'Run the tracker for a face-following path, or drag the rectangle to place the crop yourself.'}
          </Hint>
        </>
      )}
    </Section>
  );
}
