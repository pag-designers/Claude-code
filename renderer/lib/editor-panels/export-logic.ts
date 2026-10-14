/**
 * Pure logic of the Export panel: preset switching, size estimate, filename template, validation and the
 * remembered-settings round trip. Everything that decides export DEFAULTS goes through `resolveExportSettings`
 * (shared/editor.ts), the same function main uses, so the panel can never disagree with the exporter.
 */
import {
  EXPORT_PRESETS,
  exportSettingsSchema,
  resolveExportSettings,
  type ExportPresetId,
  type ExportSettings,
} from '@shared/editor';
import { formatBytes, formatClock } from '../format';

export type ExportCanvas = { width: number; height: number; fps: number };

export const PRESET_IDS: readonly ExportPresetId[] = [
  'tiktok',
  'reels',
  'shorts',
  'youtube-1080p',
  'square-1080',
  'draft-720p',
  'custom',
];

export const presetLabel = (id: ExportPresetId): string =>
  id === 'custom' ? 'Custom' : EXPORT_PRESETS[id].label;

export const FPS_CHOICES = [24, 25, 30, 50, 60] as const;
export const AUDIO_KBPS_CHOICES = [96, 128, 160, 192, 256, 320] as const;

export const LOUDNESS_CHOICES: { value: number | null; label: string; hint: string }[] = [
  { value: -14, label: '−14 LUFS', hint: 'TikTok, Reels, Shorts and YouTube loudness' },
  { value: -16, label: '−16 LUFS', hint: 'Podcast and speech-first content' },
  { value: -23, label: '−23 LUFS', hint: 'Broadcast (EBU R128)' },
  { value: null, label: 'Off', hint: 'Keep the mix exactly as edited' },
];

export const FILENAME_TOKENS = ['{title}', '{preset}', '{date}', '{n}'] as const;
const KNOWN_TOKENS: ReadonlySet<string> = new Set(FILENAME_TOKENS);

/* ------------------------------------------------------------------------------ presets / defaults */

/** Preset that matches the project canvas (so the first export needs no thinking). */
export function defaultPresetFor(canvas: ExportCanvas): ExportPresetId {
  const r = canvas.width / canvas.height;
  if (Math.abs(r - 9 / 16) < 0.02) return 'tiktok';
  if (Math.abs(r - 16 / 9) < 0.02) return 'youtube-1080p';
  if (Math.abs(r - 1) < 0.02) return 'square-1080';
  return 'custom';
}

export function defaultSettings(canvas: ExportCanvas, preset?: ExportPresetId): ExportSettings {
  return resolveExportSettings({ preset: preset ?? defaultPresetFor(canvas) }, canvas);
}

/**
 * Switches preset: size / fps / bitrate come from the preset, everything personal (quality, audio, loudness,
 * captions, filename) is kept. Switching to Custom keeps the current numbers so they can be tweaked.
 */
export function applyPreset(
  current: ExportSettings,
  preset: ExportPresetId,
  canvas: ExportCanvas,
): ExportSettings {
  if (preset === 'custom') return { ...current, preset };
  const keep: Partial<ExportSettings> = {
    rateMode: current.rateMode,
    quality: current.quality,
    audioKbps: current.audioKbps,
    burnCaptions: current.burnCaptions,
    sidecarSrt: current.sidecarSrt,
    sidecarVtt: current.sidecarVtt,
    loudnessLufs: current.loudnessLufs,
    filenameTemplate: current.filenameTemplate,
  };
  return resolveExportSettings({ ...keep, preset }, canvas);
}

/** Editing a preset-owned number turns the preset into Custom. */
export function editSettings(
  current: ExportSettings,
  patch: Partial<ExportSettings>,
): ExportSettings {
  const touchesPreset =
    'width' in patch || 'height' in patch || 'fps' in patch || 'videoKbps' in patch;
  return { ...current, ...patch, preset: touchesPreset ? 'custom' : current.preset };
}

/* --------------------------------------------------------------------------------- quality / size */

/** Slider 0..100 → CRF 30..16 (shared/editor.ts). */
export const qualityToCrf = (quality: number): number =>
  Math.round(30 - (14 * Math.max(0, Math.min(100, quality))) / 100);

export function qualityLabel(quality: number): string {
  const q = Math.max(0, Math.min(100, quality));
  const word = q < 25 ? 'Small file' : q < 50 ? 'Balanced' : q < 80 ? 'High' : 'Maximum';
  return `${word} · CRF ${qualityToCrf(q)}`;
}

/** Bits per pixel an x264-class encoder needs at a CRF (≈0.075 bpp at CRF 23, ×2 per 6 CRF steps). */
const bitsPerPixel = (crf: number): number => 0.075 * 2 ** ((23 - crf) / 6);

export function estimateVideoKbps(
  s: Pick<ExportSettings, 'rateMode' | 'videoKbps' | 'quality' | 'width' | 'height' | 'fps'>,
): number {
  if (s.rateMode === 'bitrate') return s.videoKbps;
  const kbps = (s.width * s.height * s.fps * bitsPerPixel(qualityToCrf(s.quality))) / 1000;
  return Math.round(Math.max(500, Math.min(80_000, kbps)));
}

/** Estimated file size: (video + audio kbps) × duration, plus ~1 % container overhead. */
export function estimateSizeBytes(s: ExportSettings, durationSec: number): number {
  if (!(durationSec > 0)) return 0;
  const kbps = estimateVideoKbps(s) + s.audioKbps;
  return Math.round(((kbps * 1000) / 8) * durationSec * 1.01);
}

export const describeSize = (s: ExportSettings, durationSec: number): string =>
  durationSec > 0 ? `≈ ${formatBytes(estimateSizeBytes(s, durationSec))}` : '—';

/* ------------------------------------------------------------------------------ filename template */

export interface FilenameContext {
  title: string;
  preset: ExportPresetId;
  date: Date;
  n: number;
}

// eslint-disable-next-line no-control-regex
const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g;

function slug(s: string): string {
  return s
    .replace(ILLEGAL, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60);
}

const ymd = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Live preview of the output file name, e.g. `My-clip-tiktok.mp4`. Tokens: {title} {preset} {date} {n}. */
export function renderFilename(template: string, ctx: FilenameContext): string {
  const values: Record<string, string> = {
    '{title}': slug(ctx.title) || 'untitled',
    '{preset}': ctx.preset,
    '{date}': ymd(ctx.date),
    '{n}': String(ctx.n),
  };
  const base = template
    .replace(/\{[a-z]+\}/gi, (t) => values[t.toLowerCase()] ?? t)
    .replace(ILLEGAL, '')
    .trim()
    .replace(/^\.+|\.+$/g, '');
  return `${base || 'export'}.mp4`;
}

export function unknownTokens(template: string): string[] {
  const found = template.match(/\{[^{}]*\}/g) ?? [];
  return [...new Set(found.filter((t) => !KNOWN_TOKENS.has(t.toLowerCase())))];
}

/* ---------------------------------------------------------------------------------- validation */

export type IssueField =
  | 'project'
  | 'size'
  | 'fps'
  | 'bitrate'
  | 'audio'
  | 'loudness'
  | 'filename'
  | 'duration'
  | 'aspect'
  | 'captions';

export interface ExportIssue {
  field: IssueField;
  level: 'error' | 'warning' | 'info';
  message: string;
}

export interface ExportContext {
  durationSec: number;
  canvas: ExportCanvas;
  /** Project has at least one subtitle cue. */
  hasSubtitles: boolean;
}

/** Platform length limit warning for the chosen preset, or null. */
export function durationWarning(preset: ExportPresetId, durationSec: number): string | null {
  if (preset === 'custom') return null;
  const p = EXPORT_PRESETS[preset];
  if (p.maxSec === null || durationSec <= p.maxSec) return null;
  return `${formatClock(durationSec)} is longer than the ${p.label} limit of ${formatClock(p.maxSec)}. The platform may reject or trim it.`;
}

export const aspectLabel = (w: number, h: number): string => {
  const r = w / h;
  const known: [number, string][] = [
    [9 / 16, '9:16'],
    [16 / 9, '16:9'],
    [1, '1:1'],
    [4 / 5, '4:5'],
  ];
  return known.find(([k]) => Math.abs(k - r) < 0.02)?.[1] ?? `${w}:${h}`;
};

export function validateExport(s: ExportSettings, ctx: ExportContext): ExportIssue[] {
  const out: ExportIssue[] = [];
  const add = (field: IssueField, level: ExportIssue['level'], message: string) =>
    out.push({ field, level, message });

  if (!(ctx.durationSec > 0)) add('project', 'error', 'The timeline is empty. Add a clip first.');

  const dim = (v: number, name: string) => {
    if (!Number.isInteger(v) || v < 64 || v > 4096) {
      add('size', 'error', `${name} must be a whole number between 64 and 4096 px.`);
    } else if (v % 2 !== 0) {
      add('size', 'error', `${name} must be an even number (H.264 needs even dimensions).`);
    }
  };
  dim(s.width, 'Width');
  dim(s.height, 'Height');
  if (!(s.fps >= 10 && s.fps <= 60)) add('fps', 'error', 'Frame rate must be between 10 and 60.');
  if (s.rateMode === 'bitrate' && !(s.videoKbps >= 500 && s.videoKbps <= 80_000))
    add('bitrate', 'error', 'Video bitrate must be between 500 and 80,000 kbps.');
  if (!(s.audioKbps >= 64 && s.audioKbps <= 384))
    add('audio', 'error', 'Audio bitrate must be between 64 and 384 kbps.');
  if (s.loudnessLufs !== null && !(s.loudnessLufs >= -30 && s.loudnessLufs <= -5))
    add('loudness', 'error', 'Loudness target must be between −30 and −5 LUFS.');

  const t = s.filenameTemplate.trim();
  if (!t) add('filename', 'error', 'Enter a file name.');
  else if (s.filenameTemplate.length > 120)
    add('filename', 'error', 'File names can be at most 120 characters.');
  else if (/[\\/:*?"<>|]/.test(s.filenameTemplate))
    add('filename', 'error', 'File names cannot contain \\ / : * ? " < > |');
  const bad = unknownTokens(s.filenameTemplate);
  if (bad.length)
    add(
      'filename',
      'warning',
      `${bad.join(', ')} ${bad.length === 1 ? 'is' : 'are'} not a known token and will stay as typed. Use ${FILENAME_TOKENS.join(' ')}.`,
    );

  const dur = durationWarning(s.preset, ctx.durationSec);
  if (dur) add('duration', 'warning', dur);

  const exportAspect = s.width / s.height;
  const canvasAspect = ctx.canvas.width / ctx.canvas.height;
  if (Math.abs(exportAspect - canvasAspect) / canvasAspect > 0.02) {
    add(
      'aspect',
      'info',
      `Your canvas is ${aspectLabel(ctx.canvas.width, ctx.canvas.height)} but this export is ${aspectLabel(s.width, s.height)}, so the picture is scaled and may be cropped or letterboxed.`,
    );
  } else if (s.width * s.height > ctx.canvas.width * ctx.canvas.height * 1.01) {
    add(
      'aspect',
      'info',
      `The export is larger than the ${ctx.canvas.width}×${ctx.canvas.height} canvas and will be upscaled.`,
    );
  }

  if (!ctx.hasSubtitles && ctx.durationSec > 0) {
    if (s.sidecarSrt || s.sidecarVtt)
      add(
        'captions',
        'warning',
        'There are no subtitles on the timeline, so the SRT/VTT file would be empty.',
      );
    else if (s.burnCaptions)
      add('captions', 'info', 'There are no subtitles on the timeline, so nothing is burned in.');
  }
  return out;
}

export const hasErrors = (issues: readonly ExportIssue[]): boolean =>
  issues.some((i) => i.level === 'error');

/* ---------------------------------------------------------------------------- remembered settings */

export const EXPORT_STORAGE_KEY = 'clipfern.editor.export.v1';

type ReadStore = Pick<Storage, 'getItem'>;
type WriteStore = Pick<Storage, 'setItem'>;

/** Last used settings (localStorage, every access guarded), resolved against the current canvas. */
export function loadSettings(canvas: ExportCanvas, store?: ReadStore | null): ExportSettings {
  try {
    const s = store ?? (typeof localStorage === 'undefined' ? null : localStorage);
    const raw = s?.getItem(EXPORT_STORAGE_KEY);
    if (raw) {
      const stored: unknown = JSON.parse(raw);
      const parsed = exportSettingsSchema.partial().safeParse(stored);
      if (parsed.success && stored && typeof stored === 'object') {
        // `partial()` still fills schema defaults for absent keys; only keys that were stored may override the preset
        const present = Object.fromEntries(
          Object.entries(parsed.data).filter(([k]) => k in stored),
        ) as Partial<ExportSettings>;
        return resolveExportSettings(present, canvas);
      }
    }
  } catch {
    /* storage blocked or corrupt: fall through to the defaults */
  }
  return defaultSettings(canvas);
}

export function saveSettings(settings: ExportSettings, store?: WriteStore | null): void {
  try {
    const s = store ?? (typeof localStorage === 'undefined' ? null : localStorage);
    s?.setItem(EXPORT_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* blocked: the settings are simply not remembered */
  }
}
