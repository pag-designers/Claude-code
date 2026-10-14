/**
 * Project JSON → FFmpeg (BRIEF §5). `createExportCompiler()` implements the `ExportCompiler` contract
 * (electron/main/pipeline/contracts3.ts). Semantics come from shared/editor-eval.ts only; see README.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  exportSettingsSchema,
  projectSchema,
  type ExportSettings,
  type Item,
  type Project,
  type Track,
} from '@shared/editor';
import { projectDuration } from '@shared/editor-eval';
import type {
  CompileExportArgs,
  CompiledExport,
  EditorAssetFile,
  ExportCompiler,
} from '../../pipeline/contracts3';
import { unpackedPath } from '../binaries';
import { canEncode } from '../render/encoder';
import { probeStreams, runFfmpeg } from '../render/ffmpeg';
import { buildAudio } from './audio';
import { Chain, Graph, filt, pathOpt, q } from './graph';
import { buildSubtitleCues, buildTrackOverlays, type OverlayLayer } from './overlays';
import { num } from './pl';
import { makeGrid, trackFrames, type Grid } from './timeline';
import type { Ctx, FileInfo, PlacedLayer } from './types';
import { applyOpacityFor, compileMediaItem, toYuvLayer, yuvEligible } from './video';

export class ExportCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportCompileError';
  }
}

export interface ExportCompilerOptions {
  /** ffmpeg binary used for the loudness measuring pass / probing / encoder check (default: ffmpeg-static). */
  ffmpegPath?: string;
  /** Run the loudnorm measuring pass (default true when settings.loudnessLufs is set and the project has audio). */
  measureLoudness?: boolean;
  /** Option name for the filtergraph file: '-filter_complex_script' (default; works on 6.x/7.x) or '-/filter_complex' (7+). */
  filterScriptFlag?: string;
}

function defaultFfmpeg(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const p = require('ffmpeg-static') as string | null;
  if (!p) throw new ExportCompileError('Bundled ffmpeg binary not found.');
  return unpackedPath(p);
}

/** True when the first video stream carries a YUV colour-matrix tag (printed in the ffmpeg banner). */
async function hasColorTag(ffmpegPath: string, file: string): Promise<boolean> {
  try {
    const r = await runFfmpeg(ffmpegPath, ['-hide_banner', '-nostdin', '-i', file], {
      timeoutMs: 20_000,
    });
    const m = /Video:[^\n]*?yuv[a-z0-9]*\(([^)]*)\)/.exec(r.stderr);
    if (!m?.[1]) return false;
    return m[1]
      .split(',')
      .some((t) =>
        /^(bt709|bt470bg|smpte170m|bt2020nc|bt2020c|smpte240m|fcc|ycgco)/.test(t.trim()),
      );
  } catch {
    return true; // cannot tell: let ffmpeg use the frame tag
  }
}

const even = (v: number): number => Math.max(2, 2 * Math.round(v / 2));

/** quality 0..100 → CRF 30..16. */
export const crfFromQuality = (quality: number): number =>
  Math.round(30 - (14 * Math.min(100, Math.max(0, quality))) / 100);

export type EncoderName = CompileExportArgs['encoder'];

export function videoEncoderArgs(
  encoder: EncoderName,
  s: Pick<ExportSettings, 'rateMode' | 'quality' | 'videoKbps' | 'fps'>,
): string[] {
  const gop = String(Math.max(12, Math.round(s.fps * 2)));
  const crf = crfFromQuality(s.quality);
  const kbps = s.videoKbps;
  switch (encoder) {
    case 'h264_nvenc':
      return [
        '-c:v',
        'h264_nvenc',
        '-preset',
        'p5',
        '-tune',
        'hq',
        '-rc',
        'vbr',
        ...(s.rateMode === 'bitrate'
          ? ['-b:v', `${kbps}k`, '-maxrate', `${Math.round(kbps * 1.5)}k`]
          : ['-cq', String(crf), '-b:v', '0']),
        '-bufsize',
        `${Math.round(kbps * 2)}k`,
        '-profile:v',
        'high',
        '-g',
        gop,
      ];
    case 'h264_videotoolbox': {
      const target = s.rateMode === 'bitrate' ? kbps : Math.round(kbps * (0.5 + s.quality / 100));
      return [
        '-c:v',
        'h264_videotoolbox',
        '-b:v',
        `${target}k`,
        '-maxrate',
        `${Math.round(target * 1.5)}k`,
        '-profile:v',
        'high',
        '-allow_sw',
        '1',
        '-g',
        gop,
      ];
    }
    default:
      return [
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        ...(s.rateMode === 'bitrate'
          ? [
              '-b:v',
              `${kbps}k`,
              '-maxrate',
              `${Math.round(kbps * 1.5)}k`,
              '-bufsize',
              `${kbps * 2}k`,
            ]
          : ['-crf', String(crf)]),
        '-profile:v',
        'high',
        '-g',
        gop,
      ];
  }
}

const isVisualTrack = (t: Track): boolean =>
  t.kind === 'video' || t.kind === 'overlay' || t.kind === 'image';

export function createExportCompiler(options: ExportCompilerOptions = {}): ExportCompiler {
  return {
    async compile(args: CompileExportArgs): Promise<CompiledExport> {
      const ffmpegPath = options.ffmpegPath ?? defaultFfmpeg();
      const notes: string[] = [];

      /* ---------------------------------------------------- validate ---- */
      const parsed = projectSchema.safeParse(args.project);
      if (!parsed.success) {
        throw new ExportCompileError(
          `The project is not valid: ${parsed.error.issues
            .slice(0, 3)
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; ')}`,
        );
      }
      const project: Project = parsed.data;
      const settings = exportSettingsSchema.parse(args.settings);
      const total = projectDuration(project);
      const r0 = args.range ? Math.max(0, args.range.startSec) : 0;
      const r1 = args.range ? args.range.endSec : total;
      if (!(r1 > r0)) {
        throw new ExportCompileError(
          args.range ? 'The export range is empty.' : 'The project is empty: nothing to export.',
        );
      }
      const fps = settings.fps;
      const grid: Grid = makeGrid(fps, r0, r1 - r0);
      const durationSec = grid.n / fps;
      await fs.promises.mkdir(args.workDir, { recursive: true });

      /* ------------------------------------------------------ geometry --- */
      const cw = project.canvas.width;
      const ch = project.canvas.height;
      const K = Math.min(settings.width / cw, settings.height / ch);
      const outW = even(settings.width);
      const outH = even(settings.height);
      const W = even(cw * K);
      const H = even(ch * K);
      if (Math.abs(settings.width / settings.height - cw / ch) > 0.02) {
        notes.push(
          `export aspect ${settings.width}x${settings.height} differs from the project canvas ${cw}x${ch}: the canvas is scaled to fit and padded with the background colour`,
        );
      }

      /* ------------------------------------------------------- files ---- */
      const assetById = new Map(project.assets.map((a) => [a.id, a]));
      const fileCache = new Map<string, FileInfo>();
      const needed = new Set<string>();
      const collect = (it: Item): void => {
        if (it.type === 'video' || it.type === 'audio' || it.type === 'image')
          needed.add(it.assetId);
        if ((it.type === 'video' || it.type === 'image') && it.color.lutAssetId)
          needed.add(it.color.lutAssetId);
      };
      for (const t of project.tracks) for (const it of t.items) collect(it);
      for (const id of needed) {
        const f: EditorAssetFile | undefined = args.files[id];
        const name = assetById.get(id)?.name ?? id;
        if (!assetById.has(id))
          throw new ExportCompileError(`An item references an unknown asset "${id}".`);
        if (!f)
          throw new ExportCompileError(
            `The media file for "${name}" is not available (asset ${id}).`,
          );
        if (!fs.existsSync(f.path))
          throw new ExportCompileError(`The media file for "${name}" is missing: ${f.path}`);
        let info: FileInfo = { ...f };
        if ((f.kind === 'video' || f.kind === 'image') && (!f.width || !f.height)) {
          const st = await probeStreams(ffmpegPath, f.path);
          info = {
            ...info,
            width: st.width,
            height: st.height,
            fps: info.fps ?? st.fps,
            hasAudio: st.hasAudio,
            durationSec: info.durationSec ?? st.durationSec,
          };
          if (!info.width || !info.height)
            throw new ExportCompileError(`Cannot read the size of "${name}".`);
        }
        const asset = assetById.get(id);
        info.layoutW = asset?.width ?? info.width ?? undefined;
        info.layoutH = asset?.height ?? info.height ?? undefined;
        fileCache.set(id, info);
      }
      // HD video without a colour tag: swscale would assume BT.601, browsers / players assume BT.709
      await Promise.all(
        [...fileCache.values()]
          .filter((f) => f.kind === 'video' && ((f.height ?? 0) >= 720 || (f.width ?? 0) >= 1280))
          .map(async (f) => {
            f.forceBt709 = !(await hasColorTag(ffmpegPath, f.path));
          }),
      );
      const file = (id: string): FileInfo => {
        const f = fileCache.get(id);
        if (!f) throw new ExportCompileError(`The media file for asset ${id} is not available.`);
        return f;
      };

      /* ------------------------------------------------------- video ---- */
      const g = new Graph(0);
      const ctx: Ctx = { g, grid, fps, K, cw, ch, W, H, notes, file, yuv: false };
      const bg = project.canvas.background.replace('#', '0x');
      // the longest visual media item decides the stack format: an opaque cover picture stays in yuv420p (no RGB round trip)
      {
        let best = 0;
        let eligible = false;
        for (const track of project.tracks) {
          if (track.hidden || !isVisualTrack(track)) continue;
          const tf = trackFrames(track, grid);
          for (const item of track.items) {
            if (item.type !== 'video' && item.type !== 'image') continue;
            const info = tf.items.get(item.id);
            if (!info || info.jb - info.ja <= best) continue;
            best = info.jb - info.ja;
            eligible = yuvEligible(ctx, item, info);
          }
        }
        ctx.yuv = eligible;
      }
      let stack = ctx.yuv
        ? g.source([
            filt('color', { c: bg, s: `${W}x${H}`, r: fps, d: num(durationSec, 6) }),
            'format=rgb24',
            filt('scale', { out_color_matrix: 'bt709', out_range: 'tv' }),
            'format=yuv420p',
          ])
        : g.source([
            filt('color', { c: bg, s: `${W}x${H}`, r: fps, d: num(durationSec, 6) }),
            'format=rgba',
          ]);
      const lutPath = (id: string): string => file(id).path;

      for (const track of project.tracks) {
        if (track.hidden) continue;
        const frames = trackFrames(track, grid);
        // --- picture layers (video / image items)
        const placed: PlacedLayer[] = [];
        if (isVisualTrack(track)) {
          for (const item of track.items) {
            if (item.type !== 'video' && item.type !== 'image') continue;
            const info = frames.items.get(item.id);
            if (!info) continue;
            placed.push(...compileMediaItem(ctx, item, info, { lut: lutPath }));
          }
        }
        for (const l of placed) {
          stack = drawLayer(ctx, stack, l);
        }
        // --- dip veils of this track
        stack = drawVeils(ctx, stack, frames.veils);
        // --- text / shapes / subtitles (ASS)
        const overlays = await buildTrackOverlays({
          ctx,
          track,
          frames,
          workDir: args.workDir,
          fontsDir: args.fontsDir,
          settings,
          getStyle: args.getStyle,
          captions: args.captions,
        });
        for (const o of overlays) {
          stack = drawOverlay(ctx, stack, o, args.fontsDir);
        }
      }

      // final conversion: pad to export size, RGB → BT.709 limited-range yuv420p
      const fin = new Chain(g, stack);
      if (outW !== W || outH !== H) {
        fin.push(
          filt('pad', {
            w: outW,
            h: outH,
            x: `(ow-iw)/2`,
            y: `(oh-ih)/2`,
            color: bg,
          }),
        );
      }
      if (ctx.yuv) fin.push('setsar=1', 'format=yuv420p');
      else
        fin.push(
          'setsar=1',
          filt('scale', { out_color_matrix: 'bt709', out_range: 'tv' }),
          'format=yuv420p',
        );
      const vout = fin.flush();

      /* ------------------------------------------------------- audio ---- */
      const audio = await buildAudio({
        project,
        settings,
        grid,
        file,
        inputBase: 0,
        measure: {
          ffmpegPath,
          enabled: options.measureLoudness ?? true,
        },
        notes,
      });

      /* ------------------------------------------------------ encoder --- */
      let encoder = args.encoder;
      if (encoder !== 'libx264' && !(await canEncode(ffmpegPath, encoder))) {
        notes.push(`${encoder} is not available here: falling back to libx264`);
        encoder = 'libx264';
      }

      /* ------------------------------------------------------- assemble - */
      const inputs = [...g.inputs];
      let graphText = g.text();
      let aMap: string[] = ['-an'];
      if (audio) {
        // audio inputs come after the video inputs: rebuild with the right base index
        const a = audio.withBase(inputs.length);
        inputs.push(...a.inputs);
        graphText = `${graphText};\n${a.graph}`;
        aMap = [
          '-map',
          `[${a.out}]`,
          '-c:a',
          'aac',
          '-b:a',
          `${settings.audioKbps}k`,
          '-ar',
          '48000',
          '-ac',
          '2',
        ];
        notes.push(...a.notes);
      } else {
        notes.push('no audible items: the export has no audio stream');
      }
      const graphFile = path.join(args.workDir, 'graph.ffscript');
      await fs.promises.writeFile(graphFile, graphText, 'utf8');

      const outArgs = [
        '-hide_banner',
        '-nostdin',
        '-loglevel',
        'warning',
        '-y',
        ...inputs.flat(),
        options.filterScriptFlag ?? '-filter_complex_script',
        graphFile,
        '-map',
        `[${vout}]`,
        ...aMap,
        ...videoEncoderArgs(encoder, { ...settings, fps }),
        '-pix_fmt',
        'yuv420p',
        '-colorspace',
        'bt709',
        '-color_primaries',
        'bt709',
        '-color_trc',
        'bt709',
        '-color_range',
        'tv',
        '-fps_mode',
        'cfr',
        '-r',
        String(fps),
        '-frames:v',
        String(grid.n),
        '-t',
        num(durationSec, 6),
        '-movflags',
        '+faststart',
        '-progress',
        'pipe:1',
        '-nostats',
        args.outPath,
      ];

      const cues = buildSubtitleCues(project, r0, r1);
      notes.unshift(
        `${grid.n} frames @ ${fps} fps (${durationSec.toFixed(3)} s), ${W}x${H}${outW !== W || outH !== H ? ` padded to ${outW}x${outH}` : ''}, K=${K.toFixed(4)}, encoder ${encoder}, ${inputs.length} inputs, graph ${graphText.length} chars`,
      );
      return {
        args: outArgs,
        durationSec,
        srt: cues.srt,
        vtt: cues.vtt,
        notes,
      };
    },
  };
}

/* ------------------------------------------------------------------------------ compositing ----- */

const BLEND_MODE: Record<string, string> = {
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  add: 'addition',
  darken: 'darken',
  lighten: 'lighten',
};

/** Puts a finished RGBA layer on the stack with its blend mode. */
function drawLayer(ctx: Ctx, stack: string, l: PlacedLayer): string {
  const { g } = ctx;
  if (l.blend === 'normal') {
    return g.add(
      [stack, l.label],
      [
        filt('overlay', {
          x: l.x,
          y: l.y,
          eof_action: 'pass',
          format: ctx.yuv ? 'yuv420' : 'auto',
        }),
      ],
    );
  }
  // non-normal: composite on a full-length transparent canvas, then blend through the layer's alpha
  const D = ctx.grid.n / ctx.fps;
  const canvas = g.source([
    filt('color', { c: '0x00000000', s: `${ctx.W}x${ctx.H}`, r: ctx.fps, d: num(D, 6) }),
    'format=rgba',
  ]);
  const lc = g.add(
    [canvas, l.label],
    [filt('overlay', { x: l.x, y: l.y, eof_action: 'pass', format: 'auto' })],
  );
  return blendOnto(ctx, stack, lc, l.blend, l.ja, l.jb);
}

/** `layerCanvas` is a full-length RGBA canvas with the layer drawn on it. */
function blendOnto(
  ctx: Ctx,
  stack: string,
  layerCanvas: string,
  mode: string,
  ja: number,
  jb: number,
): string {
  const { g } = ctx;
  const t0 = num(ja / ctx.fps - 0.5 / ctx.fps);
  const t1 = num(jb / ctx.fps - 0.5 / ctx.fps);
  const gate = q(`between(t,${t0},${t1})`);
  const a = g.label('ba');
  const b = g.label('bb');
  g.chains.push(`[${layerCanvas}]split=2[${a}][${b}]`);
  const mask = g.add([a], ['alphaextract']);
  const top = g.add([b], ['format=gbrp']);
  const s0 = g.label('bs');
  const s1 = g.label('bt');
  const toRgb = ctx.yuv
    ? `${filt('scale', { in_color_matrix: 'bt709', in_range: 'tv', out_range: 'pc' })},format=gbrp`
    : 'format=gbrp';
  g.chains.push(`[${stack}]${toRgb},split=2[${s0}][${s1}]`);
  const blended = g.add(
    [s0, top],
    [filt('blend', { all_mode: BLEND_MODE[mode] ?? 'normal', enable: gate })],
  );
  const back = ctx.yuv
    ? [filt('scale', { out_color_matrix: 'bt709', out_range: 'tv' }), 'format=yuv420p']
    : ['format=rgba'];
  return g.add([s1, blended, mask], [filt('maskedmerge', { enable: gate }), ...back]);
}

function drawVeils(
  ctx: Ctx,
  stack: string,
  veils: Map<number, { color: '#000000' | '#FFFFFF'; alpha: number }>,
): string {
  if (veils.size === 0) return stack;
  const js = [...veils.keys()].sort((a, b) => a - b);
  const runs: number[][] = [];
  for (const j of js) {
    const last = runs[runs.length - 1];
    if (last && (last[last.length - 1] as number) === j - 1) last.push(j);
    else runs.push([j]);
  }
  let cur = stack;
  for (const run of runs) {
    const ja = run[0] as number;
    const first = veils.get(ja) as { color: string };
    const alphas = run.map((j) => (veils.get(j) as { alpha: number }).alpha);
    const times = run.map((j) => ctx.grid.out(j));
    const src = ctx.g.source([
      filt('color', {
        c: first.color.replace('#', '0x'),
        s: `${ctx.W}x${ctx.H}`,
        r: ctx.fps,
        d: num(run.length / ctx.fps, 6),
      }),
      'format=rgba',
      `setpts=PTS+${num(ja / ctx.fps, 6)}/TB`,
    ]);
    const c = new Chain(ctx.g, src);
    applyOpacityFor(ctx, c, times, alphas);
    let veil = c.flush();
    if (ctx.yuv) veil = toYuvLayer(ctx, veil);
    cur = ctx.g.add(
      [cur, veil],
      [filt('overlay', { x: 0, y: 0, eof_action: 'pass', format: ctx.yuv ? 'yuv420' : 'auto' })],
    );
  }
  return cur;
}

/** ASS-rendered overlay (text / shapes / subtitles). */
function drawOverlay(ctx: Ctx, stack: string, o: OverlayLayer, fontsDir: string | null): string {
  const { g } = ctx;
  const assFilter = (): string => {
    let f = `ass=filename=${pathOpt(o.assPath)}:alpha=1`;
    if (fontsDir) f += `:fontsdir=${pathOpt(fontsDir)}`;
    return f;
  };
  if (o.blend === 'normal') {
    return g.add([stack], ctx.yuv ? [assFilter()] : [assFilter(), 'format=rgba']);
  }
  const D = ctx.grid.n / ctx.fps;
  const canvas = g.source([
    filt('color', { c: '0x00000000', s: `${ctx.W}x${ctx.H}`, r: ctx.fps, d: num(D, 6) }),
    'format=rgba',
    assFilter(),
    'format=rgba',
  ]);
  return blendOnto(ctx, stack, canvas, o.blend, o.ja, o.jb);
}
