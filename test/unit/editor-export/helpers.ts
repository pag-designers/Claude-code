/** Shared helpers for the editor-export tests: synthetic media, project builders, run + decode. */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  exportSettingsSchema,
  projectSchema,
  type ExportSettings,
  type Item,
  type Project,
  type Track,
} from '../../../shared/editor';
import type { CaptionStyle } from '../../../shared/cp2';
import type { EditorAssetFile } from '../../../electron/main/pipeline/contracts3';
import { createCaptionService, builtinStyles } from '../../../electron/main/services/captions';
import { createExportCompiler } from '../../../electron/main/services/editor-export';

export const FFMPEG = path.resolve(__dirname, '../../../node_modules/ffmpeg-static/ffmpeg');
export const FFPROBE = path.resolve(
  __dirname,
  '../../../node_modules/ffprobe-static/bin/linux/x64/ffprobe',
);
export const FONTS_DIR = path.resolve(__dirname, '../../../electron/main/assets/fonts');
export const FIXTURE_NEWS =
  '/tmp/claude-0/-home-user-Claude-code/389612c4-f895-58c2-a3c2-02cb884e9ba1/scratchpad/fixtures/news-3min.mp4';
export const SCRATCH =
  '/tmp/claude-0/-home-user-Claude-code/389612c4-f895-58c2-a3c2-02cb884e9ba1/scratchpad/editor-export-work';

export const haveFfmpeg = fs.existsSync(FFMPEG);

let work: string | null = null;
/** One scratch directory per test process. */
export function workRoot(): string {
  if (!work) {
    fs.mkdirSync(SCRATCH, { recursive: true });
    work = fs.mkdtempSync(path.join(SCRATCH, 'run-'));
  }
  return work;
}

export function tmp(name: string): string {
  const d = path.join(workRoot(), name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function ff(args: string[], opts: { maxBuffer?: number } = {}): Buffer {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-nostdin', '-v', 'error', '-y', ...args], {
    maxBuffer: opts.maxBuffer ?? 1 << 28,
  });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr.toString()}\nargs: ${args.join(' ')}`);
  return r.stdout;
}

/* ------------------------------------------------------------------ synthetic media ------------ */

const cache = new Map<string, string>();
const BT709 = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];
const TO_YUV = 'format=rgb24,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p';

function memo(key: string, make: (out: string) => void): string {
  const hit = cache.get(key);
  if (hit && fs.existsSync(hit)) return hit;
  const out = path.join(tmp('media'), `${key.replace(/[^a-z0-9_.-]/gi, '_')}.mp4`);
  make(out);
  cache.set(key, out);
  return out;
}

/** Flat colour clip (BT.709 tagged), no audio. */
export function flatClip(color: string, dur: number, w = 160, h = 284, fps = 30): string {
  return memo(`flat-${color}-${dur}-${w}x${h}-${fps}`, (out) =>
    ff([
      '-f', 'lavfi', '-i', `color=c=0x${color}:s=${w}x${h}:r=${fps}:d=${dur}`,
      '-vf', TO_YUV, ...BT709, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '10', out,
    ]),
  );
}

/** Quadrant clip: TL red, TR green, BL blue, BR yellow (exact halves). */
export function quadClip(dur: number, w = 160, h = 284, fps = 30): string {
  return memo(`quad-${dur}-${w}x${h}-${fps}`, (out) =>
    ff([
      '-f', 'lavfi', '-i', `color=c=black:s=${w}x${h}:r=${fps}:d=${dur}`,
      '-vf',
      `drawbox=x=0:y=0:w=${w / 2}:h=${h / 2}:color=0xFF0000:t=fill,drawbox=x=${w / 2}:y=0:w=${w / 2}:h=${h / 2}:color=0x00FF00:t=fill,drawbox=x=0:y=${h / 2}:w=${w / 2}:h=${h / 2}:color=0x0000FF:t=fill,drawbox=x=${w / 2}:y=${h / 2}:w=${w / 2}:h=${h / 2}:color=0xFFFF00:t=fill,${TO_YUV}`,
      ...BT709, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '10', out,
    ]),
  );
}

/** Frame-index clip: frame n encodes n in colour (r = n%16, g = n/16, steps of 16 levels); `frameLevels` recovers n. */
export function indexClip(frames: number, fps = 30, w = 32, h = 32): string {
  return memo(`idx2-${frames}-${fps}-${w}x${h}`, (out) =>
    ff([
      '-f', 'lavfi', '-i', `color=c=black:s=${w}x${h}:r=${fps}:d=${frames / fps + 0.001}`,
      '-vf', `format=gbrp,geq=r='mod(N,16)*16+8':g='floor(N/16)*16+8':b=128,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p`,
      ...BT709, '-c:v', 'libx264', '-qp', '0', '-preset', 'ultrafast', out,
    ]),
  );
}

/** Source frame indices shown by every frame of an `indexClip`-based export (-1 for black / no picture). */
export function frameLevels(file: string): number[] {
  const out = ff([
    '-i', file,
    '-vf', 'scale=1:1:flags=area:in_color_matrix=bt709:in_range=tv:out_range=pc,format=rgb24',
    '-f', 'rawvideo', '-',
  ]);
  const res: number[] = [];
  for (let i = 0; i + 2 < out.length; i += 3) {
    const r = out[i] as number;
    const g = out[i + 1] as number;
    const b = out[i + 2] as number;
    res.push(b < 60 ? -1 : Math.floor(g / 16) * 16 + Math.floor(r / 16));
  }
  return res;
}

/** Sine tone (mono) as wav, optional second-level amplitude. */
export function sineWav(freq: number, dur: number, amp = 0.5, rate = 48000, ch = 1): string {
  const key = `sine-${freq}-${dur}-${amp}-${rate}-${ch}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const out = path.join(tmp('media'), `${key}.wav`);
  ff(['-f', 'lavfi', '-i', `sine=f=${freq}:r=${rate}:d=${dur}`, '-af', `volume=${amp * 8},aformat=channel_layouts=${ch === 1 ? 'mono' : 'stereo'}`, out]);
  cache.set(key, out);
  return out;
}

/** Video with a sine audio track. */
export function avClip(color: string, freq: number, dur: number, amp = 0.5, w = 160, h = 284): string {
  const key = `av-${color}-${freq}-${dur}-${amp}-${w}x${h}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const out = path.join(tmp('media'), `${key}.mp4`);
  ff([
    '-f', 'lavfi', '-i', `color=c=0x${color}:s=${w}x${h}:r=30:d=${dur}`,
    '-f', 'lavfi', '-i', `sine=f=${freq}:r=48000:d=${dur}`,
    '-vf', TO_YUV, '-af', `volume=${amp * 8}`, ...BT709,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '10', '-c:a', 'aac', '-b:a', '192k', '-shortest', out,
  ]);
  cache.set(key, out);
  return out;
}

export function pngImage(color: string, w: number, h: number): string {
  const key = `png-${color}-${w}x${h}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const out = path.join(tmp('media'), `${key}.png`);
  ff(['-f', 'lavfi', '-i', `color=c=0x${color}:s=${w}x${h}`, '-frames:v', '1', out]);
  cache.set(key, out);
  return out;
}

/* ------------------------------------------------------------------ project builders ----------- */

export interface AssetSpec {
  id: string;
  kind: 'video' | 'audio' | 'image' | 'lut';
  path: string;
  w?: number;
  h?: number;
  fps?: number;
  dur?: number;
  hasAudio?: boolean;
}

export function files(specs: AssetSpec[]): Record<string, EditorAssetFile> {
  const out: Record<string, EditorAssetFile> = {};
  for (const s of specs)
    out[s.id] = {
      assetId: s.id,
      kind: s.kind,
      path: s.path,
      width: s.w ?? null,
      height: s.h ?? null,
      fps: s.fps ?? null,
      durationSec: s.dur ?? null,
      hasAudio: s.hasAudio ?? false,
    };
  return out;
}

export function assetsOf(specs: AssetSpec[]): Project['assets'] {
  return specs.map((s) => ({
    id: s.id,
    kind: s.kind,
    name: s.id,
    source: { kind: 'upload' as const, key: `k/${s.id}`, fileName: path.basename(s.path) },
    durationSec: s.dur ?? null,
    width: s.w ?? null,
    height: s.h ?? null,
    fps: s.fps ?? null,
    hasAudio: s.hasAudio ?? false,
    beats: null,
  }));
}

type AnyItem = Record<string, unknown>;
/** Parse partial item through the schema (fills defaults). */
export function item(over: AnyItem): Item {
  return over as unknown as Item;
}

export function track(kind: Track['kind'], items: AnyItem[], over: Partial<Track> = {}): Track {
  return {
    id: `t-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    name: kind,
    locked: false,
    muted: false,
    hidden: false,
    gain: 1,
    speech: kind === 'video',
    ducking: { enabled: false, reductionDb: 12, attackSec: 0.15, releaseSec: 0.5 },
    items: items as unknown as Item[],
    ...over,
  } as Track;
}

export const kf = (t: number, v: number, ease: 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'hold' = 'linear') => ({ t, v, ease });

export function makeProject(
  tracks: Track[],
  assets: AssetSpec[],
  canvas: Partial<Project['canvas']> = {},
): Project {
  return projectSchema.parse({
    canvas: { aspect: 'custom', width: 160, height: 284, fps: 30, background: '#000000', ...canvas },
    tracks: tracks.map((t) => ({
      ...t,
      items: t.items.map((i) => ({ ...(i as unknown as AnyItem) })),
    })),
    assets: assetsOf(assets),
  });
}

export function vitem(id: string, assetId: string, startSec: number, durationSec: number, over: AnyItem = {}): AnyItem {
  return { type: 'video', id, assetId, startSec, durationSec, ...over };
}

export function settingsFor(w: number, h: number, over: Partial<ExportSettings> = {}): ExportSettings {
  return exportSettingsSchema.parse({
    preset: 'custom', width: w, height: h, fps: 30, quality: 100, loudnessLufs: null, burnCaptions: true, ...over,
  });
}

/* ------------------------------------------------------------------ compile + run -------------- */

const captions = createCaptionService({ fontsDir: FONT_DIR_OR_NULL() });
function FONT_DIR_OR_NULL(): string | null {
  return fs.existsSync(FONTS_DIR) ? FONTS_DIR : null;
}
const styleMap = new Map<string, CaptionStyle>(builtinStyles().map((s) => [s.id, s]));
export const getStyle = (id: string): CaptionStyle => styleMap.get(id) ?? (styleMap.get('clean-pop') as CaptionStyle);

export interface RunResult {
  out: string;
  args: string[];
  graph: string;
  notes: string[];
  srt: string | null;
  vtt: string | null;
  durationSec: number;
  ms: number;
}

let runSeq = 0;
export async function exportProject(
  project: Project,
  fileMap: Record<string, EditorAssetFile>,
  settings: ExportSettings,
  extra: {
    range?: { startSec: number; endSec: number };
    name?: string;
    encoder?: 'libx264' | 'h264_nvenc' | 'h264_videotoolbox';
    measureLoudness?: boolean;
    run?: boolean;
  } = {},
): Promise<RunResult> {
  const dir = tmp(`export-${extra.name ?? 'x'}-${runSeq++}`);
  const out = path.join(dir, 'out.mp4');
  const compiler = createExportCompiler({ ffmpegPath: FFMPEG, measureLoudness: extra.measureLoudness ?? true });
  const t0 = Date.now();
  const c = await compiler.compile({
    project, settings, files: fileMap, workDir: dir, outPath: out, fontsDir: FONTS_DIR,
    encoder: extra.encoder ?? 'libx264', range: extra.range, getStyle, captions,
  });
  if (extra.run !== false) {
    const r = spawnSync(FFMPEG, c.args, { maxBuffer: 1 << 28 });
    if (r.status !== 0) {
      throw new Error(`export failed (${r.status}): ${r.stderr.toString().slice(-3000)}\nnotes: ${c.notes.join(' | ')}`);
    }
  }
  const graphIdx = c.args.indexOf('-filter_complex_script');
  const graph = graphIdx >= 0 ? fs.readFileSync(c.args[graphIdx + 1] as string, 'utf8') : '';
  return { out, args: c.args, graph, notes: c.notes, srt: c.srt, vtt: c.vtt, durationSec: c.durationSec, ms: Date.now() - t0 };
}

/* ------------------------------------------------------------------ decode -------------------- */

export interface Frame {
  w: number;
  h: number;
  rgb: Buffer;
  px(x: number, y: number): [number, number, number];
}

export function probeDims(file: string): { w: number; h: number; frames: number; dur: number; fps: number } {
  const out = execFileSync(FFPROBE, [
    '-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries',
    'stream=width,height,nb_read_frames,r_frame_rate,duration', '-of', 'json', file,
  ]).toString();
  const s = (JSON.parse(out) as { streams: { width: number; height: number; nb_read_frames: string; r_frame_rate: string; duration: string }[] }).streams[0];
  if (!s) throw new Error('no video stream');
  const [a, b] = s.r_frame_rate.split('/').map(Number) as [number, number];
  return { w: s.width, h: s.height, frames: Number(s.nb_read_frames), dur: Number(s.duration), fps: a / b };
}

/** Frame number k decoded to RGB (BT.709 limited → full). */
export function frameAt(file: string, k: number): Frame {
  const { w, h } = probeDims(file);
  const rgb = ff([
    '-i', file,
    '-vf', `select=eq(n\\,${k}),scale=in_color_matrix=bt709:in_range=tv:out_range=pc:flags=accurate_rnd+full_chroma_int,format=rgb24`,
    '-frames:v', '1', '-f', 'rawvideo', '-',
  ]);
  if (rgb.length < w * h * 3) throw new Error(`frame ${k} not found in ${file}`);
  return { w, h, rgb, px: (x, y) => { const o = (Math.round(y) * w + Math.round(x)) * 3; return [rgb[o] as number, rgb[o + 1] as number, rgb[o + 2] as number]; } };
}

/** All frames as RGB buffers (small clips only). */
export function allFrames(file: string): Frame[] {
  const { w, h } = probeDims(file);
  const rgb = ff([
    '-i', file,
    '-vf', 'scale=in_color_matrix=bt709:in_range=tv:out_range=pc:flags=accurate_rnd+full_chroma_int,format=rgb24',
    '-f', 'rawvideo', '-',
  ]);
  const n = Math.floor(rgb.length / (w * h * 3));
  const out: Frame[] = [];
  for (let k = 0; k < n; k++) {
    const buf = rgb.subarray(k * w * h * 3, (k + 1) * w * h * 3);
    out.push({ w, h, rgb: buf, px: (x, y) => { const o = (Math.round(y) * w + Math.round(x)) * 3; return [buf[o] as number, buf[o + 1] as number, buf[o + 2] as number]; } });
  }
  return out;
}

export const hexRgb = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16),
];

export function near(a: readonly number[], b: readonly number[], tol: number): boolean {
  return a.every((v, i) => Math.abs(v - (b[i] as number)) <= tol);
}

export function describe3(a: readonly number[]): string {
  return `(${a.join(',')})`;
}

/** Writes a PNG of frame k for visual inspection. */
export function savePng(file: string, k: number, out: string): void {
  ff(['-i', file, '-vf', `select=eq(n\\,${k})`, '-frames:v', '1', out]);
}

/** Contact sheet (tile) of every `step`-th frame. */
export function contactSheet(file: string, out: string, cols: number, rows: number, step: number, scaleW = 120): void {
  ff([
    '-i', file,
    '-vf', `select='not(mod(n\\,${step}))',scale=${scaleW}:-1,tile=${cols}x${rows}:padding=2:color=gray`,
    '-frames:v', '1', out,
  ]);
}

export { os };

/* ------------------------------------------------------------------ audio decode ---------------- */

export function decodeAudio(file: string): { rate: number; data: Float32Array } {
  const buf = ff(['-i', file, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-']);
  const copy = Buffer.from(buf);
  return { rate: 48000, data: new Float32Array(copy.buffer, copy.byteOffset, Math.floor(copy.length / 4)) };
}

export function rmsDb(a: { rate: number; data: Float32Array }, t0: number, t1: number): number {
  const i0 = Math.max(0, Math.floor(t0 * a.rate));
  const i1 = Math.min(a.data.length, Math.floor(t1 * a.rate));
  let s = 0;
  for (let i = i0; i < i1; i++) s += (a.data[i] as number) ** 2;
  const rms = Math.sqrt(s / Math.max(1, i1 - i0));
  return 20 * Math.log10(Math.max(1e-9, rms));
}

/** Zero crossings per second (≈ 2 × frequency for a sine). */
export function zcr(a: { rate: number; data: Float32Array }, t0: number, t1: number): number {
  const i0 = Math.max(1, Math.floor(t0 * a.rate));
  const i1 = Math.min(a.data.length, Math.floor(t1 * a.rate));
  let z = 0;
  for (let i = i0; i < i1; i++) if (((a.data[i - 1] as number) < 0) !== ((a.data[i] as number) < 0)) z++;
  return z / Math.max(1e-6, (i1 - i0) / a.rate);
}

export function peak(a: { rate: number; data: Float32Array }, t0: number, t1: number): number {
  const i0 = Math.max(0, Math.floor(t0 * a.rate));
  const i1 = Math.min(a.data.length, Math.floor(t1 * a.rate));
  let m = 0;
  for (let i = i0; i < i1; i++) m = Math.max(m, Math.abs(a.data[i] as number));
  return m;
}

/* ------------------------------------------------------------------ pixel search ---------------- */

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  n: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
}

/** Bounding box + count of the pixels matching `pred` (n = 0 → no match). */
export function bboxWhere(f: Frame, pred: (r: number, g: number, b: number) => boolean, region?: [number, number, number, number]): Box {
  const [rx0, ry0, rx1, ry1] = region ?? [0, 0, f.w, f.h];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  let n = 0;
  for (let y = ry0; y < ry1; y++) {
    for (let x = rx0; x < rx1; x++) {
      const o = (y * f.w + x) * 3;
      if (pred(f.rgb[o] as number, f.rgb[o + 1] as number, f.rgb[o + 2] as number)) {
        n++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (n === 0) return { x0: 0, y0: 0, x1: 0, y1: 0, n: 0, w: 0, h: 0, cx: 0, cy: 0 };
  return { x0, y0, x1, y1, n, w: x1 - x0 + 1, h: y1 - y0 + 1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

export const isWhite = (r: number, g: number, b: number): boolean => r > 200 && g > 200 && b > 200;
export const isRed = (r: number, g: number, b: number): boolean => r > 200 && g < 60 && b < 60;
export const isGreen = (r: number, g: number, b: number): boolean => g > 200 && r < 60 && b < 60;
export const isBlue = (r: number, g: number, b: number): boolean => b > 200 && r < 60 && g < 60;
export const isYellow = (r: number, g: number, b: number): boolean => r > 200 && g > 180 && b < 80;
export const isMagenta = (r: number, g: number, b: number): boolean => r > 200 && b > 200 && g < 80;
export const isDark = (r: number, g: number, b: number): boolean => r + g + b < 90;

/** Power (mean square) of the frequency `f` in [t0, t1) (Goertzel, mono). */
export function tonePower(a: { rate: number; data: Float32Array }, f: number, t0: number, t1: number): number {
  const i0 = Math.max(0, Math.floor(t0 * a.rate));
  const i1 = Math.min(a.data.length, Math.floor(t1 * a.rate));
  const n = i1 - i0;
  const w = (2 * Math.PI * f) / a.rate;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = i0; i < i1; i++) {
    const s = (a.data[i] as number) + c * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  const p = s1 * s1 + s2 * s2 - c * s1 * s2;
  return (2 * p) / (n * n) / 1; // amplitude² /2 ... (amp^2)/2 for a pure tone → mean square
}

/** Integrated loudness (LUFS) and true peak of a file via ffmpeg ebur128. */
export function loudness(file: string): { lufs: number; peakDb: number } {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8' });
  const sum = r.stderr.split('Summary:')[1] ?? '';
  const i = /I:\s+(-?[\d.]+) LUFS/.exec(sum);
  const p = /Peak:\s+(-?[\d.]+) dBFS/.exec(sum);
  return { lufs: i ? Number(i[1]) : NaN, peakDb: p ? Number(p[1]) : NaN };
}

export function audioStreamInfo(file: string): { codec: string; rate: number; channels: number; dur: number } | null {
  const out = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,sample_rate,channels,duration', '-of', 'json', file]).toString();
  const s = (JSON.parse(out) as { streams: { codec_name: string; sample_rate: string; channels: number; duration: string }[] }).streams[0];
  return s ? { codec: s.codec_name, rate: Number(s.sample_rate), channels: s.channels, dur: Number(s.duration) } : null;
}

/** A tone whose amplitude ramps linearly 0 → 1 over its duration (for reverse tests). */
export function rampTone(freq: number, dur: number): string {
  const key = `ramp-${freq}-${dur}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const out = path.join(tmp('media'), `${key}.wav`);
  ff(['-f', 'lavfi', '-i', `aevalsrc='sin(2*PI*${freq}*t)*t/${dur}':s=48000:d=${dur}`, '-ac', '1', out]);
  cache.set(key, out);
  return out;
}

/** Two tones back to back: f1 for the first half, f2 for the second. */
export function twoTone(f1: number, f2: number, dur: number): string {
  const key = `two-${f1}-${f2}-${dur}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const out = path.join(tmp('media'), `${key}.wav`);
  ff(['-f', 'lavfi', '-i', `aevalsrc='sin(2*PI*if(lt(t\\,${dur / 2})\\,${f1}\\,${f2})*t)':s=48000:d=${dur}`, '-ac', '1', out]);
  cache.set(key, out);
  return out;
}

/** Loud tone for 1 s, then very quiet noise for 1 s. */
export function toneThenNoise(): string {
  const key = 'tone-noise';
  const hit = cache.get(key);
  if (hit) return hit;
  const out = path.join(tmp('media'), `${key}.wav`);
  ff(['-f', 'lavfi', '-i', `aevalsrc='if(lt(t\\,1)\\,0.5*sin(2*PI*440*t)\\,0.0015*(random(0)-0.5)*2)':s=48000:d=2`, '-ac', '1', out]);
  cache.set(key, out);
  return out;
}
