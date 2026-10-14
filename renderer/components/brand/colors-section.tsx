'use client';

import * as React from 'react';
import { Check, Copy, Pipette, Plus, RefreshCw, Trash2, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import type { BrandColor } from '@shared/brand';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { invoke } from '@/lib/ipc';
import { cn } from '@/lib/utils';
import {
  colorFamilyName,
  groupColors,
  isLightColor,
  newId,
  normalizeHex,
  uniqueName,
} from '@/lib/brand/helpers';
import { onExtractColorsRequest } from '@/lib/brand/bus';
import { useKitSession } from '@/lib/brand/kit-session';
import { BufferedInput, FieldRow, HexField, SelectField, SubHeading } from './controls';
import { Section } from './section';

const MAX_COLORS = 60;
const GROUPS = ['Primary', 'Accent', 'Neutral', 'Background'];

function copyText(text: string, what: string) {
  void navigator.clipboard
    .writeText(text)
    .then(() => toast.success(`Copied ${what}`))
    .catch(() => toast.error('Could not copy', { description: 'Clipboard access was denied.' }));
}

/* --------------------------------------------------------------------------------------- swatch ---- */

function Swatch({ color }: { color: BrandColor }) {
  const s = useKitSession();
  const [open, setOpen] = React.useState(false);
  const light = isLightColor(color.hex);
  const set = (patch: Partial<BrandColor>) =>
    s.update('colors', (cur) => cur.map((c) => (c.id === color.id ? { ...c, ...patch } : c)));
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="swatch"
          data-hex={color.hex}
          aria-label={`${color.name} ${color.hex.toUpperCase()}, edit`}
          className="group/sw flex w-[92px] flex-col gap-1.5 rounded-lg p-1 text-left outline-none transition-colors duration-(--duration-fast) hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span
            className="relative flex h-14 w-full items-end justify-end rounded-md border border-border-strong p-1.5 shadow-xs transition-transform duration-(--duration-fast) group-hover/sw:scale-[1.03]"
            style={{ background: color.hex }}
          >
            <Pipette
              className="size-3.5 opacity-0 transition-opacity group-hover/sw:opacity-80"
              style={{ color: light ? 'var(--swatch-black)' : 'var(--swatch-white)' }}
              aria-hidden
            />
          </span>
          <span className="truncate px-0.5 text-xs font-medium text-foreground">{color.name}</span>
          <span className="-mt-1 px-0.5 font-mono text-2xs uppercase text-subtle">{color.hex}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-4" aria-label={`Edit ${color.name}`}>
        <div className="flex flex-col gap-3.5">
          <FieldRow label="Name" htmlFor={`sw-name-${color.id}`}>
            <BufferedInput
              id={`sw-name-${color.id}`}
              value={color.name}
              maxLength={40}
              onValue={(name) => set({ name })}
            />
          </FieldRow>
          <HexField
            label="Color"
            value={color.hex}
            showBrand={false}
            onChange={(hex) => set({ hex })}
          />
          <FieldRow label="Group" htmlFor={`sw-group-${color.id}`}>
            <GroupInput
              id={`sw-group-${color.id}`}
              value={color.group}
              onChange={(group) => set({ group })}
            />
          </FieldRow>
          <div className="flex items-center justify-between gap-2 pt-1">
            <Button
              size="xs"
              variant="danger-ghost"
              onClick={() => {
                s.update('colors', (cur) => cur.filter((c) => c.id !== color.id), {
                  immediate: true,
                });
                setOpen(false);
              }}
            >
              <Trash2 /> Remove
            </Button>
            <Button size="xs" variant="outline" onClick={() => copyText(color.hex, color.hex)}>
              <Copy /> Copy hex
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function GroupInput({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const { spec } = useKitSession();
  const listId = `${id}-groups`;
  const groups = [...new Set([...GROUPS, ...spec.colors.map((c) => c.group)])];
  return (
    <>
      <BufferedInput
        id={id}
        list={listId}
        value={value}
        maxLength={30}
        onValue={(v) => onChange(v.slice(0, 30))}
      />
      <datalist id={listId}>
        {groups.map((g) => (
          <option key={g} value={g} />
        ))}
      </datalist>
    </>
  );
}

/* -------------------------------------------------------------------------------------- add popover ---- */

function AddColors({ disabled }: { disabled: boolean }) {
  const s = useKitSession();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  const [hex, setHex] = React.useState('#6A4BF2');
  const [group, setGroup] = React.useState('Primary');
  const [paste, setPaste] = React.useState('');

  const pasted = React.useMemo(
    () =>
      [...paste.matchAll(/#?[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g)]
        .map((m) => normalizeHex(m[0]))
        .filter((h): h is string => !!h),
    [paste],
  );

  const add = (list: { name?: string; hex: string }[]) => {
    s.update(
      'colors',
      (cur) => {
        const next = [...cur];
        for (const c of list) {
          if (next.length >= MAX_COLORS) break;
          next.push({
            id: newId('c'),
            name: uniqueName(
              c.name?.trim() || colorFamilyName(c.hex),
              next.map((x) => x.name),
            ),
            hex: c.hex,
            group: group.trim() || 'Primary',
          });
        }
        return next;
      },
      { immediate: true },
    );
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled}>
          <Plus /> Add colors
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-4" aria-label="Add colors">
        <form
          className="flex flex-col gap-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (pasted.length) {
              add(pasted.map((h) => ({ hex: h })));
              setPaste('');
            } else {
              add([{ name, hex }]);
              setName('');
            }
            setOpen(false);
          }}
        >
          <FieldRow label="Name" htmlFor="add-color-name">
            <Input
              id="add-color-name"
              value={name}
              maxLength={40}
              placeholder={colorFamilyName(hex)}
              onChange={(e) => setName(e.target.value)}
            />
          </FieldRow>
          <HexField label="Color" value={hex} showBrand={false} onChange={setHex} />
          <FieldRow label="Palette group" htmlFor="add-color-group">
            <GroupInput id="add-color-group" value={group} onChange={setGroup} />
          </FieldRow>
          <FieldRow
            label="Or paste several"
            htmlFor="add-color-paste"
            hint={
              pasted.length
                ? `${pasted.length} colors found`
                : 'Hex codes separated by spaces or commas.'
            }
          >
            <Input
              id="add-color-paste"
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              placeholder="#6A4BF2, #FFE94D, #101114"
            />
          </FieldRow>
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" variant="primary">
              {pasted.length ? `Add ${pasted.length} colors` : 'Add color'}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

/* ------------------------------------------------------------------------------------- extraction ---- */

type Extract =
  | { state: 'loading'; assetId: string }
  | { state: 'ready'; assetId: string; colors: string[] }
  | { state: 'error'; assetId: string; message: string };

function ExtractPanel({
  ex,
  onClose,
  onRetry,
}: {
  ex: Extract;
  onClose: () => void;
  onRetry: () => void;
}) {
  const s = useKitSession();
  const asset = s.assetById(ex.assetId);
  const have = new Set(s.spec.colors.map((c) => c.hex.toLowerCase()));
  const colors = ex.state === 'ready' ? ex.colors : [];
  // the panel is keyed by what it shows, so the pre-selection is simply the initial state
  const [picked, setPicked] = React.useState<Set<string>>(
    () => new Set(colors.filter((c) => !have.has(c.toLowerCase()))),
  );
  const [group, setGroup] = React.useState('Brand');

  const add = () => {
    const chosen = colors.filter((c) => picked.has(c));
    s.update(
      'colors',
      (cur) => {
        const next = [...cur];
        for (const hex of chosen) {
          if (next.length >= MAX_COLORS) break;
          next.push({
            id: newId('c'),
            name: uniqueName(
              colorFamilyName(hex),
              next.map((x) => x.name),
            ),
            hex,
            group: group.trim() || 'Brand',
          });
        }
        return next;
      },
      { immediate: true },
    );
    toast.success(`Added ${chosen.length} ${chosen.length === 1 ? 'color' : 'colors'}`);
    onClose();
  };

  return (
    <div
      data-testid="extract-panel"
      className="flex flex-col gap-3 rounded-xl border border-primary/35 bg-primary-soft/40 p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-foreground">
            Colors found in {asset ? `“${asset.name}”` : 'this file'}
          </p>
          <p className="text-xs text-muted-foreground">
            Pick the ones to keep. You can rename them afterwards.
          </p>
        </div>
        <Button size="xs" variant="ghost" onClick={onClose}>
          Dismiss
        </Button>
      </div>
      {ex.state === 'loading' ? (
        <div className="flex gap-2" aria-busy="true" aria-label="Extracting colors">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-14 w-[92px] rounded-md" />
          ))}
        </div>
      ) : ex.state === 'error' ? (
        <Banner
          tone="danger"
          title="Could not read colors"
          action={
            <Button size="xs" variant="outline" onClick={onRetry}>
              <RefreshCw /> Try again
            </Button>
          }
        >
          {ex.message}
        </Banner>
      ) : colors.length === 0 ? (
        <p className="text-sm text-muted-foreground">No distinct colors found in this file.</p>
      ) : (
        <>
          <ul className="flex flex-wrap gap-2" aria-label="Proposed colors">
            {colors.map((hex) => {
              const exists = have.has(hex.toLowerCase());
              const on = picked.has(hex);
              return (
                <li key={hex}>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    aria-label={`${hex.toUpperCase()}${exists ? ' (already in your palette)' : ''}`}
                    disabled={exists}
                    onClick={() =>
                      setPicked((cur) => {
                        const n = new Set(cur);
                        if (n.has(hex)) n.delete(hex);
                        else n.add(hex);
                        return n;
                      })
                    }
                    className={cn(
                      'flex w-[92px] flex-col gap-1 rounded-lg border p-1 text-left outline-none transition-[border-color,opacity] duration-(--duration-fast) focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
                      on
                        ? 'border-primary bg-card'
                        : 'border-border-strong bg-card/50 hover:border-subtle',
                    )}
                  >
                    <span
                      className="relative flex h-12 items-start justify-end rounded-md border border-border-strong p-1"
                      style={{ background: hex }}
                    >
                      {on ? (
                        <span className="flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
                          <Check className="size-3" aria-hidden />
                        </span>
                      ) : null}
                    </span>
                    <span className="px-0.5 font-mono text-2xs uppercase text-foreground">
                      {hex}
                    </span>
                    {exists ? (
                      <span className="px-0.5 text-2xs text-subtle">In palette</span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="flex flex-wrap items-center gap-3">
            <label htmlFor="extract-group" className="text-sm font-medium">
              Add to group
            </label>
            <Input
              id="extract-group"
              value={group}
              maxLength={30}
              onChange={(e) => setGroup(e.target.value)}
              className="h-8 w-40"
            />
            <span className="flex-1" />
            <Button size="sm" variant="primary" disabled={picked.size === 0} onClick={add}>
              Add {picked.size || ''} {picked.size === 1 ? 'color' : 'colors'}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------------------------------- section ---- */

export function ColorsSection() {
  const s = useKitSession();
  const sources = React.useMemo(() => [...s.byKind.logo, ...s.byKind.image], [s.byKind]);
  const [ex, setEx] = React.useState<Extract | null>(null);
  const [sourceId, setSourceId] = React.useState<string>('');
  const seq = React.useRef(0);

  const run = React.useCallback(async (assetId: string) => {
    const my = ++seq.current;
    setEx({ state: 'loading', assetId });
    try {
      const res = await invoke('brand:extractColors', { assetId, count: 6 });
      if (seq.current === my) setEx({ state: 'ready', assetId, colors: res.colors });
    } catch (e) {
      if (seq.current === my)
        setEx({
          state: 'error',
          assetId,
          message: e instanceof Error ? e.message : 'The file could not be analysed.',
        });
    }
  }, []);

  React.useEffect(() => onExtractColorsRequest((id) => void run(id)), [run]);

  const defaultSource = s.spec.watermark.assetId ?? s.byKind.logo[0]?.id ?? sources[0]?.id ?? '';
  const chosen = sources.some((a) => a.id === sourceId) ? sourceId : defaultSource;
  const groups = groupColors(s.spec.colors);
  const full = s.spec.colors.length >= MAX_COLORS;

  return (
    <Section
      id="colors"
      description="Named swatches and palette groups. They appear as choices in every caption and text style."
      badge={
        s.spec.colors.length ? (
          <span className="rounded-full bg-muted px-2 py-0.5 font-sans text-2xs font-semibold tabular-nums text-muted-foreground">
            {s.spec.colors.length}
          </span>
        ) : null
      }
      actions={
        <>
          {sources.length > 1 ? (
            <SelectField
              label="Extract from"
              value={chosen}
              onChange={setSourceId}
              options={sources.map((a) => ({ value: a.id, label: a.name }))}
              className="w-44"
              triggerClassName="h-8"
            />
          ) : null}
          <Button
            variant="outline"
            size="sm"
            disabled={!chosen}
            title={chosen ? undefined : 'Add a logo or image first'}
            onClick={() => chosen && void run(chosen)}
          >
            <Wand2 /> Extract from logo
          </Button>
          <AddColors disabled={full} />
        </>
      }
    >
      {ex ? (
        <ExtractPanel
          key={`${ex.assetId}:${ex.state}:${ex.state === 'ready' ? ex.colors.join() : ''}`}
          ex={ex}
          onClose={() => setEx(null)}
          onRetry={() => void run(ex.assetId)}
        />
      ) : null}

      {groups.length === 0 ? (
        <div className="flex flex-col items-start gap-1">
          <p className="text-sm text-muted-foreground">
            No colors yet. Add your brand colors, or extract them from a logo to get started.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((g) => (
            <div key={g.group} className="flex flex-col gap-1.5" data-testid="color-group">
              <SubHeading>
                {g.group} <span className="ml-1 font-normal text-subtle">{g.colors.length}</span>
              </SubHeading>
              <div className="flex flex-wrap gap-1">
                {g.colors.map((c) => (
                  <Swatch key={c.id} color={c} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {full ? (
        <p className="text-xs text-warning">
          The palette is full (60 colors). Remove one to add more.
        </p>
      ) : null}
    </Section>
  );
}
