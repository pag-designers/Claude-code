'use client';

import type { ShapeItem, ShapeKind } from '@shared/editor';
import { shapeKindSchema } from '@shared/editor';
import { Switch } from '@/components/ui/switch';
import { ColorProp, NumberProp, SelectProp } from '../fields/prop-fields';
import { Hint, Section } from '../fields/section';
import { useInspector } from '../context';

const shape = (i: unknown) => i as ShapeItem;

const KIND_LABEL: Record<ShapeKind, string> = {
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  line: 'Line',
  arrow: 'Arrow',
  'progress-bar': 'Progress bar',
};

export function ShapeSection() {
  const ctx = useInspector();
  const kind = shape(ctx.primary).shape;
  const rounded = kind === 'rect' || kind === 'progress-bar';
  return (
    <>
      <Section title="Shape" testId="section-shape">
        <SelectProp
          label="Kind"
          testId="shape-kind"
          get={(i) => shape(i).shape}
          patch={(v) => ({ shape: v })}
          options={shapeKindSchema.options.map((k) => ({ value: k, label: KIND_LABEL[k] }))}
        />
        <NumberProp
          label="Width"
          id="width"
          get={(i) => shape(i).width}
          patch={(v) => ({ width: v })}
          min={1}
          max={8192}
          unit="px"
          slider={{ min: 1, max: ctx.project.canvas.width, step: 1 }}
        />
        <NumberProp
          label="Height"
          id="height"
          get={(i) => shape(i).height}
          patch={(v) => ({ height: v })}
          min={1}
          max={8192}
          unit="px"
          slider={{ min: 1, max: ctx.project.canvas.height / 2, step: 1 }}
        />
        {rounded ? (
          <NumberProp
            label="Corner radius"
            rowLabel="Radius"
            id="radius"
            get={(i) => shape(i).radius}
            patch={(v) => ({ radius: v })}
            min={0}
            max={500}
            unit="px"
            slider={{ min: 0, max: 100, step: 1 }}
          />
        ) : null}
        {kind === 'progress-bar' ? (
          <Hint>The bar fills left to right over the length of the clip.</Hint>
        ) : null}
      </Section>
      <Section title="Fill" testId="section-fill">
        <ColorProp
          label="Colour"
          id="fill"
          get={(i) => shape(i).fill}
          patch={(v) => ({ fill: v })}
        />
        <NumberProp
          label="Fill opacity"
          id="fillOpacity"
          get={(i) => shape(i).fillOpacity}
          patch={(v) => ({ fillOpacity: v })}
          min={0}
          max={100}
          mul={100}
          unit="%"
          slider={{ min: 0, max: 100, step: 1 }}
        />
      </Section>
      <Section
        title="Stroke"
        testId="section-shape-stroke"
        action={
          <Switch
            aria-label="Stroke enabled"
            data-testid="shape-stroke-enabled"
            checked={shape(ctx.primary).stroke !== null}
            onCheckedChange={(on) =>
              ctx.set({ stroke: on ? { color: '#000000', width: 4 } : null }, 'Stroke')
            }
          />
        }
      >
        {shape(ctx.primary).stroke ? (
          <>
            <ColorProp
              label="Stroke colour"
              rowLabel="Colour"
              id="stroke.color"
              get={(i) => shape(i).stroke?.color ?? '#000000'}
              patch={(v) => ({ stroke: { color: v } })}
            />
            <NumberProp
              label="Stroke width"
              rowLabel="Width"
              id="stroke.width"
              get={(i) => shape(i).stroke?.width ?? 0}
              patch={(v) => ({ stroke: { width: v } })}
              min={0}
              max={60}
              step={0.5}
              decimals={1}
              unit="px"
              slider={{ min: 0, max: 30, step: 0.5 }}
            />
          </>
        ) : null}
      </Section>
    </>
  );
}
