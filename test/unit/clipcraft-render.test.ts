import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ReframePlan } from '../../shared/pipeline';
import { createCaptionService } from '../../electron/main/services/captions';
import {
  CropPath,
  buildAudioFilter,
  buildCropCommands,
  buildVideoFilter,
  createRenderService,
  detectEncoder,
  encoderArgs,
  escapeFilterPath,
  extractThumbnail,
  laplacianVariance,
  parseLoudnormJson,
  parseStreamInfo,
  planStages,
  probeStreams,
  stageValues,
} from '../../electron/main/services/render';

const FFMPEG = path.resolve(__dirname, '../../node_modules/ffmpeg-static/ffmpeg');
const haveFfmpeg = fs.existsSync(FFMPEG);

const kf = (t: number, x: number, y = 0, w = 270, h = 480) => ({ t, x, y, w, h });
const mkPlan = (
  keyframes: ReframePlan['keyframes'],
  cuts: number[] = [],
  over: Partial<ReframePlan> = {},
): ReframePlan => ({
  mode: 'single-face',
  aspect: '9:16',
  srcW: 854,
  srcH: 480,
  outW: 1080,
  outH: 1920,
  keyframes,
  cuts,
  faceCoverage: 1,
  ...over,
});

describe('escapeFilterPath', () => {
  it('escapes colons, quotes, commas, brackets and converts Windows separators', () => {
    expect(escapeFilterPath('/tmp/a b/c.ass')).toBe('/tmp/a b/c.ass');
    expect(escapeFilterPath('C:\\Users\\me\\x.ass')).toBe('C\\\\:/Users/me/x.ass');
    expect(escapeFilterPath("/tmp/it's,[x];y.ass")).toBe("/tmp/it\\\\\\'s\\,\\[x\\]\\;y.ass");
  });
});

describe('probing / parsing', () => {
  const banner = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'x.mp4':
  Duration: 00:03:00.15, start: 0.000000, bitrate: 820 kb/s
  Stream #0:0[0x1](und): Video: h264 (Main) (avc1 / 0x31637661), yuv420p(progressive), 854x480 [SAR 1280:1281 DAR 16:9], 705 kb/s, 29.97 fps, 29.97 tbr, 11988 tbn (default)
  Stream #0:1[0x2](und): Audio: aac (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 71 kb/s (default)`;

  it('parses ffmpeg -i output', () => {
    expect(parseStreamInfo(banner)).toEqual({
      durationSec: 180.15,
      startTime: 0,
      hasVideo: true,
      hasAudio: true,
      width: 854,
      height: 480,
      fps: 29.97,
      tbr: 29.97,
    });
    expect(parseStreamInfo('Stream #0:0: Audio: mp3').hasVideo).toBe(false);
  });

  it('parses the loudnorm JSON block and rejects silence (-inf)', () => {
    const ok = `[Parsed_loudnorm_0 @ 0x1]\n{\n\t"input_i" : "-23.54",\n\t"input_tp" : "-4.10",\n\t"input_lra" : "6.20",\n\t"input_thresh" : "-34.00",\n\t"output_i" : "-14.5",\n\t"target_offset" : "0.30"\n}\n`;
    expect(parseLoudnormJson(ok)).toEqual({
      inputI: -23.54,
      inputTP: -4.1,
      inputLRA: 6.2,
      inputThresh: -34,
      targetOffset: 0.3,
    });
    expect(parseLoudnormJson(ok.replace('-23.54', '-inf'))).toBeNull();
    expect(parseLoudnormJson('no json here')).toBeNull();
  });

  it('builds the linear loudnorm chain (TP -1.5) and skips it for silent audio', () => {
    const f = buildAudioFilter(
      { inputI: -23.5, inputTP: -4, inputLRA: 6, inputThresh: -34, targetOffset: 0.3 },
      -14,
      30,
    );
    expect(f).toContain('loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=-23.5');
    expect(f).toContain('linear=true');
    expect(f).toContain('aresample=48000');
    expect(f).toMatch(/afade=t=out:st=29\.970:d=0\.030/);
    expect(buildAudioFilter(null, -14, 30)).not.toContain('loudnorm');
    // a wide-LRA clip raises the LRA target so linear mode can engage
    expect(
      buildAudioFilter(
        { inputI: -20, inputTP: -3, inputLRA: 18.2, inputThresh: -30, targetOffset: 0 },
        -14,
        30,
      ),
    ).toContain('LRA=20');
  });
});

describe('crop path', () => {
  it('interpolates smoothly between keyframes without overshoot and clamps to bounds', () => {
    const kfs = [0, 0.1, 0.2, 0.3, 0.4, 0.5].map((t, i) =>
      kf(t, [100, 100, 110, 140, 160, 160][i]!),
    );
    const p = new CropPath(kfs, [], { maxX: 584, maxY: 0 }, 0.0167);
    let prev = p.at(0).x;
    for (let t = 0.001; t <= 0.5; t += 0.001) {
      const x = p.at(t).x;
      expect(x).toBeGreaterThanOrEqual(prev - 1e-9); // monotone input -> monotone output
      expect(x).toBeGreaterThanOrEqual(100);
      expect(x).toBeLessThanOrEqual(160);
      prev = x;
    }
    expect(p.at(-5).x).toBe(100);
    expect(p.at(99).x).toBe(160);
    const clamped = new CropPath([kf(0, 700), kf(1, 700)], [], { maxX: 584, maxY: 0 }, 0.0167);
    expect(clamped.at(0.5).x).toBe(584);
  });

  it('jumps half a frame before the cut and never interpolates across it', () => {
    const kfs = [kf(0, 100), kf(1, 100), kf(1.999, 100), kf(2, 400), kf(3, 400)];
    const eps = 0.5 / 30;
    const p = new CropPath(kfs, [2], { maxX: 584, maxY: 0 }, eps);
    expect(p.at(1.9).x).toBe(100);
    expect(p.at(2 - eps - 1e-4).x).toBe(100);
    expect(p.at(2 - eps + 1e-4).x).toBe(400);
    expect(p.at(2.5).x).toBe(400);
    expect(p.jumpTime(0)).toBeCloseTo(2 - eps, 9);
  });
});

describe('two-stage crop', () => {
  it('splits positions so the net translation is exact to ~1 output pixel at every x', () => {
    const plan = mkPlan([kf(0, 0), kf(1, 584)]);
    const st = planStages(plan, 854, 480);
    expect(st.isStatic).toBe(false);
    expect(st.f).toBeCloseTo(4, 9);
    expect(st.w1).toBe(274);
    expect(st.sw).toBe(1096);
    for (let x = 0; x <= 584; x += 0.37) {
      const v = stageValues({ x, y: 0 }, st, 854, 480);
      expect(v.x0 % 2).toBe(0);
      expect(v.ox).toBeGreaterThanOrEqual(0);
      expect(v.ox + st.outW).toBeLessThanOrEqual(st.sw);
      expect(v.x0 + st.w1).toBeLessThanOrEqual(854);
      expect(Math.abs(v.x0 * st.f + v.ox - x * st.f)).toBeLessThanOrEqual(0.5 + 1e-9);
    }
  });

  it('static plans use a single crop+scale; moving plans use sendcmd + two crops', () => {
    const still = buildVideoFilter({
      plan: mkPlan([kf(0, 292), kf(5, 292)]),
      srcW: 854,
      srcH: 480,
      cmdFile: null,
      initial: { x0: 292, y0: 0, ox: 0, oy: 0 },
      fps: null,
      assFile: null,
      fontsDir: null,
    });
    expect(still).toBe(
      'crop=w=270:h=480:x=292:y=0,scale=1080:1920:flags=lanczos,setsar=1,format=yuv420p',
    );
    const moving = buildVideoFilter({
      plan: mkPlan([kf(0, 100), kf(5, 300)]),
      srcW: 854,
      srcH: 480,
      cmdFile: '/tmp/w d/crop.cmd',
      initial: { x0: 100, y0: 0, ox: 0, oy: 0 },
      fps: '30000/1001',
      assFile: '/tmp/w d/o.ass',
      fontsDir: '/opt/fonts',
    });
    expect(moving).toBe(
      'fps=30000/1001,sendcmd=f=/tmp/w d/crop.cmd,crop@c1=w=274:h=480:x=100:y=0,scale=1096:1920:flags=lanczos,' +
        'crop@c2=w=1080:h=1920:x=0:y=0,setsar=1,ass=filename=/tmp/w d/o.ass:fontsdir=/opt/fonts,format=yuv420p',
    );
  });

  it('writes sendcmd commands at half-frame resolution, only on change, with the cut jump at cut-0.5/fps', () => {
    const plan = mkPlan([kf(0, 100), kf(1.999, 100), kf(2, 400), kf(4, 400)], [2]);
    const st = planStages(plan, 854, 480);
    const path_ = new CropPath(plan.keyframes, plan.cuts, { maxX: 584, maxY: 0 }, 0.5 / 30);
    const text = buildCropCommands(path_, st, 854, 480, 4, 30);
    const lines = text.trim().split('\n');
    // static before and after the jump -> only the initial command and the jump (not 240 lines)
    expect(lines.length).toBeLessThan(6);
    expect(lines[0]).toMatch(/^0\.0000 crop@c1 x 100/);
    const jump = lines.find((l) => l.includes('crop@c1 x 400'));
    expect(jump).toBeDefined();
    expect(Number(jump!.split(' ')[0])).toBeCloseTo(2 - 0.5 / 30, 3);
    const times = lines.map((l) => Number(l.split(' ')[0]));
    for (let i = 1; i < times.length; i++) expect(times[i]!).toBeGreaterThanOrEqual(times[i - 1]!);
    // a moving path produces a dense, monotone command stream
    const moving = mkPlan([kf(0, 100), kf(4, 300)]);
    const mp = new CropPath(moving.keyframes, [], { maxX: 584, maxY: 0 }, 0.5 / 30);
    const mt = buildCropCommands(mp, planStages(moving, 854, 480), 854, 480, 4, 30)
      .trim()
      .split('\n');
    expect(mt.length).toBeGreaterThan(100);
  });
});

describe('encoder arguments', () => {
  it('uses libx264 veryfast/crf 20 and hardware encoders with sane rate control', () => {
    expect(encoderArgs('libx264', 30)).toEqual(
      expect.arrayContaining(['-preset', 'veryfast', '-crf', '20']),
    );
    expect(encoderArgs('h264_nvenc', 30)).toEqual(
      expect.arrayContaining(['h264_nvenc', '-cq', '21']),
    );
    expect(encoderArgs('h264_videotoolbox', 30)).toEqual(
      expect.arrayContaining(['h264_videotoolbox']),
    );
  });
});

describe('thumbnail sharpness metric', () => {
  it('scores a detailed frame above a flat one', () => {
    const w = 32;
    const h = 32;
    const flat = new Uint8Array(w * h).fill(128);
    const busy = new Uint8Array(w * h).map((_, i) => ((i * 37) % 11) * 20);
    expect(laplacianVariance(busy, w, h)).toBeGreaterThan(laplacianVariance(flat, w, h) + 100);
  });
});

describe.skipIf(!haveFfmpeg)('render with the real ffmpeg (synthetic source)', () => {
  let dir = '';
  let src = '';
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipfern-render-'));
    src = path.join(dir, 'src dir, [x].mp4'); // awkward name on purpose
    execFileSync(
      FFMPEG,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=s=320x180:r=30:d=4',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=44100:duration=4',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        src,
      ],
      { stdio: 'pipe' },
    );
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const words = [
    { w: 'Hello', s: 0.2, e: 0.6 },
    { w: 'there', s: 0.6, e: 1.0 },
    { w: 'friend.', s: 1.1, e: 1.6 },
  ];

  it('detects an encoder by actually encoding a frame', async () => {
    expect(await detectEncoder(FFMPEG)).toBe('libx264'); // no GPU in CI
    expect(await createRenderService().detectEncoder(FFMPEG)).toBe('libx264');
  });

  it('renders a 1080x1920 clip with a moving crop, captions and hook; reports progress; normalises audio', async () => {
    const svc = createRenderService();
    const caps = createCaptionService();
    const assPath = path.join(dir, 'c.ass');
    fs.writeFileSync(
      assPath,
      caps.buildAss({
        words,
        startSec: 0.5,
        endSec: 3.5,
        width: 1080,
        height: 1920,
        styleId: 'clean-pop',
      }),
    );
    const out = path.join(dir, 'out.mp4');
    const progress: number[] = [];
    const plan = mkPlan(
      [kf(0, 20, 0, 102, 180), kf(1.5, 118, 0, 102, 180), kf(3, 118, 0, 102, 180)],
      [],
      { srcW: 320, srcH: 180 },
    );
    const res = await svc.render({
      ffmpegPath: FFMPEG,
      sourcePath: src,
      outPath: out,
      startSec: 0.5,
      endSec: 3.5,
      plan,
      assPath,
      fontsDir: path.resolve(__dirname, '../../electron/main/assets/fonts'),
      hook: { text: 'Big hook here', durationSec: 2 },
      loudnessTarget: -14,
      encoder: 'auto',
      fps: null,
      onProgress: (f) => f !== null && progress.push(f),
    });
    expect(res).toEqual({ encoder: 'libx264', durationSec: 3 });
    const info = await probeStreams(FFMPEG, out);
    expect(info.width).toBe(1080);
    expect(info.height).toBe(1920);
    expect(info.fps).toBeCloseTo(30, 1);
    expect(info.hasAudio).toBe(true);
    expect(info.durationSec).toBeGreaterThan(2.9);
    expect(info.durationSec).toBeLessThan(3.2);
    expect(progress[0]).toBe(0);
    expect(progress[progress.length - 1]).toBe(1);
    for (let i = 1; i < progress.length; i++)
      expect(progress[i]!).toBeGreaterThanOrEqual(progress[i - 1]! - 1e-9);
    // no stray temp files next to the output
    expect(fs.readdirSync(dir).filter((f) => f.startsWith('.'))).toEqual([]);
    // thumbnail
    const jpg = path.join(dir, 'thumb.jpg');
    await extractThumbnail(FFMPEG, out, jpg);
    expect(fs.statSync(jpg).size).toBeGreaterThan(2000);
  }, 60_000);

  it('renders without captions/hook and with a static centre plan', async () => {
    const out = path.join(dir, 'plain.mp4');
    const plan = mkPlan([kf(0, 109, 0, 102, 180), kf(2, 109, 0, 102, 180)], [], {
      mode: 'center',
      srcW: 320,
      srcH: 180,
    });
    await createRenderService().render({
      ffmpegPath: FFMPEG,
      sourcePath: src,
      outPath: out,
      startSec: 1,
      endSec: 3,
      plan,
      assPath: null,
      fontsDir: null,
      hook: null,
      loudnessTarget: -14,
      encoder: 'libx264',
      fps: null,
    });
    const info = await probeStreams(FFMPEG, out);
    expect([info.width, info.height]).toEqual([1080, 1920]);
  }, 60_000);

  it('aborts: kills ffmpeg, rejects with AbortError and leaves no partial file', async () => {
    const ac = new AbortController();
    const out = path.join(dir, 'aborted.mp4');
    const plan = mkPlan([kf(0, 20, 0, 102, 180), kf(3, 118, 0, 102, 180)], [], {
      srcW: 320,
      srcH: 180,
    });
    const p = createRenderService().render({
      ffmpegPath: FFMPEG,
      sourcePath: src,
      outPath: out,
      startSec: 0,
      endSec: 4,
      plan,
      assPath: null,
      fontsDir: null,
      hook: null,
      loudnessTarget: -14,
      encoder: 'libx264',
      fps: null,
      signal: ac.signal,
      onProgress: (f) => {
        if (f !== null && f > 0.02) ac.abort();
      },
    });
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(fs.existsSync(out)).toBe(false);
    expect(
      fs.readdirSync(dir).filter((f) => f.startsWith('.clipfern') || f.endsWith('.partial.mp4')),
    ).toEqual([]);
  }, 60_000);

  it('reports descriptive errors with the ffmpeg stderr tail', async () => {
    const plan = mkPlan([kf(0, 20, 0, 102, 180), kf(3, 118, 0, 102, 180)], [], {
      srcW: 320,
      srcH: 180,
    });
    const bad = path.join(dir, 'bad.ass');
    fs.writeFileSync(bad, 'this is not an ass file');
    await expect(
      createRenderService().render({
        ffmpegPath: FFMPEG,
        sourcePath: path.join(dir, 'missing.mp4'),
        outPath: path.join(dir, 'x.mp4'),
        startSec: 0,
        endSec: 2,
        plan,
        assPath: null,
        fontsDir: null,
        hook: null,
        loudnessTarget: -14,
        encoder: 'libx264',
        fps: null,
      }),
    ).rejects.toThrow(/Source video not found/);
    await expect(
      createRenderService().render({
        ffmpegPath: FFMPEG,
        sourcePath: src,
        outPath: path.join(dir, 'x.mp4'),
        startSec: 2,
        endSec: 1,
        plan,
        assPath: null,
        fontsDir: null,
        hook: null,
        loudnessTarget: -14,
        encoder: 'libx264',
        fps: null,
      }),
    ).rejects.toThrow(/Invalid clip range/);
    await expect(
      createRenderService()
        .render({
          ffmpegPath: FFMPEG,
          sourcePath: src,
          outPath: path.join(dir, 'x.mp4'),
          startSec: 0,
          endSec: 2,
          plan: { ...plan, srcW: 640, srcH: 360, keyframes: plan.keyframes },
          assPath: null,
          fontsDir: null,
          hook: null,
          loudnessTarget: -14,
          encoder: 'libx264',
          fps: null,
        })
        .then(() => 'rendered'),
    ).resolves.toBe('rendered'); // same aspect, scaled plan
    await expect(
      createRenderService().render({
        ffmpegPath: FFMPEG,
        sourcePath: src,
        outPath: path.join(dir, 'x.mp4'),
        startSec: 0,
        endSec: 2,
        plan: { ...plan, srcW: 500, srcH: 500 },
        assPath: null,
        fontsDir: null,
        hook: null,
        loudnessTarget: -14,
        encoder: 'libx264',
        fps: null,
      }),
    ).rejects.toThrow(/plan was made for a 500x500 source/);
    await expect(
      createRenderService().render({
        ffmpegPath: '/nonexistent/ffmpeg',
        sourcePath: src,
        outPath: path.join(dir, 'x.mp4'),
        startSec: 0,
        endSec: 2,
        plan,
        assPath: null,
        fontsDir: null,
        hook: null,
        loudnessTarget: -14,
        encoder: 'libx264',
        fps: null,
      }),
    ).rejects.toThrow(/Could not start ffmpeg/);
  }, 60_000);
});
