/** shared/platform-specs.ts data + helpers, validateMedia (pure), and the fix plan maths (pure). */
import { describe, expect, it } from 'vitest';
import {
  PLATFORM_SPECS,
  SPEC_SUMMARY,
  aspectOf,
  containersOf,
  formatBytes,
  formatClock,
  formatDurationShort,
  isRecommendedAspect,
} from '../../shared/platform-specs';
import type { Platform } from '../../shared/publish';
import {
  buildFixArgs,
  chromaOf,
  infoFromFfprobe,
  parseRate,
  planFix,
  targetFps,
  validateMedia,
  videoEncoderArgs,
  type ProbedMediaInfo,
} from '../../electron/main/services/publish-media';
import { AUDIO_BPS_STEREO, SIZE_SAFETY } from '../../electron/main/services/publish-media/plan';

/** A clean clip; the file size follows the duration (2 Mbit/s) unless given. */
const ok = (o: Partial<ProbedMediaInfo> = {}): ProbedMediaInfo => ({
  sizeBytes: Math.round((o.durationSec ?? 30) * 250_000),
  durationSec: 30,
  width: 1080,
  height: 1920,
  fps: 30,
  videoCodec: 'h264',
  audioCodec: 'aac',
  container: ['mp4', 'mov'],
  pixFmt: 'yuv420p',
  interlaced: false,
  variableFps: false,
  audioSampleRate: 48_000,
  audioChannels: 2,
  sar: 1,
  ...o,
});

const issues = (o: Partial<ProbedMediaInfo>, p: Platform, ov = {}) =>
  validateMedia(ok(o), p, ov).issues.map((i) => `${i.severity}:${i.code}${i.fixable ? '+' : ''}`);

describe('platform specs data', () => {
  it('every platform records where its numbers come from, with a date', () => {
    for (const p of ['shorts', 'reels', 'tiktok'] as const) {
      const s = PLATFORM_SPECS[p];
      expect(s.platform).toBe(p);
      expect(s.docsUrl).toMatch(/^https:\/\//);
      expect(s.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const keys = [
        s.durationSec.max !== null || s.durationSec.min !== null ? 'duration' : null,
        s.maxSizeBytes !== null ? 'size' : null,
        s.containers ? 'container' : null,
        s.videoCodecs ? 'videoCodec' : null,
        s.fps.min !== null || s.fps.max !== null ? 'fps' : null,
        s.resolution.maxWidth !== null || s.resolution.minWidth !== null ? 'resolution' : null,
        s.maxVideoBitrateBps !== null ? 'bitrate' : null,
      ].filter((k): k is NonNullable<typeof k> => k !== null);
      for (const k of keys) {
        const src = s.sources[k as keyof typeof s.sources];
        expect(src, `${p}.${k}`).toBeDefined();
        expect(src!.url).toMatch(/^https:\/\//);
        expect(src!.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(src!.note.length).toBeGreaterThan(5);
      }
    }
  });

  it('the headline numbers match the official pages (checked 2026-10-15)', () => {
    expect(PLATFORM_SPECS.shorts.durationSec).toEqual({ min: null, max: 180 });
    expect(PLATFORM_SPECS.reels).toMatchObject({
      durationSec: { min: 3, max: 900 },
      maxSizeBytes: 300_000_000,
      fps: { min: 23, max: 60 },
      maxVideoBitrateBps: 25_000_000,
      containers: ['mp4', 'mov'],
      videoCodecs: ['h264', 'hevc'],
      audioCodecs: ['aac'],
      aspect: { min: 0.01, max: 10 },
      resolution: { maxWidth: 1920 },
    });
    expect(PLATFORM_SPECS.tiktok).toMatchObject({
      maxSizeBytes: 4_000_000_000,
      fps: { min: 23, max: 60 },
      resolution: { maxWidth: 4096, maxHeight: 4096, minWidth: 360, minHeight: 360 },
    });
  });

  it('summaries for the UI', () => {
    expect(SPEC_SUMMARY.reels).toBe('3 s – 15 min · up to 300 MB · 9:16 recommended');
    expect(SPEC_SUMMARY.tiktok).toBe('up to 10 min · up to 4 GB · 9:16 recommended');
    expect(SPEC_SUMMARY.shorts).toBe('up to 3 min · vertical or square, 9:16 recommended');
  });

  it('formatters', () => {
    expect(formatClock(252)).toBe('4:12');
    expect(formatClock(3723)).toBe('1:02:03');
    expect(formatClock(3)).toBe('0:03');
    expect(formatDurationShort(3)).toBe('3 s');
    expect(formatDurationShort(180)).toBe('3 min');
    expect(formatDurationShort(150)).toBe('2:30');
    expect(formatBytes(300e6)).toBe('300 MB');
    expect(formatBytes(12_345_678)).toBe('12.3 MB');
    expect(formatBytes(4e9)).toBe('4 GB');
    expect(formatBytes(800)).toBe('800 B');
    expect(aspectOf(1080, 1920)).toBeCloseTo(0.5625);
    expect(isRecommendedAspect(PLATFORM_SPECS.reels, 1080 / 1920)).toBe(true);
    expect(isRecommendedAspect(PLATFORM_SPECS.reels, 1080 / 1350)).toBe(false);
  });

  it('containersOf', () => {
    expect(containersOf('mov,mp4,m4a,3gp,3g2,mj2', '.mp4')).toEqual(['mp4']);
    expect(containersOf('mov,mp4,m4a,3gp,3g2,mj2', '.MOV')).toEqual(['mov']);
    expect(containersOf('mov,mp4,m4a,3gp,3g2,mj2', '')).toEqual(['mp4', 'mov']);
    expect(containersOf('matroska,webm', '.webm')).toEqual(['webm']);
    expect(containersOf('matroska,webm', '.mkv')).toEqual(['mkv']);
    expect(containersOf('avi', '.avi')).toEqual(['avi']);
  });
});

describe('validateMedia (pure)', () => {
  it('a clean vertical clip has no issues anywhere', () => {
    for (const p of ['shorts', 'reels', 'tiktok'] as const) {
      expect(validateMedia(ok(), p)).toMatchObject({ ok: true, issues: [] });
    }
  });

  it.each<[string, Partial<ProbedMediaInfo>, Platform, string[]]>([
    ['too short', { durationSec: 2 }, 'reels', ['error:duration-short']],
    ['2.97 s is within the frame-alignment slack', { durationSec: 2.97 }, 'reels', []],
    ['too long reels', { durationSec: 901 }, 'reels', ['error:duration-long']],
    ['3:00.04 Short is fine', { durationSec: 180.04 }, 'shorts', []],
    ['too long short', { durationSec: 181 }, 'shorts', ['error:duration-long']],
    ['no min on tiktok', { durationSec: 1 }, 'tiktok', []],
    ['too long tiktok', { durationSec: 601 }, 'tiktok', ['error:duration-long']],
    ['size', { sizeBytes: 300_000_001, durationSec: 899 }, 'reels', ['error:size-large+']],
    ['mkv container', { container: ['mkv'] }, 'reels', ['error:container+']],
    ['webm is fine on tiktok', { container: ['webm'], videoCodec: 'vp9' }, 'tiktok', []],
    ['vp9 on reels', { videoCodec: 'vp9' }, 'reels', ['error:codec+']],
    ['hevc ok on reels', { videoCodec: 'hevc' }, 'reels', []],
    ['mpeg4 on tiktok', { videoCodec: 'mpeg4' }, 'tiktok', ['error:codec+']],
    ['any codec on shorts', { videoCodec: 'prores' }, 'shorts', []],
    ['4:4:4 on reels', { pixFmt: 'yuv444p' }, 'reels', ['error:codec+']],
    ['10-bit on reels', { pixFmt: 'yuv420p10le' }, 'reels', ['error:codec+']],
    ['interlaced on reels', { interlaced: true }, 'reels', ['error:codec+']],
    ['interlaced elsewhere', { interlaced: true }, 'tiktok', []],
    ['mp3 audio on reels', { audioCodec: 'mp3' }, 'reels', ['error:audio-codec+']],
    ['96 kHz audio on reels', { audioSampleRate: 96_000 }, 'reels', ['error:audio-codec+']],
    ['5.1 audio on reels', { audioChannels: 6 }, 'reels', ['error:audio-codec+']],
    [
      'no audio is not an issue anywhere',
      { audioCodec: null, audioSampleRate: null, audioChannels: null },
      'reels',
      [],
    ],
    ['fps 60 ok', { fps: 60 }, 'reels', []],
    ['fps 59.94 ok', { fps: 59.94 }, 'tiktok', []],
    ['fps 61', { fps: 61 }, 'reels', ['error:fps+']],
    ['fps 22', { fps: 22 }, 'tiktok', ['error:fps+']],
    ['fps 23.976 ok', { fps: 23.976 }, 'reels', []],
    ['unknown fps is not guessed', { fps: null }, 'reels', []],
    ['120 fps on shorts is fine', { fps: 120 }, 'shorts', []],
    ['vfr', { variableFps: true }, 'shorts', ['warning:fps+']],
    [
      'vfr + out-of-range reports one fps issue',
      { variableFps: true, fps: 12 },
      'reels',
      ['error:fps+'],
    ],
    ['landscape on shorts', { width: 1920, height: 1080 }, 'shorts', ['error:aspect']],
    ['square on shorts', { width: 1080, height: 1080 }, 'shorts', ['warning:aspect']],
    ['landscape on reels', { width: 1920, height: 1080 }, 'reels', ['warning:aspect']],
    ['4:5 on tiktok', { width: 1080, height: 1350 }, 'tiktok', ['warning:aspect']],
    ['absurd aspect', { width: 1920, height: 100 }, 'reels', ['error:aspect']],
    ['1280 wide ok', { width: 720, height: 1280 }, 'reels', []],
    ['wider than 1920', { width: 2160, height: 3840 }, 'reels', ['error:resolution+']],
    ['4K tiktok', { width: 2160, height: 3840 }, 'tiktok', []],
    ['beyond 4096', { width: 4320, height: 7680 }, 'tiktok', ['error:resolution+']],
    ['tiktok too small', { width: 270, height: 480 }, 'tiktok', ['error:resolution']],
    ['bitrate', { sizeBytes: 95_000_000, durationSec: 30 }, 'reels', ['error:bitrate+']],
  ])('%s', (_n, over, platform, expected) => {
    expect(issues(over, platform)).toEqual(expected);
  });

  it('TikTok creators can have a lower limit than the 10-minute ceiling', () => {
    expect(issues({ durationSec: 400 }, 'tiktok')).toEqual([]);
    expect(issues({ durationSec: 400 }, 'tiktok', { maxDurationSec: 300 })).toEqual([
      'error:duration-long',
    ]);
    expect(issues({ durationSec: 400 }, 'tiktok', { maxDurationSec: null })).toEqual([]);
  });

  it('messages are plain language with the numbers', () => {
    const msg = (o: Partial<ProbedMediaInfo>, p: Platform): string =>
      validateMedia(ok(o), p)
        .issues.map((i) => i.message)
        .join(' | ');
    expect(msg({ durationSec: 252 }, 'reels')).toBe('');
    expect(msg({ durationSec: 1000 }, 'reels')).toBe(
      'Your clip is 16:40 long; Instagram Reels accepts up to 15:00.',
    );
    expect(msg({ durationSec: 252 }, 'shorts')).toContain(
      '4:12 long; YouTube Shorts accepts up to 3:00',
    );
    expect(msg({ width: 4320, height: 7680 }, 'tiktok')).toContain(
      'at most 4096 px wide and 4096 px tall',
    );
    expect(msg({ fps: 12 }, 'reels')).toContain('12 fps');
    expect(msg({ sizeBytes: 500e6, durationSec: 100 }, 'reels')).toContain('500 MB');
  });

  it('report carries platform, ok flag and the media', () => {
    const r = validateMedia(ok({ durationSec: 2 }), 'reels');
    expect(r).toMatchObject({ platform: 'reels', ok: false });
    expect(r.media.durationSec).toBe(2);
    expect(validateMedia(ok({ width: 1920, height: 1080 }), 'reels').ok).toBe(true); // warnings do not block
  });

  it('skips checks whose facts are unknown (info that went through the zod schema)', () => {
    const bare = {
      durationSec: 30,
      width: 1080,
      height: 1920,
      fps: 30,
      sizeBytes: 1e6,
      videoCodec: 'h264',
      audioCodec: 'aac',
    };
    expect(validateMedia(bare, 'reels').issues).toEqual([]);
  });

  it('chromaOf', () => {
    expect(chromaOf('yuv420p')).toBe('4:2:0');
    expect(chromaOf('yuvj420p')).toBe('4:2:0');
    expect(chromaOf('nv12')).toBe('4:2:0');
    expect(chromaOf('yuv422p10le')).toBe('4:2:2');
    expect(chromaOf('yuv444p')).toBe('4:4:4');
    expect(chromaOf('rgb24')).toBe('4:4:4');
    expect(chromaOf(null)).toBeNull();
  });
});

describe('infoFromFfprobe / parseRate', () => {
  const v = {
    codec_type: 'video',
    codec_name: 'h264',
    width: 1080,
    height: 1920,
    pix_fmt: 'yuv420p',
    avg_frame_rate: '30000/1001',
    r_frame_rate: '30000/1001',
  };
  it('reads a normal file', () => {
    const i = infoFromFfprobe(
      {
        streams: [v, { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 }],
        format: { duration: '12.5', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' },
      },
      1000,
      '.mp4',
    );
    expect(i).toMatchObject({
      durationSec: 12.5,
      width: 1080,
      height: 1920,
      fps: 29.97,
      videoCodec: 'h264',
      audioCodec: 'aac',
      audioSampleRate: 48000,
      audioChannels: 2,
      variableFps: false,
      interlaced: false,
      container: ['mp4'],
    });
  });
  it('rotation, anamorphic pixels, interlaced, vfr, cover art', () => {
    const rot = infoFromFfprobe(
      {
        streams: [{ ...v, width: 1920, height: 1080, side_data_list: [{ rotation: -90 }] }],
        format: { duration: '5' },
      },
      1,
      '.mp4',
    );
    expect([rot.width, rot.height]).toEqual([1080, 1920]);
    const sar = infoFromFfprobe(
      {
        streams: [{ ...v, width: 720, height: 576, sample_aspect_ratio: '16:11' }],
        format: { duration: '5' },
      },
      1,
      '.mp4',
    );
    expect([sar.width, sar.height]).toEqual([1047, 576]);
    expect(
      infoFromFfprobe(
        { streams: [{ ...v, field_order: 'tt' }], format: { duration: '5' } },
        1,
        '.mp4',
      ).interlaced,
    ).toBe(true);
    expect(
      infoFromFfprobe(
        {
          streams: [{ ...v, avg_frame_rate: '18/1', r_frame_rate: '30/1' }],
          format: { duration: '5' },
        },
        1,
        '.mp4',
      ).variableFps,
    ).toBe(true);
    const cover = infoFromFfprobe(
      {
        streams: [{ ...v, codec_name: 'mjpeg', disposition: { attached_pic: 1 } }, v],
        format: { duration: '5' },
      },
      1,
      '.mp4',
    );
    expect(cover.videoCodec).toBe('h264');
  });
  it('throws readable errors', () => {
    expect(() =>
      infoFromFfprobe({ streams: [{ codec_type: 'audio' }], format: { duration: '5' } }, 1, '.m4a'),
    ).toThrow(/no video track/);
    expect(() => infoFromFfprobe({ streams: [v], format: {} }, 1, '.mp4')).toThrow(
      /no readable duration/,
    );
    expect(() =>
      infoFromFfprobe({ streams: [{ codec_type: 'video' }], format: { duration: '5' } }, 1, '.mp4'),
    ).toThrow(/picture size/);
  });
  it('parseRate', () => {
    expect(parseRate('30000/1001')).toBeCloseTo(29.97, 2);
    expect(parseRate('0/0')).toBeNull();
    expect(parseRate(undefined)).toBeNull();
    expect(parseRate('25')).toBe(25);
  });
});

describe('fix plan (pure maths)', () => {
  it.each([
    [120, 23, 60, false, 60],
    [100, 23, 60, false, 50],
    [144, 23, 60, false, 48],
    [90, 23, 60, false, 45],
    [60, 23, 60, false, null],
    [12, 23, 60, false, 24],
    [15, 23, 60, false, 30],
    [20, 23, 60, false, 40],
    [29.97, 23, 60, true, 30],
    [30, null, null, false, null],
    [30, null, null, true, 30],
  ])('targetFps(%s, %s..%s, vfr=%s) = %s', (src, min, max, vfr, expected) => {
    expect(targetFps(src, min, max, vfr)).toBe(expected);
  });

  it('size limit: video ceiling follows the duration (two-pass maths in one pass)', () => {
    const info = ok({ sizeBytes: 500e6, durationSec: 300, width: 1080, height: 1920 });
    const v = validateMedia(info, 'reels').issues;
    const plan = planFix(info, 'reels', v);
    const D = 300;
    const totalBits = 300e6 * SIZE_SAFETY * 8 * 0.98;
    const expected = Math.floor((totalBits - AUDIO_BPS_STEREO * D) / (D + 1));
    expect(plan.videoCapBps).toBe(expected);
    // the ceiling x duration + one 1-second buffer + audio fits the platform's limit
    expect((plan.videoCapBps! * (D + 1) + AUDIO_BPS_STEREO * D) / 8).toBeLessThan(300e6);
    // picture kept if the bits per pixel are fine
    expect([plan.width, plan.height]).toEqual([1080, 1920]);
  });

  it('a tight budget scales the picture down (never up), keeping the aspect', () => {
    const info = ok({ sizeBytes: 400e6, durationSec: 899, width: 1080, height: 1920 });
    const plan = planFix(info, 'reels', validateMedia(info, 'reels').issues);
    expect(plan.width).toBeLessThan(1080);
    expect(plan.width % 2).toBe(0);
    expect(plan.height % 2).toBe(0);
    expect(Math.abs(plan.width / plan.height - 1080 / 1920)).toBeLessThan(0.01);
    expect(plan.notes.join(' ')).toMatch(/scaled to/);
  });

  it('refuses a limit that cannot be met at a watchable quality', () => {
    const info = ok({ sizeBytes: 400e6, durationSec: 899, width: 1080, height: 1920 });
    const spec = PLATFORM_SPECS.reels as { maxSizeBytes: number | null };
    const keep = spec.maxSizeBytes;
    try {
      spec.maxSizeBytes = 5_000_000; // 5 MB for 15 minutes
      expect(() => planFix(info, 'reels', validateMedia(info, 'reels').issues)).toThrow(
        /cannot be squeezed into Instagram Reels's 5 MB limit/,
      );
    } finally {
      spec.maxSizeBytes = keep;
    }
  });

  it('resolution cap keeps the aspect and even sides; TikTok caps both sides', () => {
    const a = ok({ width: 2160, height: 3840 });
    const pa = planFix(a, 'reels', validateMedia(a, 'reels').issues);
    expect([pa.width, pa.height]).toEqual([1920, 3412]); // 1920 columns is the Reels maximum
    const b = ok({ width: 4320, height: 7680 });
    const pb = planFix(b, 'tiktok', validateMedia(b, 'tiktok').issues);
    expect(pb.height).toBeLessThanOrEqual(4096);
    expect(pb.width).toBeLessThanOrEqual(4096);
    expect(Math.abs(pb.width / pb.height - 0.5625)).toBeLessThan(0.001);
    const c = ok({ width: 1920, height: 1080 });
    const pc = planFix(c, 'reels', validateMedia(c, 'reels').issues);
    expect([pc.width, pc.height]).toEqual([1920, 1080]); // not above the limit, so untouched
  });

  it('builds ffmpeg arguments: scale only when needed, fps filter only for fps fixes, no audio mapping when silent', () => {
    const info = ok({
      width: 2160,
      height: 3840,
      fps: 120,
      audioCodec: null,
      audioChannels: null,
      container: ['mkv'],
    });
    const plan = planFix(info, 'reels', validateMedia(info, 'reels').issues);
    const args = buildFixArgs('in.mkv', 'out.mp4.partial', info, plan, 'libx264');
    const vf = args[args.indexOf('-vf') + 1]!;
    expect(vf).toBe('scale=1920:3412:flags=lanczos,setsar=1,fps=60,format=yuv420p');
    expect(args).not.toContain('-c:a');
    expect(args.join(' ')).toContain(
      '-use_editlist 0 -movflags +faststart+negative_cts_offsets -f mp4 out.mp4.partial',
    );
    expect(args).toContain('-pix_fmt');
    // plain repackaging: no scale, no fps filter, audio AAC 48 kHz stereo
    const info2 = ok({ container: ['mkv'] });
    const p2 = planFix(info2, 'reels', validateMedia(info2, 'reels').issues);
    const a2 = buildFixArgs('in', 'out', info2, p2, 'libx264');
    expect(a2[a2.indexOf('-vf') + 1]).toBe('setsar=1,format=yuv420p');
    expect(a2.join(' ')).toContain('-c:a aac -b:a 128000 -ar 48000 -ac 2');
  });

  it('rate ceiling arguments per encoder', () => {
    const x = videoEncoderArgs('libx264', 30, 4_000_000);
    expect(x.join(' ')).toContain('-maxrate 4000k -bufsize 4000k');
    expect(videoEncoderArgs('libx264', 30, null).join(' ')).not.toContain('maxrate');
    const n = videoEncoderArgs('h264_nvenc', 30, 4_000_000);
    expect(n[n.indexOf('-maxrate') + 1]).toBe('4000k');
    expect(n.filter((a) => a === '-maxrate')).toHaveLength(1);
    const t = videoEncoderArgs('h264_videotoolbox', 30, 4_000_000);
    expect(t[t.indexOf('-b:v') + 1]).toBe('4000k');
    expect(t[t.indexOf('-maxrate') + 1]).toBe('4000k');
  });
});

describe('service wiring', () => {
  it('validate() passes the per-creator TikTok duration limit through', async () => {
    const { createPublishMedia } = await import('../../electron/main/services/publish-media');
    const svc = createPublishMedia({ ffprobePath: () => '/unused' });
    const info = ok({ durationSec: 400 });
    expect(svc.validate({ info, platform: 'tiktok' }).ok).toBe(true);
    const r = svc.validate({ info, platform: 'tiktok', maxDurationSec: 300 });
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toMatchObject({ code: 'duration-long', fixable: false });
    expect(r.issues[0]!.message).toContain('up to 5:00');
  });
});
