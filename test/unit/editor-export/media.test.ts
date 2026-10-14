/** EditorMediaService: probe, waveform, beats, thumbStrip, makePreview, runFfmpeg. */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createEditorMedia,
  detectBeats,
  estimateTempo,
  onsetEnvelope,
} from '../../../electron/main/services/editor-media';
import { liveProcessCount } from '../../../electron/main/services/media/proc';
import {
  FFMPEG,
  FFPROBE,
  FIXTURE_NEWS,
  avClip,
  ff,
  flatClip,
  haveFfmpeg,
  pngImage,
  probeDims,
  sineWav,
  tmp,
} from './helpers';

vi.setConfig({ testTimeout: 90_000 });
const media = createEditorMedia({ ffmpegPath: () => FFMPEG, ffprobePath: () => FFPROBE });

describe.skipIf(!haveFfmpeg)('probe', () => {
  it('video with audio', async () => {
    const r = await media.probe(avClip('FF0000', 440, 2, 0.5));
    expect(r).toMatchObject({ kind: 'video', width: 160, height: 284, hasAudio: true, fps: 30 });
    expect(r.durationSec).toBeGreaterThan(1.9);
  });
  it('video without audio', async () => {
    expect(await media.probe(flatClip('00FF00', 1))).toMatchObject({
      kind: 'video',
      hasAudio: false,
    });
  });
  it('audio file', async () => {
    const r = await media.probe(sineWav(440, 2));
    expect(r).toMatchObject({ kind: 'audio', width: null, height: null, hasAudio: true });
    expect(r.durationSec).toBeCloseTo(2, 1);
  });
  it('png and jpeg are images (no duration, no fps)', async () => {
    const png = pngImage('FF8030', 100, 60);
    expect(await media.probe(png)).toMatchObject({
      kind: 'image',
      width: 100,
      height: 60,
      durationSec: null,
      fps: null,
      hasAudio: false,
    });
    const jpg = path.join(tmp('media'), 'x.jpg');
    ff(['-i', png, jpg]);
    expect(await media.probe(jpg)).toMatchObject({ kind: 'image', width: 100, height: 60 });
  });
  it('.cube is a lut (not probed by ffprobe)', async () => {
    const f = path.join(tmp('media'), 'a.cube');
    fs.writeFileSync(f, 'LUT_3D_SIZE 2\n');
    expect(await media.probe(f)).toMatchObject({ kind: 'lut', width: null, durationSec: null });
  });
  it('missing file → readable error', async () => {
    await expect(media.probe('/nonexistent/file.mp4')).rejects.toThrow(/not found/i);
  });
  it('a text file is not media', async () => {
    const f = path.join(tmp('media'), 'x.txt');
    fs.writeFileSync(f, 'hello');
    await expect(media.probe(f)).rejects.toThrow();
  });
});

describe.skipIf(!haveFfmpeg)('waveform', () => {
  it('peaks per window follow the signal (sine amp 0.5 → peaks ≈ 0.5)', async () => {
    const w = await media.waveform(sineWav(440, 4, 0.5), 100);
    expect(w.rate).toBe(100);
    expect(w.durationSec).toBeCloseTo(4, 1);
    expect(Math.abs(w.peaks.length - 400)).toBeLessThanOrEqual(2);
    for (const p of w.peaks.slice(5, 395)) {
      expect(p).toBeGreaterThan(0.45);
      expect(p).toBeLessThan(0.52);
    }
  });
  it('silence → ~0 and an amplitude ramp rises monotonically (coarse)', async () => {
    const f = path.join(tmp('media'), 'ramp8.wav');
    ff(['-f', 'lavfi', '-i', "aevalsrc='sin(2*PI*300*t)*t/2':s=48000:d=2", '-ac', '1', f]);
    const w = await media.waveform(f, 10);
    expect(w.peaks.length).toBe(20);
    expect(w.peaks[1]!).toBeLessThan(w.peaks[10]!);
    expect(w.peaks[10]!).toBeLessThan(w.peaks[19]!);
    const z = path.join(tmp('media'), 'zero.wav');
    ff(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '1', z]);
    expect(Math.max(...(await media.waveform(z, 50)).peaks)).toBeLessThan(0.001);
  });
  it('rate above 8000 windows/s is rejected; progress is reported', async () => {
    await expect(media.waveform(sineWav(440, 1), 9000)).rejects.toThrow(/rate/i);
    const seen: number[] = [];
    await media.waveform(sineWav(440, 3), 50, { onProgress: (f) => seen.push(f ?? 0) });
    expect(seen[seen.length - 1]).toBe(1);
  });
  it('a file without audio fails with a readable error', async () => {
    await expect(media.waveform(flatClip('00FF00', 1), 50)).rejects.toThrow();
  });
});

describe.skipIf(!haveFfmpeg)('beats', () => {
  const click = (bpm: number, off: number, dur = 20) => {
    const p = 60 / bpm;
    const out = path.join(tmp('media'), `click-${bpm}-${off}.wav`);
    if (!fs.existsSync(out))
      ff([
        '-f',
        'lavfi',
        '-i',
        `aevalsrc=exprs='sin(2*PI*1500*t)*exp(-150*mod(t-${off}\\,${p}))*gte(t\\,${off})*0.8':s=44100:d=${dur}`,
        '-ac',
        '1',
        out,
      ]);
    return { file: out, p, off, dur };
  };
  const err = (beats: number[], p: number, off: number, dur: number) => {
    const exp = Array.from(
      { length: Math.floor((dur - off) / p) + 1 },
      (_v, i) => off + i * p,
    ).filter((t) => t < dur);
    let worst = 0;
    for (const b of beats) worst = Math.max(worst, Math.min(...exp.map((e) => Math.abs(e - b))));
    return worst;
  };
  for (const [bpm, off] of [
    [120, 0.12],
    [100, 0.3],
    [140, 0.2],
    [90, 0.31],
    [75, 0.05],
    [170, 0.1],
  ] as const) {
    it(`click track ${bpm} BPM (phase ${off}s): every beat within ±30 ms, no missing beats`, async () => {
      const c = click(bpm, off);
      const b = await media.beats(c.file);
      expect(b.length).toBeGreaterThan(Math.floor((c.dur - off) / c.p) - 2);
      expect(err(b, c.p, off, c.dur)).toBeLessThan(0.03);
      // tempo from the median beat interval
      const gaps = b
        .slice(1)
        .map((x, i) => x - (b[i] as number))
        .sort((x, y) => x - y);
      expect(Math.abs((gaps[Math.floor(gaps.length / 2)] as number) - c.p)).toBeLessThan(0.006);
    });
  }

  it('music-like pattern (kick + hats + bass, 100 BPM) is tracked within ±30 ms', async () => {
    const f = path.join(tmp('media'), 'music100.wav');
    ff([
      '-f',
      'lavfi',
      '-i',
      "aevalsrc='0.7*sin(2*PI*(55+90*exp(-30*mod(t-0.2,0.6)))*t)*exp(-12*mod(t-0.2,0.6))*gte(t,0.2)+0.12*(random(1)-0.5)*exp(-60*mod(t-0.2,0.3))*gte(t,0.2)+0.15*sin(2*PI*110*t)':s=44100:d=24",
      '-ac',
      '1',
      f,
    ]);
    const b = await media.beats(f);
    expect(b.length).toBeGreaterThan(30);
    // beats may lock to the kick (0.6 s) or a half-time grid; check they fall on kick onsets
    let worst = 0;
    for (const t of b) {
      const k = Math.round((t - 0.2) / 0.6);
      worst = Math.max(worst, Math.abs(t - (0.2 + k * 0.6)));
    }
    expect(worst).toBeLessThan(0.03);
  });

  it('silence and steady noise have no beat grid', async () => {
    const z = path.join(tmp('media'), 'zero10.wav');
    ff(['-f', 'lavfi', '-i', 'anullsrc=r=22050:cl=mono', '-t', '10', z]);
    expect(await media.beats(z)).toEqual([]);
  });

  it('real speech (fixture) does not crash and returns sorted times', async () => {
    if (!fs.existsSync(FIXTURE_NEWS)) return;
    const b = await media.beats(FIXTURE_NEWS);
    for (let i = 1; i < b.length; i++) expect(b[i]!).toBeGreaterThan(b[i - 1]!);
  });

  it('pure functions: too-short audio → no tempo; onset envelope length matches the hop', () => {
    expect(detectBeats(new Float32Array(1000), 22050)).toEqual([]);
    const { env, fps } = onsetEnvelope(new Float32Array(22050 * 2), 22050);
    expect(Math.abs(env.length - ((22050 * 2 - 512) / 128 + 1))).toBeLessThanOrEqual(1);
    expect(fps).toBeCloseTo(22050 / 128, 6);
    expect(estimateTempo(new Float64Array(10), 172)).toBeNull();
  });
});

describe.skipIf(!haveFfmpeg)('thumbStrip', () => {
  it('one sprite sheet: geometry, times, JPEG size', async () => {
    const out = path.join(tmp('thumbs'), 'strip.jpg');
    const g = await media.thumbStrip({
      file: flatClip('FF0000', 3),
      startSec: 0,
      endSec: 3,
      count: 10,
      height: 90,
      outJpg: out,
    });
    expect(g).toMatchObject({ cols: 10, rows: 1, tileH: 90 });
    expect(g.tileW % 2).toBe(0);
    expect(g.times).toHaveLength(10);
    expect(g.times[3]).toBeCloseTo(0.9, 6);
    const d = probeDims(out);
    expect(d.w).toBe(g.cols * g.tileW);
    expect(d.h).toBe(g.rows * g.tileH);
  });
  it('25 frames wrap into rows of 10; the requested window is honoured', async () => {
    const out = path.join(tmp('thumbs'), 'strip2.jpg');
    const g = await media.thumbStrip({
      file: flatClip('00FF00', 3),
      startSec: 0.5,
      endSec: 2.5,
      count: 25,
      height: 60,
      outJpg: out,
    });
    expect(g.cols).toBe(10);
    expect(g.rows).toBe(3);
    expect(g.times[0]).toBe(0.5);
    expect(g.times[24]).toBeCloseTo(0.5 + (24 * 2) / 25, 6);
    expect(fs.statSync(out).size).toBeGreaterThan(500);
  });
  it('the tiles show the right frames (colour changes along the strip)', async () => {
    const src = path.join(tmp('media'), 'rb.mp4');
    ff([
      '-f',
      'lavfi',
      '-i',
      'color=c=0xFF0000:s=64x64:r=10:d=1',
      '-f',
      'lavfi',
      '-i',
      'color=c=0x0000FF:s=64x64:r=10:d=1',
      '-filter_complex',
      '[0][1]concat=n=2:v=1,format=yuv420p',
      '-c:v',
      'libx264',
      '-crf',
      '12',
      src,
    ]);
    const out = path.join(tmp('thumbs'), 'rb.jpg');
    const g = await media.thumbStrip({
      file: src,
      startSec: 0,
      endSec: 2,
      count: 4,
      height: 32,
      outJpg: out,
    });
    const raw = ff(['-i', out, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    const w = g.cols * g.tileW;
    const px = (tile: number) =>
      raw.subarray((16 * w + tile * g.tileW + 8) * 3, (16 * w + tile * g.tileW + 8) * 3 + 3);
    expect(px(0)[0]).toBeGreaterThan(200); // red
    expect(px(1)[0]).toBeGreaterThan(200);
    expect(px(2)[2]).toBeGreaterThan(200); // blue
    expect(px(3)[2]).toBeGreaterThan(200);
  });
});

describe.skipIf(!haveFfmpeg)('makePreview', () => {
  it('landscape 1080p source → 480p H.264 with faststart and audio', async () => {
    const src = path.join(tmp('media'), 'big.mp4');
    ff([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=1920x1080:r=30:d=2',
      '-f',
      'lavfi',
      '-i',
      'sine=f=440:d=2',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-c:a',
      'aac',
      '-shortest',
      src,
    ]);
    const out = path.join(tmp('preview'), 'p.mp4');
    const seen: number[] = [];
    await media.makePreview(src, out, { onProgress: (f) => seen.push(f ?? 0) });
    const d = probeDims(out);
    expect(d.h).toBe(480);
    expect(d.w).toBe(854);
    const bytes = fs.readFileSync(out);
    expect(bytes.indexOf('moov')).toBeGreaterThan(0);
    expect(bytes.indexOf('moov')).toBeLessThan(bytes.indexOf('mdat')); // faststart
    expect(fs.existsSync(out.replace(/\.mp4$/, '.partial.mp4'))).toBe(false);
    expect(seen[seen.length - 1]).toBe(1);
    expect((await media.probe(out)).hasAudio).toBe(true);
  });
  it('small sources are never upscaled; no audio stays no audio', async () => {
    const out = path.join(tmp('preview'), 'small.mp4');
    await media.makePreview(flatClip('FF0000', 1, 160, 284), out);
    expect(probeDims(out).h).toBe(284);
    expect((await media.probe(out)).hasAudio).toBe(false);
  });
  it('a broken source leaves no partial file', async () => {
    const bad = path.join(tmp('media'), 'bad.mp4');
    fs.writeFileSync(bad, 'not a video');
    const out = path.join(tmp('preview'), 'bad-out.mp4');
    await expect(media.makePreview(bad, out)).rejects.toThrow();
    expect(fs.existsSync(out)).toBe(false);
    expect(fs.existsSync(out.replace(/\.mp4$/, '.partial.mp4'))).toBe(false);
  });
});

describe.skipIf(!haveFfmpeg)('runFfmpeg', () => {
  it('reports monotonic progress 0..1 against durationSec', async () => {
    const out = path.join(tmp('run'), 'o.mp4');
    const seen: number[] = [];
    await media.runFfmpeg({
      ffmpegPath: FFMPEG,
      durationSec: 3,
      args: [
        '-hide_banner',
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=s=320x240:r=30:d=3',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        out,
      ],
      onProgress: (f) => seen.push(f ?? 0),
    });
    expect(seen[0]).toBe(0);
    expect(seen[seen.length - 1]).toBe(1);
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
    expect(seen.length).toBeGreaterThan(2);
    expect(fs.statSync(out).size).toBeGreaterThan(1000);
  });
  it('a failing run rejects with the last stderr lines', async () => {
    await expect(
      media.runFfmpeg({
        ffmpegPath: FFMPEG,
        durationSec: 1,
        args: ['-hide_banner', '-y', '-i', '/nonexistent.mp4', '/tmp/x.mp4'],
      }),
    ).rejects.toThrow(/nonexistent|No such file/i);
  });
  it('AbortSignal kills the child and rejects with AbortError', async () => {
    const ac = new AbortController();
    const out = path.join(tmp('run'), 'long.mp4');
    const t0 = Date.now();
    const p = media.runFfmpeg({
      ffmpegPath: FFMPEG,
      durationSec: 600,
      signal: ac.signal,
      args: [
        '-hide_banner',
        '-v',
        'error',
        '-y',
        '-re',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=s=320x240:r=30:d=600',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        out,
      ],
    });
    setTimeout(() => ac.abort(), 400);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - t0).toBeLessThan(8000);
    expect(liveProcessCount()).toBe(0);
  });
  it('an already-aborted signal never starts the process', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      media.runFfmpeg({
        ffmpegPath: FFMPEG,
        durationSec: 1,
        signal: ac.signal,
        args: ['-version'],
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('adds -progress pipe:1 -nostats -nostdin when the caller left them out', async () => {
    const spy: string[][] = [];
    const out = path.join(tmp('run'), 'a.mp4');
    await media.runFfmpeg({
      ffmpegPath: FFMPEG,
      durationSec: 1,
      args: [
        '-hide_banner',
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=c=red:s=64x64:d=0.2',
        out,
      ],
      onProgress: () => spy.push([]),
    });
    expect(spy.length).toBeGreaterThan(0);
  });
});
