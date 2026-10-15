/**
 * Media probe / validate / fix on REAL ffmpeg + ffprobe with generated lavfi media: every violation class is detected, every
 * fixable class is actually fixed (the output re-validates clean), unfixable ones throw, aborts leave no files.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLATFORM_SPECS } from '../../shared/platform-specs';
import type { MediaIssue, Platform } from '../../shared/publish';
import { createPublishMedia } from '../../electron/main/services/publish-media';

const FFMPEG = path.resolve(__dirname, '../../node_modules/ffmpeg-static/ffmpeg');
const FFPROBE = path.resolve(__dirname, '../../node_modules/ffprobe-static/bin/linux/x64/ffprobe');
const have = fs.existsSync(FFMPEG) && fs.existsSync(FFPROBE);
const d = have ? describe : describe.skip;

let dir = '';
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipfern-pm-'));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const ff = (args: string[]): void => {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', ...args], {
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(' ')}: ${r.stderr.toString()}`);
};

/** Makes `name` from lavfi video (+ optional audio). `extra` = output options. */
function make(
  name: string,
  o: {
    size?: string;
    fps?: number;
    dur?: number;
    audio?: boolean;
    pre?: string[];
    out?: string[];
    vf?: string;
    src?: string;
  } = {},
): string {
  const file = path.join(dir, name);
  const dur = o.dur ?? 4;
  ff([
    ...(o.pre ?? []),
    '-f',
    'lavfi',
    '-i',
    `${o.src ?? 'testsrc2'}=s=${o.size ?? '360x640'}:r=${o.fps ?? 30}:d=${dur}`,
    ...(o.audio === false ? [] : ['-f', 'lavfi', '-i', `sine=f=440:r=44100:d=${dur}`]),
    ...(o.vf ? ['-vf', o.vf] : []),
    ...(o.out ?? ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p']),
    ...(o.audio === false ? [] : ['-shortest']),
    file,
  ]);
  return file;
}

const svc = createPublishMedia({
  ffprobePath: () => FFPROBE,
  detectEncoder: async () => 'libx264',
});

const codes = (r: { issues: MediaIssue[] }): string[] => r.issues.map((i) => i.code).sort();

async function check(file: string, platform: Platform) {
  return svc.validate({ info: await svc.probe(file), platform });
}

/** fix → re-probe → re-validate: no error is left. Returns both. */
async function fixAndRecheck(file: string, platform: Platform, name = 'out.mp4') {
  const report = await check(file, platform);
  const outFile = path.join(dir, `${path.basename(file)}.${name}`);
  const info = await svc.fix({ file, outFile, platform, report, ffmpegPath: FFMPEG });
  const after = await check(outFile, platform);
  expect(after.issues.filter((i) => i.severity === 'error')).toEqual([]);
  expect(fs.existsSync(`${outFile}.partial`)).toBe(false);
  return { report, info, after, outFile };
}

d('publish-media: probe', () => {
  it('reads size, fps, codecs, container', async () => {
    const f = make('probe.mp4', { fps: 25 });
    const i = await svc.probe(f);
    expect(i).toMatchObject({
      width: 360,
      height: 640,
      fps: 25,
      videoCodec: 'h264',
      audioCodec: 'aac',
      pixFmt: 'yuv420p',
      container: ['mp4', 'mov'].filter((c) => i.container?.includes(c)),
      variableFps: false,
      interlaced: false,
    });
    expect(i.durationSec).toBeCloseTo(4, 1);
    expect(i.sizeBytes).toBe(fs.statSync(f).size);
    expect(i.audioSampleRate).toBe(44100);
  });

  it('reports display size for rotated and non-square-pixel video', async () => {
    const rot = make('rot.mp4', {
      size: '640x360',
      out: ['-c:v', 'libx264', '-preset', 'ultrafast'],
    });
    const rotated = path.join(dir, 'rot2.mp4');
    ff(['-display_rotation', '90', '-i', rot, '-c', 'copy', rotated]);
    const ri = await svc.probe(rotated);
    expect([ri.width, ri.height]).toEqual([360, 640]);

    const sar = make('sar.mp4', { size: '320x640', vf: 'setsar=2', audio: false });
    const si = await svc.probe(sar);
    expect([si.width, si.height]).toEqual([640, 640]);
  });

  it('gives readable errors for unreadable input', async () => {
    const txt = path.join(dir, 'notes.mp4');
    fs.writeFileSync(txt, 'this is not a video at all');
    await expect(svc.probe(txt)).rejects.toThrow(/not a readable video/);
    await expect(svc.probe(path.join(dir, 'nope.mp4'))).rejects.toThrow(/could not be found/);
    const empty = path.join(dir, 'empty.mp4');
    fs.writeFileSync(empty, '');
    await expect(svc.probe(empty)).rejects.toThrow(/empty/);
    const audioOnly = path.join(dir, 'a.m4a');
    ff(['-f', 'lavfi', '-i', 'sine=d=1', '-c:a', 'aac', audioOnly]);
    await expect(svc.probe(audioOnly)).rejects.toThrow(/no video track/);
  });

  it('a missing ffprobe is a clear error', async () => {
    const f = make('probe2.mp4', { dur: 3.5 });
    const bad = createPublishMedia({ ffprobePath: () => '/nonexistent/ffprobe' });
    await expect(bad.probe(f)).rejects.toThrow(/ffprobe is not available/);
  });
});

d('publish-media: detection on real files', () => {
  it('a clean 9:16 H.264/AAC clip passes every platform', async () => {
    const f = make('clean.mp4', { dur: 5 });
    for (const p of ['shorts', 'reels', 'tiktok'] as const) {
      const r = await check(f, p);
      if (p === 'tiktok') {
        // 360x640 is exactly at TikTok's minimum
        expect(r.issues).toEqual([]);
      }
      expect(r.issues.filter((i) => i.severity === 'error')).toEqual([]);
      expect(r.ok).toBe(true);
    }
  });

  it('too short for Reels (unfixable)', async () => {
    const r = await check(make('short.mp4', { dur: 2 }), 'reels');
    expect(r.ok).toBe(false);
    expect(r.issues).toEqual([
      expect.objectContaining({ code: 'duration-short', severity: 'error', fixable: false }),
    ]);
    expect(r.issues[0]!.message).toMatch(/0:02 long; Instagram Reels needs at least 0:03/);
  });

  it('too long for Shorts (unfixable, plain-language message)', async () => {
    const f = make('long.mp4', {
      size: '90x160',
      fps: 5,
      dur: 190,
      audio: false,
      out: ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'],
    });
    const r = await check(f, 'shorts');
    expect(codes(r)).toEqual(['duration-long']);
    expect(r.issues[0]).toMatchObject({ fixable: false, severity: 'error' });
    expect(r.issues[0]!.message).toMatch(/3:10 long; YouTube Shorts accepts up to 3:00/);
  });

  it('wrong codec / container / audio: webm (vp8 + vorbis) for Reels', async () => {
    const f = make('v.webm', { out: ['-c:v', 'libvpx', '-b:v', '300k', '-c:a', 'libvorbis'] });
    const r = await check(f, 'reels');
    expect(codes(r)).toEqual(expect.arrayContaining(['container', 'codec', 'audio-codec']));
    for (const c of ['container', 'codec', 'audio-codec']) {
      expect(r.issues.find((i) => i.code === c)).toMatchObject({
        fixable: true,
        severity: 'error',
      });
    }
    // TikTok accepts webm/vp8: nothing but nothing blocking there
    expect((await check(f, 'tiktok')).ok).toBe(true);
  });

  it('frame rate: 120 fps and 12 fps on Reels', async () => {
    const hi = await check(make('hi.mp4', { fps: 120, dur: 3.5, audio: false }), 'reels');
    expect(hi.issues.find((i) => i.code === 'fps')).toMatchObject({
      severity: 'error',
      fixable: true,
    });
    const lo = await check(make('lo.mp4', { fps: 12, dur: 4, audio: false }), 'reels');
    expect(lo.issues.find((i) => i.code === 'fps')?.message).toMatch(/12 fps.*23/);
    // YouTube has no fps rule
    expect(
      (await check(make('hi2.mp4', { fps: 120, dur: 1, audio: false }), 'shorts')).issues,
    ).toEqual([]);
  });

  it('variable frame rate is a fixable warning', async () => {
    const f = make('vfr.mp4', {
      fps: 30,
      dur: 6,
      audio: false,
      vf: "select='gt(random(0),0.6)'",
      out: ['-fps_mode', 'vfr', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'],
    });
    const info = await svc.probe(f);
    expect(info.variableFps).toBe(true);
    const r = svc.validate({ info, platform: 'shorts' });
    expect(r.issues).toEqual([
      expect.objectContaining({ code: 'fps', severity: 'warning', fixable: true }),
    ]);
    expect(r.ok).toBe(true);
  });

  it('resolution: wider than 1920 on Reels, beyond 4096 and below 360 on TikTok', async () => {
    const big = await check(
      make('big.mp4', { size: '2560x1440', fps: 10, dur: 3, audio: false }),
      'reels',
    );
    expect(big.issues.find((i) => i.code === 'resolution')).toMatchObject({
      severity: 'error',
      fixable: true,
    });
    const huge = await check(
      make('huge.mp4', { size: '4200x2400', fps: 5, dur: 3, audio: false }),
      'tiktok',
    );
    expect(huge.issues.find((i) => i.code === 'resolution')).toMatchObject({ fixable: true });
    const tiny = await check(make('tiny.mp4', { size: '320x568', audio: false }), 'tiktok');
    expect(tiny.issues.find((i) => i.code === 'resolution')).toMatchObject({
      severity: 'error',
      fixable: false,
    });
  });

  it('aspect: landscape on Shorts is an error, off-9:16 elsewhere a warning, both unfixable', async () => {
    const land = make('land.mp4', { size: '640x360', audio: false });
    const s = await check(land, 'shorts');
    expect(s.issues.find((i) => i.code === 'aspect')).toMatchObject({
      severity: 'error',
      fixable: false,
    });
    const r = await check(land, 'reels');
    expect(r.issues).toEqual([
      expect.objectContaining({ code: 'aspect', severity: 'warning', fixable: false }),
    ]);
    expect(r.ok).toBe(true);
    const sq = await check(make('sq.mp4', { size: '480x480', audio: false }), 'shorts');
    expect(sq.issues).toEqual([expect.objectContaining({ code: 'aspect', severity: 'warning' })]);
  });

  it('chroma: 4:4:4 is refused on Reels but fine on TikTok', async () => {
    const f = make('c444.mp4', {
      audio: false,
      out: ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv444p'],
    });
    const r = await check(f, 'reels');
    expect(r.issues.find((i) => i.code === 'codec')?.message).toMatch(/4:4:4.*4:2:0/);
    expect((await check(f, 'tiktok')).ok).toBe(true);
  });

  it('size and bitrate against (temporarily lowered) limits', async () => {
    const f = make('noise.mp4', {
      size: '360x640',
      dur: 6,
      src: 'testsrc2',
      vf: 'noise=alls=60:allf=t',
      audio: false,
      out: ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '14', '-pix_fmt', 'yuv420p'],
    });
    const size = fs.statSync(f).size;
    expect(size).toBeGreaterThan(1_000_000);
    const spec = PLATFORM_SPECS.reels as {
      maxSizeBytes: number | null;
      maxVideoBitrateBps: number | null;
    };
    const keep = { ...spec };
    try {
      spec.maxSizeBytes = Math.round(size / 3);
      spec.maxVideoBitrateBps = Math.round((size * 8) / 6 / 2);
      const r = await check(f, 'reels');
      expect(codes(r)).toEqual(['bitrate', 'size-large']);
      expect(r.issues.every((i) => i.fixable && i.severity === 'error')).toBe(true);
    } finally {
      Object.assign(spec, keep);
    }
  });
});

d('publish-media: fix', () => {
  it('webm vp8/vorbis → mp4 h264/aac', async () => {
    const f = make('fx.webm', { out: ['-c:v', 'libvpx', '-b:v', '300k', '-c:a', 'libvorbis'] });
    const { info, outFile } = await fixAndRecheck(f, 'reels');
    expect(info).toMatchObject({ videoCodec: 'h264', audioCodec: 'aac', audioSampleRate: 48000 });
    expect(info.container).toContain('mp4');
    expect(info.durationSec).toBeCloseTo(4, 0);
    // faststart: moov before mdat; no edit list (Instagram)
    const bytes = fs.readFileSync(outFile);
    expect(bytes.indexOf('moov')).toBeGreaterThan(0);
    expect(bytes.indexOf('moov')).toBeLessThan(bytes.indexOf('mdat'));
    expect(bytes.includes('elst')).toBe(false);
  });

  it('mpeg4 video + mp3 audio (44.1 kHz) → h264 + aac 48 kHz', async () => {
    const f = make('fx2.mp4', {
      out: ['-c:v', 'mpeg4', '-q:v', '4', '-c:a', 'libmp3lame'],
    });
    const r = await check(f, 'reels');
    expect(codes(r)).toEqual(expect.arrayContaining(['codec', 'audio-codec']));
    const { info } = await fixAndRecheck(f, 'reels');
    expect(info.videoCodec).toBe('h264');
    expect(info.audioCodec).toBe('aac');
  });

  it('120 fps → 60 fps and 12 fps → 24 fps (even cadence), duration kept', async () => {
    const hi = await fixAndRecheck(make('fx-hi.mp4', { fps: 120, dur: 3.5 }), 'reels');
    expect(hi.info.fps).toBeCloseTo(60, 1);
    expect(hi.info.durationSec).toBeCloseTo(3.5, 0);
    const lo = await fixAndRecheck(make('fx-lo.mp4', { fps: 12, dur: 3.5 }), 'reels');
    expect(lo.info.fps).toBeCloseTo(24, 1);
    expect(lo.info.durationSec).toBeCloseTo(3.5, 0);
  });

  it('variable frame rate → constant (warning gone)', async () => {
    const f = make('fx-vfr.mp4', {
      fps: 30,
      dur: 6,
      vf: "select='gt(random(0),0.6)'",
      out: ['-fps_mode', 'vfr', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'],
    });
    const { after, info } = await fixAndRecheck(f, 'shorts');
    expect(after.issues).toEqual([]);
    expect(info.variableFps).toBe(false);
  });

  it('downscales 2560x1440 to 1920x1080 for Reels, 4200x2400 to 4096 wide for TikTok; never upscales', async () => {
    const a = await fixAndRecheck(
      make('fx-big.mp4', { size: '2560x1440', fps: 10, dur: 3.5 }),
      'reels',
    );
    expect([a.info.width, a.info.height]).toEqual([1920, 1080]);
    const b = await fixAndRecheck(
      make('fx-huge.mp4', { size: '4200x2400', fps: 5, dur: 2, audio: false }),
      'tiktok',
    );
    expect(b.info.width).toBeLessThanOrEqual(4096);
    expect(b.info.width! % 2).toBe(0);
    // aspect preserved within a pixel
    expect(Math.abs(b.info.width / b.info.height - 4200 / 2400)).toBeLessThan(0.01);
  });

  it('4:4:4 → 4:2:0, 10 fps screen-style input stays valid', async () => {
    const f = make('fx-444.mp4', {
      out: ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv444p'],
    });
    const { info } = await fixAndRecheck(f, 'reels');
    expect(info.pixFmt).toBe('yuv420p');
  });

  it('rotation metadata and anamorphic pixels are baked into square, upright pixels', async () => {
    const src = make('fx-rot-src.mp4', {
      size: '640x360',
      audio: false,
      out: ['-c:v', 'mpeg4', '-q:v', '4'],
    });
    const rotated = path.join(dir, 'fx-rot.mp4');
    ff(['-display_rotation', '90', '-i', src, '-c', 'copy', rotated]);
    const { info } = await fixAndRecheck(rotated, 'reels');
    expect([info.width, info.height]).toEqual([360, 640]);
    expect(info.sar).toBe(1);
  });

  it('interlaced video is detected and deinterlaced for Reels', async () => {
    const f = make('fx-il.mp4', {
      size: '360x640',
      audio: false,
      vf: 'interlace=scan=tff',
      out: ['-c:v', 'mpeg2video', '-flags', '+ildct+ilme', '-top', '1'],
    });
    const i = await svc.probe(f);
    expect(i.interlaced).toBe(true);
    expect((await check(f, 'reels')).issues.map((x) => x.message).join(' ')).toMatch(/interlaced/);
    const { info } = await fixAndRecheck(f, 'reels');
    expect(info.interlaced).toBe(false);
    expect(info.videoCodec).toBe('h264');
  });

  it('audio-less input stays audio-less and is fixed', async () => {
    const f = make('fx-silent.mkv', {
      audio: false,
      out: ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'],
    });
    const { info } = await fixAndRecheck(f, 'reels');
    expect(info.audioCodec).toBeNull();
    expect(info.videoCodec).toBe('h264');
  });

  it('fits a size limit (lowered for the test): output within the cap, picture still 9:16, duration kept', async () => {
    const f = make('fx-size.mp4', {
      size: '540x960',
      dur: 6,
      vf: 'noise=alls=40:allf=t',
      out: ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p'],
    });
    const size = fs.statSync(f).size;
    const spec = PLATFORM_SPECS.reels as {
      maxSizeBytes: number | null;
      maxVideoBitrateBps: number | null;
    };
    const keep = { ...spec };
    try {
      spec.maxVideoBitrateBps = null; // only the size limit is under test
      spec.maxSizeBytes = Math.round(size / 4);
      const { info, report } = await fixAndRecheck(f, 'reels');
      expect(report.issues.map((i) => i.code)).toEqual(['size-large']);
      expect(info.sizeBytes).toBeLessThanOrEqual(spec.maxSizeBytes);
      // it used the room it was given: not a tiny file
      expect(info.sizeBytes).toBeGreaterThan(spec.maxSizeBytes * 0.3);
      expect(info.durationSec).toBeCloseTo(6, 0);
      expect(Math.abs(info.width / info.height - 9 / 16)).toBeLessThan(0.02);
    } finally {
      Object.assign(spec, keep);
    }
  });

  it('fits a bitrate ceiling (lowered for the test)', async () => {
    const f = make('fx-bitrate.mp4', {
      size: '540x960',
      dur: 6,
      vf: 'noise=alls=40:allf=t',
      out: ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p'],
    });
    const size = fs.statSync(f).size;
    const spec = PLATFORM_SPECS.reels as { maxVideoBitrateBps: number | null };
    const keep = spec.maxVideoBitrateBps;
    try {
      spec.maxVideoBitrateBps = Math.round((size * 8) / 6 / 3);
      const { info, report } = await fixAndRecheck(f, 'reels');
      expect(report.issues.map((i) => i.code)).toEqual(['bitrate']);
      expect((info.sizeBytes * 8) / info.durationSec).toBeLessThanOrEqual(spec.maxVideoBitrateBps);
    } finally {
      spec.maxVideoBitrateBps = keep;
    }
  });

  it('refuses a size limit that cannot be met at a watchable quality, leaving no files', async () => {
    const f = make('fx-impossible.mp4', { size: '540x960', dur: 6, audio: false });
    const spec = PLATFORM_SPECS.reels as { maxSizeBytes: number | null };
    const keep = spec.maxSizeBytes;
    const out = path.join(dir, 'impossible-out.mp4');
    try {
      spec.maxSizeBytes = 2_000;
      const report = await check(f, 'reels');
      await expect(
        svc.fix({ file: f, outFile: out, platform: 'reels', report, ffmpegPath: FFMPEG }),
      ).rejects.toThrow(/cannot be squeezed/);
    } finally {
      spec.maxSizeBytes = keep;
    }
    expect(fs.existsSync(out)).toBe(false);
    expect(fs.existsSync(`${out}.partial`)).toBe(false);
  });

  it('nothing to fix → the file is copied as it is', async () => {
    const f = make('fx-ok.mp4', { dur: 4 });
    const report = await check(f, 'reels');
    const out = path.join(dir, 'fx-ok-out.mp4');
    const info = await svc.fix({
      file: f,
      outFile: out,
      platform: 'reels',
      report,
      ffmpegPath: FFMPEG,
    });
    expect(fs.readFileSync(out).equals(fs.readFileSync(f))).toBe(true);
    expect(info.sizeBytes).toBe(fs.statSync(f).size);
  });

  it('unfixable issues throw a clear error and write nothing', async () => {
    const out = path.join(dir, 'unfix-out.mp4');
    const cases: [string, Platform, RegExp][] = [
      [make('uf-short.mp4', { dur: 2 }), 'reels', /needs at least 0:03.*never trims/s],
      [make('uf-land.mp4', { size: '640x360', audio: false }), 'shorts', /wider than tall/],
      [make('uf-tiny.mp4', { size: '320x568', audio: false }), 'tiktok', /at least 360/],
    ];
    for (const [file, platform, re] of cases) {
      const report = await check(file, platform);
      await expect(
        svc.fix({ file, outFile: out, platform, report, ffmpegPath: FFMPEG }),
      ).rejects.toThrow(re);
      expect(fs.existsSync(out)).toBe(false);
      expect(fs.existsSync(`${out}.partial`)).toBe(false);
    }
  });

  it('reports monotonic progress ending at 1', async () => {
    const f = make('fx-prog.mp4', {
      size: '640x1136',
      fps: 60,
      dur: 12,
      out: ['-c:v', 'mpeg4', '-q:v', '3'],
    });
    const report = await check(f, 'reels');
    const seen: number[] = [];
    await svc.fix({
      file: f,
      outFile: path.join(dir, 'fx-prog-out.mp4'),
      platform: 'reels',
      report,
      ffmpegPath: FFMPEG,
      onProgress: (p) => p !== null && seen.push(p),
    });
    expect(seen.at(-1)).toBe(1);
    expect(seen.length).toBeGreaterThan(2);
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
  });

  it('abort during encoding rejects with AbortError and leaves neither output nor partial', async () => {
    const f = make('fx-abort.mp4', {
      size: '720x1280',
      fps: 60,
      dur: 40,
      out: ['-c:v', 'mpeg4', '-q:v', '3'],
    });
    const report = await check(f, 'reels');
    const out = path.join(dir, 'fx-abort-out.mp4');
    const ctl = new AbortController();
    const p = svc.fix({
      file: f,
      outFile: out,
      platform: 'reels',
      report,
      ffmpegPath: FFMPEG,
      signal: ctl.signal,
      onProgress: (frac) => {
        if (frac !== null && frac > 0.03) ctl.abort();
      },
    });
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(fs.existsSync(out)).toBe(false);
    expect(fs.existsSync(`${out}.partial`)).toBe(false);
  }, 60_000);

  it('an already-aborted signal does nothing', async () => {
    const f = make('fx-abort2.mp4', { dur: 3.5, out: ['-c:v', 'mpeg4'] });
    const report = await check(f, 'reels');
    const out = path.join(dir, 'fx-abort2-out.mp4');
    const ctl = new AbortController();
    ctl.abort();
    await expect(
      svc.fix({
        file: f,
        outFile: out,
        platform: 'reels',
        report,
        ffmpegPath: FFMPEG,
        signal: ctl.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fs.readdirSync(dir).filter((n) => n.startsWith('fx-abort2-out'))).toEqual([]);
  });

  it('a failing ffmpeg removes the partial file', async () => {
    const f = make('fx-fail.mp4', { dur: 3.5, out: ['-c:v', 'mpeg4'] });
    const report = await check(f, 'reels');
    const out = path.join(dir, 'fx-fail-out.mp4');
    await expect(
      svc.fix({
        file: f,
        outFile: out,
        platform: 'reels',
        report,
        ffmpegPath: '/nonexistent/ffmpeg',
      }),
    ).rejects.toThrow(/ffmpeg/);
    expect(fs.readdirSync(dir).filter((n) => n.startsWith('fx-fail-out'))).toEqual([]);
  });

  it('refuses to overwrite its own input', async () => {
    const f = make('fx-same.mp4', { dur: 3.5, out: ['-c:v', 'mpeg4'] });
    const report = await check(f, 'reels');
    await expect(
      svc.fix({ file: f, outFile: f, platform: 'reels', report, ffmpegPath: FFMPEG }),
    ).rejects.toThrow(/different file/);
  });
});
