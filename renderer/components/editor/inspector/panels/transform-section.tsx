'use client';

import { blendModeSchema, type Item } from '@shared/editor';
import { cn } from '@/lib/utils';
import { AnimatedField } from '../fields/animated-field';
import { Hint, Section } from '../fields/section';
import { NumberProp, SelectProp } from '../fields/prop-fields';
import { useInspector } from '../context';
import { useEditorStore } from '../store';
import { PATH_META, getAnimated, type AnimatedPath } from '../lib/animated';

/** Position, scale, rotation, opacity — every one scrubbable, sliderable and keyframable. */
export function TransformSection() {
  return (
    <Section title="Transform" testId="section-transform">
      <AnimatedField path="transform.x" />
      <AnimatedField path="transform.y" />
      <AnimatedField path="transform.scale" slider />
      <AnimatedField path="transform.rotation" slider />
      <AnimatedField path="transform.opacity" slider />
    </Section>
  );
}

const BLEND_LABEL: Record<string, string> = {
  normal: 'Normal',
  multiply: 'Multiply',
  screen: 'Screen',
  overlay: 'Overlay',
  add: 'Add (linear dodge)',
  darken: 'Darken',
  lighten: 'Lighten',
};

export function BlendSelect() {
  return (
    <SelectProp
      label="Blend mode"
      testId="blend-mode"
      get={(i) => ('blend' in i ? i.blend : 'normal')}
      patch={(v) => ({ blend: v })}
      options={blendModeSchema.options.map((m) => ({ value: m, label: BLEND_LABEL[m] ?? m }))}
    />
  );
}

/** Visual fade in / out (picture alpha; for clips with sound the same fades apply to the audio — shared fields). */
export function FadesFields() {
  const ctx = useInspector();
  const max = Math.max(0.1, ctx.primary.durationSec);
  return (
    <>
      <NumberProp
        label="Fade in"
        id="fadeInSec"
        get={(i) => ('fadeInSec' in i ? i.fadeInSec : 0)}
        patch={(v) => ({ fadeInSec: v })}
        min={0}
        max={max}
        step={0.1}
        decimals={2}
        unit="s"
        slider={{ min: 0, max: Math.min(max, 5), step: 0.05 }}
      />
      <NumberProp
        label="Fade out"
        id="fadeOutSec"
        get={(i) => ('fadeOutSec' in i ? i.fadeOutSec : 0)}
        patch={(v) => ({ fadeOutSec: v })}
        min={0}
        max={max}
        step={0.1}
        decimals={2}
        unit="s"
        slider={{ min: 0, max: Math.min(max, 5), step: 0.05 }}
      />
    </>
  );
}

/** Chips for every animated property of the clip; clicking one opens its curve in the keyframe editor. */
export function KeyframesSummary() {
  const ctx = useInspector();
  const sel = useEditorStore((s) => s.selection.keyframe);
  if (ctx.multi) return null;
  const item: Item = ctx.primary;
  const animated = (Object.keys(PATH_META) as AnimatedPath[]).filter(
    (p) => (getAnimated(item, p)?.kf.length ?? 0) > 0,
  );
  return (
    <Section title="Keyframes" testId="section-keyframes">
      {animated.length === 0 ? (
        <Hint>
          Nothing is animated yet. Click the diamond next to a value to add a keyframe at the
          playhead, then change the value somewhere else on the clip.
        </Hint>
      ) : (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Animated properties">
          {animated.map((p) => {
            const on = sel?.itemId === item.id && sel.prop === p;
            return (
              <button
                key={p}
                type="button"
                data-testid={`kf-chip-${p}`}
                aria-pressed={on}
                onClick={() =>
                  useEditorStore.getState().selectKeyframe({ itemId: item.id, prop: p, index: 0 })
                }
                className={cn(
                  'inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-2xs font-medium outline-none transition-colors duration-(--duration-fast) focus-visible:ring-2 focus-visible:ring-ring',
                  on
                    ? 'border-primary/70 bg-primary-soft text-primary-text'
                    : 'border-border-strong text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                {PATH_META[p].label}
                <span className="tabular-nums text-subtle">{getAnimated(item, p)?.kf.length}</span>
              </button>
            );
          })}
        </div>
      )}
    </Section>
  );
}
