'use client';

import * as React from 'react';
import { AudioLines, Scissors } from 'lucide-react';
import type { AudioItem, VideoItem } from '@shared/editor';
import { Button } from '@/components/ui/button';
import { invoke } from '@/lib/ipc';
import { AnimatedField } from '../fields/animated-field';
import { SwitchRow } from '../fields/controls';
import { NumberField } from '../fields/number-field';
import { SwitchProp } from '../fields/prop-fields';
import { Hint, Notice, Row, Section } from '../fields/section';
import { useInspector } from '../context';
import { useEditorStore } from '../store';
import { FadesFields } from './transform-section';
import { beatCutTimes, timelineBeats } from '../lib/retime';

type Media = VideoItem | AudioItem;

/** Volume (animatable, dB read-out), fades, audio on/off and noise gate. */
export function AudioSection() {
  const ctx = useInspector();
  const item = ctx.primary as Media;
  const hasAudio = item.type === 'audio' || ctx.assetOf(item)?.hasAudio !== false;
  return (
    <>
      <Section title="Volume" testId="section-volume">
        {item.type === 'video' ? (
          <SwitchProp
            label="Use clip audio"
            testId="audio-enabled"
            get={(i) => (i as VideoItem).audioEnabled}
            patch={(v) => ({ audioEnabled: v })}
            hint={hasAudio ? undefined : 'This clip has no audio track'}
          />
        ) : null}
        <AnimatedField path="volume" slider hint="db" />
        <FadesFields />
        <SwitchProp
          label="Noise gate"
          testId="noise-gate"
          get={(i) => (i as Media).noiseGate}
          patch={(v) => ({ noiseGate: v })}
          hint="Applied on export"
        />
      </Section>
    </>
  );
}

const bpm = (beats: readonly number[]): number | null => {
  if (beats.length < 4) return null;
  const d = beats
    .slice(1)
    .map((b, i) => b - (beats[i] as number))
    .sort((a, b) => a - b);
  const med = d[Math.floor(d.length / 2)] as number;
  return med > 0 ? Math.round(60 / med) : null;
};

/** Beat detection, "snap to beats" and the cut-to-beats helper. */
export function BeatsSection() {
  const ctx = useInspector();
  const item = ctx.primary as Media;
  const snap = useEditorStore((s) => s.snapEnabled);
  const playhead = useEditorStore((s) => s.playheadSec);
  const asset = ctx.assetOf(item);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [count, setCount] = React.useState(4);
  const beats = React.useMemo(() => timelineBeats(ctx.project), [ctx.project]);
  const cuts = beatCutTimes(item, beats, playhead, count);

  const detect = async () => {
    if (!ctx.projectId || !asset) return;
    setBusy(true);
    setError(null);
    try {
      const res = await invoke('editor:beats', { projectId: ctx.projectId, assetId: asset.id });
      useEditorStore.getState().updateAsset(asset.id, { beats: res.beats });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const cutToBeats = () => {
    // cut from the LAST beat backwards: the left half keeps this item's id, so each split targets the same clip
    const s = useEditorStore.getState();
    for (const t of [...cuts].reverse()) s.split(item.id, t);
  };

  return (
    <Section title="Beats" testId="section-beats">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground" data-testid="beats-status">
          {asset?.beats
            ? `${asset.beats.length} beats${bpm(asset.beats) ? ` · ~${bpm(asset.beats)} BPM` : ''}`
            : 'Beats not detected yet'}
        </span>
        <Button
          size="xs"
          variant="secondary"
          data-testid="detect-beats"
          loading={busy}
          disabled={!asset || !ctx.projectId || ctx.multi}
          onClick={() => void detect()}
        >
          <AudioLines aria-hidden /> {asset?.beats ? 'Re-detect' : 'Detect beats'}
        </Button>
      </div>
      {error ? (
        <Notice
          tone="danger"
          title="Beat detection failed"
          testId="beats-error"
          action={
            <Button size="xs" variant="secondary" onClick={() => void detect()}>
              Retry
            </Button>
          }
        >
          {error}
        </Notice>
      ) : null}
      <SwitchRow
        label="Snap cuts to beats"
        testId="snap-beats"
        checked={snap}
        onChange={() => useEditorStore.getState().toggleSnap()}
        hint="Edits snap to detected beats (the timeline's Snap switch)"
      />
      <Row
        label="Cut to beats"
        hint={cuts.length ? `${cuts.length} cut${cuts.length === 1 ? '' : 's'} ready` : undefined}
      >
        <NumberField
          label="Number of beats to cut"
          testId="cut-beats-count"
          value={count}
          min={1}
          max={32}
          step={1}
          decimals={0}
          onChange={setCount}
        />
        <Button
          size="xs"
          variant="secondary"
          className="ml-auto"
          data-testid="cut-to-beats"
          disabled={ctx.multi || cuts.length === 0}
          onClick={cutToBeats}
        >
          <Scissors aria-hidden /> Cut next {count}
        </Button>
      </Row>
      <Hint>
        {beats.length === 0
          ? 'Detect beats on a music clip, then split this clip at the next beats after the playhead.'
          : 'Splits the selected clip at the next beats after the playhead.'}
      </Hint>
    </Section>
  );
}
