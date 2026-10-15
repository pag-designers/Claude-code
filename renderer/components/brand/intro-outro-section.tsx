'use client';

import * as React from 'react';
import { Film, Play } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatDur } from '@/lib/brand/helpers';
import { useKitSession } from '@/lib/brand/kit-session';
import { AssetPicker } from './asset-picker';
import { SwitchRow } from './controls';
import { Section } from './section';

function Slot({ which }: { which: 'intro' | 'outro' }) {
  const s = useKitSession();
  const key = which === 'intro' ? 'introAssetId' : 'outroAssetId';
  const onKey = which === 'intro' ? 'introOn' : 'outroOn';
  const id = s.spec[key];
  const asset = s.assetById(id);
  const [playing, setPlaying] = React.useState(false);
  const Word = which === 'intro' ? 'Intro' : 'Outro';
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid={`slot-${which}`}>
      <h3 className="font-sans text-sm font-semibold">{Word}</h3>
      <div
        className={cn(
          'relative aspect-video w-full overflow-hidden rounded-lg border bg-black',
          !asset && 'border-dashed border-border-strong',
        )}
      >
        {asset ? (
          <>
            {playing && asset.previewUrl ? (
              <video
                src={asset.previewUrl}
                autoPlay
                controls
                playsInline
                aria-label={`${Word} preview`}
                onEnded={() => setPlaying(false)}
                className="size-full bg-black object-contain"
              />
            ) : (
              <>
                {asset.thumbUrl ? (
                  <img
                    src={asset.thumbUrl}
                    alt=""
                    className="size-full object-contain"
                    draggable={false}
                  />
                ) : (
                  <div className="flex size-full items-center justify-center text-subtle">
                    <Film className="size-6" aria-hidden />
                  </div>
                )}
                {asset.previewUrl ? (
                  <button
                    type="button"
                    aria-label={`Play ${which} preview`}
                    onClick={() => setPlaying(true)}
                    className="absolute left-1/2 top-1/2 flex size-10 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-card/90 text-foreground shadow-md backdrop-blur-sm transition-transform duration-(--duration-fast) hover:scale-105 active:scale-95"
                  >
                    <Play className="size-4" fill="currentColor" aria-hidden />
                  </button>
                ) : null}
                <span className="absolute bottom-2 right-2 rounded-sm bg-card/90 px-1.5 py-0.5 font-mono text-2xs tabular-nums shadow-xs">
                  {formatDur(asset.durationSec)}
                </span>
              </>
            )}
          </>
        ) : (
          <div className="flex size-full flex-col items-center justify-center gap-1 text-center text-sm text-muted-foreground">
            <Film className="size-5 text-subtle" aria-hidden />
            No {which} chosen
          </div>
        )}
      </div>
      <AssetPicker
        kind="video"
        assets={s.byKind.video}
        value={asset ? id : null}
        label={`${Word} video`}
        placeholder={`Choose an ${which === 'intro' ? 'intro' : 'outro'} video`}
        onChange={(v) => {
          setPlaying(false);
          s.edit({ [key]: v } as Record<string, string | null>, { immediate: true });
        }}
      />
      {asset?.durationSec ? (
        <p className="-mt-1 text-xs text-muted-foreground">
          Adds {asset.durationSec.toFixed(1)} s {which === 'intro' ? 'before' : 'after'} the clip.
        </p>
      ) : null}
      <SwitchRow
        label={`Add the ${which} to new clips`}
        checked={s.spec.defaults[onKey]}
        disabled={!asset}
        description={asset ? undefined : `Choose a video first.`}
        onChange={(v) => s.update('defaults', (d) => ({ ...d, [onKey]: v }), { immediate: true })}
      />
    </div>
  );
}

export function IntroOutroSection() {
  return (
    <Section
      id="intro-outro"
      description="Short videos from this kit played before and after the clip. Switch them on per project or by default."
    >
      <div className="grid gap-6 @2xl:grid-cols-2">
        <Slot which="intro" />
        <Slot which="outro" />
      </div>
    </Section>
  );
}
