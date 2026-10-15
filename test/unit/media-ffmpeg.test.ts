import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FfmpegProgressParser,
  MediaError,
  createMediaService,
  describeProgress,
  formatEta,
  humanizeFfmpegError,
  mediaInfoFromProbe,
  parseFrameRate,
  proxyHeight,
  runFfmpeg,
} from '../../electron/main/services/media/ffmpeg';
import {
  isAbortError,
  liveProcessCount,
  runProcess,
} from '../../electron/main/services/media/proc';

const req = createRequire(import.meta.url);
const FFMPEG = req('ffmpeg-static') as string;
const FFPROBE = (req('ffprobe-static') as { path: string }).path;

/* ----------------------------------------------- pure parts ------------------------------------------------ */

describe('ffmpeg -progress parsing', () => {
  // recorded from `ffmpeg -progress pipe:1` (ffmpeg 7.0.2)
  const sample = [
    'frame=60',
    'fps=0.00',
    'stream_0_0_q=-1.0',
    'bitrate=N/A',
    'total_size=N/A',
    'out_time_us=2400000',
    'out_time_ms=2400000',
    'out_time=00:00:02.400000',
    'dup_frames=0',
    'drop_frames=0',
    'speed=4.8x',
    'progress=continue',
    'frame=120',
    'out_time_us=4800000',
    'out_time=00:00:04.800000',
    'speed=N/A',
    'progress=end',
  ];

  it('emits a snapshot at every progress= line', () => {
    const p = new FfmpegProgressParser();
    const snaps = sample.map((l) => p.push(l)).filter((s) => s !== null);
    expect(snaps).toEqual([
      { outTimeSec: 2.4, speed: 4.8, ended: false },
      { outTimeSec: 4.8, speed: null, ended: true },
    ]);
  });

  it('copes with N/A start values and falls back to out_time', () => {
    const p = new FfmpegProgressParser();
    expect(p.push('out_time_us=N/A')).toBeNull();
    expect(p.push('out_time=00:01:02.500000')).toBeNull();
    expect(p.push('progress=continue')).toEqual({ outTimeSec: 62.5, speed: null, ended: false });
  });

  it('turns snapshots into fraction + "speed · ETA" messages', () => {
    expect(describeProgress({ outTimeSec: 30, speed: 2, ended: false }, 120)).toEqual({
      fraction: 0.25,
      message: '2.0x · 00:45 left',
    });
    expect(describeProgress({ outTimeSec: 30, speed: 12.4, ended: false }, 60).message).toBe(
      '12x · 00:02 left',
    );
    expect(describeProgress({ outTimeSec: 5, speed: null, ended: false }, null)).toEqual({
      fraction: null,
      message: 'Working',
    });
    expect(
      describeProgress({ outTimeSec: 130, speed: 1, ended: false }, 120).fraction,
    ).toBeLessThan(1);
    expect(describeProgress({ outTimeSec: null, speed: null, ended: true }, 10).fraction).toBe(1);
    expect(formatEta(3700)).toBe('1:01:40');
  });
});

describe('ffprobe mapping', () => {
  it('maps a recorded h264+aac mp4 probe', () => {
    const info = mediaInfoFromProbe({
      streams: [
        {
          codec_type: 'video',
          codec_name: 'h264',
          width: 854,
          height: 480,
          avg_frame_rate: '30000/1001',
          r_frame_rate: '30000/1001',
          duration: '1129.643',
        },
        { codec_type: 'audio', codec_name: 'aac', duration: '1129.643' },
      ],
      format: { duration: '1129.643000', size: '109974543' },
    });
    expect(info).toEqual({
      durationSec: 1129.643,
      width: 854,
      height: 480,
      fps: 29.97,
      videoCodec: 'h264',
      audioCodec: 'aac',
      hasAudio: true,
      hasVideo: true,
      sizeBytes: 109974543,
    });
  });

  it('ignores cover art, swaps dimensions for rotated phone video, handles audio-only', () => {
    const rotated = mediaInfoFromProbe({
      streams: [
        {
          codec_type: 'video',
          codec_name: 'mjpeg',
          width: 500,
          height: 500,
          disposition: { attached_pic: 1 },
        },
        {
          codec_type: 'video',
          codec_name: 'hevc',
          width: 1920,
          height: 1080,
          avg_frame_rate: '30/1',
          side_data_list: [{ rotation: -90 }],
        },
        { codec_type: 'audio', codec_name: 'aac' },
      ],
      format: { duration: '10.5' },
    });
    expect(rotated).toMatchObject({
      width: 1080,
      height: 1920,
      videoCodec: 'hevc',
      fps: 30,
      sizeBytes: null,
    });
    const audioOnly = mediaInfoFromProbe({
      streams: [{ codec_type: 'audio', codec_name: 'pcm_s16le', duration: '3.0' }],
      format: { duration: '3.000000', size: '96078' },
    });
    expect(audioOnly).toMatchObject({
      hasVideo: false,
      hasAudio: true,
      width: null,
      fps: null,
      durationSec: 3,
    });
    expect(mediaInfoFromProbe({}).durationSec).toBe(0);
  });

  it('parses frame rates', () => {
    expect(parseFrameRate('25/1')).toBe(25);
    expect(parseFrameRate('0/0')).toBeNull();
    expect(parseFrameRate('24')).toBe(24);
    expect(parseFrameRate(undefined)).toBeNull();
  });

  it('picks an even proxy height and never upscales', () => {
    expect(proxyHeight(1080, 480)).toBe(480);
    expect(proxyHeight(360, 480)).toBe(360);
    expect(proxyHeight(361, 480)).toBe(360);
    expect(proxyHeight(null, 480)).toBe(480);
    expect(proxyHeight(481, 481)).toBe(480);
  });
});

describe('humanizeFfmpegError', () => {
  it.each([
    ['x: No such file or directory', /does not exist/],
    ['Invalid data found when processing input', /corrupt/],
    ['moov atom not found', /corrupt/],
    ["Stream map '0:a:0' matches no streams.", /no audio track/],
    ['Output file #0 does not contain any stream', /no usable audio or video/],
    ['/x/out.wav: Permission denied', /permission denied/],
    ['av_interleaved_write_frame(): No space left on device', /disk is full/],
    ['Unknown encoder libx999', /lacks a required encoder/],
  ])('%s', (stderr, re) => {
    expect(humanizeFfmpegError(stderr, 'Doing X')).toMatch(re);
  });
  it('falls back to the last stderr line, truncated', () => {
    const m = humanizeFfmpegError('line1\nsomething odd ' + 'z'.repeat(400), 'Doing X');
    expect(m.startsWith('Doing X failed: something odd')).toBe(true);
    expect(m.length).toBeLessThan(260);
  });
});

/* -------------------------------------- integration with the real binaries --------------------------------- */

describe('MediaService (real ffmpeg/ffprobe on synthetic media)', () => {
  let dir = '';
  let src = '';
  let audioOnly = '';
  let silentVideo = '';
  const svc = createMediaService({
    ffmpegPath: () => FFMPEG,
    ffprobePath: () => FFPROBE,
    log: () => undefined,
  });

  const ff = (args: string[]): void => {
    const r = spawnSync(FFMPEG, ['-v', 'error', '-y', ...args], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
  };

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipfern-media-'));
    src = path.join(dir, 'src.mp4');
    // 6 s, 1280x720, 25 fps, stereo 48 kHz tone
    ff([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=1280x720:rate=25:duration=6',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=6',
      '-ac',
      '2',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      src,
    ]);
    audioOnly = path.join(dir, 'a.m4a');
    ff(['-f', 'lavfi', '-i', 'sine=frequency=300:duration=3', '-c:a', 'aac', audioOnly]);
    silentVideo = path.join(dir, 'silent.mp4');
    ff([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x240:rate=25:duration=2',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      silentVideo,
    ]);
  }, 60_000);
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('probe() returns MediaInfo', async () => {
    const info = await svc.probe(src);
    expect(info).toMatchObject({
      width: 1280,
      height: 720,
      fps: 25,
      videoCodec: 'h264',
      audioCodec: 'aac',
      hasAudio: true,
      hasVideo: true,
    });
    expect(info.durationSec).toBeGreaterThan(5.9);
    expect(info.durationSec).toBeLessThan(6.2);
    expect(info.sizeBytes).toBeGreaterThan(1000);
    expect(await svc.probe(audioOnly)).toMatchObject({ hasVideo: false, hasAudio: true });
  });

  it('probe() gives descriptive errors', async () => {
    await expect(svc.probe(path.join(dir, 'missing.mp4'))).rejects.toThrow(/File not found/);
    const junk = path.join(dir, 'junk.mp4');
    fs.writeFileSync(junk, 'this is not media at all');
    await expect(svc.probe(junk)).rejects.toThrow(/corrupt|not a supported/);
  });

  it('extractAudio16k() writes 16 kHz mono pcm_s16le with progress', async () => {
    const out = path.join(dir, 'audio.wav');
    const prog: (number | null)[] = [];
    await svc.extractAudio16k(src, out, { onProgress: (f) => prog.push(f) });
    const info = await svc.probe(out);
    expect(info.audioCodec).toBe('pcm_s16le');
    expect(info.durationSec).toBeGreaterThan(5.9);
    const hdr = fs.readFileSync(out).subarray(0, 44);
    expect(hdr.toString('ascii', 0, 4)).toBe('RIFF');
    expect(hdr.readUInt16LE(22)).toBe(1); // mono
    expect(hdr.readUInt32LE(24)).toBe(16000);
    expect(hdr.readUInt16LE(34)).toBe(16);
    expect(prog.at(-1)).toBe(1);
    expect(fs.readdirSync(dir).some((f) => f.includes('.partial'))).toBe(false);
  });

  it('extractAudio16k() supports a window and clamps it to the media length', async () => {
    const out = path.join(dir, 'win.wav');
    await svc.extractAudio16k(src, out, { startSec: 1, durSec: 2 });
    expect((await svc.probe(out)).durationSec).toBeCloseTo(2, 1);
    await svc.extractAudio16k(src, out, { startSec: 4, durSec: 10 });
    expect((await svc.probe(out)).durationSec).toBeCloseTo(2, 1);
    await expect(svc.extractAudio16k(src, out, { startSec: 50, durSec: 2 })).rejects.toThrow(
      /window is empty/,
    );
  });

  it('extractAudio16k() refuses media without audio', async () => {
    await expect(svc.extractAudio16k(silentVideo, path.join(dir, 'x.wav'))).rejects.toThrow(
      /no audio track/,
    );
    expect(fs.existsSync(path.join(dir, 'x.wav'))).toBe(false);
  });

  it('makeProxy() makes a 480p-max, even-sized, faststart H.264/AAC mp4 and never upscales', async () => {
    const out = path.join(dir, 'proxy.mp4');
    const prog: number[] = [];
    await svc.makeProxy(src, out, { onProgress: (f) => f !== null && prog.push(f) });
    const info = await svc.probe(out);
    expect(info.videoCodec).toBe('h264');
    expect(info.audioCodec).toBe('aac');
    // 1280x720 -> height 480; the width keeps the aspect ratio (853.3) and is rounded to an even number
    expect(info.height).toBe(480);
    expect(info.width! % 2).toBe(0);
    expect(info.width).toBe(854);
    expect(info.durationSec).toBeGreaterThan(5.8);
    // faststart: moov before mdat
    const head = fs.readFileSync(out).subarray(0, 4096).toString('latin1');
    expect(head.indexOf('moov')).toBeGreaterThan(-1);
    expect(head.indexOf('moov')).toBeLessThan(
      head.includes('mdat') ? head.indexOf('mdat') : Infinity,
    );
    expect(prog.at(-1)).toBe(1);

    const small = path.join(dir, 'small.mp4');
    await svc.makeProxy(silentVideo, small); // 320x240, no audio: no upscaling, no audio stream
    expect(await svc.probe(small)).toMatchObject({ width: 320, height: 240, hasAudio: false });

    const h240 = path.join(dir, 'h240.mp4');
    await svc.makeProxy(src, h240, { height: 240 });
    expect((await svc.probe(h240)).height).toBe(240);
  }, 60_000);

  it('makeProxy() refuses audio-only input', async () => {
    await expect(svc.makeProxy(audioOnly, path.join(dir, 'p.mp4'))).rejects.toThrow(
      /no video stream/,
    );
  });

  it('extractFrame() writes a scaled JPEG', async () => {
    const out = path.join(dir, 'frame.jpg');
    await svc.extractFrame(src, 2.5, out, { maxWidth: 320 });
    const b = fs.readFileSync(out);
    expect(b[0]).toBe(0xff);
    expect(b[1]).toBe(0xd8); // JPEG SOI
    // dimensions from the SOF0/2 marker
    let i = 2;
    let w = 0;
    let h = 0;
    while (i < b.length) {
      if (b[i] !== 0xff) break;
      const marker = b[i + 1]!;
      const len = b.readUInt16BE(i + 2);
      if (marker === 0xc0 || marker === 0xc2) {
        h = b.readUInt16BE(i + 5);
        w = b.readUInt16BE(i + 7);
        break;
      }
      i += 2 + len;
    }
    expect(w).toBe(320);
    expect(h).toBeGreaterThan(170);
    const full = path.join(dir, 'frame-full.jpg');
    await svc.extractFrame(silentVideo, 0, full); // default maxWidth 1280 must not upscale 320 px
    expect(fs.statSync(full).size).toBeGreaterThan(500);
  });

  it('extractFrame() beyond the end is a descriptive error and leaves nothing behind', async () => {
    const out = path.join(dir, 'late.jpg');
    await expect(svc.extractFrame(src, 99, out)).rejects.toThrow(/no video frame at 99\.00 s/);
    expect(fs.existsSync(out)).toBe(false);
    expect(fs.readdirSync(dir).some((f) => f.includes('.partial'))).toBe(false);
  });

  it('errors on corrupt input are descriptive and leave no partial output', async () => {
    const junk = path.join(dir, 'junk2.mp4');
    fs.writeFileSync(junk, 'nope');
    await expect(svc.extractAudio16k(junk, path.join(dir, 'j.wav'))).rejects.toThrow(MediaError);
    expect(fs.existsSync(path.join(dir, 'j.wav'))).toBe(false);
  });

  it('cancels a running job: AbortError, process gone, no partial/final output', async () => {
    const out = path.join(dir, 'long.mp4');
    const ac = new AbortController();
    const tag = `abort-test-${Date.now()}`;
    // 1080p60 test pattern for an hour: far longer than the test, so it must be the abort that ends it
    const p = runFfmpeg(
      FFMPEG,
      [
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=1920x1080:rate=60:duration=3600',
        '-c:v',
        'libx264',
        '-preset',
        'medium',
        '-metadata',
        `comment=${tag}`,
        out,
      ],
      { signal: ac.signal, durationSec: 3600, onProgress: () => undefined },
    );
    setTimeout(() => ac.abort(), 600);
    const t0 = Date.now();
    await expect(p).rejects.toSatisfy(isAbortError);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(liveProcessCount()).toBe(0);
    if (process.platform !== 'win32') {
      const ps = spawnSync('pgrep', ['-f', tag], { encoding: 'utf8' });
      expect(ps.stdout.trim()).toBe('');
    }
    // a pre-aborted signal never even spawns
    const pre = new AbortController();
    pre.abort();
    await expect(
      svc.extractAudio16k(src, path.join(dir, 'pre.wav'), { signal: pre.signal }),
    ).rejects.toSatisfy(isAbortError);
    expect(fs.existsSync(path.join(dir, 'pre.wav'))).toBe(false);
  }, 30_000);

  it('abort during extractAudio16k removes the .partial file', async () => {
    const big = path.join(dir, 'big.wav');
    // ~1 h of silence as WAV (generated instantly via lavfi) so extraction takes a moment
    const g = spawnSync(FFMPEG, [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'anoisesrc=d=3000:r=16000',
      '-c:a',
      'pcm_s16le',
      big,
    ]);
    expect(g.status).toBe(0);
    const out = path.join(dir, 'abort-audio.wav');
    const ac = new AbortController();
    const p = svc.extractAudio16k(big, out, { signal: ac.signal });
    setTimeout(() => ac.abort(), 30);
    await expect(p).rejects.toSatisfy(isAbortError);
    expect(fs.readdirSync(dir).filter((f) => f.includes('abort-audio'))).toEqual([]);
  }, 60_000);
});

describe('runProcess', () => {
  it('reports a missing executable clearly', async () => {
    await expect(runProcess('/definitely/not/here', [])).rejects.toThrow(/Executable not found/);
  });
});
