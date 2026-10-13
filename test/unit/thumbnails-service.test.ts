import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FrameScorer } from '../../electron/main/pipeline/contracts2';
import { probeStreams } from '../../electron/main/services/render';
import { createThumbnailService } from '../../electron/main/services/render';

const FFMPEG = path.resolve(__dirname, '../../node_modules/ffmpeg-static/ffmpeg');
const FONTS = path.resolve(__dirname, '../../electron/main/assets/fonts');
const have = fs.existsSync(FFMPEG);

function rawGray(file: string, w: number, h: number): Uint8Array {
  const out = execFileSync(
    FFMPEG,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      file,
      '-vf',
      `scale=${w}:${h}:flags=area,format=gray`,
      '-f',
      'rawvideo',
      '-',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 },
  );
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

describe.skipIf(!have)('thumbnail service (real ffmpeg, fake scorer)', () => {
  let dir = '';
  let clip = '';
  const svc = createThumbnailService();

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipfern-thumbs-'));
    clip = path.join(dir, 'clip [x].mp4');
    // 12 s portrait clip: a tone that is loud at 8-10 s and quiet elsewhere, moving test pattern
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
        'testsrc2=s=360x640:r=30:d=12',
        '-f',
        'lavfi',
        '-i',
        "aevalsrc='0.02*sin(2*PI*300*t)+0.5*sin(2*PI*440*t)*between(t,8,10)':s=16000:d=12",
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        clip,
      ],
      { stdio: 'pipe' },
    );
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('samples ~count frames spread over the clip, skipping the hook window, nudged to loud audio', async () => {
    const outDir = path.join(dir, 'cand');
    const frames = await svc.sample({
      ffmpegPath: FFMPEG,
      clipPath: clip,
      durationSec: 12,
      hookSeconds: 2.5,
      count: 8,
      outDir,
    });
    expect(frames.length).toBeGreaterThanOrEqual(6);
    expect(frames.length).toBeLessThanOrEqual(8);
    for (const f of frames) {
      expect(f.t).toBeGreaterThanOrEqual(2.5);
      expect(f.t).toBeLessThanOrEqual(11.7);
      expect(fs.statSync(f.file).size).toBeGreaterThan(1000);
      expect(f.file.startsWith(outDir)).toBe(true);
    }
    for (let i = 1; i < frames.length; i++) expect(frames[i]!.t).toBeGreaterThan(frames[i - 1]!.t);
    // the loud 8-10 s stretch attracts candidates
    expect(frames.some((f) => f.t >= 8 && f.t <= 10)).toBe(true);
    const info = await probeStreams(FFMPEG, frames[0]!.file);
    expect([info.width, info.height]).toEqual([360, 640]);
  }, 60_000);

  it('short clips and clips without audio still yield frames', async () => {
    const mute = path.join(dir, 'mute.mp4');
    execFileSync(
      FFMPEG,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        clip,
        '-t',
        '3',
        '-an',
        '-c:v',
        'copy',
        mute,
      ],
      { stdio: 'pipe' },
    );
    const frames = await svc.sample({
      ffmpegPath: FFMPEG,
      clipPath: mute,
      durationSec: 3,
      hookSeconds: 2.5,
      count: 8,
      outDir: path.join(dir, 'cand2'),
    });
    expect(frames.length).toBeGreaterThanOrEqual(1);
    for (const f of frames) expect(f.t).toBeLessThanOrEqual(3);
  }, 60_000);

  it('scores through the scorer (FrameScorer contract) and keeps t/file; ranks by total', async () => {
    const frames = [
      { t: 3, file: 'a.jpg' },
      { t: 5, file: 'b.jpg' },
      { t: 7, file: 'c.jpg' },
    ];
    let seen: string[] = [];
    const scorer: FrameScorer = async (files) => {
      seen = files;
      return [
        { sharpness: 20, brightness: 0.5, faces: [] },
        {
          sharpness: 300,
          brightness: 0.5,
          faces: [{ x: 0.4, y: 0.25, w: 0.2, h: 0.2, score: 0.9 }],
        },
        {
          sharpness: 280,
          brightness: 0.5,
          faces: [{ x: 0.0, y: 0.8, w: 0.05, h: 0.05, score: 0.6 }],
        },
      ];
    };
    const scored = await svc.score(frames, scorer);
    expect(seen).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
    expect(scored.map((s) => s.t)).toEqual([3, 5, 7]);
    const best = [...scored].sort((x, y) => y.total - x.total)[0]!;
    expect(best.file).toBe('b.jpg');
    expect(await svc.score([], scorer)).toEqual([]);
    await expect(svc.score(frames, async () => [])).rejects.toThrow(
      /returned 0 results for 3 frames/,
    );
  });

  it('compose: max width 720, aspect kept, text actually drawn inside the safe margins; no text -> plain scaled JPEG', async () => {
    const frame = path.join(dir, 'f.jpg');
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
        'color=c=0x336699:s=1080x1920:d=1',
        '-frames:v',
        '1',
        frame,
      ],
      { stdio: 'pipe' },
    );
    const withText = path.join(dir, 'with.jpg');
    const without = path.join(dir, 'without.jpg');
    await svc.compose({
      ffmpegPath: FFMPEG,
      framePath: frame,
      overlayText: 'This changed everything for me',
      fontsDir: FONTS,
      outJpg: withText,
    });
    await svc.compose({
      ffmpegPath: FFMPEG,
      framePath: frame,
      overlayText: null,
      fontsDir: FONTS,
      outJpg: without,
    });
    for (const f of [withText, without]) {
      const info = await probeStreams(FFMPEG, f);
      expect([info.width, info.height]).toEqual([720, 1280]);
    }
    const a = rawGray(withText, 72, 128);
    const b = rawGray(without, 72, 128);
    // text is drawn: pixels differ in the lower-middle band, nowhere else
    let bandDiff = 0;
    let outsideDiff = 0;
    let marginDiff = 0;
    for (let y = 0; y < 128; y++) {
      for (let x = 0; x < 72; x++) {
        const d = Math.abs((a[y * 72 + x] ?? 0) - (b[y * 72 + x] ?? 0));
        if (y >= 70 && y <= 100) bandDiff += d;
        else outsideDiff += d;
        if (x < 5 || x >= 67) marginDiff += d;
      }
    }
    expect(bandDiff).toBeGreaterThan(2000);
    expect(outsideDiff).toBeLessThan(bandDiff * 0.05);
    expect(marginDiff).toBeLessThan(bandDiff * 0.02);
    // small frames are not upscaled
    const small = path.join(dir, 'small.jpg');
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
        'color=c=red:s=360x640:d=1',
        '-frames:v',
        '1',
        small,
      ],
      { stdio: 'pipe' },
    );
    const outSmall = path.join(dir, 'small-out.jpg');
    await svc.compose({
      ffmpegPath: FFMPEG,
      framePath: small,
      overlayText: 'Hi',
      fontsDir: FONTS,
      outJpg: outSmall,
    });
    const info = await probeStreams(FFMPEG, outSmall);
    expect(info.width).toBe(360);
    expect(fs.readdirSync(dir).filter((f) => f.startsWith('.clipfern-thumb-'))).toEqual([]);
  }, 60_000);

  it('compose fails clearly for a missing frame', async () => {
    await expect(
      svc.compose({
        ffmpegPath: FFMPEG,
        framePath: path.join(dir, 'nope.jpg'),
        overlayText: 'x',
        fontsDir: FONTS,
        outJpg: path.join(dir, 'o.jpg'),
      }),
    ).rejects.toThrow();
  });
});
