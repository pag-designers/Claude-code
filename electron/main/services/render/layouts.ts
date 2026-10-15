/**
 * Multi-panel layouts (BRIEF §4.7/§4.13): 'split' (two face panels) and 'screen-face' (screen + webcam
 * face). Every panel is its own crop pipeline cut from ONE decoded source stream:
 *
 *   [in] fps, sendcmd(all panels) , split=N
 *     [p0] crop@<tag>1 -> scale -> crop@<tag>2          face panel (animated, two-stage sub-pixel pan)
 *     [p1] crop -> split -> (blurred cover fill) + (contain-fitted sharp copy) -> overlay   screen panel
 *   panels -> vstack / hstack (or overlay on a black canvas) -> divider lines -> ass (captions + hook)
 *
 * Plan conventions (see services/reframe/screen.ts): a 'screen' panel has a static region whose aspect
 * may differ from the panel (contain-fit, never stretched, letter/pillarbox filled with a blurred copy);
 * every other panel has windows of the panel's aspect.
 */
import type { ReframePanel, ReframePlan } from '@shared/pipeline';
import {
  CropPath,
  escapeFilterPath,
  stagesFor,
  stageValues,
  type CropStages,
  type PanelCommandInput,
  type StageValues,
} from './filters';

const evenCeil = (v: number): number => 2 * Math.ceil(v / 2);
const evenRound = (v: number): number => Math.max(2, 2 * Math.round(v / 2));

/** Width of the line drawn on the seams between panels (px of the output frame). */
export const DIVIDER_PX = 4;
/** The blurred fill of a letter/pillarboxed screen panel is computed at 1/6 resolution. */
const BLUR_DIV = 6;

export function isPanelLayout(plan: ReframePlan): boolean {
  return (
    (plan.layout === 'split' || plan.layout === 'screen-face') && (plan.panels?.length ?? 0) >= 2
  );
}

export interface PanelRuntime {
  panel: ReframePanel;
  /** 'screen' = contain-fit with blurred fill; 'face' = animated crop to the panel's aspect. */
  kind: 'screen' | 'face';
  tag: string;
  st: CropStages | null;
  path: CropPath | null;
  initial: StageValues | null;
}

/** Crop paths / stage geometry of every panel. `tagPrefix` keeps filter instance names unique in a graph. */
export function preparePanels(
  plan: ReframePlan,
  srcW: number,
  srcH: number,
  fps: number,
  tagPrefix: string,
): PanelRuntime[] {
  return (plan.panels ?? []).map((panel, i) => {
    const tag = `${tagPrefix}p${i}_`;
    if (panel.role === 'screen') {
      return { panel, kind: 'screen', tag, st: null, path: null, initial: null };
    }
    const st = stagesFor(panel.keyframes, panel.out.w, panel.out.h, srcW, srcH);
    const path = new CropPath(
      panel.keyframes,
      plan.cuts,
      { maxX: srcW - st.cropW, maxY: srcH - st.cropH },
      0.5 / fps,
    );
    return { panel, kind: 'face', tag, st, path, initial: stageValues(path.at(0), st, srcW, srcH) };
  });
}

/** Commands for the animated panels; null when every panel is static (no `sendcmd` needed). */
export function panelCommandInputs(panels: PanelRuntime[]): PanelCommandInput[] {
  const out: PanelCommandInput[] = [];
  for (const p of panels) {
    if (p.kind === 'face' && p.st && p.path && !p.st.isStatic) {
      out.push({ path: p.path, st: p.st, tag: p.tag });
    }
  }
  return out;
}

/** The static source region of a 'screen' panel (first keyframe), clamped into the source. */
export function screenRegion(
  panel: ReframePanel,
  srcW: number,
  srcH: number,
): { x: number; y: number; w: number; h: number } {
  const k = panel.keyframes[0];
  const w = Math.min(srcW, evenRound(k?.w ?? srcW));
  const h = Math.min(srcH, evenRound(k?.h ?? srcH));
  const x = Math.min(srcW - w, 2 * Math.round((k?.x ?? 0) / 2));
  const y = Math.min(srcH - h, 2 * Math.round((k?.y ?? 0) / 2));
  return { x: Math.max(0, x), y: Math.max(0, y), w, h };
}

/** Filter chain of a face panel: `[in]...[out]` (without labels). */
export function facePanelChain(p: PanelRuntime, srcW: number, srcH: number): string {
  const { st, initial, panel } = p;
  if (!st || !initial) throw new Error('face panel without stages');
  const { w: ow, h: oh } = panel.out;
  if (st.isStatic) {
    const k = panel.keyframes[0];
    const x = Math.min(Math.max(0, 2 * Math.round((k?.x ?? 0) / 2)), srcW - st.cropW);
    const y = Math.min(Math.max(0, 2 * Math.round((k?.y ?? 0) / 2)), srcH - st.cropH);
    return `crop=w=${st.cropW}:h=${st.cropH}:x=${x}:y=${y},scale=${ow}:${oh}:flags=lanczos,setsar=1`;
  }
  return [
    `crop@${p.tag}1=w=${st.w1}:h=${st.h1}:x=${initial.x0}:y=${initial.y0}`,
    `scale=${st.sw}:${st.sh}:flags=lanczos`,
    `crop@${p.tag}2=w=${ow}:h=${oh}:x=${initial.ox}:y=${initial.oy}`,
    'setsar=1',
  ].join(',');
}

/**
 * Filter graph fragment of a screen panel (several labelled chains): contain-fit the region into the
 * panel and fill the remaining bars with a blurred, dimmed copy of the same picture.
 */
export function screenPanelGraph(
  p: PanelRuntime,
  inLabel: string,
  outLabel: string,
  srcW: number,
  srcH: number,
): string {
  const r = screenRegion(p.panel, srcW, srcH);
  const { w: ow, h: oh } = p.panel.out;
  const s = Math.min(ow / r.w, oh / r.h);
  const fw = Math.min(ow, evenRound(r.w * s));
  const fh = Math.min(oh, evenRound(r.h * s));
  const crop = `crop=w=${r.w}:h=${r.h}:x=${r.x}:y=${r.y}`;
  if (fw >= ow - 2 && fh >= oh - 2) {
    return `[${inLabel}]${crop},scale=${ow}:${oh}:flags=lanczos,setsar=1[${outLabel}]`;
  }
  const bw = evenCeil(ow / BLUR_DIV);
  const bh = evenCeil(oh / BLUR_DIV);
  const t = p.tag;
  return [
    `[${inLabel}]${crop},split=2[${t}a][${t}b]`,
    `[${t}a]scale=${bw}:${bh}:force_original_aspect_ratio=increase:flags=bilinear,crop=${bw}:${bh},` +
      `gblur=sigma=4,eq=brightness=-0.08:saturation=0.85,scale=${ow}:${oh}:flags=bicubic[${t}bg]`,
    `[${t}b]scale=${fw}:${fh}:flags=lanczos[${t}fg]`,
    `[${t}bg][${t}fg]overlay=x=(W-w)/2:y=(H-h)/2:shortest=1,setsar=1[${outLabel}]`,
  ].join(';');
}

type Stack = { kind: 'v' | 'h' | 'overlay'; order: PanelRuntime[] };

/** Chooses how to assemble the panels: exact vertical / horizontal tiling -> vstack / hstack. */
export function stackSpec(panels: PanelRuntime[], outW: number, outH: number): Stack {
  const byY = [...panels].sort(
    (a, b) => a.panel.out.y - b.panel.out.y || a.panel.out.x - b.panel.out.x,
  );
  let y = 0;
  const vertical = byY.every((p) => {
    const ok = p.panel.out.x === 0 && p.panel.out.w === outW && p.panel.out.y === y;
    y += p.panel.out.h;
    return ok;
  });
  if (vertical && y === outH) return { kind: 'v', order: byY };
  const byX = [...panels].sort((a, b) => a.panel.out.x - b.panel.out.x);
  let x = 0;
  const horizontal = byX.every((p) => {
    const ok = p.panel.out.y === 0 && p.panel.out.h === outH && p.panel.out.x === x;
    x += p.panel.out.w;
    return ok;
  });
  if (horizontal && x === outW) return { kind: 'h', order: byX };
  return { kind: 'overlay', order: byY };
}

export interface LayoutGraphOptions {
  plan: ReframePlan;
  srcW: number;
  srcH: number;
  /** Pad label of the decoded source video (e.g. `0:v`). */
  inLabel: string;
  /** Output pad label (without brackets). */
  outLabel: string;
  /** Unique prefix for filter instance names / labels within the whole graph. */
  tag: string;
  /** `fps=` argument, or null. */
  fps: string | null;
  /** Output frame rate as a number (for the overlay fallback's canvas). */
  rate: number;
  /** sendcmd file for the animated panels (null when all are static). */
  cmdFile: string | null;
  panels: PanelRuntime[];
  assFile: string | null;
  fontsDir: string | null;
  divider?: boolean;
}

/** Complete `-filter_complex` fragment: source -> panels -> stacked frame -> divider -> captions. */
export function buildLayoutGraph(o: LayoutGraphOptions): string {
  const { plan, panels } = o;
  const n = panels.length;
  const lines: string[] = [];
  const head: string[] = [];
  if (o.fps) head.push(`fps=${o.fps}`);
  if (o.cmdFile) head.push(`sendcmd=f=${escapeFilterPath(o.cmdFile)}`);
  head.push(`split=${n}`);
  const inPads = panels.map((_, i) => `${o.tag}in${i}`);
  lines.push(`[${o.inLabel}]${head.join(',')}${inPads.map((l) => `[${l}]`).join('')}`);

  const outPads: string[] = [];
  panels.forEach((p, i) => {
    const inL = inPads[i] ?? '';
    const outL = `${o.tag}pn${i}`;
    outPads.push(outL);
    if (p.kind === 'screen') lines.push(screenPanelGraph(p, inL, outL, o.srcW, o.srcH));
    else lines.push(`[${inL}]${facePanelChain(p, o.srcW, o.srcH)}[${outL}]`);
  });

  const stack = stackSpec(panels, plan.outW, plan.outH);
  const orderPads = stack.order.map((p) => outPads[panels.indexOf(p)] ?? '');
  const tail: string[] = [];
  let stackedLabel = `${o.tag}stk`;
  if (stack.kind === 'v' || stack.kind === 'h') {
    const fn = stack.kind === 'v' ? 'vstack' : 'hstack';
    lines.push(`${orderPads.map((l) => `[${l}]`).join('')}${fn}=inputs=${n}[${stackedLabel}]`);
    if (o.divider !== false) {
      for (const p of stack.order.slice(1)) {
        const { x, y } = p.panel.out;
        const half = DIVIDER_PX / 2;
        tail.push(
          stack.kind === 'v'
            ? `drawbox=x=0:y=${y - half}:w=${plan.outW}:h=${DIVIDER_PX}:color=black@0.9:t=fill`
            : `drawbox=x=${x - half}:y=0:w=${DIVIDER_PX}:h=${plan.outH}:color=black@0.9:t=fill`,
        );
      }
    }
  } else {
    lines.push(`color=c=black:s=${plan.outW}x${plan.outH}:r=${o.rate}[${o.tag}bg]`);
    let base = `${o.tag}bg`;
    stack.order.forEach((p, i) => {
      const next = `${o.tag}ov${i}`;
      const pad = orderPads[i] ?? '';
      lines.push(
        `[${base}][${pad}]overlay=x=${p.panel.out.x}:y=${p.panel.out.y}:shortest=${i === n - 1 ? 1 : 0}[${next}]`,
      );
      base = next;
    });
    stackedLabel = base;
  }
  tail.push('setsar=1');
  if (o.assFile) {
    let ass = `ass=filename=${escapeFilterPath(o.assFile)}`;
    if (o.fontsDir) ass += `:fontsdir=${escapeFilterPath(o.fontsDir)}`;
    tail.push(ass);
  }
  tail.push('format=yuv420p');
  lines.push(`[${stackedLabel}]${tail.join(',')}[${o.outLabel}]`);
  return lines.join(';\n');
}
