import { describe, expect, it } from 'vitest';
import { EXPORT_PRESETS, exportSettingsSchema, resolveExportSettings } from '../../shared/editor';
import {
  EXPORT_STORAGE_KEY,
  PRESET_IDS,
  applyPreset,
  defaultPresetFor,
  defaultSettings,
  describeSize,
  durationWarning,
  editSettings,
  estimateSizeBytes,
  estimateVideoKbps,
  hasErrors,
  loadSettings,
  qualityLabel,
  qualityToCrf,
  renderFilename,
  saveSettings,
  unknownTokens,
  validateExport,
} from '../../renderer/lib/editor-panels/export-logic';

const CANVAS = { width: 1080, height: 1920, fps: 30 };
const ctx = (over: Partial<Parameters<typeof validateExport>[1]> = {}) => ({
  durationSec: 30,
  canvas: CANVAS,
  hasSubtitles: true,
  ...over,
});
const issue = (issues: ReturnType<typeof validateExport>, field: string) =>
  issues.find((i) => i.field === field);

describe('export settings resolution', () => {
  it('lists every shared preset plus custom, in a stable order', () => {
    expect(PRESET_IDS.filter((p) => p !== 'custom').sort()).toEqual(
      Object.keys(EXPORT_PRESETS).sort(),
    );
    expect(PRESET_IDS.at(-1)).toBe('custom');
  });

  it('the default preset follows the canvas aspect', () => {
    expect(defaultPresetFor({ width: 1080, height: 1920, fps: 30 })).toBe('tiktok');
    expect(defaultPresetFor({ width: 1920, height: 1080, fps: 30 })).toBe('youtube-1080p');
    expect(defaultPresetFor({ width: 1080, height: 1080, fps: 30 })).toBe('square-1080');
    expect(defaultPresetFor({ width: 1080, height: 1350, fps: 30 })).toBe('custom');
  });

  it('defaults come from resolveExportSettings (the same function main uses)', () => {
    expect(defaultSettings(CANVAS)).toEqual(resolveExportSettings({ preset: 'tiktok' }, CANVAS));
    const custom = defaultSettings({ width: 1080, height: 1350, fps: 25 });
    expect(custom).toMatchObject({ preset: 'custom', width: 1080, height: 1350, fps: 25 });
    expect(defaultSettings(CANVAS).loudnessLufs).toBe(-14);
  });

  it('switching preset takes size / fps / bitrate from the preset and keeps personal choices', () => {
    const mine = {
      ...defaultSettings(CANVAS),
      quality: 33,
      audioKbps: 256 as number,
      loudnessLufs: null,
      sidecarSrt: true,
      burnCaptions: false,
      filenameTemplate: 'x-{n}',
      rateMode: 'bitrate' as const,
    };
    const yt = applyPreset(mine, 'youtube-1080p', CANVAS);
    expect(yt).toMatchObject({
      preset: 'youtube-1080p',
      width: 1920,
      height: 1080,
      videoKbps: 12000,
      quality: 33,
      audioKbps: 256,
      loudnessLufs: null,
      sidecarSrt: true,
      burnCaptions: false,
      filenameTemplate: 'x-{n}',
      rateMode: 'bitrate',
    });
    const draft = applyPreset(mine, 'draft-720p', CANVAS);
    expect(draft).toMatchObject({ width: 720, height: 1280, videoKbps: 4000 });
  });

  it('custom keeps the current numbers; editing a preset-owned number makes it custom', () => {
    const tt = defaultSettings(CANVAS);
    expect(applyPreset(tt, 'custom', CANVAS)).toMatchObject({
      preset: 'custom',
      width: 1080,
      height: 1920,
    });
    expect(editSettings(tt, { width: 1000 })).toMatchObject({ preset: 'custom', width: 1000 });
    expect(editSettings(tt, { fps: 24 }).preset).toBe('custom');
    expect(editSettings(tt, { audioKbps: 128 }).preset).toBe('tiktok');
  });

  it('every preset resolves to a schema-valid request', () => {
    for (const p of PRESET_IDS)
      expect(() =>
        exportSettingsSchema.parse(applyPreset(defaultSettings(CANVAS), p, CANVAS)),
      ).not.toThrow();
  });
});

describe('quality, bitrate and size estimate', () => {
  it('maps the 0..100 slider to CRF 30..16', () => {
    expect(qualityToCrf(0)).toBe(30);
    expect(qualityToCrf(100)).toBe(16);
    expect(qualityToCrf(70)).toBe(20);
    expect(qualityToCrf(-10)).toBe(30);
    expect(qualityToCrf(250)).toBe(16);
    expect(qualityLabel(70)).toBe('High · CRF 20');
    expect(qualityLabel(10)).toMatch(/^Small file/);
    expect(qualityLabel(100)).toMatch(/^Maximum/);
  });

  it('bitrate mode uses the typed bitrate; quality mode grows with resolution, fps and quality', () => {
    const s = defaultSettings(CANVAS);
    expect(estimateVideoKbps({ ...s, rateMode: 'bitrate', videoKbps: 8000 })).toBe(8000);
    const q = estimateVideoKbps({ ...s, rateMode: 'quality', quality: 70 });
    expect(q).toBeGreaterThan(3000);
    expect(q).toBeLessThan(15000);
    expect(estimateVideoKbps({ ...s, quality: 100 })).toBeGreaterThan(q);
    expect(estimateVideoKbps({ ...s, quality: 20 })).toBeLessThan(q);
    expect(estimateVideoKbps({ ...s, fps: 60 })).toBeGreaterThan(q);
    expect(estimateVideoKbps({ ...s, width: 720, height: 1280 })).toBeLessThan(q);
    expect(estimateVideoKbps({ ...s, width: 64, height: 64, quality: 0 })).toBe(500); // clamped
  });

  it('size = (video + audio kbps) × duration, with ~1 % container overhead', () => {
    const s = {
      ...defaultSettings(CANVAS),
      rateMode: 'bitrate' as const,
      videoKbps: 8000,
      audioKbps: 192,
    };
    const bytes = estimateSizeBytes(s, 60);
    expect(bytes).toBe(Math.round(((8192 * 1000) / 8) * 60 * 1.01));
    expect(estimateSizeBytes(s, 0)).toBe(0);
    expect(describeSize(s, 60)).toMatch(/^≈ 6\d(\.\d)? MB$/);
    expect(describeSize(s, 0)).toBe('—');
  });
});

describe('filename template', () => {
  const date = new Date(2026, 9, 14, 12);
  const base = { title: 'My Great Clip!', preset: 'tiktok' as const, date, n: 3 };
  it('replaces {title} {preset} {date} {n} and adds .mp4', () => {
    expect(renderFilename('{title}-{preset}', base)).toBe('My-Great-Clip!-tiktok.mp4');
    expect(renderFilename('{date}_{n}_{preset}', base)).toBe('2026-10-14_3_tiktok.mp4');
    expect(renderFilename('{TITLE}', base)).toBe('My-Great-Clip!.mp4');
  });
  it('strips characters that are illegal in file names and falls back for empty results', () => {
    expect(renderFilename('a/b\\c:d*e?f"g<h>i|j', base)).toBe('abcdefghij.mp4');
    expect(renderFilename('  ', base)).toBe('export.mp4');
    expect(renderFilename('{title}', { ...base, title: '///' })).toBe('untitled.mp4');
    expect(renderFilename('{title}', { ...base, title: 'Ünï — tëst  clip' })).toBe(
      'Ünï-—-tëst-clip.mp4',
    );
  });
  it('leaves unknown tokens as typed and reports them', () => {
    expect(renderFilename('{foo}-{n}', base)).toBe('{foo}-3.mp4');
    expect(unknownTokens('{title}-{foo}-{BAR}-{n}')).toEqual(['{foo}', '{BAR}']);
    expect(unknownTokens('{title}')).toEqual([]);
  });
});

describe('validation', () => {
  const ok = defaultSettings(CANVAS);
  it('a normal export has no errors', () => {
    expect(hasErrors(validateExport(ok, ctx()))).toBe(false);
  });
  it('an empty timeline is an error', () => {
    expect(issue(validateExport(ok, ctx({ durationSec: 0 })), 'project')?.level).toBe('error');
  });
  it('size must be even and in range', () => {
    expect(issue(validateExport({ ...ok, width: 1081 }, ctx()), 'size')?.message).toMatch(/even/);
    expect(issue(validateExport({ ...ok, height: 32 }, ctx()), 'size')?.level).toBe('error');
    expect(issue(validateExport({ ...ok, width: 5000 }, ctx()), 'size')?.level).toBe('error');
    expect(hasErrors(validateExport({ ...ok, width: 1920, height: 1080 }, ctx()))).toBe(false);
  });
  it('checks fps, bitrate, audio bitrate and loudness ranges', () => {
    expect(issue(validateExport({ ...ok, fps: 5 }, ctx()), 'fps')).toBeTruthy();
    expect(
      issue(validateExport({ ...ok, rateMode: 'bitrate', videoKbps: 100 }, ctx()), 'bitrate'),
    ).toBeTruthy();
    expect(
      issue(validateExport({ ...ok, rateMode: 'quality', videoKbps: 100 }, ctx()), 'bitrate'),
    ).toBeUndefined();
    expect(issue(validateExport({ ...ok, audioKbps: 32 }, ctx()), 'audio')).toBeTruthy();
    expect(issue(validateExport({ ...ok, loudnessLufs: -2 }, ctx()), 'loudness')).toBeTruthy();
    expect(issue(validateExport({ ...ok, loudnessLufs: null }, ctx()), 'loudness')).toBeUndefined();
  });
  it('file names: required, no illegal characters, unknown tokens only warn', () => {
    expect(issue(validateExport({ ...ok, filenameTemplate: ' ' }, ctx()), 'filename')?.level).toBe(
      'error',
    );
    expect(
      issue(validateExport({ ...ok, filenameTemplate: 'a/b' }, ctx()), 'filename')?.level,
    ).toBe('error');
    const warn = issue(
      validateExport({ ...ok, filenameTemplate: '{title}-{oops}' }, ctx()),
      'filename',
    );
    expect(warn?.level).toBe('warning');
    expect(warn?.message).toContain('{oops}');
  });
  it('warns when the project is longer than the platform allows', () => {
    const tt = { ...ok, preset: 'reels' as const };
    expect(issue(validateExport(tt, ctx({ durationSec: 200 })), 'duration')?.level).toBe('warning');
    expect(durationWarning('reels', 200)).toContain('3:00');
    expect(durationWarning('reels', 180)).toBeNull();
    expect(durationWarning('shorts', 181)).toContain('YouTube Shorts');
    expect(durationWarning('tiktok', 599)).toBeNull();
    expect(durationWarning('tiktok', 601)).toContain('10:00');
    expect(durationWarning('youtube-1080p', 7200)).toBeNull();
    expect(durationWarning('custom', 7200)).toBeNull();
  });
  it('explains an export that does not match the canvas', () => {
    const i = issue(validateExport({ ...ok, width: 1920, height: 1080 }, ctx()), 'aspect');
    expect(i?.level).toBe('info');
    expect(i?.message).toMatch(/9:16.*16:9/);
    expect(issue(validateExport(ok, ctx()), 'aspect')).toBeUndefined();
    const up = issue(validateExport({ ...ok, width: 2160, height: 3840 }, ctx()), 'aspect');
    expect(up?.message).toMatch(/upscaled/);
  });
  it('captions: sidecar files with no subtitles warn, burn-in only informs', () => {
    const none = ctx({ hasSubtitles: false });
    expect(issue(validateExport({ ...ok, sidecarSrt: true }, none), 'captions')?.level).toBe(
      'warning',
    );
    expect(
      issue(validateExport({ ...ok, sidecarSrt: false, burnCaptions: true }, none), 'captions')
        ?.level,
    ).toBe('info');
    expect(
      issue(validateExport({ ...ok, sidecarSrt: false, burnCaptions: false }, none), 'captions'),
    ).toBeUndefined();
  });
});

describe('remembered settings', () => {
  const mem = () => {
    const m = new Map<string, string>();
    return {
      m,
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
    };
  };
  it('round-trips through storage', () => {
    const st = mem();
    const s = {
      ...defaultSettings(CANVAS),
      preset: 'reels' as const,
      quality: 55,
      loudnessLufs: -16,
    };
    saveSettings(s, st);
    expect(st.m.has(EXPORT_STORAGE_KEY)).toBe(true);
    expect(loadSettings(CANVAS, st)).toEqual(s);
  });
  it('falls back to the defaults on garbage, schema violations and blocked storage', () => {
    const st = mem();
    st.setItem(EXPORT_STORAGE_KEY, '{not json');
    expect(loadSettings(CANVAS, st)).toEqual(defaultSettings(CANVAS));
    st.setItem(EXPORT_STORAGE_KEY, JSON.stringify({ quality: 900 }));
    expect(loadSettings(CANVAS, st)).toEqual(defaultSettings(CANVAS));
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(loadSettings(CANVAS, throwing)).toEqual(defaultSettings(CANVAS));
    expect(() => saveSettings(defaultSettings(CANVAS), throwing)).not.toThrow();
  });
  it('a partial stored value is completed from the preset', () => {
    const st = mem();
    st.setItem(EXPORT_STORAGE_KEY, JSON.stringify({ preset: 'shorts', quality: 40 }));
    expect(loadSettings(CANVAS, st)).toMatchObject({
      preset: 'shorts',
      quality: 40,
      videoKbps: 12000,
      width: 1080,
    });
  });
});
