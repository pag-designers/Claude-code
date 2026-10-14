'use client';

import * as React from 'react';
import type { Item } from '@shared/editor';
import { useInspector, type EditPatch } from '../context';
import { ColorInput } from './color-input';
import { DenseSelect, SwitchRow, type Option } from './controls';
import { NumberField } from './number-field';
import { Row } from './section';
import { SliderField } from './slider-field';

/** A plain (non-animated) number property bound to every selected item. Display value = stored × mul. */
export function NumberProp({
  label,
  rowLabel,
  get,
  patch,
  id,
  min,
  max,
  step = 1,
  decimals = 0,
  unit,
  mul = 1,
  slider,
  hint,
  disabled,
  deferred,
  testId,
}: {
  label: string;
  /** Row caption when it should differ from the (more descriptive) accessible label. */
  rowLabel?: string;
  get: (item: Item) => number;
  patch: (v: number) => EditPatch;
  /** Coalescing key suffix. */
  id: string;
  min: number;
  max: number;
  step?: number;
  decimals?: number;
  unit?: string;
  mul?: number;
  slider?: { min: number; max: number; step: number };
  hint?: React.ReactNode;
  disabled?: boolean;
  /** Write once per gesture (for store actions that cannot coalesce). */
  deferred?: boolean;
  testId?: string;
}) {
  const ctx = useInspector();
  const { value, mixed } = ctx.read(get);
  const h = ctx.bind<number>((v) => patch(v / mul), id, label);
  const live = deferred ? () => undefined : h.onChange;
  const commit = (v: number) => {
    if (deferred) {
      if (ctx.multi) h.onCommit(v);
      else ctx.set(patch(v / mul), label);
    } else h.onCommit(v);
  };
  return (
    <Row label={rowLabel ?? label} hint={hint}>
      <NumberField
        label={label}
        testId={testId ?? `field-${id}`}
        value={value * mul}
        mixed={mixed}
        disabled={disabled}
        min={min}
        max={max}
        step={step}
        decimals={decimals}
        unit={unit}
        onChange={live}
        onCommit={commit}
      />
      {slider ? (
        <SliderField
          label={`${label} slider`}
          testId={`slider-${id}`}
          min={slider.min}
          max={slider.max}
          step={slider.step}
          deferred={deferred}
          disabled={disabled}
          value={Math.min(slider.max, Math.max(slider.min, value * mul))}
          onChange={live}
          onCommit={commit}
        />
      ) : null}
    </Row>
  );
}

export function SwitchProp({
  label,
  get,
  patch,
  hint,
  disabledReason,
  testId,
}: {
  label: string;
  get: (item: Item) => boolean;
  patch: (v: boolean) => EditPatch;
  hint?: React.ReactNode;
  disabledReason?: string;
  testId?: string;
}) {
  const ctx = useInspector();
  const { value, mixed } = ctx.read(get);
  return (
    <SwitchRow
      label={label}
      hint={hint}
      checked={value}
      mixed={mixed}
      disabledReason={disabledReason}
      testId={testId}
      onChange={(v) => ctx.set(patch(v), label)}
    />
  );
}

export function SelectProp<T extends string>({
  label,
  rowLabel,
  get,
  patch,
  options,
  testId,
}: {
  label: string;
  rowLabel?: string;
  get: (item: Item) => T;
  patch: (v: T) => EditPatch;
  options: Option<T>[];
  testId?: string;
}) {
  const ctx = useInspector();
  const { value, mixed } = ctx.read(get);
  return (
    <Row label={rowLabel ?? label}>
      <DenseSelect
        label={label}
        testId={testId}
        value={value}
        mixed={mixed}
        options={options}
        onChange={(v) => ctx.set(patch(v), label)}
      />
    </Row>
  );
}

export function ColorProp({
  label,
  rowLabel,
  get,
  patch,
  id,
}: {
  label: string;
  rowLabel?: string;
  get: (item: Item) => string;
  patch: (hex: string) => EditPatch;
  id: string;
}) {
  const ctx = useInspector();
  const { value, mixed } = ctx.read(get);
  const h = ctx.bind<string>(patch, id, label);
  return (
    <Row label={rowLabel ?? label}>
      <ColorInput
        label={label}
        value={mixed ? '#808080' : value}
        onChange={h.onChange}
        onCommit={h.onCommit}
      />
    </Row>
  );
}
