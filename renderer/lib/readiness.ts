'use client';

import { useMemo } from 'react';
import { settingsHref } from './nav';
import { useBinaries, useCost, useSidecarStatus, useStorageUsage } from './queries';
import { useSecrets } from './settings';

export interface Blocker {
  id: 'anthropic' | 'storage' | 'ffmpeg' | 'ytdlp' | 'engine' | 'budget';
  message: string;
  href: string;
  action: string;
}

/**
 * What the pipeline needs, read from real state: Anthropic key, connected storage, ffmpeg/ffprobe, yt-dlp and the
 * transcription engine (BRIEF §4). `loading` is true until every source has answered, so the UI never flashes a false
 * "not configured" while queries are in flight.
 */
export function usePipelineReadiness() {
  const secrets = useSecrets();
  const storage = useStorageUsage();
  const bins = useBinaries();
  const sidecar = useSidecarStatus();
  const cost = useCost();

  return useMemo(() => {
    const loading = secrets.loading || storage.isPending || bins.isPending || sidecar.isPending;
    const blockers: Blocker[] = [];
    if (!loading) {
      if (!secrets.keys?.['anthropic.apiKey']?.set)
        blockers.push({
          id: 'anthropic',
          message: 'Add your Anthropic API key. Claude finds, scores and titles the moments.',
          href: settingsHref('api-keys'),
          action: 'Add key',
        });
      if (!storage.data?.configured)
        blockers.push({
          id: 'storage',
          message:
            'Connect cloud storage (Cloudflare R2 or Backblaze B2). Clips and the 480p proxy are kept there, not on your disk.',
          href: settingsHref('storage'),
          action: 'Connect',
        });
      else if (storage.data.error)
        blockers.push({
          id: 'storage',
          message: `Your cloud storage connection has a problem: ${storage.data.error}`,
          href: settingsHref('storage'),
          action: 'Fix storage',
        });
      const tools = bins.data?.tools ?? [];
      const bad = (n: string) => !tools.find((t) => t.name.toLowerCase() === n)?.ok;
      if (bad('ffmpeg') || bad('ffprobe'))
        blockers.push({
          id: 'ffmpeg',
          message: 'ffmpeg is not working, so clips cannot be cut or rendered.',
          href: settingsHref('diagnostics'),
          action: 'Diagnose',
        });
      if (bad('yt-dlp'))
        blockers.push({
          id: 'ytdlp',
          message: 'yt-dlp has not been downloaded yet, so videos cannot be fetched.',
          href: settingsHref('diagnostics'),
          action: 'Diagnose',
        });
      const sc = sidecar.data;
      if (!sc?.installed || !sc.modelReady) {
        const installing = sc && !['idle', 'stopped', 'error', 'ready'].includes(sc.phase);
        blockers.push({
          id: 'engine',
          message: installing
            ? `The transcription engine is still installing (${sc.message || sc.phase}).`
            : sc?.phase === 'error'
              ? `The transcription engine failed to install: ${sc.error ?? 'see Compute settings'}.`
              : 'Install the transcription engine (one-time download). Whisper runs locally and is free.',
          href: settingsHref('compute'),
          action: installing ? 'View progress' : 'Set up',
        });
      }
      if (cost.data?.level === 'hard-cap')
        blockers.push({
          id: 'budget',
          message: `The monthly AI hard cap ($${cost.data.hardCapUsd.toFixed(0)}) is reached, so Claude calls are paused.`,
          href: settingsHref('models'),
          action: 'Open budget',
        });
    }
    return { loading, blockers, ready: !loading && blockers.length === 0 };
  }, [
    secrets.loading,
    secrets.keys,
    storage.isPending,
    storage.data,
    bins.isPending,
    bins.data,
    sidecar.isPending,
    sidecar.data,
    cost.data,
  ]);
}
