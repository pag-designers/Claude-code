/**
 * Brand finisher on REAL ffmpeg with generated lavfi media: a testsrc clip with a sine "speech" track (0-2 s, then
 * silence), a half-transparent red logo, a 1.5 s 16:9 intro with audio, a 2 s square silent outro and a music tone.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { watermarkRect } from '../../shared/brand';
import type { FinishRequest, FinisherMedia } from '../../electron/main/pipeline/contracts4';
import {
  buildAudioGraph,
  buildVideoGraph,
  createBrandFinisher,
  duckThresholdLinear,
  finishEncoderArgs,
  type GraphPlan,
} from '../../electron/main/services/brand-finish';
import { fpsExpression, frameAligned } from '../../electron/main/services/brand-finish/graph';
import { parseLoudnormJson } from '../../electron/main/services/render/audio';
import { parseStreamInfo } from '../../electron/main/services/render/ffmpeg';

const FFMPEG = path.resolve(__dirname, '../../node_modules/ffmpeg-static/ffmpeg');
const haveFfmpeg = fs.existsSync(FFMPEG);

const W = 360;
const H = 640;
const FPS = 30;
const TARGET = -16;

const ff = (args: string[]): string => {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', ...args], {
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(' ')} failed: ${r.stderr.toString()}`);
  return r.stderr.toString();
};

const info = (file: string) =>
  parseStreamInfo(spawnSync(FFMPEG, ['-hide_banner', '-nostdin', '-i', file]).stderr.toString());

/** RGB frame at time `t` (accurate seek). */
function frame(file: string, t: number, w = W, h = H): Buffer {
  const r = spawnSync(
    FFMPEG,
    [
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'error',
      '-ss',
      t.toFixed(3),
      '-i',
      file,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  expect(r.status, r.stderr.toString()).toBe(0);
  expect(r.stdout.length).toBe(w * h * 3);
  return r.stdout;
}
const px = (f: Buffer, x: number, y: number, w = W): [number, number, number] => {
  const i = (y * w + x) * 3;
  return [f[i]!, f[i + 1]!, f[i + 2]!];
};
const dist = (a: number[], b: number[]): number =>
  Math.max(...a.map((v, i) => Math.abs(v - b[i]!)));
const isRed = (p: number[]): boolean => p[0]! > 200 && p[1]! < 60 && p[2]! < 60;

/** Mean level (dB) of the `freq` band in [ss, ss+t] of the file's audio (volumedetect; -91 = silence). */
function bandDb(file: string, ss: number, t: number, freq: number): number {
  const r = spawnSync(FFMPEG, [
    '-hide_banner',
    '-nostdin',
    '-ss',
    String(ss),
    '-t',
    String(t),
    '-i',
    file,
    '-vn',
    '-af',
    `${Array(3).fill(`bandpass=f=${freq}:width_type=h:w=60`).join(',')},volumedetect`,
    '-f',
    'null',
    '-',
  ]);
  const m = /mean_volume:\s*(-?[\d.]+|-inf)\s*dB/.exec(r.stderr.toString());
  return m && m[1] !== '-inf' ? Number(m[1]) : -120;
}
function rmsDb(file: string, ss: number, t: number): number {
  const r = spawnSync(FFMPEG, [
    '-hide_banner',
    '-nostdin',
    '-ss',
    String(ss),
    '-t',
    String(t),
    '-i',
    file,
    '-vn',
    '-af',
    'volumedetect',
    '-f',
    'null',
    '-',
  ]);
  const m = /mean_volume:\s*(-?[\d.]+|-inf)\s*dB/.exec(r.stderr.toString());
  return m && m[1] !== '-inf' ? Number(m[1]) : -120;
}
function loudness(file: string): { i: number; tp: number } {
  const r = spawnSync(FFMPEG, [
    '-hide_banner',
    '-nostdin',
    '-i',
    file,
    '-vn',
    '-af',
    `loudnorm=I=${TARGET}:TP=-1.5:LRA=11:print_format=json`,
    '-f',
    'null',
    '-',
  ]);
  const m = parseLoudnormJson(r.stderr.toString());
  if (!m) throw new Error('loudness not measurable');
  return { i: m.inputI, tp: m.inputTP };
}
function videoMd5(file: string): string {
  const r = spawnSync(FFMPEG, [
    '-hide_banner',
    '-nostdin',
    '-i',
    file,
    '-map',
    '0:v:0',
    '-c',
    'copy',
    '-f',
    'md5',
    '-',
  ]);
  return r.stdout.toString().trim();
}

describe('graph builders (pure)', () => {
  const plan = (over: Partial<GraphPlan> = {}): GraphPlan => ({
    canvas: { width: 1080, height: 1920 },
    fps: 30,
    fpsExpr: '30',
    pieces: [
      { kind: 'intro', inputIndex: 1, frames: 45, sec: 1.5, hasAudio: true },
      { kind: 'clip', inputIndex: 0, frames: 150, sec: 5, hasAudio: true },
      { kind: 'outro', inputIndex: 2, frames: 60, sec: 2, hasAudio: false },
    ],
    watermark: { inputIndex: 4, rect: { x: 10, y: 20, w: 300, h: 150 }, opacity: 0.5 },
    music: { inputIndex: 3, gainDb: -18, duckAmountDb: 12, fadeInSec: 0.8, fadeOutSec: 1.5 },
    totalSec: 8.5,
    ...over,
  });

  it('video: the watermark only touches the clip piece; intro/outro are fitted; hard-cut concat', () => {
    const g = buildVideoGraph(plan()).graph;
    expect(g).toContain(
      '[4:v:0]format=rgba,scale=300:150:flags=lanczos,colorchannelmixer=aa=0.5[wmk]',
    );
    expect(g.match(/overlay=/g)).toHaveLength(1);
    expect(g).toMatch(/\[0:v:0\][^;]*\[pv1pre\];/);
    expect(g).toContain('overlay=x=10:y=20');
    expect(g).toContain(
      'scale=360:640'.replace('360:640', '1080:1920') + ':force_original_aspect_ratio=decrease',
    );
    expect(g).toContain('pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black');
    expect(g).toContain('[pv0][pv1][pv2]concat=n=3:v=1:a=0[vcat];[vcat]fps=30[vout]');
    expect(g).toContain('trim=end_frame=45');
  });

  it('audio: silent track for files without audio, ducking only when enabled', () => {
    const a = buildAudioGraph(plan()).graph;
    expect(a).toContain('anullsrc=r=48000:cl=stereo');
    expect(a).toContain('sidechaincompress=');
    expect(a).toContain('attack=20:release=350');
    expect(a).toContain('concat=n=3:v=0:a=1[pa]');
    const noDuck = buildAudioGraph(
      plan({
        music: { inputIndex: 3, gainDb: -18, duckAmountDb: null, fadeInSec: 0, fadeOutSec: 0 },
      }),
    ).graph;
    expect(noDuck).not.toContain('sidechaincompress');
    expect(noDuck).not.toContain('afade');
    expect(buildAudioGraph(plan({ music: null })).graph).toContain('[pa]anull[mix]');
  });

  it('helpers: NTSC rates, frame alignment, threshold monotonic in the duck amount', () => {
    expect(fpsExpression(29.97).expr).toBe('30000/1001');
    expect(fpsExpression(30).expr).toBe('30');
    expect(fpsExpression(24).fps).toBe(24);
    expect(frameAligned(1.51, 30)).toEqual({ frames: 45, sec: 1.5 });
    expect(frameAligned(0, 30).frames).toBe(1);
    expect(duckThresholdLinear(6)).toBeGreaterThan(duckThresholdLinear(12));
    expect(duckThresholdLinear(12)).toBeGreaterThan(duckThresholdLinear(24));
    expect(finishEncoderArgs('libx264', 30)).toEqual(expect.arrayContaining(['-crf', '17']));
    expect(finishEncoderArgs('h264_nvenc', 30)).toEqual(expect.arrayContaining(['-cq', '17']));
  });
});

describe.skipIf(!haveFfmpeg)('brand finisher (real ffmpeg)', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'clipfern-brandfinish-'));
  const p = (n: string): string => path.join(work, n);
  const finisher = createBrandFinisher();

  const media = (file: string, w: number, h: number): FinisherMedia => {
    const i = info(file);
    return {
      path: file,
      hasAudio: i.hasAudio,
      durationSec: i.durationSec ?? 0,
      width: w,
      height: h,
    };
  };
  let clipM: FinishRequest['input'];
  let logoM: FinisherMedia;
  let introM: FinisherMedia;
  let outroM: FinisherMedia;
  let musicM: FinisherMedia;
  let flatM: FinishRequest['input'];

  beforeAll(() => {
    // 4 s clip: testsrc, 300 Hz tremolo "speech" for 0-2 s then silence
    ff([
      '-f',
      'lavfi',
      '-i',
      `testsrc=s=${W}x${H}:r=${FPS}:d=4`,
      '-f',
      'lavfi',
      '-i',
      "aevalsrc='if(lt(t,2),0.5*sin(2*PI*300*t)*(0.6+0.4*sin(2*PI*4*t)),0)':s=48000:d=4:c=stereo",
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-g',
      '30',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-shortest',
      p('clip.mp4'),
    ]);
    // flat colour clip (exact blend maths) with a steady tone
    ff([
      '-f',
      'lavfi',
      '-i',
      `color=c=0x3060C0:s=${W}x${H}:r=${FPS}:d=3`,
      '-f',
      'lavfi',
      '-i',
      'sine=f=300:d=3',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      p('flat.mp4'),
    ]);
    // 100x50 logo: left half opaque red, right half fully transparent
    ff([
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=100x50,format=rgba,geq=r=255:g=0:b=0:a=if(lt(X\\,50)\\,255\\,0)',
      '-frames:v',
      '1',
      p('logo.png'),
    ]);
    ff([
      '-f',
      'lavfi',
      '-i',
      'color=c=0x2060A0:s=640x360:r=25:d=1.5',
      '-f',
      'lavfi',
      '-i',
      'sine=f=500:d=1.5',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      p('intro.mp4'),
    ]);
    ff([
      '-f',
      'lavfi',
      '-i',
      'color=c=0x40A040:s=400x400:r=24:d=2',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      p('outro.mp4'),
    ]);
    ff(['-f', 'lavfi', '-i', 'sine=f=880:d=3', '-c:a', 'aac', '-b:a', '192k', p('music.m4a')]);
    clipM = { ...media(p('clip.mp4'), W, H), fps: FPS };
    flatM = { ...media(p('flat.mp4'), W, H), fps: FPS };
    logoM = { path: p('logo.png'), hasAudio: false, durationSec: 0, width: 100, height: 50 };
    introM = media(p('intro.mp4'), 640, 360);
    outroM = media(p('outro.mp4'), 400, 400);
    musicM = media(p('music.m4a'), 0, 0);
  }, 120_000);
  afterAll(() => fs.rmSync(work, { recursive: true, force: true }));

  const req = (outName: string, over: Partial<FinishRequest> = {}): FinishRequest => ({
    ffmpegPath: FFMPEG,
    input: clipM,
    outPath: p(outName),
    watermark: null,
    intro: null,
    outro: null,
    music: null,
    encoder: 'libx264',
    loudnessTarget: TARGET,
    ...over,
  });
  const wm = (
    over: Partial<NonNullable<FinishRequest['watermark']>> = {},
  ): NonNullable<FinishRequest['watermark']> => ({
    media: logoM,
    position: 'top-left',
    sizePct: 25,
    opacity: 1,
    marginPct: 5,
    safeArea: 'none',
    ...over,
  });
  const music = (
    over: Partial<NonNullable<FinishRequest['music']>> = {},
  ): NonNullable<FinishRequest['music']> => ({
    media: musicM,
    gainDb: -18,
    duckEnabled: true,
    duckAmountDb: 12,
    fadeInSec: 0.2,
    fadeOutSec: 0.3,
    ...over,
  });

  it('nothing requested: the clip is copied byte for byte', async () => {
    const r = await finisher.finish(req('noop.mp4'));
    expect(r.applied).toEqual({ watermark: false, intro: false, outro: false, music: false });
    expect(r.notes).toEqual([]);
    expect(fs.readFileSync(p('noop.mp4')).equals(fs.readFileSync(p('clip.mp4')))).toBe(true);
    expect(fs.existsSync(p('noop.mp4.partial'))).toBe(false);
    expect(r.durationSec).toBeCloseTo(4, 1);
  });

  it('watermark: logo colour inside the rect during the clip, input pixels untouched elsewhere', async () => {
    const r = await finisher.finish(req('wm.mp4', { watermark: wm() }));
    expect(r.applied.watermark).toBe(true);
    const i = info(p('wm.mp4'));
    expect([i.width, i.height]).toEqual([W, H]);
    expect(i.durationSec).toBeCloseTo(4, 1);
    const rect = watermarkRect({ width: W, height: H }, wm(), 2);
    expect(rect).toMatchObject({ x: 18, y: 18, w: 90, h: 45 });
    for (const t of [0.5, 2, 3.5]) {
      const out = frame(p('wm.mp4'), t);
      const src = frame(p('clip.mp4'), t);
      // opaque half of the logo
      for (const [fx, fy] of [
        [0.1, 0.2],
        [0.25, 0.5],
        [0.4, 0.8],
      ] as const) {
        const q = px(out, Math.round(rect.x + rect.w * fx), Math.round(rect.y + rect.h * fy));
        expect(isRed(q), `t=${t} fx=${fx}: ${q}`).toBe(true);
      }
      // transparent half: the underlying (re-encoded) picture shows through
      const tx = Math.round(rect.x + rect.w * 0.8);
      const ty = Math.round(rect.y + rect.h * 0.5);
      expect(dist(px(out, tx, ty), px(src, tx, ty))).toBeLessThan(40);
      // just outside the rect on every side equals the input
      for (const [ox, oy] of [
        [rect.x - 4, rect.y + 10],
        [rect.x + rect.w + 4, rect.y + 10],
        [rect.x + 20, rect.y - 4],
        [rect.x + 20, rect.y + rect.h + 4],
      ] as const) {
        expect(isRed(px(out, ox, oy))).toBe(false);
      }
      // everywhere outside the rect: mean abs error vs the input is tiny (crf 17 on top of crf 23)
      let sum = 0;
      let n = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (
            x >= rect.x - 3 &&
            x < rect.x + rect.w + 3 &&
            y >= rect.y - 3 &&
            y < rect.y + rect.h + 3
          )
            continue;
          const a = px(out, x, y);
          const b = px(src, x, y);
          sum += Math.abs(a[0]! - b[0]!) + Math.abs(a[1]! - b[1]!) + Math.abs(a[2]! - b[2]!);
          n += 3;
        }
      }
      expect(sum / n).toBeLessThan(2.5);
    }
  }, 60_000);

  it('watermark only: the clip audio stream is copied untouched', async () => {
    await finisher.finish(req('wmaudio.mp4', { watermark: wm() }));
    const a = spawnSync(FFMPEG, [
      '-hide_banner',
      '-nostdin',
      '-i',
      p('clip.mp4'),
      '-map',
      '0:a:0',
      '-c',
      'copy',
      '-f',
      'md5',
      '-',
    ]).stdout.toString();
    const b = spawnSync(FFMPEG, [
      '-hide_banner',
      '-nostdin',
      '-i',
      p('wmaudio.mp4'),
      '-map',
      '0:a:0',
      '-c',
      'copy',
      '-f',
      'md5',
      '-',
    ]).stdout.toString();
    expect(b).toBe(a);
  }, 60_000);

  it('opacity blends the logo with the picture (and position/size follow watermarkRect)', async () => {
    await finisher.finish(
      req('op.mp4', {
        input: flatM,
        watermark: wm({ opacity: 0.5, position: 'bottom-right', sizePct: 30 }),
      }),
    );
    const rect = watermarkRect(
      { width: W, height: H },
      wm({ position: 'bottom-right', sizePct: 30 }),
      2,
    );
    expect(rect.x + rect.w).toBeLessThanOrEqual(W - 17);
    expect(rect.y + rect.h).toBeLessThanOrEqual(H - 17);
    const out = frame(p('op.mp4'), 1);
    const inside = px(out, Math.round(rect.x + rect.w * 0.25), Math.round(rect.y + rect.h * 0.5));
    // 0.5 * red + 0.5 * (0x30,0x60,0xC0)
    expect(dist(inside, [151.5, 48, 96])).toBeLessThan(10);
    // fully opaque would be pure red, fully transparent the flat colour
    expect(isRed(inside)).toBe(false);
    expect(
      dist(
        px(out, Math.round(rect.x + rect.w * 0.9), Math.round(rect.y + rect.h * 0.5)),
        [0x30, 0x60, 0xc0],
      ),
    ).toBeLessThan(8);
    // nothing at the top-left
    expect(dist(px(out, 20, 20), [0x30, 0x60, 0xc0])).toBeLessThan(8);
  }, 60_000);

  it('intro + clip + outro: exact length, fitted to the clip, watermark only during the clip', async () => {
    const r = await finisher.finish(
      req('join.mp4', { watermark: wm(), intro: introM, outro: outroM }),
    );
    expect(r.applied).toEqual({ watermark: true, intro: true, outro: true, music: false });
    expect(r.notes).toEqual([]);
    const i = info(p('join.mp4'));
    expect([i.width, i.height]).toEqual([W, H]);
    expect(i.fps).toBeCloseTo(FPS, 1);
    expect(i.hasAudio).toBe(true);
    const expected = 1.5 + 4 + 2;
    expect(Math.abs((i.durationSec ?? 0) - expected)).toBeLessThan(0.07);
    expect(Math.abs(r.durationSec - expected)).toBeLessThan(0.07);

    const rect = watermarkRect({ width: W, height: H }, wm(), 2);
    const probe = (t: number): [number, number, number] =>
      px(
        frame(p('join.mp4'), t),
        Math.round(rect.x + rect.w * 0.25),
        Math.round(rect.y + rect.h * 0.5),
      );
    // intro (0-1.5): no logo; clip (1.5-5.5): logo; outro (5.5-7.5): no logo
    for (const t of [0.1, 0.7, 1.4]) expect(isRed(probe(t)), `intro t=${t}`).toBe(false);
    for (const t of [1.6, 3.0, 5.4]) expect(isRed(probe(t)), `clip t=${t}`).toBe(true);
    for (const t of [5.6, 6.5, 7.4]) expect(isRed(probe(t)), `outro t=${t}`).toBe(false);

    // intro (16:9) is letterboxed into the 9:16 canvas: black bars, picture in the middle
    const intro = frame(p('join.mp4'), 0.7);
    expect(dist(px(intro, 180, 5), [0, 0, 0])).toBeLessThan(10);
    expect(dist(px(intro, 180, H - 5), [0, 0, 0])).toBeLessThan(10);
    expect(dist(px(intro, 180, 320), [0x20, 0x60, 0xa0])).toBeLessThan(12);
    // outro (square) likewise
    const outro = frame(p('join.mp4'), 6.5);
    expect(dist(px(outro, 180, 5), [0, 0, 0])).toBeLessThan(10);
    expect(dist(px(outro, 180, 320), [0x40, 0xa0, 0x40])).toBeLessThan(12);
    // the clip segment is the clip
    const mid = frame(p('join.mp4'), 1.5 + 1.0);
    const src = frame(p('clip.mp4'), 1.0);
    expect(dist(px(mid, 300, 400), px(src, 300, 400))).toBeLessThan(20);

    // audio: intro tone audible, the clip's speech right after, outro silent (generated)
    expect(bandDb(p('join.mp4'), 0.2, 1.0, 500)).toBeGreaterThan(-40);
    expect(bandDb(p('join.mp4'), 1.7, 1.5, 300)).toBeGreaterThan(-40);
    expect(rmsDb(p('join.mp4'), 5.8, 1.5)).toBeLessThan(-70);
    const l = loudness(p('join.mp4'));
    expect(Math.abs(l.i - TARGET)).toBeLessThanOrEqual(1.5);
    expect(l.tp).toBeLessThanOrEqual(-1.0);
  }, 120_000);

  it('intro/outro are resampled to the clip fps', async () => {
    await finisher.finish(req('fps.mp4', { intro: introM, outro: outroM }));
    const i = info(p('fps.mp4'));
    expect(i.fps).toBeCloseTo(30, 1);
    expect(i.tbr).toBeCloseTo(30, 1);
    expect(Math.abs((i.durationSec ?? 0) - 7.5)).toBeLessThan(0.07);
  }, 60_000);

  it('music only: video stream copied bit for bit, bed audible in the silence, ducked under speech', async () => {
    const r = await finisher.finish(req('music.mp4', { music: music() }));
    expect(r.applied.music).toBe(true);
    expect(videoMd5(p('music.mp4'))).toBe(videoMd5(p('clip.mp4')));
    const i = info(p('music.mp4'));
    expect([i.width, i.height]).toEqual([W, H]);
    expect(Math.abs((i.durationSec ?? 0) - 4)).toBeLessThan(0.1);
    // 880 Hz bed: speech window (0.5-1.5, speech 0-2 s) vs silent window (2.8-3.6, past the 350 ms release)
    const ducked = bandDb(p('music.mp4'), 0.5, 1.0, 880);
    const free = bandDb(p('music.mp4'), 2.8, 0.8, 880);
    expect(free).toBeGreaterThan(-55); // audible
    expect(Math.abs(free - ducked - 12)).toBeLessThanOrEqual(3);
    // speech is still there
    expect(bandDb(p('music.mp4'), 0.5, 1.0, 300)).toBeGreaterThan(-40);
    const l = loudness(p('music.mp4'));
    expect(Math.abs(l.i - TARGET)).toBeLessThanOrEqual(1.5);
    expect(l.tp).toBeLessThanOrEqual(-1.0);
  }, 90_000);

  it('the ducking amount follows duckAmountDb; duckEnabled=false does not duck', async () => {
    const gap = async (name: string, m: ReturnType<typeof music>): Promise<number> => {
      await finisher.finish(req(name, { music: m }));
      return bandDb(p(name), 2.8, 0.8, 880) - bandDb(p(name), 0.5, 1.0, 880);
    };
    const six = await gap('d6.mp4', music({ duckAmountDb: 6 }));
    const twenty = await gap('d20.mp4', music({ duckAmountDb: 20 }));
    const off = await gap('doff.mp4', music({ duckEnabled: false }));
    expect(Math.abs(six - 6)).toBeLessThanOrEqual(3);
    expect(Math.abs(twenty - 20)).toBeLessThanOrEqual(3);
    expect(Math.abs(off)).toBeLessThanOrEqual(1.5);
  }, 120_000);

  it('music is looped/trimmed over the whole result (3 s bed under 7.5 s) and fades out', async () => {
    const r = await finisher.finish(
      req('long.mp4', {
        intro: introM,
        outro: outroM,
        music: music({ duckEnabled: false, fadeOutSec: 1 }),
      }),
    );
    expect(r.applied).toMatchObject({ intro: true, outro: true, music: true });
    expect(Math.abs((info(p('long.mp4')).durationSec ?? 0) - 7.5)).toBeLessThan(0.1);
    // 880 Hz present in the outro (silent programme) well past the 3 s bed length, and gone at the very end
    expect(bandDb(p('long.mp4'), 5.8, 0.6, 880)).toBeGreaterThan(-55);
    expect(bandDb(p('long.mp4'), 7.45, 0.05, 880)).toBeLessThan(
      bandDb(p('long.mp4'), 5.8, 0.6, 880) - 10,
    );
    const l = loudness(p('long.mp4'));
    expect(Math.abs(l.i - TARGET)).toBeLessThanOrEqual(1.5);
  }, 120_000);

  it('everything at once keeps lengths, watermark window and loudness', async () => {
    const r = await finisher.finish(
      req('all.mp4', {
        watermark: wm({ opacity: 0.8 }),
        intro: introM,
        outro: outroM,
        music: music(),
      }),
    );
    expect(r.applied).toEqual({ watermark: true, intro: true, outro: true, music: true });
    expect(Math.abs(r.durationSec - 7.5)).toBeLessThan(0.1);
    const rect = watermarkRect({ width: W, height: H }, wm(), 2);
    const at = (t: number) =>
      px(
        frame(p('all.mp4'), t),
        Math.round(rect.x + rect.w * 0.25),
        Math.round(rect.y + rect.h * 0.5),
      );
    expect(at(0.5)[0]).toBeLessThan(150);
    expect(at(3)[0]).toBeGreaterThan(150);
    expect(at(7)[0]).toBeLessThan(150);
    expect(Math.abs(loudness(p('all.mp4')).i - TARGET)).toBeLessThanOrEqual(1.5);
  }, 120_000);

  it('reports progress 0 -> 1 monotonically', async () => {
    const seen: number[] = [];
    await finisher.finish(req('prog.mp4', { watermark: wm(), intro: introM }), {
      onProgress: (f) => seen.push(f),
    });
    expect(seen[0]).toBe(0);
    expect(seen[seen.length - 1]).toBe(1);
    expect(seen.length).toBeGreaterThan(3);
    for (let k = 1; k < seen.length; k++) expect(seen[k]!).toBeGreaterThanOrEqual(seen[k - 1]!);
  }, 60_000);

  it('a corrupt / missing optional piece is reported, never silently dropped', async () => {
    fs.writeFileSync(p('bad-intro.mp4'), Buffer.from('definitely not an mp4 file '.repeat(200)));
    const r = await finisher.finish(
      req('badintro.mp4', {
        intro: { ...introM, path: p('bad-intro.mp4') },
        outro: outroM,
        music: music({ media: { ...musicM, path: p('missing-music.m4a') } }),
        watermark: wm({ media: { ...logoM, path: p('missing-logo.png') } }),
      }),
    );
    expect(r.applied).toEqual({ watermark: false, intro: false, outro: true, music: false });
    expect(r.notes.join('\n')).toMatch(/Intro skipped/);
    expect(r.notes.join('\n')).toMatch(/Music skipped/);
    expect(r.notes.join('\n')).toMatch(/Watermark skipped/);
    expect(r.notes).toHaveLength(3);
    expect(Math.abs((info(p('badintro.mp4')).durationSec ?? 0) - 6)).toBeLessThan(0.07);
  }, 60_000);

  it('damaged data inside an otherwise readable intro is caught too', async () => {
    const buf = fs.readFileSync(p('intro.mp4'));
    const mdat = buf.indexOf(Buffer.from('mdat'));
    for (let k = mdat + 8; k < buf.length - 64; k++) buf[k] = (k * 37) & 0xff;
    fs.writeFileSync(p('dmg-intro.mp4'), buf);
    const r = await finisher.finish(
      req('dmg.mp4', { intro: { ...introM, path: p('dmg-intro.mp4') } }),
    );
    // either rejected up front (preferred) or, if ffmpeg conceals everything, still a valid file of the right length
    if (!r.applied.intro) expect(r.notes.join(' ')).toMatch(/Intro skipped/);
    expect(info(p('dmg.mp4')).hasVideo).toBe(true);
  }, 60_000);

  it('a corrupt INPUT clip throws a clear error and writes nothing', async () => {
    fs.writeFileSync(p('bad-clip.mp4'), Buffer.from('nope'.repeat(500)));
    await expect(
      finisher.finish(
        req('never.mp4', { input: { ...clipM, path: p('bad-clip.mp4') }, watermark: wm() }),
      ),
    ).rejects.toThrow(/rendered clip could not be read/);
    await expect(
      finisher.finish(req('never2.mp4', { input: { ...clipM, path: p('nope.mp4') } })),
    ).rejects.toThrow(/rendered clip could not be read/);
    expect(fs.existsSync(p('never.mp4'))).toBe(false);
    expect(fs.existsSync(p('never.mp4.partial'))).toBe(false);
    await expect(finisher.finish(req('clip.mp4', { watermark: wm() }))).rejects.toThrow(
      /different file/,
    );
  }, 30_000);

  it('abort mid-run kills ffmpeg and leaves no output (or partial) file', async () => {
    // a bigger job so the encode is still running when we abort
    ff([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=1080x1920:r=30:d=12',
      '-f',
      'lavfi',
      '-i',
      'sine=f=300:d=12',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      p('big.mp4'),
    ]);
    const big = { ...media(p('big.mp4'), 1080, 1920), fps: 30 };
    const ac = new AbortController();
    let running = false;
    const promise = finisher.finish(
      req('aborted.mp4', { input: big, watermark: wm(), intro: introM, music: music() }),
      {
        signal: ac.signal,
        onProgress: (f) => {
          if (f > 0.21 && !running) {
            running = true;
            setTimeout(() => ac.abort(), 150);
          }
        },
      },
    );
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(running).toBe(true);
    expect(fs.existsSync(p('aborted.mp4'))).toBe(false);
    expect(fs.existsSync(p('aborted.mp4.partial'))).toBe(false);
    // already-aborted signal: fails fast, nothing written
    await expect(
      finisher.finish(req('pre.mp4', { watermark: wm() }), { signal: ac.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fs.existsSync(p('pre.mp4'))).toBe(false);
  }, 120_000);

  it('a silent clip gets the bed too (nothing to duck against) and a video-less clip is rejected', async () => {
    ff([
      '-f',
      'lavfi',
      '-i',
      `color=c=0x808080:s=${W}x${H}:r=${FPS}:d=2`,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      p('mute.mp4'),
    ]);
    const mute = { ...media(p('mute.mp4'), W, H), fps: FPS };
    const r = await finisher.finish(
      req('mutemusic.mp4', { input: mute, music: music({ fadeOutSec: 0.2 }) }),
    );
    expect(r.applied.music).toBe(true);
    expect(info(p('mutemusic.mp4')).hasAudio).toBe(true);
    expect(bandDb(p('mutemusic.mp4'), 0.5, 1, 880)).toBeGreaterThan(-55);
    expect(Math.abs(loudness(p('mutemusic.mp4')).i - TARGET)).toBeLessThanOrEqual(1.5);
    // watermark only on a silent clip: still no audio stream
    await finisher.finish(req('mutewm.mp4', { input: mute, watermark: wm() }));
    expect(info(p('mutewm.mp4')).hasAudio).toBe(false);
    ff(['-f', 'lavfi', '-i', 'sine=f=300:d=2', '-c:a', 'aac', p('audioonly.m4a')]);
    await expect(
      finisher.finish(req('av.mp4', { input: { ...media(p('audioonly.m4a'), 0, 0), fps: 30 } })),
    ).rejects.toThrow(/no video/);
  }, 90_000);
});
