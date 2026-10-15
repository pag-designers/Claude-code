'use client';

import * as React from 'react';
import { AlignCenter, AlignLeft, AlignRight, Play, Smile } from 'lucide-react';
import type { TextItem } from '@shared/editor';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useBrandFonts } from '@/lib/brand/fonts';
import { BrandStyleChip } from './brand-style-chip';
import { FontSelect, fontChoices } from '../fields/font-select';
import { COMMON_EMOJI } from '../lib/emoji';
import { DenseSelect, MiniSegmented, SwitchRow } from '../fields/controls';
import { ColorProp, NumberProp, SelectProp, SwitchProp } from '../fields/prop-fields';
import { Hint, Row, Section } from '../fields/section';
import { useInspector } from '../context';
import { useEditorStore } from '../store';

const text = (i: unknown) => i as TextItem;

/** Content textarea with an emoji picker. */
export function TextContentSection() {
  const ctx = useInspector();
  const item = text(ctx.primary);
  const ref = React.useRef<HTMLTextAreaElement>(null);
  const [open, setOpen] = React.useState(false);
  const mixed = ctx.read((i) => text(i).text).mixed;
  const h = ctx.bind<string>((v) => ({ text: v }), 'text', 'Edit text');

  const insert = (emoji: string) => {
    const el = ref.current;
    const at = el?.selectionStart ?? item.text.length;
    const end = el?.selectionEnd ?? at;
    const next = item.text.slice(0, at) + emoji + item.text.slice(end);
    h.onChange(next);
    h.onCommit(next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + emoji.length, at + emoji.length);
    });
  };

  return (
    <Section title="Content" testId="section-text-content">
      <textarea
        ref={ref}
        aria-label="Text content"
        data-testid="text-content"
        rows={3}
        value={mixed ? '' : item.text}
        placeholder={mixed ? 'Mixed text' : 'Type your text'}
        disabled={ctx.multi}
        onChange={(e) => h.onChange(e.target.value)}
        className="w-full resize-y rounded-md border border-input bg-field px-2 py-1.5 text-sm leading-5 text-foreground shadow-[inset_0_1px_2px_rgb(0_0_0/0.12)] outline-none transition-[border-color,box-shadow] duration-(--duration-fast) placeholder:text-subtle hover:border-border-strong focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 disabled:opacity-50"
      />
      <div className="flex items-center justify-between gap-2">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button size="xs" variant="secondary" data-testid="emoji-button" disabled={ctx.multi}>
              <Smile aria-hidden /> Emoji
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-60 p-2"
            data-testid="emoji-grid"
            onEscapeKeyDown={(e) => e.stopPropagation()}
          >
            <div role="group" aria-label="Emoji" className="grid grid-cols-8 gap-0.5">
              {COMMON_EMOJI.map((e) => (
                <button
                  key={e}
                  type="button"
                  aria-label={`Insert ${e}`}
                  onClick={() => insert(e)}
                  className="flex size-7 items-center justify-center rounded-md text-base outline-none transition-colors duration-(--duration-fast) hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {e}
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
        <BrandStyleChip />
      </div>
    </Section>
  );
}

export function FontSection() {
  const ctx = useInspector();
  const { fonts: brandFonts } = useBrandFonts();
  const family = ctx.read((i) => text(i).style.fontFamily);
  const choices = fontChoices(brandFonts, family.mixed ? undefined : family.value);
  const known = choices.find((c) => c.family === family.value)?.weights ?? [];
  const weights = known.length ? known : [400, 700, 800];
  const align = ctx.read((i) => text(i).style.align);
  return (
    <Section title="Font" testId="section-font">
      <Row label="Family">
        <FontSelect
          value={family.value}
          mixed={family.mixed}
          onChange={(v, choice) => {
            const cur = text(ctx.primary).style.weight;
            // snap the weight to one the family ships / was uploaded with, so the preview and export pick the same face
            const w = choice?.weights.length
              ? choice.weights.reduce((a, b) => (Math.abs(b - cur) < Math.abs(a - cur) ? b : a))
              : cur;
            ctx.set({ style: { fontFamily: v, weight: w } }, 'Font family');
          }}
        />
      </Row>
      <Row label="Weight">
        <DenseSelect
          label="Font weight"
          testId="font-weight"
          value={String(text(ctx.primary).style.weight)}
          mixed={ctx.read((i) => text(i).style.weight).mixed}
          options={[...new Set([...weights, text(ctx.primary).style.weight])]
            .sort((x, y) => x - y)
            .map((w) => ({ value: String(w), label: String(w) }))}
          onChange={(v) => ctx.set({ style: { weight: Number(v) } }, 'Font weight')}
        />
      </Row>
      <SwitchProp
        label="Italic"
        testId="font-italic"
        get={(i) => text(i).style.italic}
        patch={(v) => ({ style: { italic: v } })}
      />
      <NumberProp
        label="Size"
        id="style.size"
        get={(i) => text(i).style.size}
        patch={(v) => ({ style: { size: v } })}
        min={8}
        max={600}
        unit="px"
        slider={{ min: 8, max: 300, step: 1 }}
      />
      <ColorProp
        label="Colour"
        id="style.color"
        get={(i) => text(i).style.color}
        patch={(v) => ({ style: { color: v } })}
      />
      <Row label="Align">
        <MiniSegmented
          label="Text alignment"
          testId="text-align"
          value={align.mixed ? null : align.value}
          className="flex-1"
          options={[
            { value: 'left', label: <AlignLeft aria-label="Left" />, title: 'Align left' },
            { value: 'center', label: <AlignCenter aria-label="Centre" />, title: 'Centre' },
            { value: 'right', label: <AlignRight aria-label="Right" />, title: 'Align right' },
          ]}
          onChange={(v) => ctx.set({ style: { align: v } }, 'Text alignment')}
        />
      </Row>
      <NumberProp
        label="Letter spacing"
        rowLabel="Spacing"
        id="style.letterSpacing"
        get={(i) => text(i).style.letterSpacing}
        patch={(v) => ({ style: { letterSpacing: v } })}
        min={-20}
        max={80}
        step={0.5}
        decimals={1}
        unit="px"
        slider={{ min: -10, max: 40, step: 0.5 }}
      />
      <NumberProp
        label="Line height"
        id="style.lineHeight"
        get={(i) => text(i).style.lineHeight}
        patch={(v) => ({ style: { lineHeight: v } })}
        min={0.6}
        max={3}
        step={0.05}
        decimals={2}
        unit="×"
        slider={{ min: 0.6, max: 2.5, step: 0.05 }}
      />
      <MaxWidthRow />
    </Section>
  );
}

function MaxWidthRow() {
  const ctx = useInspector();
  const mw = ctx.read((i) => text(i).style.maxWidth);
  const auto = mw.value === null;
  return (
    <>
      <SwitchRow
        label="Wrap to canvas"
        hint="Off: wrap at a fixed width"
        testId="wrap-auto"
        checked={auto}
        mixed={mw.mixed}
        onChange={(on) =>
          ctx.set(
            { style: { maxWidth: on ? null : Math.round(ctx.project.canvas.width * 0.8) } },
            'Wrap width',
          )
        }
      />
      {!auto ? (
        <NumberProp
          label="Max width"
          id="style.maxWidth"
          get={(i) => text(i).style.maxWidth ?? ctx.project.canvas.width}
          patch={(v) => ({ style: { maxWidth: v } })}
          min={40}
          max={ctx.project.canvas.width * 2}
          unit="px"
          slider={{ min: 40, max: ctx.project.canvas.width, step: 1 }}
        />
      ) : null}
    </>
  );
}

/** A switchable optional sub-style (stroke / shadow / box): the header switch writes defaults (on) or null (off). */
function OptionalStyle({
  title,
  field,
  defaults,
  children,
}: {
  title: string;
  field: 'stroke' | 'shadow' | 'box';
  defaults: Record<string, unknown>;
  children: React.ReactNode;
}) {
  const ctx = useInspector();
  const cur = ctx.read((i) => text(i).style[field] !== null);
  return (
    <Section
      title={title}
      testId={`section-${field}`}
      action={
        <Switch
          aria-label={`${title} enabled`}
          data-testid={`${field}-enabled`}
          checked={cur.value}
          className={cn(cur.mixed && 'opacity-60')}
          onCheckedChange={(on) =>
            ctx.set({ style: { [field]: on ? defaults : null } }, `${title} ${on ? 'on' : 'off'}`)
          }
        />
      }
    >
      {cur.value ? children : null}
    </Section>
  );
}

export function StyleSections() {
  return (
    <>
      <OptionalStyle title="Stroke" field="stroke" defaults={{ color: '#000000', width: 4 }}>
        <ColorProp
          label="Stroke colour"
          rowLabel="Colour"
          id="style.stroke.color"
          get={(i) => text(i).style.stroke?.color ?? '#000000'}
          patch={(v) => ({ style: { stroke: { color: v } } })}
        />
        <NumberProp
          label="Stroke width"
          rowLabel="Width"
          id="style.stroke.width"
          get={(i) => text(i).style.stroke?.width ?? 0}
          patch={(v) => ({ style: { stroke: { width: v } } })}
          min={0}
          max={40}
          step={0.5}
          decimals={1}
          unit="px"
          slider={{ min: 0, max: 20, step: 0.5 }}
        />
      </OptionalStyle>
      <OptionalStyle
        title="Shadow"
        field="shadow"
        defaults={{ color: '#000000', opacity: 0.5, blur: 8, offsetX: 0, offsetY: 4 }}
      >
        <ColorProp
          label="Shadow colour"
          rowLabel="Colour"
          id="style.shadow.color"
          get={(i) => text(i).style.shadow?.color ?? '#000000'}
          patch={(v) => ({ style: { shadow: { color: v } } })}
        />
        <NumberProp
          label="Shadow opacity"
          rowLabel="Opacity"
          id="style.shadow.opacity"
          get={(i) => text(i).style.shadow?.opacity ?? 0}
          patch={(v) => ({ style: { shadow: { opacity: v } } })}
          min={0}
          max={100}
          mul={100}
          unit="%"
          slider={{ min: 0, max: 100, step: 1 }}
        />
        <NumberProp
          label="Shadow blur"
          rowLabel="Blur"
          id="style.shadow.blur"
          get={(i) => text(i).style.shadow?.blur ?? 0}
          patch={(v) => ({ style: { shadow: { blur: v } } })}
          min={0}
          max={60}
          unit="px"
          slider={{ min: 0, max: 40, step: 1 }}
        />
        <NumberProp
          label="Shadow offset X"
          rowLabel="Offset X"
          id="style.shadow.offsetX"
          get={(i) => text(i).style.shadow?.offsetX ?? 0}
          patch={(v) => ({ style: { shadow: { offsetX: v } } })}
          min={-60}
          max={60}
          unit="px"
        />
        <NumberProp
          label="Shadow offset Y"
          rowLabel="Offset Y"
          id="style.shadow.offsetY"
          get={(i) => text(i).style.shadow?.offsetY ?? 0}
          patch={(v) => ({ style: { shadow: { offsetY: v } } })}
          min={-60}
          max={60}
          unit="px"
        />
      </OptionalStyle>
      <OptionalStyle
        title="Background box"
        field="box"
        defaults={{ color: '#000000', opacity: 0.6, padding: 16, radius: 12 }}
      >
        <ColorProp
          label="Box colour"
          rowLabel="Colour"
          id="style.box.color"
          get={(i) => text(i).style.box?.color ?? '#000000'}
          patch={(v) => ({ style: { box: { color: v } } })}
        />
        <NumberProp
          label="Box opacity"
          rowLabel="Opacity"
          id="style.box.opacity"
          get={(i) => text(i).style.box?.opacity ?? 0}
          patch={(v) => ({ style: { box: { opacity: v } } })}
          min={0}
          max={100}
          mul={100}
          unit="%"
          slider={{ min: 0, max: 100, step: 1 }}
        />
        <NumberProp
          label="Box padding"
          rowLabel="Padding"
          id="style.box.padding"
          get={(i) => text(i).style.box?.padding ?? 0}
          patch={(v) => ({ style: { box: { padding: v } } })}
          min={0}
          max={120}
          unit="px"
          slider={{ min: 0, max: 80, step: 1 }}
        />
        <NumberProp
          label="Box radius"
          rowLabel="Radius"
          id="style.box.radius"
          get={(i) => text(i).style.box?.radius ?? 0}
          patch={(v) => ({ style: { box: { radius: v } } })}
          min={0}
          max={120}
          unit="px"
          slider={{ min: 0, max: 80, step: 1 }}
        />
      </OptionalStyle>
    </>
  );
}

const ANIMS = [
  { value: 'none', label: 'None' },
  { value: 'pop', label: 'Pop' },
  { value: 'typewriter', label: 'Typewriter' },
  { value: 'slide', label: 'Slide' },
  { value: 'bounce', label: 'Bounce' },
  { value: 'fade', label: 'Fade' },
  { value: 'scale', label: 'Scale' },
] as const;

/** Scrubs the playhead across an animation once (real time), then puts it back. */
function useReplay() {
  const raf = React.useRef(0);
  React.useEffect(() => () => cancelAnimationFrame(raf.current), []);
  return React.useCallback((from: number, to: number) => {
    const s = useEditorStore.getState();
    const back = s.playheadSec;
    s.pause();
    cancelAnimationFrame(raf.current);
    const secs = Math.max(0.35, Math.abs(to - from));
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / 1000 / secs);
      useEditorStore.getState().setPlayhead(from + (to - from) * p);
      if (p < 1) raf.current = requestAnimationFrame(tick);
      else setTimeout(() => useEditorStore.getState().setPlayhead(back), 250);
    };
    raf.current = requestAnimationFrame(tick);
  }, []);
}

export function AnimationSection() {
  const ctx = useInspector();
  const item = text(ctx.primary);
  const replay = useReplay();
  const one = (which: 'animIn' | 'animOut', title: string) => {
    const cur = item[which];
    return (
      <div className="flex flex-col gap-1.5" key={which}>
        <SelectProp
          label={`Animation ${title.toLowerCase()}`}
          rowLabel="Type"
          testId={`anim-${which}`}
          get={(i) => text(i)[which].type}
          patch={(v) => ({ [which]: { type: v } })}
          options={ANIMS.map((a) => ({ ...a }))}
        />
        <NumberProp
          label={`${title} duration`}
          rowLabel="Duration"
          id={`${which}.durationSec`}
          get={(i) => text(i)[which].durationSec}
          patch={(v) => ({ [which]: { durationSec: v } })}
          min={0}
          max={Math.min(3, item.durationSec)}
          step={0.05}
          decimals={2}
          unit="s"
          disabled={cur.type === 'none'}
          slider={{ min: 0, max: Math.min(3, item.durationSec), step: 0.05 }}
        />
        <Button
          size="xs"
          variant="secondary"
          className="self-start"
          data-testid={`replay-${which}`}
          disabled={ctx.multi || cur.type === 'none'}
          onClick={() => {
            const d = cur.durationSec;
            if (which === 'animIn') replay(item.startSec, item.startSec + d);
            else replay(item.startSec + item.durationSec - d, item.startSec + item.durationSec);
          }}
        >
          <Play aria-hidden /> Replay
        </Button>
      </div>
    );
  };
  return (
    <>
      <Section title="Animation in" testId="section-anim-in">
        {one('animIn', 'In')}
      </Section>
      <Section title="Animation out" testId="section-anim-out">
        {one('animOut', 'Out')}
      </Section>
      <Hint className={cn('px-3 pb-3')}>
        Replay scrubs the playhead across the animation. Typewriter reveals characters; Pop and
        Bounce overshoot.
      </Hint>
    </>
  );
}
