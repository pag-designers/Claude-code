/**
 * Turns Library rows (ClipView / VideoView) into editor project assets, and filters the Library for the bin's
 * "From your Library" section. Pure: ids are injected so tests are deterministic.
 */
import { ASPECT_SIZES, type Asset, type AssetSource } from '@shared/editor';
import type { ClipView, VideoView } from '@shared/pipeline';

/** Only clips with a finished render can be played by the editor. */
export const clipHasMedia = (c: Pick<ClipView, 'status' | 'hasRender'>): boolean =>
  c.status === 'rendered' && c.hasRender;

/** Source videos play from their 480p proxy in the preview. */
export const videoHasMedia = (v: Pick<VideoView, 'hasProxy' | 'status'>): boolean =>
  v.hasProxy && v.status !== 'failed';

export function assetFromClip(clip: ClipView, id: string): Asset {
  const size = ASPECT_SIZES[clip.aspect];
  return {
    id,
    kind: 'video',
    name: clip.title,
    source: { kind: 'clip', clipId: clip.id },
    durationSec: clip.durationSec,
    width: size.width,
    height: size.height,
    // the render fps is not part of the view; the editor probes it on load
    fps: null,
    hasAudio: true,
    beats: null,
  };
}

/**
 * A source video. The Library view carries no pixel size (the editor plays the 480p proxy and probes the real file
 * on export), so width / height stay null instead of being guessed.
 */
export function assetFromVideo(video: VideoView, id: string): Asset {
  return {
    id,
    kind: 'video',
    name: video.title,
    source: { kind: 'video', videoId: video.id },
    durationSec: video.durationSec,
    width: null,
    height: null,
    fps: null,
    hasAudio: true,
    beats: null,
  };
}

export const sameSource = (a: AssetSource, b: AssetSource): boolean => {
  if (a.kind === 'clip' && b.kind === 'clip') return a.clipId === b.clipId;
  if (a.kind === 'video' && b.kind === 'video') return a.videoId === b.videoId;
  if (a.kind === 'upload' && b.kind === 'upload') return a.key === b.key;
  return false;
};

/** The asset already in the project for this source, so adding the same clip twice reuses one asset. */
export const findAssetBySource = (
  assets: readonly Asset[],
  source: AssetSource,
): Asset | undefined => assets.find((a) => sameSource(a.source, source));

export type LibraryKind = 'clips' | 'videos';

export interface LibraryRow {
  key: string;
  kind: LibraryKind;
  title: string;
  subtitle: string | null;
  durationSec: number | null;
  clip?: ClipView;
  video?: VideoView;
}

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');

/** Rows for the bin's Library list: media-available items only, newest first, filtered by a search query. */
export function libraryRows(
  kind: LibraryKind,
  clips: readonly ClipView[],
  videos: readonly VideoView[],
  query: string,
): LibraryRow[] {
  const q = norm(query.trim());
  const rows: LibraryRow[] =
    kind === 'clips'
      ? clips
          .filter(clipHasMedia)
          .map((c) => ({
            key: c.id,
            kind,
            title: c.title,
            subtitle: c.videoTitle,
            durationSec: c.durationSec,
            clip: c,
            createdAt: c.createdAt,
          }))
          .sort((a, b) => b.createdAt - a.createdAt)
          .map(({ createdAt: _c, ...r }) => r)
      : videos
          .filter(videoHasMedia)
          .map((v) => ({
            key: v.id,
            kind,
            title: v.title,
            subtitle: v.channel,
            durationSec: v.durationSec,
            video: v,
            createdAt: v.createdAt,
          }))
          .sort((a, b) => b.createdAt - a.createdAt)
          .map(({ createdAt: _c, ...r }) => r);
  if (!q) return rows;
  return rows.filter((r) => norm(`${r.title} ${r.subtitle ?? ''}`).includes(q));
}

/** Number of library items with media available (for empty-state decisions). */
export const libraryCounts = (clips: readonly ClipView[], videos: readonly VideoView[]) => ({
  clips: clips.filter(clipHasMedia).length,
  videos: videos.filter(videoHasMedia).length,
});
