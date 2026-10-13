import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Transition } from '../../shared/cp2';
import type { ReframePlan } from '../../shared/pipeline';
import {
  DEFAULT_TRANSITION_SEC,
  audioStitchGraph,
  buildLayoutGraph,
  buildMultiCropCommands,
  createRenderService,
  effectiveTransitionSec,
  panelCommandInputs,
  preparePanels,
  probeStreams,
  renderCleanFrame,
  windowPlan,
  screenPanelGraph,
  screenRegion,
  segmentAudioChain,
  stackSpec,
  stitchedDuration,
  videoStitchGraph,
  XFADE_NAME,
} from '../../electron/main/services/render';

const FFMPEG = path.resolve(__dirname, '../../node_modules/ffmpeg-static/ffmpeg');
const haveFfmpeg = fs.existsSync(FFMPEG);

const kf = (t: number, x: number, y: number, w: number, h: number) => ({ t, x, y, w, h });

/** Plan with two stacked panels on a 270x480 output (small = fast tests). */
function splitPlan(over: Partial<ReframePlan> = {}): ReframePlan {
  const a = [kf(0, 0, 0, 320, 360), kf(3, 0, 0, 320, 360)];
  const b = [kf(0, 320, 0, 320, 360), kf(3, 320, 0, 320, 360)];
  return {
    mode: 'multi-face',
    aspect: '9:16',
    srcW: 640,
    srcH: 360,
    outW: 270,
    outH: 480,
    keyframes: a,
    cuts: [],
    faceCoverage: 1,
    layout: 'split',
    panels: [
      { out: { x: 0, y: 0, w: 270, h: 240 }, keyframes: a, role: 'face-a' },
      { out: { x: 0, y: 240, w: 270, h: 240 }, keyframes: b, role: 'face-b' },
    ],
    ...over,
  };
}

describe('stitch builders (pure)', () => {
  it('effective transition: cut = 0; default 0.35; limited by the shortest segment; tiny = 0', () => {
    expect(effectiveTransitionSec('cut', 0.5, [8, 9])).toBe(0);
    expect(effectiveTransitionSec('crossfade', undefined, [8, 9])).toBe(DEFAULT_TRANSITION_SEC);
    expect(effectiveTransitionSec('crossfade', 0.5, [8, 9])).toBe(0.5);
    expect(effectiveTransitionSec('crossfade', 5, [8, 9])).toBeCloseTo(3.2, 3); // 40% of 8
    expect(effectiveTransitionSec('crossfade', 0.5, [0.2, 9])).toBe(0);
    expect(effectiveTransitionSec('slide', 0.4, [10])).toBe(0); // one segment: nothing to blend
  });

  it('duration = sum of segments - sum of overlaps', () => {
    expect(stitchedDuration([8, 9, 10], 0.4)).toBeCloseTo(26.2, 6);
    expect(stitchedDuration([8, 9, 10], 0)).toBe(27);
    expect(stitchedDuration([8], 0.4)).toBe(8);
  });

  it('xfade chain: offsets accumulate (sum so far - k*T) and every transition has an ffmpeg name', () => {
    const g = videoStitchGraph(['v0', 'v1', 'v2'], [8, 9, 10], 'dip-black', 0.4, 'out');
    expect(g).toBe(
      '[v0][v1]xfade=transition=fadeblack:duration=0.400:offset=7.600[xf1];' +
        '[xf1][v2]xfade=transition=fadeblack:duration=0.400:offset=16.200[out]',
    );
    expect(Object.keys(XFADE_NAME).sort()).toEqual(
      ['crossfade', 'dip-black', 'dip-white', 'slide', 'zoom'].sort(),
    );
    expect(XFADE_NAME.crossfade).toBe('fade');
    expect(XFADE_NAME['dip-white']).toBe('fadewhite');
  });

  it('cut = concat; audio = acrossfade chain (or concat for cuts)', () => {
    expect(videoStitchGraph(['v0', 'v1'], [5, 5], 'cut', 0, 'o')).toBe(
      '[v0][v1]concat=n=2:v=1:a=0[o]',
    );
    expect(videoStitchGraph(['v0'], [5], 'crossfade', 0, 'o')).toBe('[v0]null[o]');
    expect(audioStitchGraph(['a0', 'a1', 'a2'], 'crossfade', 0.4, 'o')).toBe(
      '[a0][a1]acrossfade=d=0.400:c1=qsin:c2=qsin[ax1];[ax1][a2]acrossfade=d=0.400:c1=qsin:c2=qsin[o]',
    );
    expect(audioStitchGraph(['a0', 'a1'], 'cut', 0, 'o')).toBe('[a0][a1]concat=n=2:v=0:a=1[o]');
    expect(segmentAudioChain(1, 5, true)).toContain('afade=t=in');
    expect(segmentAudioChain(1, 5, false)).not.toContain('afade');
  });
});

describe('windowPlan', () => {
  it('interpolates the window ends, keeps inner keyframes, shifts cuts', () => {
    const plan = splitPlan({ cuts: [4, 12.5, 20] });
    const ks = [kf(0, 0, 0, 100, 100), kf(5, 50, 0, 100, 100), kf(10, 90, 0, 100, 100)];
    const w = windowPlan({ ...plan, keyframes: ks }, 4.8, 1.2);
    expect(w.keyframes.map((k) => k.t)).toEqual([0, 0.2, 1.2]);
    expect(w.keyframes[0]!.x).toBeCloseTo(48, 6); // 4.8 s: 0.96 of the way 0 -> 50
    expect(w.keyframes[1]!.x).toBe(50);
    expect(w.keyframes[2]!.x).toBeCloseTo(50 + (1 / 5) * 40, 6);
    expect(w.cuts).toEqual([]);
    const far = windowPlan(
      { ...plan, keyframes: [kf(0, 0, 0, 100, 100), kf(30, 90, 0, 100, 100)] },
      12,
      1.2,
    );
    expect(far.keyframes).toHaveLength(2);
    expect(far.keyframes[0]!.x).toBeCloseTo(36, 6);
    expect(windowPlan({ ...plan, cuts: [12.5] }, 12, 1.2).cuts).toEqual([0.5]);
  });
});

describe('panel layout builders (pure)', () => {
  it('tiling panels use vstack / hstack; anything else falls back to overlay', () => {
    const p = splitPlan();
    const panels = preparePanels(p, 640, 360, 30, 's0_');
    expect(stackSpec(panels, 270, 480).kind).toBe('v');
    const side = splitPlan({
      outW: 480,
      outH: 270,
      panels: [
        { out: { x: 0, y: 0, w: 240, h: 270 }, keyframes: p.keyframes, role: 'face-a' },
        { out: { x: 240, y: 0, w: 240, h: 270 }, keyframes: p.keyframes, role: 'face-b' },
      ],
    });
    expect(stackSpec(preparePanels(side, 640, 360, 30, 'x'), 480, 270).kind).toBe('h');
    const odd = splitPlan({
      panels: [
        { out: { x: 0, y: 0, w: 270, h: 200 }, keyframes: p.keyframes, role: 'face-a' },
        { out: { x: 0, y: 280, w: 270, h: 200 }, keyframes: p.keyframes, role: 'face-b' },
      ],
    });
    expect(stackSpec(preparePanels(odd, 640, 360, 30, 'x'), 270, 480).kind).toBe('overlay');
  });

  it('builds one sendcmd + split + per-panel crops + vstack + divider + ass', () => {
    const moving = splitPlan({
      panels: [
        {
          out: { x: 0, y: 0, w: 270, h: 240 },
          keyframes: [kf(0, 0, 0, 320, 284), kf(3, 100, 0, 320, 284)],
          role: 'face-a',
        },
        {
          out: { x: 0, y: 240, w: 270, h: 240 },
          keyframes: [kf(0, 320, 0, 320, 284), kf(3, 300, 0, 320, 284)],
          role: 'face-b',
        },
      ],
    });
    const panels = preparePanels(moving, 640, 360, 30, 'r');
    expect(panelCommandInputs(panels)).toHaveLength(2);
    const g = buildLayoutGraph({
      plan: moving,
      srcW: 640,
      srcH: 360,
      inLabel: '0:v:0',
      outLabel: 'vout',
      tag: 'r',
      fps: '30000/1001',
      rate: 29.97,
      cmdFile: '/tmp/a b/c.cmd',
      panels,
      assFile: '/tmp/a b/o.ass',
      fontsDir: '/opt/f',
    });
    expect(g).toContain('[0:v:0]fps=30000/1001,sendcmd=f=/tmp/a b/c.cmd,split=2[rin0][rin1]');
    expect(g).toContain('crop@rp0_1=');
    expect(g).toContain('crop@rp1_2=');
    expect(g).toContain('[rpn0][rpn1]vstack=inputs=2[rstk]');
    expect(g).toContain('drawbox=x=0:y=238:w=270:h=4:color=black@0.9:t=fill');
    expect(g).toContain('ass=filename=/tmp/a b/o.ass:fontsdir=/opt/f');
    expect(g.endsWith('format=yuv420p[vout]')).toBe(true);
    // unique instance names per panel
    const names = [...g.matchAll(/crop@(\w+)=/g)].map((m) => m[1]);
    expect(new Set(names).size).toBe(names.length);
  });

  it('a static panel set needs no sendcmd', () => {
    const panels = preparePanels(splitPlan(), 640, 360, 30, 'r');
    expect(panelCommandInputs(panels)).toHaveLength(0);
  });

  it('screen panel: contain-fit + blurred fill when the aspect differs, plain scale when it matches', () => {
    const p = splitPlan({
      layout: 'screen-face',
      panels: [
        {
          out: { x: 0, y: 0, w: 270, h: 320 },
          keyframes: [kf(0, 0, 0, 640, 360), kf(3, 0, 0, 640, 360)],
          role: 'screen',
        },
        {
          out: { x: 0, y: 320, w: 270, h: 160 },
          keyframes: [kf(0, 500, 250, 135, 80), kf(3, 500, 250, 135, 80)],
          role: 'face',
        },
      ],
    });
    const panels = preparePanels(p, 640, 360, 30, 's0_');
    const g = screenPanelGraph(panels[0]!, 'in0', 'o', 640, 360);
    expect(g).toContain('gblur');
    expect(g).toContain('scale=270:152'); // 640x360 fitted into the 270 px width
    expect(g).toContain('overlay=x=(W-w)/2:y=(H-h)/2');
    const exact = screenPanelGraph(
      { ...panels[0]!, panel: { ...panels[0]!.panel, out: { x: 0, y: 0, w: 320, h: 180 } } },
      'in0',
      'o',
      640,
      360,
    );
    expect(exact).not.toContain('gblur');
    expect(screenRegion(panels[0]!.panel, 640, 360)).toEqual({ x: 0, y: 0, w: 640, h: 360 });
  });

  it('one command file drives all panels (merged lines, only on change)', () => {
    const moving = splitPlan({
      panels: [
        {
          out: { x: 0, y: 0, w: 270, h: 240 },
          keyframes: [kf(0, 0, 0, 320, 284), kf(2, 100, 0, 320, 284)],
          role: 'face-a',
        },
        {
          out: { x: 0, y: 240, w: 270, h: 240 },
          keyframes: [kf(0, 320, 0, 320, 284), kf(2, 320, 0, 320, 284)],
          role: 'face-b',
        },
      ],
    });
    const panels = preparePanels(moving, 640, 360, 30, 'q');
    const text = buildMultiCropCommands(panelCommandInputs(panels), 640, 360, 2, 30);
    const lines = text.trim().split('\n');
    expect(lines[0]).toMatch(/^0\.0000 /);
    expect(lines[0]).toContain('crop@qp0_1 x');
    // panel B is static: it has no sendcmd entries at all
    expect(text.includes('qp1_')).toBe(false);
    expect(lines.length).toBeGreaterThan(20);
  });
});

/* ------------------------------------------------ real ffmpeg ------------------------------------------------ */

function ffmpeg(args: string[]): void {
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'pipe' });
}

/** Decodes one frame at `t` to rgb24, scaled to w x h. */
function frameRgb(file: string, t: number | null, w: number, h: number): Uint8Array {
  const out = execFileSync(
    FFMPEG,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      ...(t === null ? [] : ['-ss', String(t)]),
      '-i',
      file,
      '-frames:v',
      '1',
      '-vf',
      `scale=${w}:${h}:flags=area`,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 },
  );
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

const mean = (
  rgb: Uint8Array,
  w: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): [number, number, number] => {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 3;
      r += rgb[i] ?? 0;
      g += rgb[i + 1] ?? 0;
      b += rgb[i + 2] ?? 0;
      n++;
    }
  }
  return [r / n, g / n, b / n];
};

describe.skipIf(!haveFfmpeg)('render layouts and highlights with the real ffmpeg', () => {
  let dir = '';
  let src = '';
  let silent = '';
  const render = createRenderService();
  const base = (out: string) => ({
    ffmpegPath: FFMPEG,
    outPath: path.join(dir, out),
    fontsDir: null,
    hook: null,
    loudnessTarget: -14,
    encoder: 'libx264' as const,
    fps: null,
  });

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipfern-render2-'));
    src = path.join(dir, 'src dir [x].mp4');
    // left half red, right half blue, a bright "webcam" block bottom-right, a changing tone
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=320x360:r=30:d=9',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=320x360:r=30:d=9',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=330:sample_rate=44100:duration=9',
      '-filter_complex',
      '[0:v][1:v]hstack,drawbox=x=540:y=270:w=90:h=80:color=yellow:t=fill,drawbox=x=100:y=100:w=60:h=60:color=white:t=fill,drawbox=x=420:y=40:w=100:h=40:color=lime:t=fill[v]',
      '-map',
      '[v]',
      '-map',
      '2:a',
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
    ]);
    silent = path.join(dir, 'silent.mp4');
    ffmpeg(['-i', src, '-an', '-c:v', 'copy', silent]);
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('split layout: panel A shows the left (red) half on top, panel B the right (blue) half below, with a divider', async () => {
    const out = path.join(dir, 'split.mp4');
    const res = await render.render({
      ...base('split.mp4'),
      sourcePath: src,
      startSec: 1,
      endSec: 4,
      plan: splitPlan(),
      assPath: null,
    });
    expect(res.durationSec).toBe(3);
    const info = await probeStreams(FFMPEG, out);
    expect([info.width, info.height]).toEqual([270, 480]);
    expect(info.hasAudio).toBe(true);
    const px = frameRgb(out, 1, 270, 480);
    const top = mean(px, 270, 20, 20, 250, 220);
    const bottom = mean(px, 270, 20, 260, 250, 460);
    expect(top[0]).toBeGreaterThan(180);
    expect(top[2]).toBeLessThan(80);
    expect(bottom[2]).toBeGreaterThan(150);
    expect(bottom[0]).toBeLessThan(80);
    // the seam (y = 238..242) is dark
    const seam = mean(px, 270, 20, 239, 250, 241);
    expect(seam[0] + seam[1] + seam[2]).toBeLessThan(120);
    // no stray temp files
    expect(fs.readdirSync(dir).filter((f) => f.startsWith('.'))).toEqual([]);
  }, 60_000);

  it('split layout with moving panels (sendcmd) renders and tracks: the pan reveals different content', async () => {
    const a = [kf(0, 0, 0, 160, 142), kf(3, 480, 0, 160, 142)];
    const b = [kf(0, 480, 0, 160, 142), kf(3, 0, 0, 160, 142)];
    const plan = splitPlan({
      keyframes: a,
      panels: [
        { out: { x: 0, y: 0, w: 270, h: 240 }, keyframes: a, role: 'face-a' },
        { out: { x: 0, y: 240, w: 270, h: 240 }, keyframes: b, role: 'face-b' },
      ],
    });
    const out = path.join(dir, 'split-move.mp4');
    await render.render({
      ...base('split-move.mp4'),
      sourcePath: src,
      startSec: 0,
      endSec: 3,
      plan,
      assPath: null,
    });
    const first = frameRgb(out, 0.05, 270, 480);
    const last = frameRgb(out, 2.9, 270, 480);
    expect(mean(first, 270, 20, 20, 250, 220)[0]).toBeGreaterThan(150); // A starts on red
    expect(mean(last, 270, 20, 20, 250, 220)[2]).toBeGreaterThan(150); // ... ends on blue
    expect(mean(first, 270, 20, 260, 250, 460)[2]).toBeGreaterThan(150);
    expect(mean(last, 270, 20, 260, 250, 460)[0]).toBeGreaterThan(150);
  }, 60_000);

  it('screen + face: screen contain-fitted (blurred fill above and below), webcam strip below', async () => {
    const plan: ReframePlan = splitPlan({
      mode: 'screen-face',
      layout: 'screen-face',
      panels: [
        {
          out: { x: 0, y: 0, w: 270, h: 320 },
          keyframes: [kf(0, 0, 0, 640, 360), kf(3, 0, 0, 640, 360)],
          role: 'screen',
        },
        {
          out: { x: 0, y: 320, w: 270, h: 160 },
          keyframes: [kf(0, 534, 264, 96, 57), kf(3, 534, 264, 96, 57)],
          role: 'face',
        },
      ],
    });
    const out = path.join(dir, 'screen.mp4');
    await render.render({
      ...base('screen.mp4'),
      sourcePath: src,
      startSec: 0,
      endSec: 3,
      plan,
      assPath: null,
    });
    const px = frameRgb(out, 1, 270, 480);
    // webcam strip = the yellow block
    const strip = mean(px, 270, 20, 340, 250, 460);
    expect(strip[0]).toBeGreaterThan(200);
    expect(strip[1]).toBeGreaterThan(200);
    expect(strip[2]).toBeLessThan(80);
    // the 640x360 screen is 270x152 centred in 270x320: rows 84..236 hold the sharp picture (red | blue halves),
    // rows above/below are a blurred copy (colours present, but no hard edge and dimmed)
    const picL = mean(px, 270, 10, 100, 120, 220);
    const picR = mean(px, 270, 150, 100, 260, 220);
    expect(picL[0]).toBeGreaterThan(picL[2]);
    expect(picR[2]).toBeGreaterThan(picR[0]);
    const fillTop = mean(px, 270, 10, 5, 120, 70);
    expect(fillTop[0]).toBeGreaterThan(fillTop[2]); // red side continues in the fill
    expect(fillTop[0]).toBeLessThan(picL[0] + 1); // dimmed, not brighter than the picture
    // not stretched: the fitted picture is 152 px tall, so row 40 must not be sharp picture:
    // the white square (100,100,60x60 in the source) sits at y = 100*0.42 + 84 = 126..151 in the output
    const white = mean(px, 270, 45, 130, 62, 148);
    expect(white[0]).toBeGreaterThan(200);
    expect(white[1]).toBeGreaterThan(200);
    const aboveWhite = mean(px, 270, 45, 60, 62, 78);
    expect(aboveWhite[1]).toBeLessThan(120);
  }, 60_000);

  it('layout plans keep captions + hook (ass) and report progress', async () => {
    const ass = path.join(dir, 'c.ass');
    fs.writeFileSync(
      ass,
      '[Script Info]\nPlayResX: 270\nPlayResY: 480\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Caption,Arial,40,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:02.00,Caption,,0,0,0,,HELLO\n',
    );
    const progress: number[] = [];
    const out = path.join(dir, 'split-cap.mp4');
    await render.render({
      ...base('split-cap.mp4'),
      sourcePath: src,
      startSec: 0,
      endSec: 3,
      plan: splitPlan(),
      assPath: ass,
      hook: { text: 'Big hook here', durationSec: 2 },
      fontsDir: path.resolve(__dirname, '../../electron/main/assets/fonts'),
      onProgress: (f) => f !== null && progress.push(f),
    });
    expect(progress[0]).toBe(0);
    expect(progress[progress.length - 1]).toBe(1);
    const withText = frameRgb(out, 1, 270, 480);
    const noText = frameRgb(path.join(dir, 'split.mp4'), 1, 270, 480);
    let diff = 0;
    for (let i = 0; i < withText.length; i++)
      diff += Math.abs((withText[i] ?? 0) - (noText[i] ?? 0));
    expect(diff / withText.length).toBeGreaterThan(0.5); // captions/hook were burned in
  }, 60_000);

  it('aborts a layout render: AbortError, no partial output', async () => {
    const ac = new AbortController();
    const p = render.render({
      ...base('abort-split.mp4'),
      sourcePath: src,
      startSec: 0,
      endSec: 8,
      plan: splitPlan(),
      assPath: null,
      signal: ac.signal,
      onProgress: (f) => {
        if (f !== null && f > 0.02) ac.abort();
      },
    });
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(fs.existsSync(path.join(dir, 'abort-split.mp4'))).toBe(false);
    expect(fs.readdirSync(dir).filter((f) => f.startsWith('.'))).toEqual([]);
  }, 60_000);

  it('rejects broken layout plans', async () => {
    await expect(
      render.render({
        ...base('x.mp4'),
        sourcePath: src,
        startSec: 0,
        endSec: 2,
        plan: splitPlan({ panels: undefined }),
        assPath: null,
      }),
    ).rejects.toThrow(/needs at least two panels/);
  });

  it('renderCleanFrame: the frame of the same reframed picture, without captions or hook', async () => {
    const a = [kf(0, 0, 0, 160, 142), kf(3, 480, 0, 160, 142)];
    const b = [kf(0, 480, 0, 160, 142), kf(3, 0, 0, 160, 142)];
    const plan = splitPlan({
      keyframes: a,
      panels: [
        { out: { x: 0, y: 0, w: 270, h: 240 }, keyframes: a, role: 'face-a' },
        { out: { x: 0, y: 240, w: 270, h: 240 }, keyframes: b, role: 'face-b' },
      ],
    });
    const jpg = path.join(dir, 'clean', 'still.jpg');
    await renderCleanFrame({
      ffmpegPath: FFMPEG,
      sourcePath: src,
      startSec: 2,
      atSec: 2.8,
      plan,
      outJpg: jpg,
      encoder: 'libx264',
    });
    const px = frameRgb(jpg, null, 270, 480);
    // at 2.8 s of 3 the panels have panned nearly all the way: A is blue, B is red
    expect(mean(px, 270, 20, 20, 250, 220)[2]).toBeGreaterThan(150);
    expect(mean(px, 270, 20, 260, 250, 460)[0]).toBeGreaterThan(150);
    expect(fs.readdirSync(path.join(dir, 'clean')).filter((f) => f.startsWith('.'))).toEqual([]);
  }, 60_000);

  describe('highlights', () => {
    const seg = (s: number, e: number, plan?: ReframePlan) => ({
      startSec: s,
      endSec: e,
      plan: plan ?? splitPlan(),
      assPath: null,
    });
    const transitions: Transition[] = [
      'cut',
      'crossfade',
      'dip-black',
      'dip-white',
      'slide',
      'zoom',
    ];

    it.each(transitions)(
      '%s: duration = sum of segments - sum of overlaps; A/V both present',
      async (tr) => {
        const segments = [seg(0, 3), seg(3, 5.5), seg(5.5, 9)];
        const T = effectiveTransitionSec(tr, 0.4, [3, 2.5, 3.5]);
        const expected = stitchedDuration([3, 2.5, 3.5], T);
        const out = path.join(dir, `hl-${tr}.mp4`);
        const res = await render.renderHighlight({
          ...base(`hl-${tr}.mp4`),
          sourcePath: src,
          segments,
          transition: tr,
          transitionSec: 0.4,
        });
        expect(res.durationSec).toBeCloseTo(expected, 3);
        expect(expected).toBeCloseTo(tr === 'cut' ? 9 : 8.2, 6);
        const info = await probeStreams(FFMPEG, out);
        expect(info.durationSec!).toBeGreaterThan(expected - 0.1);
        expect(info.durationSec!).toBeLessThan(expected + 0.1);
        expect(info.hasAudio).toBe(true);
        expect([info.width, info.height]).toEqual([270, 480]);
        expect(fs.readdirSync(dir).filter((f) => f.startsWith('.'))).toEqual([]);
      },
      120_000,
    );

    it('transition frames are really blended (crossfade) / black (dip-black)', async () => {
      // segment 1 = red/blue split of the left half only (red), segment 2 = right half (blue)
      const red = splitPlan({
        panels: [
          {
            out: { x: 0, y: 0, w: 270, h: 240 },
            keyframes: [kf(0, 0, 0, 160, 142), kf(3, 0, 0, 160, 142)],
            role: 'face-a',
          },
          {
            out: { x: 0, y: 240, w: 270, h: 240 },
            keyframes: [kf(0, 0, 0, 160, 142), kf(3, 0, 0, 160, 142)],
            role: 'face-b',
          },
        ],
      });
      const blue = splitPlan({
        panels: [
          {
            out: { x: 0, y: 0, w: 270, h: 240 },
            keyframes: [kf(0, 480, 0, 160, 142), kf(3, 480, 0, 160, 142)],
            role: 'face-a',
          },
          {
            out: { x: 0, y: 240, w: 270, h: 240 },
            keyframes: [kf(0, 480, 0, 160, 142), kf(3, 480, 0, 160, 142)],
            role: 'face-b',
          },
        ],
      });
      for (const tr of ['crossfade', 'dip-black'] as const) {
        const out = path.join(dir, `blend-${tr}.mp4`);
        await render.renderHighlight({
          ...base(`blend-${tr}.mp4`),
          sourcePath: src,
          segments: [seg(0, 3, red), seg(3, 6, blue)],
          transition: tr,
          transitionSec: 1,
        });
        // overlap = [2, 3]; its midpoint is t = 2.5
        const before = mean(frameRgb(out, 1, 270, 480), 270, 20, 20, 250, 220);
        const mid = mean(frameRgb(out, 2.5, 270, 480), 270, 20, 20, 250, 220);
        const after = mean(frameRgb(out, 4, 270, 480), 270, 20, 20, 250, 220);
        expect(before[0]).toBeGreaterThan(200);
        expect(after[2]).toBeGreaterThan(200);
        if (tr === 'crossfade') {
          expect(mid[0]).toBeGreaterThan(60);
          expect(mid[2]).toBeGreaterThan(60); // both pictures visible
        } else {
          expect(mid[0] + mid[1] + mid[2]).toBeLessThan(150); // through black (before/after are > 400)
        }
      }
    }, 120_000);

    it('loudness is normalised ONCE on the joined audio (about -14 LUFS)', async () => {
      const out = path.join(dir, 'hl-loud.mp4');
      await render.renderHighlight({
        ...base('hl-loud.mp4'),
        sourcePath: src,
        segments: [seg(0, 4), seg(4, 8)],
        transition: 'crossfade',
        transitionSec: 0.5,
      });
      const err = String(
        spawnSync(FFMPEG, [
          '-hide_banner',
          '-nostats',
          '-i',
          out,
          '-af',
          'ebur128',
          '-f',
          'null',
          '-',
        ]).stderr,
      );
      const m = /Integrated loudness:\s*\n\s*I:\s*(-?[\d.]+) LUFS/.exec(err);
      expect(m).not.toBeNull();
      expect(Math.abs(Number(m![1]) + 14)).toBeLessThan(1.2);
    }, 60_000);

    it('a single segment, a silent source and per-segment layouts (split + single) work', async () => {
      const single: ReframePlan = {
        mode: 'single-face',
        aspect: '9:16',
        srcW: 640,
        srcH: 360,
        outW: 270,
        outH: 480,
        keyframes: [kf(0, 100, 0, 203, 360), kf(3, 300, 0, 203, 360)],
        cuts: [],
        faceCoverage: 1,
        layout: 'single',
      };
      const one = await render.renderHighlight({
        ...base('hl-one.mp4'),
        sourcePath: src,
        segments: [seg(0, 3, single)],
        transition: 'crossfade',
        transitionSec: 0.4,
      });
      expect(one.durationSec).toBe(3);
      const mixed = await render.renderHighlight({
        ...base('hl-mixed.mp4'),
        sourcePath: silent,
        segments: [seg(0, 3, single), seg(3, 6)],
        transition: 'slide',
        transitionSec: 0.5,
        hook: { text: 'Hook over the first seconds', durationSec: 2 },
        fontsDir: path.resolve(__dirname, '../../electron/main/assets/fonts'),
      });
      expect(mixed.durationSec).toBeCloseTo(5.5, 3);
      const info = await probeStreams(FFMPEG, path.join(dir, 'hl-mixed.mp4'));
      expect(info.hasAudio).toBe(false);
    }, 120_000);

    it('aborts, validates and cleans up', async () => {
      const ac = new AbortController();
      const p = render.renderHighlight({
        ...base('hl-abort.mp4'),
        sourcePath: src,
        segments: [seg(0, 4), seg(4, 8)],
        transition: 'crossfade',
        transitionSec: 0.4,
        signal: ac.signal,
        onProgress: (f) => {
          if (f !== null && f > 0.02) ac.abort();
        },
      });
      await expect(p).rejects.toMatchObject({ name: 'AbortError' });
      expect(fs.existsSync(path.join(dir, 'hl-abort.mp4'))).toBe(false);
      expect(fs.readdirSync(dir).filter((f) => f.startsWith('.'))).toEqual([]);
      await expect(
        render.renderHighlight({
          ...base('x.mp4'),
          sourcePath: src,
          segments: [],
          transition: 'cut',
          transitionSec: 0.3,
        }),
      ).rejects.toThrow(/at least one segment/);
      await expect(
        render.renderHighlight({
          ...base('x.mp4'),
          sourcePath: src,
          segments: [seg(5, 2)],
          transition: 'cut',
          transitionSec: 0.3,
        }),
      ).rejects.toThrow(/Invalid segment range/);
      await expect(
        render.renderHighlight({
          ...base('x.mp4'),
          sourcePath: src,
          segments: [seg(0, 2), { ...seg(2, 4), plan: { ...splitPlan(), outW: 540, outH: 960 } }],
          transition: 'cut',
          transitionSec: 0.3,
        }),
      ).rejects.toThrow(/same output size/);
    }, 60_000);
  });
});
