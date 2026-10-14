import { randomBytes } from 'node:crypto';
import {
  ASPECT_SIZES,
  assetSchema,
  projectSchema,
  subtitleItemSchema,
  textItemSchema,
  trackSchema,
  videoItemSchema,
  type Asset,
  type Item,
  type Project,
  type SubtitleItem,
  type Track,
} from '@shared/editor';
import type { Cue } from '@shared/cp2';
import type { Word } from '@shared/pipeline';

export const newId = (prefix: string): string => `${prefix}_${randomBytes(5).toString('hex')}`;

type FourAspects = keyof typeof ASPECT_SIZES;

/** Empty project with the four default tracks, bottom → top: Video (speech), Subtitles, Text, Music. */
export function blankProject(aspect: FourAspects = '9:16'): Project {
  const { width, height } = ASPECT_SIZES[aspect];
  const mk = (kind: Track['kind'], name: string, extra: Partial<Track> = {}): Track =>
    trackSchema.parse({ id: newId('tr'), kind, name, items: [], ...extra });
  return projectSchema.parse({
    canvas: { aspect, width, height },
    tracks: [
      mk('video', 'Video', { speech: true }),
      mk('subtitle', 'Subtitles'),
      mk('text', 'Text'),
      mk('audio', 'Music'),
    ],
    assets: [],
  });
}

export function canvasFor(
  width: number,
  height: number,
): { aspect: Project['canvas']['aspect']; width: number; height: number } {
  const r = width / height;
  const pick = (
    Object.entries(ASPECT_SIZES) as [FourAspects, { width: number; height: number }][]
  ).find(([, s]) => Math.abs(s.width / s.height - r) < 0.02);
  if (pick) return { aspect: pick[0], width: pick[1].width, height: pick[1].height };
  // Odd aspect: keep the long side at 1920 and round to even numbers.
  const w = r >= 1 ? 1920 : Math.round((1920 * r) / 2) * 2;
  const h = r >= 1 ? Math.round(1920 / r / 2) * 2 : 1920;
  return { aspect: 'custom', width: w, height: h };
}

/**
 * Subtitle cues → subtitle items on the TIMELINE. `offsetSec` is subtracted from cue times (clip start);
 * only cues overlapping [from, to) are kept and clamped to it.
 */
export function cuesToItems(
  cues: Cue[],
  words: Word[],
  opts: { from: number; to: number; offsetSec: number; styleId: string },
): SubtitleItem[] {
  const out: SubtitleItem[] = [];
  for (const c of cues) {
    if (c.e <= opts.from || c.s >= opts.to) continue;
    const slice = words
      .slice(c.wordStart, c.wordEnd + 1)
      .filter((w) => w.e > opts.from && w.s < opts.to);
    if (slice.length === 0) continue;
    const start = Math.max(c.s, opts.from);
    const end = Math.min(Math.max(c.e, slice[slice.length - 1]?.e ?? c.e), opts.to);
    if (end - start < 0.04) continue;
    out.push(
      subtitleItemSchema.parse({
        type: 'subtitle',
        id: newId('it'),
        startSec: Math.max(0, start - opts.offsetSec),
        durationSec: end - start,
        styleId: opts.styleId,
        words: slice.map((w) => ({
          w: w.w.trim(),
          s: Math.max(0, w.s - start),
          e: Math.max(0.01, Math.min(w.e, end) - start),
        })),
      }),
    );
  }
  return out;
}

/** Title-card look of the CP1 hook (white card, dark bold text, near the top), as an editable text item. */
export function hookTextItem(
  text: string,
  canvasW: number,
  canvasH: number,
  durationSec: number,
  startSec = 0,
): Item {
  const landscape = canvasW > canvasH;
  const base = landscape ? canvasH : canvasW;
  return textItemSchema.parse({
    type: 'text',
    id: newId('it'),
    name: 'Hook',
    startSec,
    durationSec: Math.max(1.2, Math.min(4, durationSec)),
    text: text.replace(/\s+/g, ' ').trim(),
    style: {
      fontFamily: 'Montserrat',
      weight: 800,
      size: Math.round(base * (landscape ? 0.066 : 0.074)),
      color: '#101114',
      align: 'center',
      lineHeight: 1.12,
      box: {
        color: '#FFFFFF',
        opacity: 1,
        padding: Math.round(base * 0.025),
        radius: Math.round(base * 0.02),
      },
      maxWidth: Math.round(canvasW * 0.84),
    },
    transform: { y: { v: Math.round(canvasH * (0.18 - 0.5)) } },
    animIn: { type: 'pop', durationSec: 0.3 },
    animOut: { type: 'fade', durationSec: 0.25 },
  });
}

export function videoAsset(args: {
  id?: string;
  name: string;
  videoId?: string;
  clipId?: string;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  fps?: number | null;
}): Asset {
  return assetSchema.parse({
    id: args.id ?? newId('as'),
    kind: 'video',
    name: args.name,
    source: args.clipId
      ? { kind: 'clip', clipId: args.clipId }
      : { kind: 'video', videoId: args.videoId ?? '' },
    durationSec: args.durationSec,
    width: args.width,
    height: args.height,
    fps: args.fps ?? null,
    hasAudio: true,
  });
}

export function mainVideoItem(args: {
  assetId: string;
  inSec: number;
  durationSec: number;
  crop?: { t: number; x: number; y: number; w: number; h: number }[];
  fit: 'cover' | 'contain';
}): Item {
  const kfs = (key: 'x' | 'y' | 'w' | 'h') =>
    args.crop?.map((k) => ({ t: k.t, v: k[key], ease: 'linear' as const })) ?? [];
  const base = (key: 'x' | 'y' | 'w' | 'h', d: number) => ({
    v: args.crop?.[0]?.[key] ?? d,
    kf: kfs(key),
  });
  return videoItemSchema.parse({
    type: 'video',
    id: newId('it'),
    name: 'Source',
    startSec: 0,
    durationSec: args.durationSec,
    assetId: args.assetId,
    inSec: args.inSec,
    fit: args.fit,
    crop: args.crop?.length
      ? { x: base('x', 0), y: base('y', 0), w: base('w', 1), h: base('h', 1) }
      : undefined,
    audioEnabled: true,
  });
}

export const withItems = (project: Project, kind: Track['kind'], items: Item[]): Project => ({
  ...project,
  tracks: project.tracks.map((t) =>
    t.kind === kind
      ? { ...t, items: [...t.items, ...items].sort((a, b) => a.startSec - b.startSec) }
      : t,
  ),
});
