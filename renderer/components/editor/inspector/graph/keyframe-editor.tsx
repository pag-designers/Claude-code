'use client';

import * as React from 'react';
import { ChevronLeft, ChevronRight, Plus, Trash2, X } from 'lucide-react';
import type { Easing, Keyframe } from '@shared/editor';
import { interpolate } from '@shared/editor-eval';
import { Button } from '@/components/ui/button';
import { IconButton, MiniSegmented } from '../fields/controls';
import { NumberField } from '../fields/number-field';
import { Row } from '../fields/section';
import { easingChoice, type EasingChoice } from '../lib/bezier';
import { BezierEditor } from './bezier-editor';
import { KeyframeGraph, type KeyframeGraphProps } from './keyframe-graph';

export interface KeyframeEditorProps extends Pick<
  KeyframeGraphProps,
  | 'keyframes'
  | 'base'
  | 'durationSec'
  | 'floor'
  | 'ceil'
  | 'scale'
  | 'minSpan'
  | 'guideValue'
  | 'pinEnds'
  | 'label'
> {
  title: string;
  /** Axis label for a value (default: stored × mul, rounded). */
  format?: (v: number) => string;
  /** Item-local playhead (null when it is not over the item). */
  playheadSec: number | null;
  selected: number | null;
  onSelect: (i: number | null) => void;
  /** Shown/typed value = stored × mul. */
  valueFormat: {
    mul: number;
    decimals: number;
    unit: string;
    step: number;
    min: number;
    max: number;
  };
  onMove: (i: number, t: number, v: number) => void;
  onAdd: (t: number, v: number) => void;
  onRemove: (i: number) => void;
  onEase: (i: number, e: Easing) => void;
  onClear?: () => void;
  onClose?: () => void;
  /** Delete is disabled at or below this many keyframes (speed ramps keep two). */
  minKeys?: number;
  testId?: string;
}

const EASE_OPTIONS: { value: EasingChoice; label: string; title: string }[] = [
  { value: 'linear', label: 'Linear', title: 'Constant rate' },
  { value: 'ease-in', label: 'In', title: 'Ease in' },
  { value: 'ease-out', label: 'Out', title: 'Ease out' },
  { value: 'ease-in-out', label: 'In-out', title: 'Ease in and out' },
  { value: 'hold', label: 'Hold', title: 'Hold the value until the next keyframe' },
  { value: 'bezier', label: 'Bezier', title: 'Custom cubic bezier' },
];

/** Graph + selected-keyframe details (time, value, easing to the next keyframe, bezier editor). Store-agnostic. */
export function KeyframeEditor(p: KeyframeEditorProps) {
  const { keyframes: kf, selected, valueFormat: vf } = p;
  const sel = selected !== null && selected < kf.length ? selected : null;
  const k = sel !== null ? (kf[sel] as Keyframe) : null;
  const isLast = sel !== null && sel === kf.length - 1;
  const pinned = !!p.pinEnds && sel !== null && (sel === 0 || isLast);
  // the bezier is edited on a local draft and written once per gesture (setKeyframeEase cannot coalesce)
  const [draft, setDraft] = React.useState<{ index: number; ease: Easing } | null>(null);
  const shownEase: Easing | null = k ? (draft && draft.index === sel ? draft.ease : k.ease) : null;
  const choice = shownEase ? easingChoice(shownEase) : null;
  const [showBezier, setShowBezier] = React.useState(false);
  const bezierOpen = choice === 'bezier' || showBezier;

  const fmtAxis = (v: number) => {
    const d = v * vf.mul;
    return String(Math.abs(d) >= 100 ? Math.round(d) : Math.round(d * 10) / 10);
  };

  return (
    <div className="flex flex-col gap-2" data-testid={p.testId ?? 'keyframe-editor'}>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium text-foreground">{p.title}</span>
        <div className="flex items-center gap-0.5">
          <IconButton
            label="Previous keyframe"
            disabled={kf.length === 0 || sel === 0}
            onClick={() => p.onSelect(sel === null ? kf.length - 1 : Math.max(0, sel - 1))}
            testId="kf-prev"
          >
            <ChevronLeft />
          </IconButton>
          <span className="min-w-8 text-center text-2xs tabular-nums text-subtle">
            {sel !== null ? `${sel + 1}/${kf.length}` : `${kf.length} kf`}
          </span>
          <IconButton
            label="Next keyframe"
            disabled={kf.length === 0 || isLast}
            onClick={() => p.onSelect(sel === null ? 0 : Math.min(kf.length - 1, sel + 1))}
            testId="kf-next"
          >
            <ChevronRight />
          </IconButton>
          {p.onClose ? (
            <IconButton label="Close keyframe editor" onClick={p.onClose} testId="kf-close">
              <X />
            </IconButton>
          ) : null}
        </div>
      </div>

      <KeyframeGraph
        keyframes={kf}
        base={p.base}
        durationSec={p.durationSec}
        floor={p.floor}
        ceil={p.ceil}
        scale={p.scale}
        minSpan={p.minSpan}
        guideValue={p.guideValue}
        pinEnds={p.pinEnds}
        format={p.format ?? fmtAxis}
        playheadSec={p.playheadSec}
        selected={sel}
        onSelect={p.onSelect}
        onMove={p.onMove}
        onAdd={p.onAdd}
        onRemove={p.onRemove}
        label={p.label}
        testId="keyframe-graph"
      />

      {k && sel !== null ? (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Row label="Time" className="grid-cols-[2.25rem_minmax(0,1fr)]">
              <NumberField
                label="Keyframe time"
                testId="kf-time"
                value={k.t}
                min={0}
                max={p.durationSec}
                step={0.01}
                decimals={2}
                unit="s"
                disabled={pinned}
                className="w-full"
                onChange={() => undefined}
                onCommit={(t) => p.onMove(sel, t, k.v)}
              />
            </Row>
            <Row label="Value" className="grid-cols-[2.25rem_minmax(0,1fr)]">
              <NumberField
                label="Keyframe value"
                testId="kf-value"
                value={k.v * vf.mul}
                min={vf.min * vf.mul}
                max={vf.max * vf.mul}
                step={vf.step}
                decimals={vf.decimals}
                unit={vf.unit}
                className="w-full"
                onChange={() => undefined}
                onCommit={(v) => p.onMove(sel, k.t, v / vf.mul)}
              />
            </Row>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-2xs text-subtle">
              {isLast ? 'Last keyframe: easing unused' : 'Easing to next keyframe'}
            </span>
            <MiniSegmented
              label="Easing to next keyframe"
              testId="kf-ease"
              value={choice}
              options={EASE_OPTIONS.map((o) => ({ ...o, disabled: isLast }))}
              onChange={(c) => {
                if (c === 'bezier') {
                  setShowBezier(true);
                  const e: Easing = { type: 'bezier', x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 };
                  p.onEase(sel, e);
                } else {
                  setShowBezier(false);
                  p.onEase(sel, c);
                }
              }}
            />
            {bezierOpen && !isLast && shownEase && shownEase !== 'hold' ? (
              <div className="pt-1">
                <BezierEditor
                  value={shownEase}
                  onChange={(e) => setDraft({ index: sel, ease: e })}
                  onCommit={(e) => {
                    p.onEase(sel, e);
                    setDraft(null);
                  }}
                />
              </div>
            ) : null}
          </div>
        </>
      ) : (
        <p className="text-2xs leading-4 text-subtle">
          Click a keyframe to edit it. Double-click the graph to add one; drag a point to change its
          time and value.
        </p>
      )}

      <div className="flex items-center gap-1.5">
        <Button
          size="xs"
          variant="secondary"
          data-testid="kf-add"
          disabled={p.playheadSec === null}
          onClick={() => {
            if (p.playheadSec !== null)
              p.onAdd(p.playheadSec, interpolate(kf, p.playheadSec, p.base));
          }}
        >
          <Plus aria-hidden /> Add at playhead
        </Button>
        <Button
          size="xs"
          variant="danger-ghost"
          data-testid="kf-delete"
          disabled={sel === null || kf.length <= (p.minKeys ?? 0)}
          onClick={() => {
            if (sel !== null) p.onRemove(sel);
          }}
        >
          <Trash2 aria-hidden /> Delete
        </Button>
        {p.onClear ? (
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto"
            data-testid="kf-clear"
            onClick={p.onClear}
          >
            Clear all
          </Button>
        ) : null}
      </div>
    </div>
  );
}
