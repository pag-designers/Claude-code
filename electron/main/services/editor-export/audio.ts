/**
 * Audio mix of the project: one chain per audible item (trim → reverse → speed → gate → place on the
 * timeline → gain automation), summed with `amix normalize=0`, then loudness-normalised (two-pass).
 *
 * Gain = itemGainAt (volume keyframes × fades) × track gain × ducking × transition crossfade, all sampled from
 * the shared evaluator into ONE piecewise-linear `volume` expression per item (no sidechain compressor).
 */
import type { ExportSettings, Item, Project, Track } from '@shared/editor';
import {
  activeOnTrack,
  duckBreakpoints,
  duckGainAt,
  itemEnd,
  itemGainAt,
  makeSourceOffset,
  speechRanges,
  type TimeRange,
} from '@shared/editor-eval';
import { buildAudioFilter, measureLoudnessGraph } from '../render/audio';
import { Graph, filt, q } from './graph';
import { num, seriesExpr, toSeries } from './pl';
import type { Grid } from './timeline';
import type { FileInfo } from './types';

export interface AudioBuild {
  inputs: string[][];
  graph: string;
  out: string;
  notes: string[];
  /** Same graph with input indices starting at `base` (audio inputs follow the video inputs). */
  withBase(base: number): AudioBuild;
}

const RATE = 48000;
const RAMP_SEG = 1 / 6;
const GATE_THRESHOLD = Math.pow(10, -45 / 20);
const FORMAT = `aformat=sample_fmts=fltp:sample_rates=${RATE}:channel_layouts=stereo`;

type MediaItem = Extract<Item, { type: 'video' | 'audio' }>;

/** atempo chain for any rate in [0.1, 10] (each atempo stage takes 0.5–100). */
export function tempoChain(rate: number): string[] {
  const out: string[] = [];
  let r = rate;
  while (r < 0.5 - 1e-9) {
    out.push('atempo=0.5');
    r /= 0.5;
  }
  if (Math.abs(r - 1) > 1e-6) out.push(`atempo=${num(r, 6)}`);
  return out;
}

/** Adaptive polyline of f over [a, b] (value tolerance tol), always including the extra breakpoints. */
export function adaptiveKnots(
  f: (t: number) => number,
  breaks: number[],
  tol: number,
): { t: number; v: number }[] {
  const pts = [...new Set(breaks.map((b) => Math.round(b * 1e6) / 1e6))].sort((x, y) => x - y);
  const out: { t: number; v: number }[] = [];
  const rec = (a: number, fa: number, b: number, fb: number, depth: number): void => {
    if (depth > 8 || b - a < 0.004) return;
    const m = (a + b) / 2;
    const fm = f(m);
    if (Math.abs(fm - (fa + fb) / 2) > tol) {
      rec(a, fa, m, fm, depth + 1);
      out.push({ t: m, v: fm });
      rec(m, fm, b, fb, depth + 1);
    }
  };
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i] as number;
    const fa = f(a);
    out.push({ t: a, v: fa });
    const b = pts[i + 1];
    if (b !== undefined) rec(a, fa, b, f(b), 0);
  }
  return out;
}

interface AudibleItem {
  track: Track;
  item: MediaItem;
  file: FileInfo;
}

function collect(
  project: Project,
  file: (id: string) => FileInfo,
  r0: number,
  r1: number,
): AudibleItem[] {
  const out: AudibleItem[] = [];
  for (const track of project.tracks) {
    if (track.muted || track.hidden) continue;
    for (const item of track.items) {
      if (item.type !== 'audio' && item.type !== 'video') continue;
      if (item.type === 'video' && !item.audioEnabled) continue;
      if (item.freezeAtSec !== null) continue; // a frozen picture has no sound
      if (itemEnd(item) <= r0 || item.startSec >= r1) continue;
      const f = file(item.assetId);
      if (!f.hasAudio && f.kind !== 'audio') continue;
      out.push({ track, item, file: f });
    }
  }
  return out;
}

/** Crossfade factor of an item inside a transition overlap (video-like tracks only). */
function crossFactor(track: Track, item: Item, T: number): number {
  if (track.kind !== 'video' && track.kind !== 'overlay' && track.kind !== 'image') return 1;
  const act = activeOnTrack(track, T);
  if (!act.items.some((i) => i.id === item.id)) return 0;
  if (!act.transition) return 1;
  if (act.transition.from.id === item.id) return 1 - act.transition.progress;
  if (act.transition.to.id === item.id) return act.transition.progress;
  return 1;
}

interface Plan {
  inputs: string[][];
  /** Builds the chains with input indices starting at `base`; returns the labels of the item streams. */
  build(g: Graph, base: number): string[];
}

function planItems(
  project: Project,
  items: AudibleItem[],
  r0: number,
  r1: number,
  ranges: TimeRange[],
  notes: string[],
): Plan {
  const inputs: string[][] = [];
  const builders: ((g: Graph, base: number) => string)[] = [];
  items.forEach(({ track, item, file }, idx) => {
    const off = makeSourceOffset(item);
    const A = Math.max(item.startSec, r0);
    const B = Math.min(itemEnd(item), r1);
    const tlA = A - item.startSec;
    const tlB = B - item.startSec;
    const span = off(item.durationSec);
    const ramp = item.speedCurve.length > 0;
    interface Seg {
      u0: number;
      u1: number;
      rate: number;
    }
    const segs: Seg[] = [];
    const srcWin = (c0: number, c1: number): [number, number] =>
      item.reverse
        ? [Math.max(0, item.inSec + span - c1), Math.max(0, item.inSec + span - c0)]
        : [item.inSec + c0, item.inSec + c1];
    if (!ramp) {
      const [u0, u1] = srcWin(off(tlA), off(tlB));
      segs.push({ u0, u1, rate: item.speed });
    } else {
      const n = Math.max(1, Math.ceil((tlB - tlA) / RAMP_SEG - 1e-9));
      for (let i = 0; i < n; i++) {
        const a = tlA + ((tlB - tlA) * i) / n;
        const b = tlA + ((tlB - tlA) * (i + 1)) / n;
        const [u0, u1] = srcWin(off(a), off(b));
        segs.push({ u0, u1, rate: Math.max(0.1, (off(b) - off(a)) / (b - a)) });
      }
    }
    const lo = Math.min(...segs.map((s) => s.u0));
    const hi = Math.max(...segs.map((s) => s.u1));
    const seek = Math.max(0, lo - 0.05);
    const argsIn = ['-ss', num(seek, 4), '-t', num(hi - seek + 0.1, 4), '-i', file.path];
    const inputIdx = inputs.length;
    inputs.push(argsIn);

    // ---- gain function (timeline time)
    const duck = track.ducking.enabled && (track.kind === 'audio' || track.kind === 'sfx');
    const gainAt = (T: number): number =>
      itemGainAt(item, T - item.startSec) *
      track.gain *
      (duck ? duckGainAt(ranges, track.ducking, T) : 1) *
      crossFactor(track, item, Math.min(T, itemEnd(item) - 1e-5));
    const breaks: number[] = [A, B];
    const eps = 1e-4;
    for (const k of item.volume.kf) breaks.push(item.startSec + k.t - eps, item.startSec + k.t, item.startSec + k.t + eps);
    if (item.fadeInSec > 0) breaks.push(item.startSec + item.fadeInSec);
    if (item.fadeOutSec > 0) breaks.push(B - item.fadeOutSec, itemEnd(item) - item.fadeOutSec);
    if (duck) breaks.push(...duckBreakpoints(ranges, track.ducking, project.tracks.length ? r1 + 1 : r1));
    const tin = item.type === 'video' ? item.transitionIn : null;
    if (tin) breaks.push(item.startSec, item.startSec + tin.durationSec);
    // outgoing side of a neighbour's transition
    for (const o of track.items) {
      const t2 = o.type === 'video' || o.type === 'image' ? o.transitionIn : null;
      if (t2 && o.startSec < itemEnd(item) && o.startSec + t2.durationSec > item.startSec)
        breaks.push(o.startSec, o.startSec + t2.durationSec);
    }
    const inRange = breaks.filter((b) => b >= A - 1e-9 && b <= B + 1e-9).map((b) => Math.min(B, Math.max(A, b)));
    const knots = adaptiveKnots(gainAt, inRange, 0.003).map((k) => ({ t: k.t - r0, v: k.v }));
    const times = knots.map((k) => k.t);
    const values = knots.map((k) => k.v);
    const series = toSeries(times, values, 0.001);
    const unity = series.kind === 'const' && Math.abs(series.v - 1) < 0.001;

    builders.push((g, base) => {
      const src = `${base + inputIdx}:a:0`;
      let cur: string;
      const clipF = (s: Seg): string[] => {
        const f: string[] = [
          filt('atrim', { start: num(s.u0 - seek, 6), end: num(s.u1 - seek, 6) }),
          'asetpts=PTS-STARTPTS',
        ];
        if (item.reverse) f.push('areverse');
        if (Math.abs(s.rate - 1) > 1e-6) {
          if (item.preservePitch) f.push(...tempoChain(s.rate));
          else f.push(`asetrate=${num(RATE * s.rate, 3)}`, `aresample=${RATE}`);
        }
        return f;
      };
      const pre = g.add([src], [FORMAT]);
      if (segs.length === 1) {
        cur = g.add([pre], clipF(segs[0] as Seg));
      } else {
        const outs = segs.map(() => g.label('as'));
        g.chains.push(`[${pre}]asplit=${segs.length}${outs.map((o) => `[${o}0]`).join('')}`);
        const done = segs.map((s, i) => g.add([`${outs[i]}0`], [...clipF(s), FORMAT]));
        cur = g.add(done, [`concat=n=${done.length}:v=0:a=1`]);
      }
      const f: string[] = [];
      if (item.noiseGate) {
        f.push(filt('agate', { threshold: num(GATE_THRESHOLD, 6), ratio: 10, attack: 10, release: 120 }));
      }
      f.push(filt('atrim', { end: num(tlB - tlA, 6) }));
      const delaySamples = Math.round((A - r0) * RATE);
      if (delaySamples > 0) f.push(`adelay=${delaySamples}S:all=1`);
      if (!unity) {
        f.push('asetnsamples=n=480:p=0');
        f.push(
          filt('volume', {
            volume: q(seriesExpr(series)),
            eval: 'frame',
            precision: 'float',
          }),
        );
      }
      return g.add([cur], f);
    });
  });
  void notes;
  return { inputs, build: (g, base) => builders.map((b) => b(g, base)) };
}

export async function buildAudio(a: {
  project: Project;
  settings: ExportSettings;
  grid: Grid;
  file(id: string): FileInfo;
  inputBase: number;
  measure: { ffmpegPath: string; enabled: boolean };
  notes: string[];
}): Promise<AudioBuild | null> {
  const { project, settings, grid } = a;
  const r0 = grid.r0;
  const D = grid.n / grid.fps;
  const r1 = r0 + D;
  const items = collect(project, a.file, r0, r1);
  if (items.length === 0) return null;
  const ranges = speechRanges(project);
  const notes: string[] = [];
  const plan = planItems(project, items, r0, r1, ranges, notes);

  const make = (base: number, filterTail: string | null): AudioBuild => {
    const g = new Graph(base, 'au');
    const labels = plan.build(g, base);
    const mixed =
      labels.length === 1
        ? (labels[0] as string)
        : g.add(labels, [
            `amix=inputs=${labels.length}:normalize=0:duration=longest:dropout_transition=0`,
          ]);
    const tail = [`apad=whole_dur=${num(D, 6)}`, `atrim=end=${num(D, 6)}`];
    if (filterTail) tail.push(filterTail);
    const out = g.add([mixed], [FORMAT, ...tail], 'aout');
    return {
      inputs: plan.inputs,
      graph: g.text(),
      out,
      notes,
      withBase: (b) => make(b, filterTail),
    };
  };
  const target = settings.loudnessLufs;
  let tail: string | null = null;
  if (target !== null) {
    if (a.measure.enabled) {
      const probe = make(0, null);
      // the measuring pass mixes everything that will be exported, then loudnorm prints the stats
      const m = await measureLoudnessGraph(
        a.measure.ffmpegPath,
        probe.inputs.flat(),
        probe.graph,
        probe.out,
        target,
      );
      tail = buildAudioFilter(m, target, D);
      notes.push(
        m
          ? `loudnorm two-pass: measured ${m.inputI} LUFS / ${m.inputTP} dBTP → ${target} LUFS`
          : 'loudnorm skipped: the mix is silent',
      );
    } else {
      tail = `loudnorm=I=${target}:TP=-1.5:LRA=11,aresample=${RATE}`;
      notes.push('loudnorm single pass (measuring pass disabled)');
    }
  }
  const built = make(a.inputBase, tail);
  built.notes.push(`audio: ${items.length} item(s) mixed`);
  return built;
}
