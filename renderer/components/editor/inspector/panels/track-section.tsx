'use client';

import type { Track } from '@shared/editor';
import { Switch } from '@/components/ui/switch';
import { useEditorStore } from '../store';
import { SwitchRow } from '../fields/controls';
import { NumberField } from '../fields/number-field';
import { Hint, Row, Section } from '../fields/section';
import { SliderField } from '../fields/slider-field';
import { dbToGain, formatDb } from '../lib/animated';

const AUDIO_KINDS = new Set(['audio', 'sfx']);

/**
 * Track-level audio: gain, mute, "this track carries speech", and auto-ducking under speech.
 * Store actions here (updateTrack) cannot coalesce, so sliders write once on release.
 */
export function TrackSection({ track }: { track: Track }) {
  const st = () => useEditorStore.getState();
  const patch = (p: Parameters<ReturnType<typeof st>['updateTrack']>[1]) =>
    st().updateTrack(track.id, p);
  const d = track.ducking;
  const setDuck = (p: Partial<Track['ducking']>) => patch({ ducking: { ...d, ...p } });
  const audioTrack = AUDIO_KINDS.has(track.kind);
  const hasAudio = audioTrack || track.kind === 'video' || track.kind === 'overlay';
  return (
    <>
      <Section title={`Track · ${track.name}`} testId="section-track">
        {hasAudio ? (
          <Row label="Gain" hint={formatDb(track.gain)}>
            <NumberField
              label="Track gain"
              testId="track-gain"
              value={track.gain * 100}
              min={0}
              max={400}
              step={1}
              unit="%"
              onChange={() => undefined}
              onCommit={(v) => patch({ gain: v / 100 })}
            />
            <SliderField
              label="Track gain slider"
              testId="track-gain-slider"
              min={0}
              max={200}
              step={1}
              value={Math.min(200, track.gain * 100)}
              deferred
              onCommit={(v) => patch({ gain: v / 100 })}
            />
          </Row>
        ) : null}
        <SwitchRow
          label="Muted"
          testId="track-muted"
          checked={track.muted}
          onChange={(v) => patch({ muted: v })}
        />
        <SwitchRow
          label="Hidden"
          testId="track-hidden"
          checked={track.hidden}
          onChange={(v) => patch({ hidden: v })}
        />
        <SwitchRow
          label="Locked"
          testId="track-locked"
          checked={track.locked}
          onChange={(v) => patch({ locked: v })}
        />
        {hasAudio ? (
          <SwitchRow
            label="Carries speech"
            testId="track-speech"
            hint="Music on ducked tracks dips under this track"
            checked={track.speech}
            onChange={(v) => patch({ speech: v })}
          />
        ) : null}
      </Section>
      {audioTrack ? (
        <Section title="Auto-ducking" testId="section-ducking">
          <div className="flex min-h-7 items-center justify-between gap-2">
            <label htmlFor={`duck-${track.id}`} className="text-xs text-muted-foreground">
              Duck under speech
            </label>
            <Switch
              id={`duck-${track.id}`}
              data-testid="duck-enabled"
              checked={d.enabled}
              onCheckedChange={(v) => setDuck({ enabled: v })}
            />
          </div>
          <Row
            label="Reduction"
            hint={`−${d.reductionDb.toFixed(1)} dB (×${dbToGain(-d.reductionDb).toFixed(2)})`}
          >
            <NumberField
              label="Ducking reduction"
              testId="duck-reduction"
              value={d.reductionDb}
              min={0}
              max={40}
              step={0.5}
              decimals={1}
              unit="dB"
              disabled={!d.enabled}
              onChange={() => undefined}
              onCommit={(v) => setDuck({ reductionDb: v })}
            />
            <SliderField
              label="Ducking reduction slider"
              min={0}
              max={40}
              step={0.5}
              value={d.reductionDb}
              disabled={!d.enabled}
              deferred
              onCommit={(v) => setDuck({ reductionDb: v })}
            />
          </Row>
          <Row label="Attack">
            <NumberField
              label="Ducking attack"
              testId="duck-attack"
              value={d.attackSec}
              min={0}
              max={2}
              step={0.01}
              decimals={2}
              unit="s"
              disabled={!d.enabled}
              onChange={() => undefined}
              onCommit={(v) => setDuck({ attackSec: v })}
            />
            <SliderField
              label="Ducking attack slider"
              min={0}
              max={2}
              step={0.01}
              value={d.attackSec}
              disabled={!d.enabled}
              deferred
              onCommit={(v) => setDuck({ attackSec: v })}
            />
          </Row>
          <Row label="Release">
            <NumberField
              label="Ducking release"
              testId="duck-release"
              value={d.releaseSec}
              min={0}
              max={5}
              step={0.05}
              decimals={2}
              unit="s"
              disabled={!d.enabled}
              onChange={() => undefined}
              onCommit={(v) => setDuck({ releaseSec: v })}
            />
            <SliderField
              label="Ducking release slider"
              min={0}
              max={5}
              step={0.05}
              value={d.releaseSec}
              disabled={!d.enabled}
              deferred
              onCommit={(v) => setDuck({ releaseSec: v })}
            />
          </Row>
          <Hint>
            Speech = the words of your subtitle track. Without subtitles, the sound of clips on
            tracks marked “Carries speech” is used. The music fades down just before speech starts
            and recovers after it ends.
          </Hint>
        </Section>
      ) : null}
    </>
  );
}
