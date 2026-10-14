'use client';

import * as React from 'react';
import { Ban, Check, Palette, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import type { Asset } from '@shared/editor';
import { FILTER_PRESETS } from '@shared/editor-eval';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { useEditorStore } from '@/lib/editor/core';
import { selectedVisualItems, sharedFilter, sharedLut } from '@/lib/editor-panels/edit-targets';
import { filterSwatchBackground } from '@/lib/editor-panels/filter-swatch';
import { cn } from '@/lib/utils';
import { applyFilter, applyLut, setLutAmount } from './actions';
import { GroupLabel, Note, tileBase } from './bits';
import { ImportButton } from './import-button';

/** What the filters would apply to, as a primitive summary (re-renders only when it changes). */
function useSelectedLook() {
  const json = useEditorStore((s) => {
    const items = selectedVisualItems(s.project, s.selection.itemIds);
    const lut = sharedLut(items);
    return JSON.stringify({
      count: items.length,
      filter: sharedFilter(items),
      lut,
      lutAmount: lut && lut !== 'mixed' ? (items[0]?.color.lutAmount ?? 1) : 1,
    });
  });
  return React.useMemo(
    () =>
      JSON.parse(json) as {
        count: number;
        filter: string | null | 'mixed';
        lut: string | null | 'mixed';
        lutAmount: number;
      },
    [json],
  );
}

const FILTERS: { key: string | null; label: string }[] = [
  { key: null, label: 'None' },
  ...Object.entries(FILTER_PRESETS).map(([key, p]) => ({ key, label: p.label })),
];

function LutRow({
  asset,
  active,
  onApply,
}: {
  asset: Asset;
  active: boolean;
  onApply: () => void;
}) {
  return (
    <li
      data-testid="bin-lut"
      data-asset-id={asset.id}
      className={cn(
        'flex items-center gap-2 rounded-lg border bg-card px-2.5 py-1.5',
        active && 'border-primary bg-primary-soft',
      )}
    >
      <Palette className="size-3.5 shrink-0 text-primary-text" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-xs font-medium" title={asset.name}>
        {asset.name}
      </span>
      {active ? <Check className="size-3.5 text-primary-text" aria-label="Applied" /> : null}
      <Button variant={active ? 'ghost' : 'soft'} size="xs" onClick={onApply} className="h-6 px-2">
        {active ? 'Remove' : 'Apply'}
      </Button>
    </li>
  );
}

export function EffectsTab() {
  const look = useSelectedLook();
  const assets = useEditorStore((s) => s.project.assets);
  const luts = React.useMemo(() => assets.filter((a) => a.kind === 'lut'), [assets]);

  const notify = (r: ReturnType<typeof applyFilter>, ok: string) => {
    if (r.ok) toast.success(ok);
    else toast.info(r.reason);
  };

  return (
    <div className="flex flex-col gap-5" data-testid="bin-effects">
      <p
        className="flex items-start gap-2 rounded-xl border bg-muted/40 p-3 text-xs leading-4 text-muted-foreground"
        data-testid="bin-effects-target"
        data-count={look.count}
      >
        <Wand2 className="mt-px size-3.5 shrink-0 text-primary-text" aria-hidden />
        {look.count > 0
          ? `Looks apply to ${look.count} selected ${look.count === 1 ? 'clip' : 'clips'}.`
          : 'Select a video or image clip on the timeline, then pick a look.'}
      </p>

      <section aria-label="Filters" className="flex flex-col gap-2.5">
        <GroupLabel>Filters</GroupLabel>
        <ul className="grid grid-cols-2 gap-2">
          {FILTERS.map((f) => {
            const active = look.count > 0 && look.filter === f.key;
            return (
              <li key={f.key ?? 'none'} className="min-w-0">
                <button
                  type="button"
                  aria-pressed={active}
                  aria-label={f.key === null ? 'No filter' : `${f.label} filter`}
                  data-testid="bin-filter"
                  data-filter={f.key ?? 'none'}
                  onClick={() =>
                    notify(applyFilter(f.key), f.key ? `${f.label} applied` : 'Filter removed')
                  }
                  className={cn(
                    tileBase,
                    'w-full',
                    active && 'border-primary bg-primary-soft hover:border-primary',
                  )}
                >
                  <span
                    className="relative block aspect-[16/10] w-full overflow-hidden rounded-md"
                    style={{ background: filterSwatchBackground(f.key) }}
                    aria-hidden
                  >
                    {f.key === null ? (
                      <Ban className="absolute right-1 top-1 size-3.5 text-white/80 drop-shadow" />
                    ) : null}
                  </span>
                  <span className="flex items-center justify-between px-0.5">
                    <span className="truncate text-xs font-medium">{f.label}</span>
                    {active ? <Check className="size-3.5 text-primary-text" aria-hidden /> : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {look.filter === 'mixed' ? (
          <p className="text-2xs text-subtle">The selected clips use different filters.</p>
        ) : null}
      </section>

      <section aria-label="LUTs" className="flex flex-col gap-2.5">
        <GroupLabel
          action={
            <ImportButton
              kinds={['lut']}
              noun="LUT"
              label="Import LUT"
              size="xs"
              data-testid="bin-lut-import"
            />
          }
        >
          Colour LUTs
        </GroupLabel>
        {luts.length === 0 ? (
          <Note icon={Palette} title="No LUTs yet">
            Import a .cube file and apply it as a grade on top of any filter.
          </Note>
        ) : (
          <>
            <ul className="flex flex-col gap-1.5" aria-label="Project LUTs">
              {luts.map((a) => {
                const active = look.count > 0 && look.lut === a.id;
                return (
                  <LutRow
                    key={a.id}
                    asset={a}
                    active={active}
                    onApply={() =>
                      notify(
                        applyLut(active ? null : a.id),
                        active ? 'LUT removed' : `${a.name} applied`,
                      )
                    }
                  />
                );
              })}
            </ul>
            {look.lut && look.lut !== 'mixed' ? (
              <div className="flex items-center gap-3">
                <label htmlFor="bin-lut-amount" className="shrink-0 text-xs font-medium">
                  Amount
                </label>
                <Slider
                  id="bin-lut-amount"
                  value={Math.round(look.lutAmount * 100)}
                  onValueChange={(v) => setLutAmount(v / 100)}
                  min={0}
                  max={100}
                  aria-label="LUT amount"
                  className="flex-1"
                />
                <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                  {Math.round(look.lutAmount * 100)}%
                </span>
              </div>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
