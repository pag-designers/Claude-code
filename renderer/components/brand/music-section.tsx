'use client';

import * as React from 'react';
import type { MusicBed } from '@shared/brand';
import { bedEnvelope } from '@/lib/brand/helpers';
import { useKitSession } from '@/lib/brand/kit-session';
import { AssetPicker } from './asset-picker';
import { FieldRow, SliderRow, SwitchRow } from './controls';
import { MiniPlayer } from './mini-player';
import { Section } from './section';

const TOTAL = 12;
const SPEECH: readonly (readonly [number, number])[] = [
  [2.2, 5.4],
  [7, 9.6],
];
const W = 360;
const H = 96;

/** Illustrates fades and ducking from the actual numbers: bed level over a 12 s sample with two spoken passages. */
function BedCurve({ bed }: { bed: MusicBed }) {
  const pts = bedEnvelope(bed, TOTAL, SPEECH);
  const x = (t: number) => (t / TOTAL) * W;
  const y = (db: number) => H - 6 - ((db + 40) / 40) * (H - 14);
  const line = pts
    .map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p.db).toFixed(1)}`)
    .join(' ');
  const area = `${line} L${W} ${H} L0 ${H} Z`;
  return (
    <figure className="flex flex-col gap-1.5" data-testid="bed-curve">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Music bed level over a ${TOTAL} second sample: fade in ${bed.fadeInSec} seconds, ${
          bed.duckEnabled ? `ducks ${bed.duckAmountDb} dB under speech` : 'no ducking'
        }, fade out ${bed.fadeOutSec} seconds`}
        className="h-auto w-full overflow-visible rounded-lg border bg-muted/40"
      >
        {SPEECH.map(([a, b]) => (
          <rect
            key={a}
            x={x(a)}
            y={0}
            width={x(b) - x(a)}
            height={H}
            fill="var(--primary)"
            opacity={0.12}
          />
        ))}
        <path d={area} fill="var(--primary)" opacity={0.2} />
        <path
          d={line}
          fill="none"
          stroke="var(--primary-text)"
          strokeWidth={2}
          strokeLinejoin="round"
        />
      </svg>
      <figcaption className="flex justify-between text-2xs text-subtle">
        <span>0 s</span>
        <span className="text-primary-text">Shaded: someone is speaking</span>
        <span>{TOTAL} s</span>
      </figcaption>
    </figure>
  );
}

export function MusicSection() {
  const s = useKitSession();
  const bed = s.spec.musicBed;
  const asset = s.assetById(bed.assetId);
  const set = (patch: Partial<MusicBed>) => s.update('musicBed', (b) => ({ ...b, ...patch }));
  return (
    <Section
      id="music"
      description="A track under the clip that dips automatically while someone is speaking, with fades at both ends."
    >
      <div className="grid gap-6 @3xl:grid-cols-[minmax(0,1fr)_minmax(260px,400px)]">
        <div className="flex min-w-0 flex-col gap-4">
          <FieldRow label="Track">
            <AssetPicker
              kind="audio"
              assets={s.byKind.audio}
              value={asset ? bed.assetId : null}
              label="Music bed track"
              placeholder="Choose a music bed"
              onChange={(assetId) =>
                s.update('musicBed', (b) => ({ ...b, assetId }), { immediate: true })
              }
            />
          </FieldRow>
          <SliderRow
            label="Level"
            value={bed.gainDb}
            min={-40}
            max={0}
            step={0.5}
            decimals={1}
            unit="dB"
            hint="Level of the bed before ducking. Speech stays at full volume."
            onChange={(gainDb) => set({ gainDb })}
          />
          <SwitchRow
            label="Duck under speech"
            description="Lower the bed automatically while someone talks."
            ariaLabel="Duck under speech"
            checked={bed.duckEnabled}
            onChange={(duckEnabled) => set({ duckEnabled })}
          />
          <SliderRow
            label="Ducking amount"
            value={bed.duckAmountDb}
            min={0}
            max={30}
            step={0.5}
            decimals={1}
            unit="dB"
            disabled={!bed.duckEnabled}
            onChange={(duckAmountDb) => set({ duckAmountDb })}
          />
          <div className="grid gap-4 @xl:grid-cols-2">
            <SliderRow
              label="Fade in"
              value={bed.fadeInSec}
              min={0}
              max={5}
              step={0.1}
              decimals={1}
              unit="s"
              onChange={(fadeInSec) => set({ fadeInSec })}
            />
            <SliderRow
              label="Fade out"
              value={bed.fadeOutSec}
              min={0}
              max={8}
              step={0.1}
              decimals={1}
              unit="s"
              onChange={(fadeOutSec) => set({ fadeOutSec })}
            />
          </div>
          <SwitchRow
            label="Add the music bed to new clips"
            checked={s.spec.defaults.musicOn}
            disabled={!asset}
            description={asset ? undefined : 'Choose a track first.'}
            onChange={(v) =>
              s.update('defaults', (d) => ({ ...d, musicOn: v }), { immediate: true })
            }
          />
        </div>
        <div className="flex flex-col gap-2">
          <h3 className="font-sans text-2xs font-semibold uppercase tracking-wider text-subtle">
            Level over time
          </h3>
          <BedCurve bed={bed} />
          {asset ? (
            <div className="rounded-lg border bg-muted/30 p-3">
              <MiniPlayer
                src={asset.previewUrl}
                name={asset.name}
                durationSec={asset.durationSec}
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                You hear the loudness-normalised preview; the level below is applied on top.
              </p>
            </div>
          ) : null}
        </div>
      </div>
    </Section>
  );
}
