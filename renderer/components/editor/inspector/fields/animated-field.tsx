'use client';

import { RotateCcw } from 'lucide-react';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useInspector, useAnimatedValue } from '../context';
import {
  PATH_META,
  diamondState,
  fromDisplay,
  getAnimated,
  localTime,
  toDisplay,
  formatDb,
  type AnimatedPath,
} from '../lib/animated';
import { KeyframeDiamond } from './keyframe-diamond';
import { NumberField } from './number-field';
import { Row } from './section';
import { SliderField } from './slider-field';

/** Slider ranges in DISPLAY units (the number field accepts the full meta range). */
const SLIDER: Partial<Record<AnimatedPath, { min: number; max: number; step: number }>> = {
  'transform.scale': { min: 0, max: 300, step: 1 },
  'transform.rotation': { min: -180, max: 180, step: 1 },
  'transform.opacity': { min: 0, max: 100, step: 1 },
  'crop.x': { min: 0, max: 100, step: 0.5 },
  'crop.y': { min: 0, max: 100, step: 0.5 },
  'crop.w': { min: 1, max: 100, step: 0.5 },
  'crop.h': { min: 1, max: 100, step: 0.5 },
  volume: { min: 0, max: 200, step: 1 },
  blur: { min: 0, max: 100, step: 0.5 },
  'color.exposure': { min: -100, max: 100, step: 1 },
  'color.contrast': { min: -100, max: 100, step: 1 },
  'color.saturation': { min: -100, max: 100, step: 1 },
  'color.temperature': { min: -100, max: 100, step: 1 },
};

/**
 * One animatable property: label, scrubbable value (shows the animated value at the playhead), optional slider,
 * keyframe diamond and reset. Editing a keyframed property sets/updates a keyframe at the playhead (store.setProp).
 */
export function AnimatedField({
  path,
  label,
  slider = false,
  hint,
}: {
  path: AnimatedPath;
  label?: string;
  slider?: boolean;
  hint?: 'db';
}) {
  const ctx = useInspector();
  const meta = PATH_META[path];
  const { value, mixed, animated, playhead } = useAnimatedValue(path);
  const h = ctx.animated(path);
  const name = label ?? meta.label;
  if (value === null) return null;

  const single = !ctx.multi;
  const reason = !single
    ? 'Select one clip to set keyframes'
    : !localTime(ctx.primary, playhead).inside
      ? 'Move the playhead over the clip to set a keyframe'
      : undefined;
  const state = single ? diamondState(ctx.primary, path, playhead, ctx.fps) : 'none';
  const pristine =
    !animated &&
    !mixed &&
    Math.abs(value - meta.neutral) < 1e-9 &&
    !getAnimated(ctx.primary, path)?.kf.length;
  const sl = slider ? SLIDER[path] : undefined;
  const display = toDisplay(path, value);

  return (
    <Row
      label={name}
      hint={hint === 'db' && !mixed ? formatDb(value) : undefined}
      className="[&:hover_[data-reset]]:opacity-100"
    >
      <NumberField
        label={name}
        testId={`field-${path}`}
        value={display}
        mixed={mixed}
        animated={animated}
        min={toDisplay(path, meta.min)}
        max={toDisplay(path, meta.max)}
        step={meta.step}
        decimals={meta.decimals}
        unit={meta.unit}
        onChange={(v) => h.onChange(fromDisplay(path, v))}
        onCommit={(v) => h.onCommit(fromDisplay(path, v))}
      />
      {sl ? (
        <SliderField
          label={`${name} slider`}
          testId={`slider-${path}`}
          min={sl.min}
          max={sl.max}
          step={sl.step}
          value={Math.min(sl.max, Math.max(sl.min, display))}
          onChange={(v) => h.onChange(fromDisplay(path, v))}
          onCommit={(v) => h.onCommit(fromDisplay(path, v))}
        />
      ) : (
        <span className="flex-1" />
      )}
      <KeyframeDiamond
        state={state}
        label={name}
        disabledReason={reason}
        onToggle={() => ctx.toggleKeyframe(path)}
      />
      <Tip
        content={`Reset ${name.toLowerCase()}${animated ? ' (clears keyframes)' : ''}`}
        side="left"
      >
        <button
          type="button"
          data-reset
          data-testid="reset"
          aria-label={`Reset ${name}`}
          tabIndex={pristine ? -1 : 0}
          onClick={() => ctx.resetAnimated(path)}
          className={cn(
            'flex size-6 shrink-0 items-center justify-center rounded-md text-subtle outline-none transition-[opacity,background-color,color] duration-(--duration-fast)',
            'hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring',
            pristine ? 'pointer-events-none opacity-0' : 'opacity-100',
          )}
        >
          <RotateCcw className="size-3" aria-hidden />
        </button>
      </Tip>
    </Row>
  );
}
