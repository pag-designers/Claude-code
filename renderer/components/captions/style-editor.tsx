'use client';

import * as React from 'react';
import { Controller, useFormContext, useWatch, type Path } from 'react-hook-form';
import { AlertCircle } from 'lucide-react';
import type { CaptionStyleInput } from '@shared/cp2';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { useCaptionFonts } from '@/lib/cp2-captions';
import { cn } from '@/lib/utils';
import { ColorField } from './color-field';

type P = Path<CaptionStyleInput>;

function Section({
  title,
  children,
  hint,
}: {
  title: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <section
      className="flex flex-col gap-3.5 border-b px-5 py-4 last:border-b-0"
      aria-label={title}
    >
      <div>
        <h3 className="text-2xs font-semibold uppercase tracking-wider text-subtle">{title}</h3>
        {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

const fieldId = (name: string) => `cs-${name.replace(/\./g, '-')}`;

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="flex items-center gap-1.5 text-xs text-danger">
      <AlertCircle className="size-3.5 shrink-0" aria-hidden />
      {message}
    </p>
  );
}

/** Zod's wording is for developers; the editor says what range is allowed. */
function numberMessage(value: unknown, min: number, max: number, int?: boolean): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'Enter a number.';
  if (int && !Number.isInteger(value)) return 'Whole numbers only.';
  return `Must be between ${min} and ${max}.`;
}

/** Slider + number box bound to one numeric style field. */
function NumField({
  name,
  label,
  min,
  max,
  step,
  suffix,
  int,
  disabled,
}: {
  name: P;
  label: string;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  int?: boolean;
  disabled?: boolean;
}) {
  const { control } = useFormContext<CaptionStyleInput>();
  const id = fieldId(name);
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => {
        const v = field.value as number;
        const finite = typeof v === 'number' && Number.isFinite(v);
        const inRange = finite && v >= min && v <= max;
        return (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-3">
              <label htmlFor={id} className="text-sm font-medium">
                {label}
              </label>
              <Input
                id={id}
                type="number"
                inputMode="decimal"
                min={min}
                max={max}
                step={step}
                disabled={disabled}
                value={finite ? v : ''}
                aria-describedby={fieldState.error ? `${id}-err` : undefined}
                invalid={!!fieldState.error}
                onChange={(e) =>
                  field.onChange(e.target.value === '' ? Number.NaN : Number(e.target.value))
                }
                onBlur={field.onBlur}
                className="h-8 w-full pr-6 text-right tabular-nums"
                wrapperClassName="w-24"
                trailing={suffix ? <span className="pr-1 text-2xs">{suffix}</span> : undefined}
              />
            </div>
            <Slider
              aria-label={`${label} slider`}
              value={inRange ? v : Math.min(Math.max(finite ? v : min, min), max)}
              min={min}
              max={max}
              step={step}
              disabled={disabled}
              onValueChange={(n) => field.onChange(int ? Math.round(n) : n)}
            />
            <FieldError
              id={`${id}-err`}
              message={fieldState.error ? numberMessage(v, min, max, int) : undefined}
            />
          </div>
        );
      }}
    />
  );
}

function ColorControl({ name, label, compact }: { name: P; label: string; compact?: boolean }) {
  const { control } = useFormContext<CaptionStyleInput>();
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <ColorField
          id={fieldId(name)}
          label={label}
          value={String(field.value ?? '')}
          onChange={field.onChange}
          compact={compact}
          error={fieldState.error ? 'Use a 6-digit hex colour such as #FFD60A.' : undefined}
        />
      )}
    />
  );
}

function ChoiceSelect<T extends string>({
  name,
  label,
  options,
}: {
  name: P;
  label: string;
  options: { value: T; label: string }[];
}) {
  const { control } = useFormContext<CaptionStyleInput>();
  const id = fieldId(name);
  return (
    <Controller
      control={control}
      name={name}
      render={({ field }) => (
        <div className="flex items-center justify-between gap-3">
          <label htmlFor={id} className="text-sm font-medium">
            {label}
          </label>
          <Select value={String(field.value)} onValueChange={field.onChange}>
            <SelectTrigger id={id} className="h-8 w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    />
  );
}

function ToggleRow({ name, label, hint }: { name: P; label: string; hint?: string }) {
  const { control } = useFormContext<CaptionStyleInput>();
  const id = fieldId(name);
  return (
    <Controller
      control={control}
      name={name}
      render={({ field }) => (
        <div className="flex items-center justify-between gap-3">
          <label htmlFor={id} className="min-w-0 text-sm font-medium">
            {label}
            {hint ? (
              <span className="block text-xs font-normal text-muted-foreground">{hint}</span>
            ) : null}
          </label>
          <Switch id={id} checked={!!field.value} onCheckedChange={field.onChange} />
        </div>
      )}
    />
  );
}

function useWatched<T>(name: P): T {
  const { control } = useFormContext<CaptionStyleInput>();
  return useWatch({ control, name }) as T;
}

const HIGHLIGHT_MODES = [
  { value: 'none', label: 'None' },
  { value: 'color', label: 'Colour' },
  { value: 'box', label: 'Box behind word' },
  { value: 'scale', label: 'Scale up' },
  { value: 'color-scale', label: 'Colour + scale' },
] as const;
const ANIMATIONS = [
  { value: 'none', label: 'None' },
  { value: 'pop', label: 'Pop' },
  { value: 'bounce', label: 'Bounce' },
  { value: 'typewriter', label: 'Typewriter' },
  { value: 'fade', label: 'Fade' },
  { value: 'slide-up', label: 'Slide up' },
  { value: 'karaoke', label: 'Karaoke sweep' },
] as const;

function FontFields() {
  const { control } = useFormContext<CaptionStyleInput>();
  const fonts = useCaptionFonts();
  const family = useWatched<string>('font.family');
  const list = React.useMemo(() => {
    const base = fonts.data?.fonts ?? [];
    return base.some((f) => f.family === family) || !family
      ? base
      : [...base, { family, weights: [] }];
  }, [fonts.data, family]);
  const weights = React.useMemo(() => {
    const w = list.find((f) => f.family === family)?.weights ?? [];
    return w.length ? w : [100, 200, 300, 400, 500, 600, 700, 800, 900];
  }, [list, family]);

  return (
    <>
      <Controller
        control={control}
        name="font.family"
        render={({ field, fieldState }) => (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-3">
              <label htmlFor="cs-font-family" className="text-sm font-medium">
                Font
              </label>
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger id="cs-font-family" className="h-8 w-52" data-testid="font-family">
                  <SelectValue placeholder={fonts.isPending ? 'Loading fonts…' : 'Choose a font'} />
                </SelectTrigger>
                <SelectContent>
                  {list.map((f) => (
                    <SelectItem key={f.family} value={f.family}>
                      {f.family}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {fonts.isError ? (
              <p role="status" className="text-xs text-warning">
                Could not list the shipped fonts ({fonts.error.message}); the current font stays
                selected.
              </p>
            ) : null}
            <FieldError
              id="cs-font-family-err"
              message={fieldState.error ? 'Choose a font.' : undefined}
            />
          </div>
        )}
      />
      <Controller
        control={control}
        name="font.weight"
        render={({ field }) => (
          <div className="flex items-center justify-between gap-3">
            <label htmlFor="cs-font-weight" className="text-sm font-medium">
              Weight
            </label>
            <Select value={String(field.value)} onValueChange={(v) => field.onChange(Number(v))}>
              <SelectTrigger id="cs-font-weight" className="h-8 w-52">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[
                  ...(weights.includes(field.value as number)
                    ? weights
                    : [...weights, field.value as number]),
                ]
                  .sort((a, b) => a - b)
                  .map((w) => (
                    <SelectItem key={w} value={String(w)}>
                      {weightName(w)} · {w}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
        )}
      />
      <NumField name="font.sizePct" label="Size" min={2} max={14} step={0.1} suffix="%" />
      <NumField
        name="font.letterSpacingPct"
        label="Letter spacing"
        min={-2}
        max={6}
        step={0.1}
        suffix="%"
      />
      <ToggleRow name="font.italic" label="Italic" />
      <Controller
        control={control}
        name="textCase"
        render={({ field }) => (
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium">Case</span>
            <Segmented
              size="sm"
              label="Text case"
              value={field.value as string}
              onValueChange={field.onChange}
              options={[
                { value: 'none', label: 'As spoken' },
                { value: 'upper', label: 'UPPER' },
                { value: 'lower', label: 'lower' },
                { value: 'title', label: 'Title' },
              ]}
            />
          </div>
        )}
      />
    </>
  );
}

function weightName(w: number): string {
  return (
    (
      {
        100: 'Thin',
        200: 'Extra light',
        300: 'Light',
        400: 'Regular',
        500: 'Medium',
        600: 'Semi bold',
        700: 'Bold',
        800: 'Extra bold',
        900: 'Black',
      } as Record<number, string>
    )[w] ?? 'Custom'
  );
}

/** All fields of a `CaptionStyle` (BRIEF §7). Must be rendered inside a react-hook-form `FormProvider`. */
export function StyleEditorFields({ className }: { className?: string }) {
  const { control } = useFormContext<CaptionStyleInput>();
  const mode = useWatched<string>('highlight.mode');
  const boxOn = useWatched<boolean>('box.enabled');
  return (
    <div className={cn('flex flex-col', className)} data-testid="style-editor">
      <Section title="Typography">
        <FontFields />
      </Section>
      <Section title="Colours">
        <ColorControl name="fill" label="Text fill" />
        <ColorControl name="stroke.color" label="Outline colour" compact />
        <NumField
          name="stroke.widthPct"
          label="Outline width"
          min={0}
          max={1.5}
          step={0.05}
          suffix="%"
        />
        <ColorControl name="keywordColor" label="Keyword colour" compact />
      </Section>
      <Section title="Active word" hint="How the word being spoken stands out.">
        <ChoiceSelect name="highlight.mode" label="Emphasis" options={[...HIGHLIGHT_MODES]} />
        {mode === 'color' || mode === 'color-scale' ? (
          <ColorControl name="highlight.color" label="Highlight colour" compact />
        ) : null}
        {mode === 'box' ? (
          <ColorControl name="highlight.boxColor" label="Highlight box" compact />
        ) : null}
        {mode === 'scale' || mode === 'color-scale' ? (
          <NumField name="highlight.scale" label="Scale" min={1} max={1.5} step={0.01} suffix="×" />
        ) : null}
        <ChoiceSelect name="animation" label="Animation" options={[...ANIMATIONS]} />
      </Section>
      <Section title="Shadow">
        <ColorControl name="shadow.color" label="Shadow colour" compact />
        <NumField name="shadow.opacity" label="Opacity" min={0} max={1} step={0.05} />
        <NumField name="shadow.blurPx" label="Blur" min={0} max={24} step={1} suffix="px" int />
        <NumField name="shadow.offsetPx" label="Offset" min={0} max={24} step={1} suffix="px" int />
      </Section>
      <Section title="Background box">
        <ToggleRow name="box.enabled" label="Box behind the text" />
        {boxOn ? (
          <>
            <ColorControl name="box.color" label="Box colour" compact />
            <NumField name="box.opacity" label="Opacity" min={0} max={1} step={0.05} />
            <NumField name="box.paddingPct" label="Padding" min={0} max={4} step={0.1} suffix="%" />
          </>
        ) : null}
      </Section>
      <Section title="Position">
        <NumField
          name="layout.yPct"
          label="Vertical position"
          min={5}
          max={95}
          step={1}
          suffix="%"
        />
        <NumField
          name="layout.marginXPct"
          label="Side margins"
          min={0}
          max={20}
          step={0.5}
          suffix="%"
        />
        <Controller
          control={control}
          name="layout.align"
          render={({ field }) => (
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium">Alignment</span>
              <Segmented
                size="sm"
                label="Alignment"
                value={field.value as string}
                onValueChange={field.onChange}
                options={[
                  { value: 'center', label: 'Centre' },
                  { value: 'left', label: 'Left' },
                ]}
              />
            </div>
          )}
        />
      </Section>
      <Section title="Line breaking" hint="Captions are chunked so no line looks crowded.">
        <NumField name="chunking.maxWords" label="Words per caption" min={1} max={5} step={1} int />
        <NumField
          name="chunking.maxChars"
          label="Characters per line"
          min={6}
          max={48}
          step={1}
          int
        />
        <NumField name="chunking.maxLines" label="Lines" min={1} max={3} step={1} int />
      </Section>
    </div>
  );
}

/** Used by the Studio header: style name input bound to the form. */
export function StyleNameField() {
  const { control } = useFormContext<CaptionStyleInput>();
  return (
    <Controller
      control={control}
      name="name"
      render={({ field, fieldState }) => (
        <div className="flex flex-col gap-1">
          <Input
            aria-label="Style name"
            value={String(field.value ?? '')}
            onChange={field.onChange}
            onBlur={field.onBlur}
            maxLength={40}
            invalid={!!fieldState.error}
            className="h-9 font-display text-md font-semibold"
            placeholder="Style name"
          />
          <FieldError
            id="cs-name-err"
            message={fieldState.error ? 'Name the style (1–40 characters).' : undefined}
          />
        </div>
      )}
    />
  );
}
