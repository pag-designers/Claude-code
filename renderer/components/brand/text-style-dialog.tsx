'use client';

import * as React from 'react';
import { ArrowLeft } from 'lucide-react';
import { brandTextStyleSchema, TEXT_STYLE_KINDS, type BrandTextStyle } from '@shared/brand';
import type { TextAnimation, TextStyle } from '@shared/editor';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { newId } from '@/lib/brand/helpers';
import { useFontChoices } from '@/lib/brand/use-fonts';
import {
  TEXT_KIND_LABEL,
  TEXT_KIND_SAMPLE,
  TEXT_PRESETS,
  presetsOfKind,
  type TextPreset,
  type TextStyleKind,
} from '@/lib/brand/text-presets';
import {
  BufferedInput,
  FieldRow,
  HexField,
  NumberBox,
  SelectField,
  SliderRow,
  SubHeading,
} from './controls';
import { ReplayButton, TextStylePreview } from './text-style-preview';

const ANIMS: { value: TextAnimation['type']; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'fade', label: 'Fade' },
  { value: 'pop', label: 'Pop' },
  { value: 'scale', label: 'Scale' },
  { value: 'slide', label: 'Slide up' },
  { value: 'bounce', label: 'Bounce' },
  { value: 'typewriter', label: 'Typewriter' },
];
const WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900];
const DEF_STROKE = { color: '#000000', width: 6 };
const DEF_SHADOW = { color: '#000000', opacity: 0.5, blur: 12, offsetX: 0, offsetY: 4 };
const DEF_BOX = { color: '#000000', opacity: 0.6, padding: 24, radius: 16 };

export interface TextStyleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Edit this style, or null to pick a preset first. */
  editing: BrandTextStyle | null;
  /** Preset kind to show first when adding. */
  initialKind?: TextStyleKind;
  onSave: (style: BrandTextStyle) => void;
}

export function TextStyleDialog(props: TextStyleDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      {props.open ? <Body {...props} /> : null}
    </Dialog>
  );
}

function Body({ editing, onSave, onOpenChange, initialKind }: TextStyleDialogProps) {
  const [draft, setDraft] = React.useState<BrandTextStyle | null>(editing);
  return (
    <DialogContent
      className="h-[min(88vh,800px)] max-h-[min(88vh,800px)] w-[calc(100vw-48px)] max-w-[1040px]"
      data-testid="text-style-dialog"
      aria-describedby="text-style-desc"
    >
      {draft ? (
        <Editor
          key={draft.id}
          initial={draft}
          isNew={!editing}
          onBack={editing ? undefined : () => setDraft(null)}
          onCancel={() => onOpenChange(false)}
          onSave={(s) => {
            onSave(s);
            onOpenChange(false);
          }}
        />
      ) : (
        <Picker
          initialKind={initialKind}
          onPick={(p) => setDraft({ id: newId('ts'), ...p.make() })}
        />
      )}
    </DialogContent>
  );
}

/* ---------------------------------------------------------------------------------------- picker ---- */

function Picker({
  onPick,
  initialKind,
}: {
  onPick: (p: TextPreset) => void;
  initialKind?: TextStyleKind;
}) {
  const [kind, setKind] = React.useState<TextStyleKind | 'all'>(initialKind ?? 'all');
  useFontChoices(); // loads the shipped fonts so the previews use them
  const presets = kind === 'all' ? TEXT_PRESETS : presetsOfKind(kind);
  return (
    <>
      <DialogHeader>
        <DialogTitle className="font-display text-xl font-semibold">Add text styles</DialogTitle>
        <DialogDescription id="text-style-desc" className="text-sm text-muted-foreground">
          Title, hook, call-to-action and lower-third presets with entrance and exit animations.
          Pick one to tune it.
        </DialogDescription>
      </DialogHeader>
      <div className="flex items-center gap-3 border-b px-6 py-3">
        <Segmented
          label="Style type"
          size="sm"
          value={kind}
          onValueChange={setKind}
          options={[
            { value: 'all', label: 'All' },
            ...TEXT_STYLE_KINDS.map((k) => ({ value: k, label: TEXT_KIND_LABEL[k] })),
          ]}
        />
      </div>
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-6">
        <ul
          className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-4"
          aria-label="Text style presets"
        >
          {presets.map((p) => {
            const made = p.make();
            return (
              <li key={p.key}>
                <button
                  type="button"
                  data-testid="text-preset"
                  data-preset={p.key}
                  aria-label={`Start from ${p.label}`}
                  onClick={() => onPick(p)}
                  className="group flex w-full flex-col gap-2 rounded-xl border bg-card p-2 text-left outline-none transition-[border-color,box-shadow,transform] duration-(--duration-base) hover:-translate-y-px hover:border-border-strong hover:shadow-sm focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <TextStylePreview
                    style={made.style}
                    text={TEXT_KIND_SAMPLE[p.kind]}
                    yPct={null}
                  />
                  <span className="flex items-baseline justify-between gap-2 px-1">
                    <span className="text-sm font-semibold">{p.label}</span>
                    <span className="text-2xs uppercase tracking-wider text-subtle">
                      {TEXT_KIND_LABEL[p.kind]}
                    </span>
                  </span>
                  <span className="px-1 pb-1 text-xs text-muted-foreground">{p.blurb}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </>
  );
}

/* ---------------------------------------------------------------------------------------- editor ---- */

function Toggle({
  label,
  on,
  onChange,
}: {
  label: string;
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <SubHeading>{label}</SubHeading>
      <Switch checked={on} onCheckedChange={onChange} aria-label={label} />
    </div>
  );
}

function Editor({
  initial,
  isNew,
  onBack,
  onCancel,
  onSave,
}: {
  initial: BrandTextStyle;
  isNew: boolean;
  onBack?: () => void;
  onCancel: () => void;
  onSave: (s: BrandTextStyle) => void;
}) {
  const { choices } = useFontChoices();
  const [d, setD] = React.useState<BrandTextStyle>(initial);
  const [text, setText] = React.useState(TEXT_KIND_SAMPLE[initial.kind]);
  const [textTouched, setTextTouched] = React.useState(false);
  const [replay, setReplay] = React.useState(0);
  const [aspect, setAspect] = React.useState<'9:16' | '16:9'>('9:16');

  const set = (patch: Partial<BrandTextStyle>) => setD((cur) => ({ ...cur, ...patch }));
  const setStyle = (patch: Partial<TextStyle>) =>
    setD((cur) => ({ ...cur, style: { ...cur.style, ...patch } }));
  const st = d.style;

  const family = choices.find((c) => c.family === st.fontFamily);
  const weights = React.useMemo(() => {
    const base = family?.weights?.length ? family.weights : WEIGHTS;
    return [...new Set([...base, st.weight])].sort((a, b) => a - b);
  }, [family, st.weight]);

  const valid = brandTextStyleSchema.safeParse(d);
  const dirty = JSON.stringify(d) !== JSON.stringify(initial);

  const fontOptions = choices.map((c) => ({
    value: c.family,
    label: (
      <span
        className="flex items-center gap-2"
        style={{ fontFamily: `"${c.family}", var(--font-sans)` }}
      >
        {c.family}
        {c.source === 'brand' ? (
          <span className="rounded-full bg-primary-soft px-1.5 text-2xs font-sans font-semibold text-primary-text">
            Your font
          </span>
        ) : null}
      </span>
    ),
  }));
  if (!family) fontOptions.unshift({ value: st.fontFamily, label: <span>{st.fontFamily}</span> });

  return (
    <>
      <DialogHeader className="flex-row items-center justify-between gap-6 pr-14">
        <div className="flex min-w-0 items-center gap-3">
          {onBack ? (
            <Button size="icon-sm" variant="ghost" aria-label="Back to presets" onClick={onBack}>
              <ArrowLeft />
            </Button>
          ) : null}
          <div className="min-w-0">
            <DialogTitle className="font-display text-xl font-semibold">
              {isNew ? 'New text style' : 'Edit text style'}
            </DialogTitle>
            <DialogDescription id="text-style-desc" className="text-sm text-muted-foreground">
              Sizes are in pixels of a 1080 px wide canvas and scale to other formats.
            </DialogDescription>
          </div>
        </div>
      </DialogHeader>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(340px,400px)]">
        <div className="flex min-h-0 flex-col items-center gap-3 bg-background/50 p-5">
          <div className="flex min-h-0 w-full flex-1 items-center justify-center">
            <div className={cn('w-full', aspect === '9:16' ? 'max-w-[300px]' : 'max-w-[520px]')}>
              <TextStylePreview
                style={st}
                text={text}
                yPct={d.yPct}
                animIn={d.animIn}
                animOut={d.animOut}
                replayKey={replay}
                aspect={aspect}
              />
            </div>
          </div>
          <div className="flex w-full flex-wrap items-center justify-center gap-3">
            <Segmented
              size="sm"
              label="Preview format"
              value={aspect}
              onValueChange={setAspect}
              options={[
                { value: '9:16', label: '9:16' },
                { value: '16:9', label: '16:9' },
              ]}
            />
            <ReplayButton onClick={() => setReplay((n) => n + 1)} />
          </div>
          <div className="w-full max-w-[520px]">
            <FieldRow label="Sample text" htmlFor="ts-sample">
              <BufferedInput
                id="ts-sample"
                allowEmpty
                value={text}
                maxLength={80}
                onValue={(v) => {
                  setText(v);
                  setTextTouched(true);
                }}
              />
            </FieldRow>
          </div>
        </div>
        <div className="scrollbar-thin flex min-h-0 flex-col gap-5 overflow-y-auto border-l px-5 py-4">
          <FieldRow label="Name" htmlFor="ts-name">
            <BufferedInput
              id="ts-name"
              value={d.name}
              maxLength={40}
              onValue={(name) => set({ name })}
            />
          </FieldRow>
          <FieldRow label="Used for">
            <Segmented
              size="sm"
              label="Style type"
              value={d.kind}
              onValueChange={(kind) => {
                set({ kind });
                if (!textTouched) setText(TEXT_KIND_SAMPLE[kind]);
              }}
              options={TEXT_STYLE_KINDS.map((k) => ({ value: k, label: TEXT_KIND_LABEL[k] }))}
              className="flex-wrap"
            />
          </FieldRow>

          <div className="flex flex-col gap-3.5">
            <SubHeading>Font</SubHeading>
            <FieldRow label="Family" htmlFor="ts-font">
              <SelectField
                id="ts-font"
                label="Font family"
                value={st.fontFamily}
                onChange={(fontFamily) => {
                  const next = choices.find((c) => c.family === fontFamily);
                  const nearest = next?.weights.length
                    ? next.weights.reduce((a, b) =>
                        Math.abs(b - st.weight) < Math.abs(a - st.weight) ? b : a,
                      )
                    : st.weight;
                  setStyle({ fontFamily, weight: nearest });
                }}
                options={fontOptions}
              />
            </FieldRow>
            <div className="grid grid-cols-2 gap-3">
              <FieldRow label="Weight" htmlFor="ts-weight">
                <SelectField
                  id="ts-weight"
                  label="Font weight"
                  value={String(st.weight)}
                  onChange={(w) => setStyle({ weight: Number(w) })}
                  options={weights.map((w) => ({ value: String(w), label: String(w) }))}
                />
              </FieldRow>
              <FieldRow label="Italic">
                <Segmented
                  size="sm"
                  label="Italic"
                  value={st.italic ? 'on' : 'off'}
                  onValueChange={(v) => setStyle({ italic: v === 'on' })}
                  options={[
                    { value: 'off', label: 'Off' },
                    { value: 'on', label: 'On' },
                  ]}
                />
              </FieldRow>
            </div>
            <SliderRow
              label="Size"
              value={st.size}
              min={8}
              max={400}
              unit="px"
              onChange={(size) => setStyle({ size })}
            />
            <FieldRow label="Align">
              <Segmented
                size="sm"
                label="Text align"
                value={st.align}
                onValueChange={(align) => setStyle({ align })}
                options={[
                  { value: 'left', label: 'Left' },
                  { value: 'center', label: 'Center' },
                  { value: 'right', label: 'Right' },
                ]}
              />
            </FieldRow>
            <SliderRow
              label="Letter spacing"
              value={st.letterSpacing}
              min={-20}
              max={80}
              onChange={(letterSpacing) => setStyle({ letterSpacing })}
            />
            <SliderRow
              label="Line height"
              value={st.lineHeight}
              min={0.6}
              max={3}
              step={0.05}
              decimals={2}
              onChange={(lineHeight) => setStyle({ lineHeight })}
            />
          </div>

          <div className="flex flex-col gap-3.5">
            <SubHeading>Color</SubHeading>
            <HexField
              label="Text color"
              value={st.color}
              onChange={(color) => setStyle({ color })}
            />
          </div>

          <div className="flex flex-col gap-3.5">
            <Toggle
              label="Outline"
              on={!!st.stroke}
              onChange={(on) => setStyle({ stroke: on ? DEF_STROKE : null })}
            />
            {st.stroke ? (
              <>
                <HexField
                  label="Outline color"
                  value={st.stroke.color}
                  onChange={(color) => setStyle({ stroke: { ...st.stroke!, color } })}
                />
                <SliderRow
                  label="Outline width"
                  value={st.stroke.width}
                  min={0}
                  max={40}
                  onChange={(width) => setStyle({ stroke: { ...st.stroke!, width } })}
                />
              </>
            ) : null}
          </div>

          <div className="flex flex-col gap-3.5">
            <Toggle
              label="Shadow"
              on={!!st.shadow}
              onChange={(on) => setStyle({ shadow: on ? DEF_SHADOW : null })}
            />
            {st.shadow ? (
              <>
                <HexField
                  label="Shadow color"
                  value={st.shadow.color}
                  onChange={(color) => setStyle({ shadow: { ...st.shadow!, color } })}
                />
                <SliderRow
                  label="Shadow opacity"
                  value={Math.round(st.shadow.opacity * 100)}
                  min={0}
                  max={100}
                  unit="%"
                  onChange={(v) => setStyle({ shadow: { ...st.shadow!, opacity: v / 100 } })}
                />
                <SliderRow
                  label="Shadow blur"
                  value={st.shadow.blur}
                  min={0}
                  max={60}
                  onChange={(blur) => setStyle({ shadow: { ...st.shadow!, blur } })}
                />
                <SliderRow
                  label="Shadow offset X"
                  value={st.shadow.offsetX}
                  min={-60}
                  max={60}
                  onChange={(offsetX) => setStyle({ shadow: { ...st.shadow!, offsetX } })}
                />
                <SliderRow
                  label="Shadow offset Y"
                  value={st.shadow.offsetY}
                  min={-60}
                  max={60}
                  onChange={(offsetY) => setStyle({ shadow: { ...st.shadow!, offsetY } })}
                />
              </>
            ) : null}
          </div>

          <div className="flex flex-col gap-3.5">
            <Toggle
              label="Background box"
              on={!!st.box}
              onChange={(on) => setStyle({ box: on ? DEF_BOX : null })}
            />
            {st.box ? (
              <>
                <HexField
                  label="Box color"
                  value={st.box.color}
                  onChange={(color) => setStyle({ box: { ...st.box!, color } })}
                />
                <SliderRow
                  label="Box opacity"
                  value={Math.round(st.box.opacity * 100)}
                  min={0}
                  max={100}
                  unit="%"
                  onChange={(v) => setStyle({ box: { ...st.box!, opacity: v / 100 } })}
                />
                <SliderRow
                  label="Box padding"
                  value={st.box.padding}
                  min={0}
                  max={120}
                  onChange={(padding) => setStyle({ box: { ...st.box!, padding } })}
                />
                <SliderRow
                  label="Box corner radius"
                  value={st.box.radius}
                  min={0}
                  max={120}
                  onChange={(radius) => setStyle({ box: { ...st.box!, radius } })}
                />
              </>
            ) : null}
          </div>

          <div className="flex flex-col gap-3.5">
            <SubHeading>Animation</SubHeading>
            {(['animIn', 'animOut'] as const).map((key) => {
              const a = d[key];
              const word = key === 'animIn' ? 'In' : 'Out';
              return (
                <div key={key} className="grid grid-cols-[1fr_auto] items-end gap-3">
                  <FieldRow label={`Animate ${word.toLowerCase()}`} htmlFor={`ts-${key}`}>
                    <SelectField
                      id={`ts-${key}`}
                      label={`Animation ${word.toLowerCase()}`}
                      value={a.type}
                      onChange={(type) => {
                        set({ [key]: { ...a, type } } as Partial<BrandTextStyle>);
                        setReplay((n) => n + 1);
                      }}
                      options={ANIMS}
                    />
                  </FieldRow>
                  <NumberBox
                    label={`${word} duration`}
                    value={a.durationSec}
                    min={0}
                    max={3}
                    step={0.05}
                    decimals={2}
                    unit="s"
                    width="w-[76px]"
                    onChange={(durationSec) =>
                      set({ [key]: { ...a, durationSec } } as Partial<BrandTextStyle>)
                    }
                  />
                </div>
              );
            })}
          </div>

          <div className="flex flex-col gap-3.5 pb-1">
            <SubHeading>Position</SubHeading>
            <SliderRow
              label="Vertical position"
              value={d.yPct}
              min={0}
              max={100}
              unit="%"
              hint="Centre of the text, from the top of the frame."
              onChange={(yPct) => set({ yPct })}
            />
          </div>
        </div>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={!valid.success || (!isNew && !dirty)}
          data-testid="text-style-save"
          onClick={() => valid.success && onSave(valid.data)}
        >
          {isNew ? 'Add style' : 'Save'}
        </Button>
      </DialogFooter>
    </>
  );
}
