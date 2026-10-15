import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeWithFfmpeg, ff, makeService, measureEbur, probeJson } from './brand-media-helpers';
import { tmpDir } from './helpers';

let dir: string;
let n = 0;
const outDir = (): string => path.join(dir, `out-${n++}`);
const svc = makeService();

/** 5 one-second colour segments (red, lime, blue, yellow, white) so the 25 % thumbnail has a known colour. */
const SEGMENTS = '[0:v][1:v][2:v][3:v][4:v]concat=n=5:v=1:a=0,format=yuv420p[v]';
const segInputs = (size: string): string[] =>
  ['red', 'lime', 'blue', 'yellow', 'white'].flatMap((c) => [
    '-f',
    'lavfi',
    '-i',
    `color=c=${c}:s=${size}:r=25:d=1`,
  ]);

/** A "music-like" tone stack, amplitude-modulated so loudness is not a flat sine. */
const tone = (dur: number, volDb: number): string =>
  `aevalsrc='0.5*sin(2*PI*220*t)+0.3*sin(2*PI*331*t)+0.2*sin(2*PI*523*t)*(0.6+0.4*sin(2*PI*2*t))':s=44100:d=${dur},volume=${volDb}dB`;

beforeAll(() => {
  dir = tmpDir('brand-av-');
  // 5 s video with audio at 640x360
  ff([
    ...segInputs('640x360'),
    '-f',
    'lavfi',
    '-i',
    tone(5, -18),
    '-filter_complex',
    SEGMENTS,
    '-map',
    '[v]',
    '-map',
    '5:a',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-c:a',
    'aac',
    '-shortest',
    path.join(dir, 'clip.mp4'),
  ]);
  ff([
    ...segInputs('640x360'),
    '-filter_complex',
    SEGMENTS,
    '-map',
    '[v]',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    path.join(dir, 'silent.mp4'),
  ]);
  ff([
    ...segInputs('720x1280'),
    '-f',
    'lavfi',
    '-i',
    tone(5, -18),
    '-filter_complex',
    SEGMENTS,
    '-map',
    '[v]',
    '-map',
    '5:a',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-c:a',
    'aac',
    '-shortest',
    path.join(dir, 'portrait.mp4'),
  ]);
  ff(['-i', path.join(dir, 'clip.mp4'), '-c', 'copy', path.join(dir, 'clip.mov')]);
  ff([
    '-i',
    path.join(dir, 'clip.mp4'),
    '-c:v',
    'libvpx',
    '-b:v',
    '300k',
    '-deadline',
    'realtime',
    '-c:a',
    'libopus',
    path.join(dir, 'clip.webm'),
  ]);
  ff(['-f', 'lavfi', '-i', tone(8, -30), '-c:a', 'pcm_s16le', path.join(dir, 'quiet.wav')]);
  ff([
    '-f',
    'lavfi',
    '-i',
    tone(8, 0),
    '-af',
    'volume=6dB,alimiter=limit=0.99:level=disabled',
    '-c:a',
    'libmp3lame',
    '-b:a',
    '192k',
    path.join(dir, 'loud.mp3'),
  ]);
  ff(['-f', 'lavfi', '-i', tone(8, -14), '-c:a', 'aac', '-f', 'adts', path.join(dir, 'mid.aac')]);
  ff(['-f', 'lavfi', '-i', tone(8, -20), '-c:a', 'aac', path.join(dir, 'mid.m4a')]);
  ff([
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=44100:cl=stereo',
    '-t',
    '3',
    '-c:a',
    'pcm_s16le',
    path.join(dir, 'silence.wav'),
  ]);
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const f = (name: string): string => path.join(dir, name);

describe('video', () => {
  it('mp4 with audio: probe data, loudness, 480p H.264 faststart preview, 25 % thumbnail', async () => {
    const progress: [string, number | null][] = [];
    const res = await svc.process({
      kind: 'video',
      file: f('clip.mp4'),
      ext: 'mp4',
      outDir: outDir(),
      onProgress: (s, p) => progress.push([s, p]),
    });
    expect([res.width, res.height]).toEqual([640, 360]);
    expect(res.durationSec).toBeCloseTo(5, 0);
    expect(res.fps).toBe(25);
    expect(res.hasAudio).toBe(true);
    const ref = measureEbur(f('clip.mp4'));
    expect(Math.abs((res.loudnessLufs as number) - ref.lufs)).toBeLessThan(0.6);

    const pv = res.preview as NonNullable<typeof res.preview>;
    expect(pv).toMatchObject({ ext: 'mp4', contentType: 'video/mp4' });
    const meta = probeJson(pv.path);
    const v = meta.streams.find((s) => s.codec_type === 'video') as Record<string, number | string>;
    expect(v.codec_name).toBe('h264');
    expect(v.pix_fmt).toBe('yuv420p');
    expect(v.height).toBe(360); // never upscaled
    expect(meta.streams.some((s) => s.codec_type === 'audio' && s.codec_name === 'aac')).toBe(true);
    // faststart: the moov atom precedes mdat
    const head = fs.readFileSync(pv.path).subarray(0, 4096).toString('latin1');
    expect(head.indexOf('moov')).toBeGreaterThan(-1);
    expect(head.indexOf('moov')).toBeLessThan(
      head.indexOf('mdat') === -1 ? Infinity : head.indexOf('mdat'),
    );

    // 25 % of 5 s = 1.25 s -> the GREEN segment
    const t = decodeWithFfmpeg((res.thumb as { path: string }).path);
    const [r, g, b] = t.at(Math.floor(t.width / 2), Math.floor(t.height / 2));
    expect(g).toBeGreaterThan(150);
    expect(r).toBeLessThan(80);
    expect(b).toBeLessThan(80);

    // progress is monotonic, within 0..1, reports stages and ends at 1
    const fr = progress.map((p) => p[1]).filter((x): x is number => x !== null);
    for (let i = 1; i < fr.length; i++)
      expect(fr[i] as number).toBeGreaterThanOrEqual(fr[i - 1] as number);
    expect(fr.at(-1)).toBe(1);
    expect(new Set(progress.map((p) => p[0]))).toContain('Creating preview');
    expect(new Set(progress.map((p) => p[0]))).toContain('Measuring loudness');
  });

  it('video without audio: no loudness, no audio stream in the preview', async () => {
    const res = await svc.process({
      kind: 'video',
      file: f('silent.mp4'),
      ext: 'mp4',
      outDir: outDir(),
    });
    expect(res.hasAudio).toBe(false);
    expect(res.loudnessLufs).toBeNull();
    expect(
      probeJson((res.preview as { path: string }).path).streams.some(
        (s) => s.codec_type === 'audio',
      ),
    ).toBe(false);
  });

  it('portrait video: 480 px tall preview with an even width, thumbnail <= 480', async () => {
    const res = await svc.process({
      kind: 'video',
      file: f('portrait.mp4'),
      ext: 'mp4',
      outDir: outDir(),
    });
    expect([res.width, res.height]).toEqual([720, 1280]);
    const v = probeJson((res.preview as { path: string }).path).streams.find(
      (s) => s.codec_type === 'video',
    ) as Record<string, number>;
    expect([v.width, v.height]).toEqual([270, 480]);
    const th = probeJson((res.thumb as { path: string }).path).streams[0] as Record<string, number>;
    expect(Math.max(th.width as number, th.height as number)).toBeLessThanOrEqual(480);
  });

  it.each(['mov', 'webm'])('%s containers are accepted', async (ext) => {
    const res = await svc.process({ kind: 'video', file: f(`clip.${ext}`), ext, outDir: outDir() });
    expect([res.width, res.height]).toEqual([640, 360]);
    expect(res.hasAudio).toBe(true);
    expect(res.durationSec).toBeGreaterThan(4);
    expect(res.preview?.ext).toBe('mp4');
  });

  it('an audio-only file uploaded as a video is explained', async () => {
    fs.copyFileSync(f('mid.m4a'), f('audio-as-video.mp4'));
    await expect(
      svc.process({ kind: 'video', file: f('audio-as-video.mp4'), ext: 'mp4', outDir: outDir() }),
    ).rejects.toThrow(
      "'audio-as-video.mp4' has no video track, only audio. Add it to the Audio section instead.",
    );
  });

  it('a wav under the video section is rejected by extension', async () => {
    await expect(
      svc.process({ kind: 'video', file: f('quiet.wav'), ext: 'wav', outDir: outDir() }),
    ).rejects.toThrow(/not a supported video file\. Supported: MP4, MOV, WEBM/);
  });

  it('truncated, garbage and empty files', async () => {
    const full = fs.readFileSync(f('clip.mp4'));
    fs.writeFileSync(f('cut.mp4'), full.subarray(0, Math.floor(full.length * 0.3)));
    await expect(
      svc.process({ kind: 'video', file: f('cut.mp4'), ext: 'mp4', outDir: outDir() }),
    ).rejects.toThrow(/Clipfern could not read 'cut\.mp4'\. Is it a valid MP4 video\?/);
    fs.writeFileSync(f('junk.mov'), Buffer.alloc(5000, 0x41));
    await expect(
      svc.process({ kind: 'video', file: f('junk.mov'), ext: 'mov', outDir: outDir() }),
    ).rejects.toThrow(/Clipfern could not read 'junk\.mov'/);
    fs.writeFileSync(f('zero.webm'), '');
    await expect(
      svc.process({ kind: 'video', file: f('zero.webm'), ext: 'webm', outDir: outDir() }),
    ).rejects.toThrow(/is empty/);
  });

  it('honours an already-aborted signal and leaves no preview behind', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const od = outDir();
    await expect(
      svc.process({
        kind: 'video',
        file: f('clip.mp4'),
        ext: 'mp4',
        outDir: od,
        signal: ctl.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fs.existsSync(path.join(od, 'preview.mp4'))).toBe(false);
  });
});

describe('audio', () => {
  /** The audition copy must sit at -14 LUFS (+-1 LU) with a true peak of at most -1 dBTP: measured independently. */
  const checkNormalised = (p: string): void => {
    const m = measureEbur(p);
    expect(Math.abs(m.lufs - -14)).toBeLessThanOrEqual(1);
    expect(m.truePeak).toBeLessThanOrEqual(-1);
  };

  it.each([
    ['quiet.wav', 'wav'],
    ['loud.mp3', 'mp3'],
    ['mid.aac', 'aac'],
    ['mid.m4a', 'm4a'],
  ] as const)(
    '%s: loudness of the original reported, audition copy normalised',
    async (file, ext) => {
      const res = await svc.process({ kind: 'audio', file: f(file), ext, outDir: outDir() });
      expect(res.hasAudio).toBe(true);
      expect(res.thumb).toBeNull();
      expect([res.width, res.height, res.fps]).toEqual([null, null, null]);
      expect(res.durationSec).toBeCloseTo(8, 0);
      const ref = measureEbur(f(file));
      expect(Math.abs((res.loudnessLufs as number) - ref.lufs)).toBeLessThan(0.6);
      const pv = res.preview as NonNullable<typeof res.preview>;
      expect(pv).toMatchObject({ ext: 'm4a', contentType: 'audio/mp4' });
      const meta = probeJson(pv.path);
      expect(meta.streams).toHaveLength(1);
      expect(meta.streams[0]).toMatchObject({ codec_type: 'audio', codec_name: 'aac' });
      checkNormalised(pv.path);
    },
  );

  it('the originals really differ in loudness (so the test proves normalisation)', () => {
    expect(measureEbur(f('loud.mp3')).lufs).toBeGreaterThan(measureEbur(f('quiet.wav')).lufs + 12);
  });

  it('a short SFX stinger (decaying hit, high crest factor) still lands on -14 LUFS under the peak ceiling', async () => {
    ff([
      '-f',
      'lavfi',
      '-i',
      "aevalsrc='0.9*exp(-5*t)*sin(2*PI*800*t)+0.3*exp(-9*t)*sin(2*PI*130*t)':s=44100:d=1.5",
      '-c:a',
      'pcm_s16le',
      f('stinger.wav'),
    ]);
    const res = await svc.process({
      kind: 'audio',
      file: f('stinger.wav'),
      ext: 'wav',
      outDir: outDir(),
    });
    checkNormalised((res.preview as { path: string }).path);
  });

  it('material that cannot reach -14 LUFS under the ceiling never breaks the peak ceiling', async () => {
    // quiet pad with sparse full-scale clicks: gain alone cannot get this to -14 LUFS without clipping
    ff([
      '-f',
      'lavfi',
      '-i',
      "aevalsrc='0.02*sin(2*PI*220*t)+0.95*sin(2*PI*1000*t)*lt(mod(t,2),0.03)':s=48000:d=10",
      '-c:a',
      'pcm_s16le',
      f('crest.wav'),
    ]);
    const res = await svc.process({
      kind: 'audio',
      file: f('crest.wav'),
      ext: 'wav',
      outDir: outDir(),
    });
    const m = measureEbur((res.preview as { path: string }).path);
    expect(m.truePeak).toBeLessThanOrEqual(-1);
    // the best a -1 dBTP ceiling allows is about -1 - (peak-to-loudness 14.7) = -15.7 LUFS: we land within ~1 LU of it
    expect(m.lufs).toBeGreaterThan(-17.5);
    expect(m.lufs).toBeLessThan(-14);
  });

  it('digital silence: no loudness value, still gets a preview', async () => {
    const res = await svc.process({
      kind: 'audio',
      file: f('silence.wav'),
      ext: 'wav',
      outDir: outDir(),
    });
    expect(res.loudnessLufs).toBeNull();
    expect(res.preview?.ext).toBe('m4a');
    expect(fs.statSync((res.preview as { path: string }).path).size).toBeGreaterThan(0);
  });

  it('a video-only file uploaded as audio is explained', async () => {
    fs.copyFileSync(f('silent.mp4'), f('video-as-audio.m4a'));
    await expect(
      svc.process({ kind: 'audio', file: f('video-as-audio.m4a'), ext: 'm4a', outDir: outDir() }),
    ).rejects.toThrow(
      "'video-as-audio.m4a' has no audio track. Add it to the Videos section instead.",
    );
  });

  it('an mp4 under the audio section is rejected by extension', async () => {
    await expect(
      svc.process({ kind: 'audio', file: f('clip.mp4'), ext: 'mp4', outDir: outDir() }),
    ).rejects.toThrow(/not a supported audio file\. Supported: MP3, WAV, AAC, M4A/);
  });

  it('truncated / garbage / empty audio', async () => {
    fs.writeFileSync(f('junk.mp3'), 'this is definitely not an mp3 file');
    await expect(
      svc.process({ kind: 'audio', file: f('junk.mp3'), ext: 'mp3', outDir: outDir() }),
    ).rejects.toThrow(/Clipfern could not read 'junk\.mp3'/);
    fs.writeFileSync(f('zero.wav'), '');
    await expect(
      svc.process({ kind: 'audio', file: f('zero.wav'), ext: 'wav', outDir: outDir() }),
    ).rejects.toThrow(/is empty/);
    const wav = fs.readFileSync(f('quiet.wav'));
    fs.writeFileSync(f('cut.m4a'), fs.readFileSync(f('mid.m4a')).subarray(0, 2000));
    await expect(
      svc.process({ kind: 'audio', file: f('cut.m4a'), ext: 'm4a', outDir: outDir() }),
    ).rejects.toThrow(/Clipfern could not read 'cut\.m4a'/);
    expect(wav.length).toBeGreaterThan(0);
  });

  it('progress is monotonic and finishes at 1', async () => {
    const seen: number[] = [];
    await svc.process({
      kind: 'audio',
      file: f('loud.mp3'),
      ext: 'mp3',
      outDir: outDir(),
      onProgress: (_s, p) => p !== null && seen.push(p),
    });
    for (let i = 1; i < seen.length; i++)
      expect(seen[i] as number).toBeGreaterThanOrEqual(seen[i - 1] as number);
    expect(seen.at(-1)).toBe(1);
  });
});
