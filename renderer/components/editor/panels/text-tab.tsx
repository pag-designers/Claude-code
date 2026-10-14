'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { useEditorStore } from '@/lib/editor/core';
import {
  TEXT_ANIMATIONS,
  TEXT_PRESETS,
  animationPreset,
  textPatch,
  type TextPresetDef,
} from '@/lib/editor-panels/presets';
import { cn } from '@/lib/utils';
import { addText } from './actions';
import { GroupLabel, tileBase } from './bits';

/** Scale of the in-tile preview: a tile is ~130 px wide and stands for a 1080 px canvas. */
const PREVIEW_SCALE = 0.125;

function previewStyle(preset: TextPresetDef): React.CSSProperties {
  // CSS twin of the saved style (the editor's compositor draws the real thing)
  const p = textPatch(preset, { width: 1080, height: 1920 });
  const s = p.style;
  const px = Math.max(9, Math.round((s.size ?? 72) * PREVIEW_SCALE));
  const css: React.CSSProperties = {
    fontFamily: `'${s.fontFamily ?? 'Montserrat'}', var(--font-sans)`,
    fontWeight: s.weight ?? 800,
    fontStyle: s.italic ? 'italic' : 'normal',
    fontSize: px,
    lineHeight: s.lineHeight ?? 1.15,
    color: s.color ?? 'var(--swatch-white)',
    textAlign: s.align ?? 'center',
    whiteSpace: 'pre-line',
  };
  if (s.stroke) {
    css.WebkitTextStroke = `${Math.max(1, Math.round(s.stroke.width * PREVIEW_SCALE))}px ${s.stroke.color}`;
    css.paintOrder = 'stroke fill';
  }
  if (s.shadow)
    css.textShadow = `0 ${Math.round(s.shadow.offsetY * PREVIEW_SCALE)}px ${Math.round(s.shadow.blur * PREVIEW_SCALE)}px rgb(0 0 0 / ${s.shadow.opacity})`;
  if (s.box) {
    css.background = `rgb(0 0 0 / ${s.box.opacity})`;
    css.padding = `${Math.round(s.box.padding * PREVIEW_SCALE)}px`;
    css.borderRadius = Math.round(s.box.radius * PREVIEW_SCALE);
  }
  return css;
}

function TextTile({ preset, animated }: { preset: TextPresetDef; animated?: boolean }) {
  const anim = preset.animIn?.type;
  return (
    <li className="min-w-0">
      <button
        type="button"
        onClick={() => {
          addText(preset);
          toast.success(`${preset.label} added at the playhead`);
        }}
        aria-label={`Add ${preset.label} text at the playhead`}
        data-testid="bin-text-preset"
        data-preset={preset.id}
        className={cn(tileBase, 'ed-play w-full')}
      >
        <span className="flex aspect-[16/10] w-full items-center justify-center overflow-hidden rounded-md bg-black px-2">
          <span
            style={previewStyle(preset)}
            className={cn('max-w-full', animated ? 'ta' : undefined)}
            data-a={anim}
          >
            {preset.text}
          </span>
        </span>
        <span className="px-0.5">
          <span className="block truncate text-xs font-medium">{preset.label}</span>
          <span className="block truncate text-2xs text-subtle">{preset.hint}</span>
        </span>
      </button>
    </li>
  );
}

const ANIMATION_PRESETS = TEXT_ANIMATIONS.map(animationPreset);

export function TextTab() {
  const hasProject = useEditorStore((s) => s.projectId !== null);
  return (
    <div className="flex flex-col gap-5" data-testid="bin-text" data-ready={hasProject}>
      <section className="flex flex-col gap-2.5" aria-label="Text styles">
        <GroupLabel>Text styles</GroupLabel>
        <ul className="grid grid-cols-2 gap-2">
          {TEXT_PRESETS.map((p) => (
            <TextTile key={p.id} preset={p} />
          ))}
        </ul>
      </section>
      <section className="flex flex-col gap-2.5" aria-label="Text animations">
        <GroupLabel>Animated in</GroupLabel>
        <ul className="grid grid-cols-2 gap-2">
          {ANIMATION_PRESETS.map((p) => (
            <TextTile key={p.id} preset={p} animated />
          ))}
        </ul>
        <p className="text-2xs leading-4 text-subtle">
          Hover a tile to preview. Click to drop it at the playhead; change the animation or style
          in the inspector.
        </p>
      </section>
    </div>
  );
}
