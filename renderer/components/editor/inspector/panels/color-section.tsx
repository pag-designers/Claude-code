'use client';

import * as React from 'react';
import { FileUp, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { colorSchema, type ImageItem, type VideoItem } from '@shared/editor';
import { FILTER_PRESETS, applyColor, resolveColor } from '@shared/editor-eval';
import { Button } from '@/components/ui/button';
import { invoke } from '@/lib/ipc';
import { cn } from '@/lib/utils';
import { AnimatedField } from '../fields/animated-field';
import { DenseSelect } from '../fields/controls';
import { NumberProp } from '../fields/prop-fields';
import { Hint, Row, Section } from '../fields/section';
import { useInspector } from '../context';
import { useEditorStore } from '../store';

type Visual = VideoItem | ImageItem;

/** Reference colours the filter swatches are graded with (sky, skin, foliage, brick, mid grey, white). */
const SAMPLE: [number, number, number][] = [
  [0.35, 0.58, 0.9],
  [0.9, 0.7, 0.58],
  [0.32, 0.62, 0.3],
  [0.78, 0.3, 0.26],
  [0.5, 0.5, 0.5],
  [0.96, 0.96, 0.94],
];

/** A strip of the sample colours run through the REAL colour maths (preset on top of the clip's own values). */
function swatchGradient(color: Visual['color'], filter: string | null): string {
  const eff = resolveColor({ ...color, filter }, 0);
  const stops = SAMPLE.map((rgb, i) => {
    const [r, g, b] = applyColor(rgb, eff).map((v) => Math.round(v * 255));
    const a = (i / SAMPLE.length) * 100;
    const z = ((i + 1) / SAMPLE.length) * 100;
    return `rgb(${r} ${g} ${b}) ${a}% ${z}%`;
  });
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

export function ColorSection() {
  const ctx = useInspector();
  const item = ctx.primary as Visual;
  const luts = ctx.project.assets.filter((a) => a.kind === 'lut');
  const lut = ctx.read((i) => (i as Visual).color.lutAssetId);
  const filter = ctx.read((i) => (i as Visual).color.filter);
  const [importing, setImporting] = React.useState(false);

  const importLut = async () => {
    if (!ctx.projectId) return;
    setImporting(true);
    try {
      const res = await invoke('editor:importAssets', { projectId: ctx.projectId, kinds: ['lut'] });
      if (res.canceled || res.assets.length === 0) return;
      useEditorStore.getState().addAssets(res.assets);
      ctx.set({ color: { lutAssetId: res.assets[0]!.id } }, 'Apply LUT');
    } catch (e) {
      toast.error('Could not import the LUT', {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setImporting(false);
    }
  };

  const neutral = colorSchema.parse({});
  const dirty = JSON.stringify(item.color) !== JSON.stringify(neutral) || ctx.multi;

  return (
    <>
      <Section
        title="Adjust"
        testId="section-adjust"
        action={
          <Button
            size="xs"
            variant="ghost"
            className="h-6 px-2 text-2xs"
            data-testid="color-reset"
            disabled={!dirty}
            onClick={() =>
              ctx.set(
                {
                  color: {
                    exposure: { v: 0, kf: [] },
                    contrast: { v: 0, kf: [] },
                    saturation: { v: 0, kf: [] },
                    temperature: { v: 0, kf: [] },
                    filter: null,
                    lutAssetId: null,
                    lutAmount: 1,
                  },
                },
                'Reset colour',
              )
            }
          >
            <RotateCcw aria-hidden /> Reset
          </Button>
        }
      >
        <AnimatedField path="color.exposure" slider />
        <AnimatedField path="color.contrast" slider />
        <AnimatedField path="color.saturation" slider />
        <AnimatedField path="color.temperature" slider />
      </Section>
      <Section title="Filters" testId="section-filters">
        <div role="radiogroup" aria-label="Filter presets" className="grid grid-cols-4 gap-1.5">
          {[
            { id: null as string | null, label: 'None' },
            ...Object.entries(FILTER_PRESETS).map(([id, p]) => ({
              id: id as string | null,
              label: p.label,
            })),
          ].map((f) => {
            const on = !filter.mixed && filter.value === f.id;
            return (
              <button
                key={f.id ?? 'none'}
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={`Filter: ${f.label}`}
                data-testid={`filter-${f.id ?? 'none'}`}
                onClick={() => ctx.set({ color: { filter: f.id } }, `Filter ${f.label}`)}
                className={cn(
                  'flex min-w-0 flex-col gap-1 rounded-md border p-1 outline-none transition-colors duration-(--duration-fast) focus-visible:ring-2 focus-visible:ring-ring',
                  on ? 'border-primary/70 bg-primary-soft' : 'border-border-strong hover:bg-accent',
                )}
              >
                <span
                  aria-hidden
                  className="h-6 w-full rounded-sm border border-border"
                  style={{ background: swatchGradient(item.color, f.id) }}
                />
                <span
                  className={cn(
                    'truncate text-center text-2xs font-medium',
                    on ? 'text-primary-text' : 'text-muted-foreground',
                  )}
                >
                  {f.label}
                </span>
              </button>
            );
          })}
        </div>
        <Hint>Presets are added on top of the adjustments above.</Hint>
      </Section>
      <Section title="LUT" testId="section-lut">
        <Row label="LUT file">
          <DenseSelect
            label="LUT"
            testId="lut-select"
            value={lut.value ?? '__none'}
            mixed={lut.mixed}
            options={[
              { value: '__none', label: 'None' },
              ...luts.map((l) => ({ value: l.id, label: l.name })),
            ]}
            onChange={(v) => ctx.set({ color: { lutAssetId: v === '__none' ? null : v } }, 'LUT')}
          />
        </Row>
        <NumberProp
          label="LUT amount"
          rowLabel="Amount"
          id="lutAmount"
          get={(i) => (i as Visual).color.lutAmount}
          patch={(v) => ({ color: { lutAmount: v } })}
          min={0}
          max={100}
          mul={100}
          unit="%"
          slider={{ min: 0, max: 100, step: 1 }}
          disabled={!lut.value && !lut.mixed}
        />
        <Button
          size="xs"
          variant="secondary"
          className="self-start"
          data-testid="lut-import"
          loading={importing}
          disabled={!ctx.projectId}
          onClick={() => void importLut()}
        >
          <FileUp aria-hidden /> Import .cube LUT…
        </Button>
      </Section>
    </>
  );
}
