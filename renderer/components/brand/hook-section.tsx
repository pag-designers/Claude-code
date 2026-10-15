'use client';

import * as React from 'react';
import { RotateCcw } from 'lucide-react';
import { DEFAULT_HOOK_STYLE, type HookStyle } from '@shared/brand';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import { hexToRgba } from '@/lib/brand/helpers';
import { useKitSession } from '@/lib/brand/kit-session';
import { useFontChoices } from '@/lib/brand/use-fonts';
import { FieldRow, HexField, SelectField, SliderRow } from './controls';
import { PhoneFrame } from './phone-frame';
import { Section } from './section';

const WEIGHTS = [400, 500, 600, 700, 800, 900];
const SAMPLE = 'Nobody tells you this about editing';

/** The card as the finisher draws it: a rounded box centred at `yPct`, text sized as % of the frame's short side. */
export function HookCardPreview({ hook, text = SAMPLE }: { hook: HookStyle; text?: string }) {
  const shown =
    hook.textCase === 'upper'
      ? text.toUpperCase()
      : hook.textCase === 'lower'
        ? text.toLowerCase()
        : text;
  return (
    <PhoneFrame
      width={9}
      height={16}
      label="Hook card preview"
      testId="hook-preview"
      className="w-full"
    >
      <div
        className="absolute inset-x-0 flex justify-center"
        style={{ top: `${hook.yPct}%`, transform: 'translateY(-50%)' }}
      >
        <div
          data-testid="hook-card"
          style={{
            fontFamily: `"${hook.fontFamily}", var(--font-sans)`,
            fontWeight: hook.weight,
            fontSize: `${hook.sizePct}cqw`,
            lineHeight: 1.12,
            color: hook.textColor,
            background: hexToRgba(hook.cardColor, hook.cardOpacity),
            padding: '0.5em 0.7em',
            borderRadius: '0.34em',
            maxWidth: '84cqw',
            textAlign: 'center',
            overflowWrap: 'anywhere',
          }}
        >
          {shown}
        </div>
      </div>
    </PhoneFrame>
  );
}

export function HookSection() {
  const s = useKitSession();
  const hook = s.spec.hook;
  const { choices } = useFontChoices();
  const set = (patch: Partial<HookStyle>) => s.update('hook', (h) => ({ ...h, ...patch }));
  const family = choices.find((c) => c.family === hook.fontFamily);
  const weights = [
    ...new Set([...(family?.weights.length ? family.weights : WEIGHTS), hook.weight]),
  ].sort((a, b) => a - b);
  const isDefault = JSON.stringify(hook) === JSON.stringify(DEFAULT_HOOK_STYLE);
  const fontOptions = choices.map((c) => ({
    value: c.family,
    label: (
      <span style={{ fontFamily: `"${c.family}", var(--font-sans)` }}>
        {c.family}
        {c.source === 'brand' ? ' · your font' : ''}
      </span>
    ),
  }));
  if (!family)
    fontOptions.unshift({ value: hook.fontFamily, label: <span>{hook.fontFamily}</span> });

  return (
    <Section
      id="hook"
      description="The title card burned into the first seconds of every clip. Defaults match the built-in card."
      actions={
        <Button
          size="sm"
          variant="ghost"
          disabled={isDefault}
          onClick={() => s.edit({ hook: DEFAULT_HOOK_STYLE }, { immediate: true })}
        >
          <RotateCcw /> Reset to default
        </Button>
      }
    >
      <div className="grid gap-6 @2xl:grid-cols-[220px_minmax(0,1fr)]">
        <div className="mx-auto w-[200px] @2xl:w-full">
          <HookCardPreview hook={hook} />
        </div>
        <div className="grid content-start gap-x-6 gap-y-4 @2xl:grid-cols-2">
          <FieldRow label="Font" htmlFor="hook-font">
            <SelectField
              id="hook-font"
              label="Hook font"
              value={hook.fontFamily}
              options={fontOptions}
              onChange={(fontFamily) => {
                const next = choices.find((c) => c.family === fontFamily);
                const nearest = next?.weights.length
                  ? next.weights.reduce((a, b) =>
                      Math.abs(b - hook.weight) < Math.abs(a - hook.weight) ? b : a,
                    )
                  : hook.weight;
                set({ fontFamily, weight: nearest });
              }}
            />
          </FieldRow>
          <FieldRow label="Weight" htmlFor="hook-weight">
            <SelectField
              id="hook-weight"
              label="Hook font weight"
              value={String(hook.weight)}
              options={weights.map((w) => ({ value: String(w), label: String(w) }))}
              onChange={(w) => set({ weight: Number(w) })}
            />
          </FieldRow>
          <FieldRow label="Letter case" className="@2xl:col-span-2">
            <Segmented
              size="sm"
              label="Hook text case"
              value={hook.textCase}
              onValueChange={(textCase) => set({ textCase })}
              options={[
                { value: 'none', label: 'As written' },
                { value: 'upper', label: 'UPPERCASE' },
                { value: 'lower', label: 'lowercase' },
              ]}
            />
          </FieldRow>
          <HexField
            label="Text color"
            value={hook.textColor}
            onChange={(textColor) => set({ textColor })}
          />
          <div className="flex flex-col gap-3">
            <HexField
              label="Card color"
              value={hook.cardColor}
              onChange={(cardColor) => set({ cardColor })}
            />
          </div>
          <SliderRow
            label="Card opacity"
            value={Math.round(hook.cardOpacity * 100)}
            min={0}
            max={100}
            unit="%"
            onChange={(v) => set({ cardOpacity: v / 100 })}
          />
          <SliderRow
            label="Text size"
            value={hook.sizePct}
            min={3}
            max={12}
            step={0.1}
            decimals={1}
            unit="%"
            hint="Of the frame’s short side."
            onChange={(sizePct) => set({ sizePct })}
          />
          <SliderRow
            label="Vertical position"
            value={hook.yPct}
            min={5}
            max={90}
            unit="%"
            hint="Centre of the card, from the top."
            onChange={(yPct) => set({ yPct })}
          />
        </div>
      </div>
    </Section>
  );
}
