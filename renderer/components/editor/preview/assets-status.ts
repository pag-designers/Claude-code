import type { Project } from '@shared/editor';
import { itemEnd } from '@shared/editor-eval';
import type { AssetStatus } from '../../../lib/editor/playback/pool';

/**
 * Which assets matter for the picture RIGHT NOW: video / image items on visible tracks whose span touches the window
 * [t − 0.1, t + 1]. Audio-only assets are reported separately (they must not blank the picture).
 */
export function relevantAssets(
  project: Pick<Project, 'tracks'>,
  t: number,
): { visual: string[]; audio: string[] } {
  const visual = new Set<string>();
  const audio = new Set<string>();
  for (const tr of project.tracks) {
    for (const it of tr.items) {
      if (it.startSec > t + 1 || itemEnd(it) < t - 0.1) continue;
      if (it.type === 'video' || it.type === 'image') {
        if (!tr.hidden) visual.add(it.assetId);
        if (it.type === 'video' && it.audioEnabled && !tr.muted && !tr.hidden)
          audio.add(it.assetId);
      } else if (it.type === 'audio' && !tr.muted) audio.add(it.assetId);
    }
  }
  return { visual: [...visual], audio: [...audio] };
}

export interface StatusSummary {
  loading: boolean;
  /** First blocking error (visual asset) or null. */
  error: { assetId: string; reason: string | null } | null;
  /** Additional visual assets in error. */
  moreErrors: number;
  /** Audio assets in error. */
  audioErrors: { assetId: string; reason: string | null }[];
}

export function summarizeStatuses(
  rel: { visual: readonly string[]; audio: readonly string[] },
  statuses: Readonly<Record<string, AssetStatus>>,
): StatusSummary {
  const errs: { assetId: string; reason: string | null }[] = [];
  let loading = false;
  for (const id of rel.visual) {
    const st = statuses[id];
    if (!st) continue;
    if (st.state === 'error') errs.push({ assetId: id, reason: st.reason });
    else if (st.state === 'loading') loading = true;
  }
  const audioErrors: { assetId: string; reason: string | null }[] = [];
  for (const id of rel.audio) {
    const st = statuses[id];
    if (st?.state === 'error' && !rel.visual.includes(id))
      audioErrors.push({ assetId: id, reason: st.reason });
  }
  return {
    loading: loading && errs.length === 0,
    error: errs[0] ?? null,
    moreErrors: Math.max(0, errs.length - 1),
    audioErrors,
  };
}
