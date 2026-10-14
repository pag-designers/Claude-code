'use client';

import { RotateCw } from 'lucide-react';
import type { ImageItem, VideoItem } from '@shared/editor';
import { resolveCrop } from '@shared/editor-eval';
import { Button } from '@/components/ui/button';
import { AnimatedField } from '../fields/animated-field';
import { MiniSegmented } from '../fields/controls';
import { SwitchProp } from '../fields/prop-fields';
import { Hint, Row, Section } from '../fields/section';
import { useAnimatedValue, useInspector } from '../context';
import { localTime } from '../lib/animated';
import { aspectCropRect } from '../lib/retime';
import { useEditorStore } from '../store';

type Visual = VideoItem | ImageItem;

const FIT_OPTIONS = [
  { value: 'cover', label: 'Cover', title: 'Fill the canvas, cropping the overflow' },
  { value: 'contain', label: 'Contain', title: 'Fit the whole picture inside the canvas' },
  { value: 'native', label: 'Native', title: 'Source pixels 1:1' },
] as const;

/** Fit, mirror, rotate 90°, background blur fill and the Blur effect. */
export function FitSection() {
  const ctx = useInspector();
  const fit = ctx.read((i) => (i as Visual).fit);
  const rot = useAnimatedValue('transform.rotation');
  const rotH = ctx.animated('transform.rotation');
  return (
    <Section title="Fit & effects" testId="section-fit">
      <Row label="Fit">
        <MiniSegmented
          label="Fit"
          testId="fit"
          value={fit.mixed ? null : fit.value}
          options={FIT_OPTIONS.map((o) => ({ ...o }))}
          onChange={(v) => ctx.set({ fit: v }, 'Fit')}
          className="flex-1"
        />
      </Row>
      <SwitchProp
        label="Background blur fill"
        testId="bg-blur"
        get={(i) => (i as Visual).backgroundBlur}
        patch={(v) => ({ backgroundBlur: v })}
        hint="Fills empty canvas with a blurred copy"
        disabledReason={
          !fit.mixed && fit.value !== 'contain' ? 'Only applies with Fit: Contain' : undefined
        }
      />
      <SwitchProp
        label="Mirror"
        testId="mirror"
        get={(i) => (i as Visual).mirror}
        patch={(v) => ({ mirror: v })}
      />
      <Row label="Rotate">
        <Button
          size="xs"
          variant="secondary"
          data-testid="rotate-90"
          onClick={() => {
            const v = (rot.value ?? 0) + 90;
            rotH.onChange(v);
            rotH.onCommit(v);
          }}
        >
          <RotateCw aria-hidden /> Rotate 90°
        </Button>
      </Row>
      <AnimatedField path="blur" slider />
    </Section>
  );
}

const CROP_PRESETS = [
  { id: 'full', label: 'Full' },
  { id: '9:16', label: '9:16', ratio: 9 / 16 },
  { id: '4:5', label: '4:5', ratio: 4 / 5 },
  { id: '1:1', label: '1:1', ratio: 1 },
  { id: '16:9', label: '16:9', ratio: 16 / 9 },
  { id: 'canvas', label: 'Canvas' },
] as const;

/** Crop (animatable) with aspect-locked presets. A preset replaces the crop animation (keyframes cleared). */
export function CropSection() {
  const ctx = useInspector();
  const playhead = useEditorStore((s) => s.playheadSec);
  const item = ctx.primary as Visual;
  const asset = ctx.assetOf(item);
  const srcW = asset?.width ?? 1920;
  const srcH = asset?.height ?? 1080;
  const apply = (id: (typeof CROP_PRESETS)[number]['id']) => {
    const cur = resolveCrop(item.crop, localTime(item, playhead).t);
    const centre = { cx: cur.x + cur.w / 2, cy: cur.y + cur.h / 2 };
    const preset = CROP_PRESETS.find((p) => p.id === id);
    let r = { x: 0, y: 0, w: 1, h: 1 };
    if (id === 'canvas')
      r = aspectCropRect(srcW, srcH, ctx.project.canvas.width / ctx.project.canvas.height, centre);
    else if (preset && 'ratio' in preset) r = aspectCropRect(srcW, srcH, preset.ratio, centre);
    const one = (v: number) => ({ v, kf: [] });
    ctx.set(
      { crop: { x: one(r.x), y: one(r.y), w: one(r.w), h: one(r.h) } },
      `Crop ${preset?.label ?? ''}`.trim(),
    );
  };
  return (
    <Section title="Crop" testId="section-crop" defaultOpen={false}>
      <div role="group" aria-label="Crop presets" className="flex flex-wrap gap-1">
        {CROP_PRESETS.map((p) => (
          <Button
            key={p.id}
            size="xs"
            variant="secondary"
            className="h-6 px-2 text-2xs"
            data-testid={`crop-preset-${p.id}`}
            onClick={() => apply(p.id)}
          >
            {p.label}
          </Button>
        ))}
      </div>
      <AnimatedField path="crop.x" slider />
      <AnimatedField path="crop.y" slider />
      <AnimatedField path="crop.w" slider />
      <AnimatedField path="crop.h" slider />
      <Hint>Presets keep the aspect ratio of the source frame and replace the crop animation.</Hint>
    </Section>
  );
}
