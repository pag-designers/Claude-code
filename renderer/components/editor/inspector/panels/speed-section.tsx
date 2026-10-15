'use client';

import * as React from 'react';
import { Snowflake } from 'lucide-react';
import type { AudioItem, Easing, Keyframe, VideoItem } from '@shared/editor';
import { sourceSpan } from '@shared/editor-eval';
import { Button } from '@/components/ui/button';
import { KeyframeEditor } from '../graph/keyframe-editor';
import { MiniSegmented, SwitchRow } from '../fields/controls';
import { NumberField } from '../fields/number-field';
import { SwitchProp } from '../fields/prop-fields';
import { Hint, Row, Section } from '../fields/section';
import { SliderField } from '../fields/slider-field';
import { useInspector } from '../context';
import { useEditorStore } from '../store';
import { localTime } from '../lib/animated';
import {
  RAMP_PRESETS,
  SPEED_MAX,
  SPEED_MIN,
  averageSpeed,
  clampSpeed,
  constantFromRamp,
  fitRampToSpan,
  formatSpeed,
  rampFromConstant,
  sameRamp,
} from '../lib/speed';

type Media = VideoItem | AudioItem;
const SPEED_CHIPS = [0.25, 0.5, 1, 1.5, 2, 4];

const fmtSec = (s: number) => `${s.toFixed(s >= 100 ? 0 : 1)} s`;

export function SpeedSection() {
  const ctx = useInspector();
  const item = ctx.primary as Media;
  const asset = ctx.assetOf(item);
  const ramp = item.speedCurve.length > 0;
  const [keepLength, setKeepLength] = React.useState(false);
  const [sel, setSel] = React.useState<number | null>(null);
  const playhead = useEditorStore((s) => s.playheadSec);
  const st = () => useEditorStore.getState();

  const span = sourceSpan(item);
  const available = typeof asset?.durationSec === 'number' ? asset.durationSec - item.inSec : null;
  const overrun = available !== null && !item.reverse && span > available + 0.05;

  const setConstant = (v: number) => {
    const sp = clampSpeed(v);
    for (const it of ctx.items) st().setSpeed(it.id, sp, { keepDuration: keepLength });
  };
  const writeRamp = (kf: Keyframe[], label: string) => ctx.set({ speedCurve: kf }, label);
  const sorted = (kf: Keyframe[]) => [...kf].sort((a, b) => a.t - b.t);
  const lt = localTime(item, playhead);

  return (
    <>
      <Section title="Speed" testId="section-speed">
        <MiniSegmented
          label="Speed mode"
          testId="speed-mode"
          value={ramp ? 'ramp' : 'constant'}
          options={[
            { value: 'constant', label: 'Constant' },
            { value: 'ramp', label: 'Speed ramp', disabled: ctx.multi },
          ]}
          onChange={(m) => {
            if (m === 'ramp' && !ramp) {
              writeRamp(rampFromConstant(item.speed, item.durationSec), 'Speed ramp');
              setSel(0);
            } else if (m === 'constant' && ramp) {
              ctx.set({ speedCurve: [], speed: constantFromRamp(item) }, 'Constant speed');
              setSel(null);
            }
          }}
        />

        {!ramp ? (
          <>
            <Row label="Speed" hint={`${fmtSec(span)} of source`}>
              <NumberField
                label="Speed"
                testId="field-speed"
                value={item.speed}
                min={SPEED_MIN}
                max={SPEED_MAX}
                step={0.05}
                decimals={2}
                unit="×"
                mixed={ctx.read((i) => (i as Media).speed).mixed}
                onChange={() => undefined}
                onCommit={setConstant}
              />
              <SliderField
                label="Speed slider"
                testId="slider-speed"
                min={Math.log2(SPEED_MIN)}
                max={Math.log2(SPEED_MAX)}
                step={0.01}
                value={Math.log2(item.speed)}
                deferred
                onCommit={(v) => setConstant(Math.round(Math.pow(2, v) * 100) / 100)}
              />
            </Row>
            <div role="group" aria-label="Speed presets" className="flex flex-wrap gap-1">
              {SPEED_CHIPS.map((v) => (
                <Button
                  key={v}
                  size="xs"
                  variant={Math.abs(item.speed - v) < 1e-6 ? 'soft' : 'secondary'}
                  className="h-6 px-2 text-2xs tabular-nums"
                  data-testid={`speed-chip-${v}`}
                  onClick={() => setConstant(v)}
                >
                  {formatSpeed(v)}
                </Button>
              ))}
            </div>
            <SwitchRow
              label="Keep clip length"
              testId="keep-length"
              checked={keepLength}
              onChange={setKeepLength}
              hint="Off: the clip gets shorter / longer so it shows the same footage"
            />
          </>
        ) : (
          <>
            <KeyframeEditor
              title="Speed ramp"
              label="Speed ramp curve"
              testId="speed-ramp-editor"
              keyframes={item.speedCurve}
              base={item.speed}
              durationSec={item.durationSec}
              floor={SPEED_MIN}
              ceil={SPEED_MAX}
              scale="log"
              guideValue={1}
              pinEnds
              minKeys={2}
              format={(v) => `${Math.round(v * 1000) / 1000}×`}
              valueFormat={{
                mul: 1,
                decimals: 2,
                unit: '×',
                step: 0.05,
                min: SPEED_MIN,
                max: SPEED_MAX,
              }}
              playheadSec={lt.inside ? lt.t : null}
              selected={sel}
              onSelect={setSel}
              onMove={(i, t, v) => {
                const next = item.speedCurve.map((k, j) =>
                  j === i ? { ...k, t, v: clampSpeed(v) } : k,
                );
                writeRamp(sorted(next), 'Edit speed ramp');
              }}
              onAdd={(t, v) => {
                const next = sorted([
                  ...item.speedCurve,
                  { t, v: clampSpeed(v), ease: 'ease-in-out' as Easing },
                ]);
                writeRamp(next, 'Add speed point');
                setSel(next.findIndex((k) => Math.abs(k.t - t) < 1e-6));
              }}
              onRemove={(i) => {
                if (item.speedCurve.length <= 2) return;
                writeRamp(
                  item.speedCurve.filter((_, j) => j !== i),
                  'Remove speed point',
                );
                setSel(null);
              }}
              onEase={(i, e) =>
                writeRamp(
                  item.speedCurve.map((k, j) => (j === i ? { ...k, ease: e } : k)),
                  'Speed easing',
                )
              }
            />
            <div role="group" aria-label="Ramp presets" className="flex flex-wrap gap-1">
              {RAMP_PRESETS.map((p) => {
                const built = fitRampToSpan(item, p.build(item.durationSec, item.speed), span);
                return (
                  <Button
                    key={p.id}
                    size="xs"
                    variant={sameRamp(item.speedCurve, built) ? 'soft' : 'secondary'}
                    className="h-6 px-2 text-2xs"
                    title={p.hint}
                    data-testid={`ramp-${p.id}`}
                    onClick={() => {
                      writeRamp(built, p.label);
                      setSel(null);
                    }}
                  >
                    {p.label}
                  </Button>
                );
              })}
            </div>
            <Hint>
              Average {formatSpeed(Math.round(averageSpeed(item) * 100) / 100)} — uses{' '}
              {fmtSec(span)} of source in {fmtSec(item.durationSec)}. Presets keep the same footage.
            </Hint>
          </>
        )}
        {overrun ? (
          <p role="alert" className="text-2xs leading-4 text-danger" data-testid="speed-overrun">
            This speed needs {fmtSec(span)} of source but only {fmtSec(available ?? 0)} remain after
            the in-point; the last frame will hold.
          </p>
        ) : null}
      </Section>
      <Section title="Playback" testId="section-playback">
        <SwitchProp
          label="Reverse"
          testId="reverse"
          get={(i) => (i as Media).reverse}
          patch={(v) => ({ reverse: v })}
        />
        {item.type === 'audio' || (item.type === 'video' && item.audioEnabled) ? (
          <SwitchProp
            label="Preserve pitch"
            testId="preserve-pitch"
            get={(i) => (i as Media).preservePitch}
            patch={(v) => ({ preservePitch: v })}
            hint="Keeps voices natural when sped up or slowed down"
          />
        ) : null}
      </Section>
      {item.type === 'video' ? <FreezeSection item={item} /> : null}
    </>
  );
}

function FreezeSection({ item }: { item: VideoItem }) {
  const ctx = useInspector();
  const playhead = useEditorStore((s) => s.playheadSec);
  const [hold, setHold] = React.useState(2);
  const lt = localTime(item, playhead);
  if (item.freezeAtSec !== null) {
    return (
      <Section title="Freeze frame" testId="section-freeze">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            Showing the still at{' '}
            <span className="tabular-nums text-foreground">{item.freezeAtSec.toFixed(2)} s</span> of
            the source.
          </span>
          <Button
            size="xs"
            variant="secondary"
            data-testid="unfreeze"
            disabled={ctx.multi}
            onClick={() => ctx.set({ freezeAtSec: null }, 'Unfreeze')}
          >
            Unfreeze
          </Button>
        </div>
      </Section>
    );
  }
  return (
    <Section title="Freeze frame" testId="section-freeze">
      <Row label="Hold for">
        <NumberField
          label="Freeze hold duration"
          testId="freeze-hold"
          value={hold}
          min={0.1}
          max={30}
          step={0.1}
          decimals={1}
          unit="s"
          onChange={setHold}
        />
        <Button
          size="xs"
          variant="secondary"
          className="ml-auto"
          data-testid="freeze-frame"
          disabled={ctx.multi || !lt.inside || lt.t < 0.04 || lt.t > item.durationSec - 0.04}
          onClick={() => useEditorStore.getState().freezeFrame(item.id, playhead, hold)}
        >
          <Snowflake aria-hidden /> Freeze at playhead
        </Button>
      </Row>
      <Hint>Splits the clip at the playhead and inserts a still between the halves.</Hint>
    </Section>
  );
}
