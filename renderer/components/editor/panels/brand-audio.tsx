'use client';

import * as React from 'react';
import { Pause, Play, Plus, Volume2, Waves } from 'lucide-react';
import { toast } from 'sonner';
import type { BrandAssetView } from '@shared/brand';
import { brandProjectAssetId } from '@shared/brand-apply';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { formatClock } from '@/lib/format';
import { groupBrandAssets } from '@/lib/editor-panels/brand';
import { useBrandPanelKit } from '@/lib/editor-panels/brand-hooks';
import { startAssetDrag } from '@/lib/editor-panels/drag';
import { addBrandClip, ensureBrandAsset, setAsMusicBed } from './brand-actions';
import { BrandSection } from './brand-bits';

/* One shared <audio> so only a single audition plays at a time. */
let audio: HTMLAudioElement | null = null;
let playingId: string | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function toggleAudition(id: string, url: string): void {
  if (typeof Audio === 'undefined') return;
  if (!audio) {
    audio = new Audio();
    audio.preload = 'none';
    audio.addEventListener('ended', () => {
      playingId = null;
      emit();
    });
    audio.addEventListener('error', () => {
      if (playingId !== null) toast.error('That preview could not be played');
      playingId = null;
      emit();
    });
  }
  if (playingId === id) {
    audio.pause();
    playingId = null;
  } else {
    audio.src = url;
    playingId = id;
    void audio.play().catch(() => {
      playingId = null;
      emit();
    });
  }
  emit();
}

function stopAudition(): void {
  audio?.pause();
  playingId = null;
  emit();
}

function useAuditionState(id: string): boolean {
  return React.useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => playingId === id,
    () => false,
  );
}

function BrandAudioRow({
  asset,
  role,
  onMusicBed,
}: {
  asset: BrandAssetView;
  role: 'music' | null;
  onMusicBed: (a: BrandAssetView) => void;
}) {
  const playing = useAuditionState(asset.id);
  // the loudness-normalised copy is what you hear; without one (still processing) the original plays
  const url = asset.previewUrl ?? asset.url;
  return (
    <li
      draggable
      onDragStart={(e) => {
        const a = ensureBrandAsset(asset, { defer: true });
        startAssetDrag(e.dataTransfer, a.id, a.name);
      }}
      onDoubleClick={() => addBrandClip(asset)}
      data-testid="bin-brand-audio"
      data-asset-id={asset.id}
      data-project-asset-id={brandProjectAssetId(asset.id)}
      className="group flex cursor-grab flex-col gap-1.5 rounded-lg border bg-card p-2.5 transition-colors duration-(--duration-fast) hover:border-border-strong hover:bg-accent/40 active:cursor-grabbing"
    >
      <div className="flex items-center gap-2">
        <Tip
          content={
            playing ? 'Stop' : url ? 'Listen (loudness-normalised preview)' : 'No preview yet'
          }
        >
          <Button
            variant={playing ? 'primary' : 'soft'}
            size="icon-sm"
            aria-label={playing ? `Stop ${asset.name}` : `Listen to ${asset.name}`}
            aria-pressed={playing}
            disabled={!url}
            data-testid="bin-brand-audition"
            onClick={() => url && toggleAudition(asset.id, url)}
          >
            {playing ? <Pause /> : <Play />}
          </Button>
        </Tip>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium" title={asset.name}>
            {asset.name}
          </p>
          <p className="whitespace-nowrap text-2xs tabular-nums text-subtle">
            {asset.durationSec !== null ? formatClock(asset.durationSec) : '—'}
            {asset.loudnessLufs !== null ? ` · ${Math.round(asset.loudnessLufs)} LUFS` : ''}
          </p>
          {role ? (
            <p
              className="text-2xs font-medium text-primary-text"
              data-testid="bin-brand-audio-role"
            >
              The kit&apos;s music bed
            </p>
          ) : null}
        </div>
        <Tip content="Add at playhead">
          <Button
            variant="soft"
            size="icon-xs"
            aria-label={`Add ${asset.name} to the timeline`}
            data-testid="bin-brand-audio-add"
            onClick={() => {
              if (addBrandClip(asset)) toast.success(`${asset.name} added at the playhead`);
            }}
          >
            <Plus />
          </Button>
        </Tip>
      </div>
      <Button
        variant="ghost"
        size="xs"
        className="h-6 w-fit px-2"
        data-testid="bin-brand-music-bed"
        onClick={() => onMusicBed(asset)}
      >
        <Waves /> Add as music with ducking
      </Button>
    </li>
  );
}

/** Audio tab: the kit's music beds, SFX and stingers, with a normalised audition and one-click music bed. */
export function BrandAudioSection() {
  const panel = useBrandPanelKit();
  const audioAssets = React.useMemo(() => groupBrandAssets(panel.assets).audio, [panel.assets]);
  React.useEffect(() => stopAudition, []);
  const musicBed = (a: BrandAssetView) => {
    if (!panel.kit) return;
    const r = setAsMusicBed(panel.kit, panel.assets, a);
    if (r.ok) toast.success('Music bed added', { description: r.detail });
    else toast.error('Could not add the music bed', { description: r.reason });
  };
  return (
    <BrandSection
      title="Brand Kit audio"
      testId="bin-brandkit-audio"
      panel={panel}
      isEmpty={audioAssets.length === 0}
      emptyTitle="No audio in this kit"
      emptyHint="Music beds, sound effects and stingers from the kit show up here."
    >
      <ul className="flex flex-col gap-2" aria-label="Brand Kit audio files">
        {audioAssets.map((a) => (
          <BrandAudioRow
            key={a.id}
            asset={a}
            role={panel.kit?.spec.musicBed.assetId === a.id ? 'music' : null}
            onMusicBed={musicBed}
          />
        ))}
      </ul>
      <p className="flex items-start gap-1.5 text-2xs leading-4 text-subtle">
        <Volume2 className="mt-px size-3 shrink-0" aria-hidden />
        Listen plays a loudness-normalised copy. “Add as music with ducking” loops or trims the
        track to the project, fades it with the kit&apos;s settings and lowers it under speech.
      </p>
    </BrandSection>
  );
}
