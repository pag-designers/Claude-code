'use client';

import * as React from 'react';
import { Activity, AudioLines, Info, Music, Plus, Search } from 'lucide-react';
import { toast } from 'sonner';
import type { Asset } from '@shared/editor';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DisabledTip, Tip } from '@/components/ui/tooltip';
import { formatClock } from '@/lib/format';
import { invoke, IpcCallError, useIpcQuery } from '@/lib/ipc';
import { useEditorStore } from '@/lib/editor/core';
import { startAssetDrag } from '@/lib/editor-panels/drag';
import { estimateBpm } from '@/lib/editor-panels/edit-targets';
import { addAssetToTimeline } from './actions';
import { BrandAudioSection } from './brand-audio';
import { GroupLabel, Note } from './bits';
import { ImportButton } from './import-button';

/** Mirrored mini waveform from `editor:waveform` peaks (downsampled to a fixed number of bars). */
function MiniWave({ asset }: { asset: Asset }) {
  const projectId = useEditorStore((s) => s.projectId);
  const q = useIpcQuery(
    'editor:waveform',
    { projectId: projectId ?? '', assetId: asset.id },
    { enabled: !!projectId, staleTime: 10 * 60_000, retry: false },
  );
  const bars = 36;
  const peaks = q.data?.peaks;
  const heights = React.useMemo(() => {
    if (!peaks || peaks.length === 0) return null;
    const out: number[] = [];
    for (let i = 0; i < bars; i++) {
      const a = Math.floor((i / bars) * peaks.length);
      const b = Math.max(a + 1, Math.floor(((i + 1) / bars) * peaks.length));
      let m = 0;
      for (let k = a; k < b; k++) m = Math.max(m, peaks[k] ?? 0);
      out.push(m);
    }
    return out;
  }, [peaks]);
  if (!heights) return <span className="h-7 w-full rounded-md bg-muted" aria-hidden />;
  return (
    <svg
      viewBox={`0 0 ${bars * 3} 28`}
      className="h-7 w-full text-primary-text"
      aria-hidden
      preserveAspectRatio="none"
    >
      {heights.map((h, i) => {
        const bh = Math.max(2, h * 26);
        return (
          <rect
            key={i}
            x={i * 3}
            y={14 - bh / 2}
            width={2}
            height={bh}
            rx={1}
            fill="currentColor"
            opacity={0.85}
          />
        );
      })}
    </svg>
  );
}

function AudioRow({ asset }: { asset: Asset }) {
  const projectId = useEditorStore((s) => s.projectId);
  const [busy, setBusy] = React.useState(false);
  const bpm = estimateBpm(asset.beats);

  const detect = async () => {
    if (!projectId || busy) return;
    setBusy(true);
    try {
      const r = await invoke('editor:beats', { projectId, assetId: asset.id });
      useEditorStore.getState().updateAsset(asset.id, { beats: r.beats });
      if (r.beats.length === 0)
        toast.info('No clear beat found', {
          description: 'This track may be ambient or speech. You can still cut by ear.',
        });
      else
        toast.success(`Found ${r.beats.length} beats`, {
          description: 'They now act as snap points on the timeline.',
        });
    } catch (e) {
      toast.error('Beat detection failed', {
        description: e instanceof IpcCallError ? e.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <li
      draggable
      onDragStart={(e) => startAssetDrag(e.dataTransfer, asset.id, asset.name)}
      onDoubleClick={() => addAssetToTimeline(asset.id)}
      data-testid="bin-audio-row"
      data-asset-id={asset.id}
      className="group flex cursor-grab flex-col gap-1.5 rounded-lg border bg-card p-2.5 transition-colors duration-(--duration-fast) hover:border-border-strong hover:bg-accent/40 active:cursor-grabbing"
    >
      <div className="flex items-center gap-2">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary-soft text-primary-text">
          <Music className="size-3.5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium" title={asset.name}>
            {asset.name}
          </p>
          <p className="flex items-center gap-1.5 text-2xs tabular-nums text-subtle">
            {asset.durationSec !== null ? formatClock(asset.durationSec) : '—'}
            {bpm ? (
              <Badge variant="primary" data-testid="bin-audio-bpm" className="h-4 px-1.5">
                {bpm} BPM
              </Badge>
            ) : asset.beats && asset.beats.length === 0 ? (
              <span>no beat found</span>
            ) : null}
          </p>
        </div>
        <Tip content="Add at playhead">
          <Button
            variant="soft"
            size="icon-xs"
            aria-label={`Add ${asset.name} to the timeline`}
            data-testid="bin-audio-add"
            onClick={() => addAssetToTimeline(asset.id)}
          >
            <Plus />
          </Button>
        </Tip>
      </div>
      <MiniWave asset={asset} />
      <div className="flex items-center justify-between gap-2">
        <span className="text-2xs text-subtle">
          {asset.beats
            ? asset.beats.length > 0
              ? `${asset.beats.length} beats detected`
              : 'No beats detected'
            : 'Beats not detected yet'}
        </span>
        <Button
          variant="ghost"
          size="xs"
          loading={busy}
          disabled={!projectId}
          onClick={() => void detect()}
          data-testid="bin-audio-detect"
          className="h-6 px-2"
        >
          <Activity /> {asset.beats ? 'Re-detect' : 'Detect beats'}
        </Button>
      </div>
    </li>
  );
}

export function AudioTab() {
  const assets = useEditorStore((s) => s.project.assets);
  const audio = React.useMemo(() => assets.filter((a) => a.kind === 'audio'), [assets]);
  return (
    <div className="flex flex-col gap-5" data-testid="bin-audio">
      <section className="flex flex-col gap-2.5" aria-label="Project audio">
        <GroupLabel
          action={
            <ImportButton
              kinds={['audio']}
              noun="audio"
              label="Upload audio"
              size="xs"
              data-testid="bin-audio-import"
            />
          }
        >
          Project audio
        </GroupLabel>
        {audio.length === 0 ? (
          <Note icon={AudioLines} title="No music or sound yet">
            Upload an MP3, WAV, AAC or M4A. It lands on a music track and can duck under speech.
          </Note>
        ) : (
          <ul className="flex flex-col gap-2" aria-label="Project audio files">
            {audio.map((a) => (
              <AudioRow key={a.id} asset={a} />
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2.5" aria-label="Music search">
        <GroupLabel>Free music</GroupLabel>
        <DisabledTip
          reason="Pixabay has no official music API, so music comes from your own files"
          className="w-full"
        >
          <Input
            disabled
            readOnly
            placeholder="Search Pixabay or Pexels music"
            aria-label="Search free music (unavailable)"
            leading={<Search />}
            className="h-8"
            data-testid="bin-music-search"
          />
        </DisabledTip>
        <p className="flex items-start gap-1.5 text-2xs leading-4 text-subtle">
          <Info className="mt-px size-3 shrink-0" aria-hidden />
          Clipfern only uses official APIs, so there is no in-app music search. Upload tracks you
          have the rights to, or keep them in your Brand Kit and use them from Brand Kit audio.
        </p>
      </section>

      <BrandAudioSection />

      <section
        className="flex flex-col gap-2 rounded-xl border bg-muted/40 p-3"
        aria-label="Beat sync"
      >
        <p className="flex items-center gap-2 text-xs font-semibold">
          <Activity className="size-3.5 text-primary-text" aria-hidden /> Beat sync
        </p>
        <p className="text-xs leading-4 text-muted-foreground">
          Run <strong className="font-semibold text-foreground">Detect beats</strong> on a track.
          The beats become snap points on the timeline (keep Snap on), so cuts and text land on the
          rhythm.
        </p>
      </section>
    </div>
  );
}
