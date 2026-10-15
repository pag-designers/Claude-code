'use client';

import { ASPECT_SIZES, SAFE_AREAS, type AspectId } from '@shared/editor';
import { Switch } from '@/components/ui/switch';
import { ColorInput } from '../fields/color-input';
import { DenseSelect, MiniSegmented } from '../fields/controls';
import { NumberField } from '../fields/number-field';
import { Hint, Row, Section } from '../fields/section';
import { useEditorStore } from '../store';

const ASPECTS: AspectId[] = ['9:16', '1:1', '16:9', '4:5', 'custom'];
const FPS = ['24', '25', '30', '50', '60'] as const;

/** Project settings shown when nothing is selected: canvas, frame rate, background, guides. */
export function ProjectSettings() {
  const canvas = useEditorStore((s) => s.project.canvas);
  const safeArea = useEditorStore((s) => s.safeArea);
  const showGrid = useEditorStore((s) => s.showGrid);
  const st = () => useEditorStore.getState();
  const custom = canvas.aspect === 'custom';
  const setAspect = (a: AspectId) => {
    if (a === 'custom') st().setCanvas({ aspect: 'custom' });
    else st().setCanvas({ aspect: a, ...ASPECT_SIZES[a] });
  };
  return (
    <>
      <Section title="Canvas" testId="section-canvas">
        <Row label="Aspect">
          <MiniSegmented<AspectId>
            label="Canvas aspect"
            testId="canvas-aspect"
            className="flex-1"
            value={canvas.aspect}
            options={ASPECTS.map((a) => ({ value: a, label: a === 'custom' ? 'Custom' : a }))}
            onChange={setAspect}
          />
        </Row>
        <Row label="Size">
          <NumberField
            label="Canvas width"
            testId="canvas-width"
            value={canvas.width}
            min={64}
            max={4096}
            unit="px"
            disabled={!custom}
            onChange={() => undefined}
            onCommit={(v) => st().setCanvas({ width: Math.round(v) })}
          />
          <span className="text-xs text-subtle" aria-hidden>
            ×
          </span>
          <NumberField
            label="Canvas height"
            testId="canvas-height"
            value={canvas.height}
            min={64}
            max={4096}
            unit="px"
            disabled={!custom}
            onChange={() => undefined}
            onCommit={(v) => st().setCanvas({ height: Math.round(v) })}
          />
        </Row>
        {!custom ? <Hint>Pick “Custom” to type your own size.</Hint> : null}
        <Row label="Frame rate">
          <DenseSelect
            label="Frame rate"
            testId="canvas-fps"
            value={String(canvas.fps) as (typeof FPS)[number]}
            options={FPS.map((f) => ({ value: f, label: `${f} fps` }))}
            onChange={(v) => st().setCanvas({ fps: Number(v) as 24 | 25 | 30 | 50 | 60 })}
          />
        </Row>
        <Row label="Background">
          <ColorInput
            label="Canvas background"
            value={canvas.background}
            onChange={() => undefined}
            onCommit={(hex) => st().setCanvas({ background: hex })}
          />
        </Row>
      </Section>
      <Section title="Guides" testId="section-guides">
        <Row label="Safe area">
          <DenseSelect
            label="Safe-area guide"
            testId="safe-area"
            value={safeArea ?? '__off'}
            options={[
              { value: '__off', label: 'Off' },
              ...Object.entries(SAFE_AREAS).map(([id, a]) => ({ value: id, label: a.label })),
            ]}
            onChange={(v) => st().setSafeArea(v === '__off' ? null : v)}
          />
        </Row>
        <div className="flex min-h-7 items-center justify-between gap-2">
          <label htmlFor="grid-toggle" className="text-xs text-muted-foreground">
            Show grid
          </label>
          <Switch
            id="grid-toggle"
            data-testid="show-grid"
            checked={showGrid}
            onCheckedChange={() => st().toggleGrid()}
          />
        </div>
      </Section>
    </>
  );
}
