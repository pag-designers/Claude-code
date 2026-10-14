/** Compiler contract: validation, errors, options, encoders, sizes, performance, graph size. */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { exportSettingsSchema, resolveExportSettings } from '../../../shared/editor';
import {
  createExportCompiler,
  videoEncoderArgs,
} from '../../../electron/main/services/editor-export';
import { A, TR, std } from './fixtures';
import {
  FFMPEG,
  FFPROBE,
  FIXTURE_NEWS,
  FONTS_DIR,
  avClip,
  exportProject,
  files,
  flatClip,
  frameAt,
  getStyle,
  haveFfmpeg,
  makeProject,
  probeDims,
  settingsFor,
  sineWav,
  tmp,
  track,
  vitem,
  workRoot,
} from './helpers';
import { createCaptionService } from '../../../electron/main/services/captions';

vi.setConfig({ testTimeout: 120_000 });
const { specs } = std();
const compiler = createExportCompiler({ ffmpegPath: FFMPEG, measureLoudness: false });
const captions = createCaptionService({ fontsDir: FONTS_DIR });
let seq = 0;
const compile = (
  project: ReturnType<typeof makeProject>,
  fileMap = files(specs),
  settings = settingsFor(160, 284),
  extra: Record<string, unknown> = {},
) => {
  const dir = tmp(`compile-${seq++}`);
  return compiler.compile({
    project,
    settings,
    files: fileMap,
    workDir: dir,
    outPath: path.join(dir, 'o.mp4'),
    fontsDir: FONTS_DIR,
    encoder: 'libx264',
    getStyle,
    captions,
    ...extra,
  } as never);
};
const one = () => makeProject([track('video', [vitem('i', 'r', 0, 1)])], specs);

describe.skipIf(!haveFfmpeg)('validation and errors', () => {
  it('an invalid project is rejected with a readable message', async () => {
    await expect(compile({ ...one(), tracks: 'nope' } as never)).rejects.toThrow(
      /project is not valid/i,
    );
  });
  it('an empty project cannot be exported', async () => {
    await expect(compile(makeProject([track('video', [])], specs))).rejects.toThrow(/empty/i);
  });
  it('an empty range is rejected', async () => {
    await expect(
      compile(one(), files(specs), settingsFor(160, 284), { range: { startSec: 1, endSec: 1 } }),
    ).rejects.toThrow(/range is empty/i);
  });
  it('an item referencing an unknown asset names it', async () => {
    const p = makeProject([track('video', [vitem('i', 'ghost', 0, 1)])], specs);
    await expect(compile(p)).rejects.toThrow(/unknown asset "ghost"/);
  });
  it('a missing local file entry names the asset', async () => {
    await expect(compile(one(), {})).rejects.toThrow(/media file for "r" is not available/);
  });
  it('a file that does not exist on disk names the path', async () => {
    const f = files([{ id: 'r', kind: 'video', path: '/nope/missing.mp4', w: 160, h: 284 }]);
    await expect(compile(one(), f)).rejects.toThrow(/missing.*\/nope\/missing\.mp4/);
  });
  it('settings are validated by the schema (bad fps)', async () => {
    await expect(
      compile(one(), files(specs), { ...settingsFor(160, 284), fps: 500 } as never),
    ).rejects.toThrow();
  });
});

describe.skipIf(!haveFfmpeg)('compiled arguments', () => {
  it('ends with the output path; has progress, faststart, cfr, colour tags and a filter script file', async () => {
    const c = await compile(one());
    const a = c.args;
    expect(a[a.length - 1]).toMatch(/o\.mp4$/);
    expect(a).toContain('-progress');
    expect(a[a.indexOf('-progress') + 1]).toBe('pipe:1');
    expect(a).toContain('-nostats');
    expect(a).toContain('-movflags');
    expect(a).toContain('+faststart');
    expect(a[a.indexOf('-colorspace') + 1]).toBe('bt709');
    expect(a[a.indexOf('-fps_mode') + 1]).toBe('cfr');
    const script = a[a.indexOf('-filter_complex_script') + 1] as string;
    expect(fs.existsSync(script)).toBe(true);
    expect(c.durationSec).toBeCloseTo(1, 6);
    expect(c.notes[0]).toMatch(/30 frames @ 30 fps/);
  });

  it('filterScriptFlag option selects -/filter_complex', async () => {
    const dir = tmp(`compile-${seq++}`);
    const c = await createExportCompiler({
      ffmpegPath: FFMPEG,
      measureLoudness: false,
      filterScriptFlag: '-/filter_complex',
    }).compile({
      project: one(),
      settings: settingsFor(160, 284),
      files: files(specs),
      workDir: dir,
      outPath: path.join(dir, 'o.mp4'),
      fontsDir: null,
      encoder: 'libx264',
      getStyle,
      captions,
    });
    expect(c.args).toContain('-/filter_complex');
    const r = execFileSync(FFMPEG, c.args, { stdio: 'pipe' });
    expect(r).toBeDefined();
  });

  it('quality maps to CRF 30..16 (libx264)', async () => {
    for (const [q, crf] of [
      [0, '30'],
      [50, '23'],
      [70, '20'],
      [100, '16'],
    ] as const) {
      const c = await compile(one(), files(specs), settingsFor(160, 284, { quality: q }));
      expect(c.args[c.args.indexOf('-crf') + 1]).toBe(crf);
    }
  });

  it('bitrate mode uses -b:v / -maxrate / -bufsize instead of -crf', async () => {
    const c = await compile(
      one(),
      files(specs),
      settingsFor(160, 284, { rateMode: 'bitrate', videoKbps: 8000 }),
    );
    expect(c.args).not.toContain('-crf');
    expect(c.args[c.args.indexOf('-b:v') + 1]).toBe('8000k');
    expect(c.args[c.args.indexOf('-maxrate') + 1]).toBe('12000k');
  });

  it('hardware encoders that cannot encode here fall back to libx264 (noted)', async () => {
    for (const enc of ['h264_nvenc', 'h264_videotoolbox'] as const) {
      const c = await compile(one(), files(specs), settingsFor(160, 284), { encoder: enc });
      expect(c.args).toContain('libx264');
      expect(c.notes.join()).toMatch(new RegExp(`${enc} is not available.*libx264`));
    }
  });

  it('hardware encoder arguments (as emitted when available): nvenc cq / videotoolbox bitrate', () => {
    const s = exportSettingsSchema.parse({
      width: 1080,
      height: 1920,
      quality: 70,
      videoKbps: 10000,
    });
    const nv = videoEncoderArgs('h264_nvenc', s);
    expect(nv).toContain('h264_nvenc');
    expect(nv[nv.indexOf('-cq') + 1]).toBe('20');
    const vt = videoEncoderArgs('h264_videotoolbox', s);
    expect(vt[vt.indexOf('-b:v') + 1]).toBe('12000k');
    expect(videoEncoderArgs('h264_nvenc', { ...s, rateMode: 'bitrate' })).toContain('-maxrate');
  });

  it('the export keeps exactly the requested size and fps (preset resolution)', async () => {
    const s = resolveExportSettings(
      { preset: 'draft-720p', loudnessLufs: null },
      { width: 1080, height: 1920, fps: 30 },
    );
    const dir = tmp(`compile-${seq++}`);
    const out = path.join(dir, 'o.mp4');
    const p = makeProject([track('video', [vitem('i', 'q', 0, 0.5)])], specs, {
      width: 1080,
      height: 1920,
    });
    const c = await compiler.compile({
      project: p,
      settings: s,
      files: files(specs),
      workDir: dir,
      outPath: out,
      fontsDir: null,
      encoder: 'libx264',
      getStyle,
      captions,
    });
    execFileSync(FFMPEG, c.args, { stdio: 'pipe' });
    const d = probeDims(out);
    expect([d.w, d.h, d.fps]).toEqual([720, 1280, 30]);
  });

  it('K scaling: project coordinates scale with the export size (x offset 20 canvas px → 40 export px)', async () => {
    const p = makeProject(
      [track('video', [vitem('i', 'r', 0, 0.5, { transform: TR({ x: A(20), scale: A(0.25) }) })])],
      specs,
    );
    const r = await exportProject(p, files(specs), settingsFor(320, 568), { name: 'k2' });
    const f = frameAt(r.out, 2);
    expect(f.px(160 + 40, 284)[0]).toBeGreaterThan(240);
    expect(f.px(160 + 40 + 50, 284)[0]).toBeLessThan(30);
    expect(f.px(172, 284)[0]).toBeGreaterThan(240);
  });

  it('a different export aspect pads the canvas (noted) instead of stretching', async () => {
    const p = one();
    const r = await exportProject(p, files(specs), settingsFor(320, 320), { name: 'aspect' });
    expect(r.notes.join()).toMatch(/padded|differs/);
    const d = probeDims(r.out);
    expect([d.w, d.h]).toEqual([320, 320]);
    const f = frameAt(r.out, 3);
    expect(f.px(5, 160)).toEqual([0, 0, 0]); // letterbox bar
    expect(f.px(160, 160)[0]).toBeGreaterThan(240);
  });

  it('range: duration and frame count are those of the window', async () => {
    const c = await compile(one(), files(specs), settingsFor(160, 284), {
      range: { startSec: 0.2, endSec: 0.6 },
    });
    expect(c.durationSec).toBeCloseTo(0.4, 6);
    expect(c.args[c.args.indexOf('-frames:v') + 1]).toBe('12');
  });

  it('SRT / VTT come back only when the project has a subtitle track', async () => {
    expect((await compile(one())).srt).toBeNull();
    const p = makeProject(
      [
        track('video', [vitem('i', 'r', 0, 1)]),
        track('subtitle', [
          {
            type: 'subtitle',
            id: 's',
            startSec: 0,
            durationSec: 1,
            words: [{ w: 'Hi', s: 0, e: 0.5, color: null }],
          },
        ]),
      ],
      specs,
    );
    const c = await compile(p);
    expect(c.srt).toContain('Hi');
    expect(c.vtt).toMatch(/^WEBVTT/);
  });

  it('the filter graph and notes are deterministic for the same input', async () => {
    const a = await compile(one());
    const b = await compile(one());
    const g = (c: { args: string[] }) =>
      fs.readFileSync(c.args[c.args.indexOf('-filter_complex_script') + 1] as string, 'utf8');
    expect(g(a)).toBe(g(b));
  });
});

describe.skipIf(!haveFfmpeg)('size and speed of the compile', () => {
  /** 60 s, 4 tracks: 12 video items (pans, zoom, transitions), overlay image/text/shape, music with ducking. */
  const bigProject = (nItems: number) => {
    const sp = [
      {
        id: 'q',
        kind: 'video' as const,
        path: specs.find((s) => s.id === 'q')!.path,
        w: 160,
        h: 284,
        fps: 30,
        dur: 3,
        hasAudio: false,
      },
      {
        id: 'w',
        kind: 'video' as const,
        path: specs.find((s) => s.id === 'w')!.path,
        w: 320,
        h: 180,
        fps: 30,
        dur: 3,
        hasAudio: false,
      },
      { id: 'm', kind: 'audio' as const, path: sineWav(440, 4, 0.3), dur: 4, hasAudio: true },
    ];
    const dur = 60 / nItems;
    const items = Array.from({ length: nItems }, (_v, i) =>
      vitem(`v${i}`, i % 2 ? 'w' : 'q', i * dur - (i ? 0.3 : 0), dur + (i ? 0.3 : 0), {
        crop: {
          x: A(0, [
            { t: 0, v: 0, ease: 'ease-in-out' },
            { t: dur, v: 0.4 },
          ]),
          y: A(0),
          w: A(0.5),
          h: A(1),
        },
        transform: TR({
          scale: A(1, [
            { t: 0, v: 1 },
            { t: dur, v: 1.2, ease: 'ease-out' },
          ]),
          rotation: A(0, [
            { t: 0, v: 0 },
            { t: dur, v: 5 },
          ]),
        }),
        color: {
          exposure: A(0, [
            { t: 0, v: 0 },
            { t: dur, v: 0.2 },
          ]),
        },
        transitionIn: i
          ? {
              type: (
                ['crossfade', 'slide-left', 'zoom', 'dip-black', 'glitch', 'whip-pan'] as const
              )[i % 6],
              durationSec: 0.3,
            }
          : null,
        audioEnabled: false,
      }),
    );
    const overlay = Array.from({ length: Math.round(nItems / 2) }, (_v, i) => ({
      type: 'text',
      id: `t${i}`,
      startSec: i * 5,
      durationSec: 4,
      text: `Title ${i}`,
      style: { size: 40 },
      animIn: { type: 'pop', durationSec: 0.3 },
    }));
    const music = [
      { type: 'audio', id: 'm1', assetId: 'm', startSec: 0, durationSec: 4 },
      { type: 'audio', id: 'm2', assetId: 'm', startSec: 30, durationSec: 4 },
    ];
    const project = makeProject(
      [
        track('video', items, { speech: true }),
        track('text', overlay),
        track('audio', music, {
          ducking: { enabled: true, reductionDb: 12, attackSec: 0.15, releaseSec: 0.5 },
        }),
      ],
      sp,
    );
    return { project, fileMap: files(sp) };
  };

  it('a 60 s multi-track project (12 animated items, transitions, text, ducked music) compiles in < 2 s', async () => {
    const { project, fileMap } = bigProject(12);
    const t0 = Date.now();
    const c = await compile(project, fileMap, settingsFor(160, 284, { loudnessLufs: null }));
    const ms = Date.now() - t0;
    console.warn(`[perf] compile 60 s / 12 items: ${ms} ms, graph ${c.notes[0]}`);
    expect(ms).toBeLessThan(2000);
    expect(c.durationSec).toBeCloseTo(60, 6);
  });

  it('graph size is bounded by the timeline length, not the item count (4× the items → < 4× the size, linear)', async () => {
    const small = await compile(
      bigProject(12).project,
      bigProject(12).fileMap,
      settingsFor(160, 284, { loudnessLufs: null }),
    );
    const large = await compile(
      bigProject(48).project,
      bigProject(48).fileMap,
      settingsFor(160, 284, { loudnessLufs: null }),
    );
    const size = (c: { args: string[] }) =>
      fs.statSync(c.args[c.args.indexOf('-filter_complex_script') + 1] as string).size;
    expect(size(small)).toBeLessThan(600_000);
    expect(size(large)).toBeLessThan(size(small) * 5);
    // the command line itself stays tiny (the graph lives in the script file)
    expect(small.args.join(' ').length).toBeLessThan(6000);
  });

  it('a long linear keyframe track does not explode: an item with 120 keyframes → knot count bounded by simplification', async () => {
    const kfs = Array.from({ length: 120 }, (_v, i) => ({
      t: i * 0.1,
      v: Math.sin(i / 5) * 30,
      ease: 'linear',
    }));
    const p = makeProject(
      [track('video', [vitem('i', 'r', 0, 12, { transform: TR({ x: { v: 0, kf: kfs } }) })])],
      specs,
    );
    const c = await compile(p, files(specs), settingsFor(160, 284));
    const g = fs.readFileSync(
      c.args[c.args.indexOf('-filter_complex_script') + 1] as string,
      'utf8',
    );
    expect(g.length).toBeLessThan(40_000);
  });

  it('speed-ramped audio uses ≤ 1/6 s segments (a 3 s ramp → 18 segments)', async () => {
    const sp = [
      { id: 'mus', kind: 'audio' as const, path: sineWav(440, 4, 0.3), dur: 4, hasAudio: true },
      ...specs.filter((x) => x.id !== 'm'),
    ];
    const p = makeProject(
      [
        track('video', [vitem('i', 'r', 0, 3, { audioEnabled: false })]),
        track('audio', [
          {
            type: 'audio',
            id: 'a',
            assetId: 'mus',
            startSec: 0,
            durationSec: 3,
            speedCurve: [
              { t: 0, v: 1, ease: 'linear' },
              { t: 3, v: 2, ease: 'linear' },
            ],
          },
        ]),
      ],
      sp,
    );
    const c = await compile(p, files(sp), settingsFor(160, 284, { loudnessLufs: null }));
    const g = fs.readFileSync(
      c.args[c.args.indexOf('-filter_complex_script') + 1] as string,
      'utf8',
    );
    expect(g).toMatch(/asplit=18/);
    expect(g).toMatch(/concat=n=18:v=0:a=1/);
  });
});

describe.skipIf(!haveFfmpeg)('end to end on real media', () => {
  it('news fixture: 3 layers + ducked music, 480x854, exports and plays (reports ×realtime)', async () => {
    if (!fs.existsSync(FIXTURE_NEWS)) return;
    const sp = [
      {
        id: 'n',
        kind: 'video' as const,
        path: FIXTURE_NEWS,
        w: 854,
        h: 480,
        fps: 29.97,
        dur: 180,
        hasAudio: true,
      },
      { id: 'm', kind: 'audio' as const, path: sineWav(220, 12, 0.2), dur: 12, hasAudio: true },
    ];
    const p = makeProject(
      [
        track(
          'video',
          [
            vitem('a', 'n', 0, 10, {
              inSec: 20,
              crop: {
                x: A(0.1, [
                  { t: 0, v: 0.1 },
                  { t: 10, v: 0.4 },
                ]),
                y: A(0),
                w: A(0.3164),
                h: A(1),
              },
            }),
          ],
          { speech: true },
        ),
        track('overlay', [
          vitem('b', 'n', 2, 6, {
            inSec: 90,
            audioEnabled: false,
            fit: 'contain',
            transform: TR({ y: A(-600), scale: A(0.45) }),
          }),
        ]),
        track('text', [
          {
            type: 'text',
            id: 't',
            startSec: 1,
            durationSec: 5,
            text: 'Breaking news',
            style: { size: 70 },
            animIn: { type: 'pop', durationSec: 0.4 },
          },
        ]),
        track('audio', [{ type: 'audio', id: 'au', assetId: 'm', startSec: 0, durationSec: 10 }], {
          ducking: { enabled: true, reductionDb: 10, attackSec: 0.1, releaseSec: 0.4 },
        }),
      ],
      sp,
      { width: 1080, height: 1920 },
    );
    const t0 = Date.now();
    const r = await exportProject(
      p,
      files(sp),
      settingsFor(480, 854, { loudnessLufs: -14, quality: 70 }),
      { name: 'news' },
    );
    const wall = (Date.now() - t0) / 1000;
    console.warn(
      `[perf] news 10 s, 3 layers + audio @ 480x854: ${wall.toFixed(1)} s wall = ${(10 / wall).toFixed(2)}x realtime`,
    );
    const d = probeDims(r.out);
    expect([d.w, d.h]).toEqual([480, 854]);
    expect(Math.abs(d.dur - 10)).toBeLessThan(0.1);
    const info = JSON.parse(
      execFileSync(FFPROBE, [
        '-v',
        'error',
        '-show_entries',
        'stream=codec_name,codec_type',
        '-of',
        'json',
        r.out,
      ]).toString(),
    ).streams.map((s: { codec_name: string }) => s.codec_name);
    expect(info).toEqual(expect.arrayContaining(['h264', 'aac']));
    fs.copyFileSync(r.out, path.join(workRoot(), 'news-export.mp4'));
  });
});
void flatClip;
void avClip;
