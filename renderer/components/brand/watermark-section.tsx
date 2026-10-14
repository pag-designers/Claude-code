'use client';

import * as React from 'react';
import { ImageIcon, Stamp } from 'lucide-react';
import {
  safeInsets,
  type BrandAssetView,
  type Watermark,
  type WatermarkPosition,
} from '@shared/brand';
import { SAFE_AREAS } from '@shared/editor';
import { Segmented } from '@/components/ui/segmented';
import { cn } from '@/lib/utils';
import {
  PREVIEW_ASPECTS,
  assetAspect,
  watermarkPreviewBox,
  type PreviewAspect,
} from '@/lib/brand/helpers';
import { goToSection } from '@/lib/brand/bus';
import { useKitSession } from '@/lib/brand/kit-session';
import { FieldRow, SelectField, SliderRow, SwitchRow } from './controls';
import { PhoneFrame } from './phone-frame';
import { Section } from './section';

const POSITIONS: { id: WatermarkPosition; label: string; cell: string }[] = [
  { id: 'top-left', label: 'Top left', cell: 'col-start-1 row-start-1' },
  { id: 'top-right', label: 'Top right', cell: 'col-start-3 row-start-1' },
  { id: 'center', label: 'Center', cell: 'col-start-2 row-start-2' },
  { id: 'bottom-left', label: 'Bottom left', cell: 'col-start-1 row-start-3' },
  { id: 'bottom-right', label: 'Bottom right', cell: 'col-start-3 row-start-3' },
];

const SAFE_OPTIONS: { value: Watermark['safeArea']; label: string }[] = [
  { value: 'all', label: 'All platforms (TikTok, Reels, Shorts)' },
  { value: 'tiktok', label: 'TikTok' },
  { value: 'reels', label: 'Instagram Reels' },
  { value: 'shorts', label: 'YouTube Shorts' },
  { value: 'none', label: 'None (margin only)' },
];

function PositionGrid({
  value,
  onChange,
}: {
  value: WatermarkPosition;
  onChange: (v: WatermarkPosition) => void;
}) {
  const refs = React.useRef<Record<string, HTMLButtonElement | null>>({});
  const move = (from: number, dir: 1 | -1) => {
    const n = POSITIONS.length;
    const next = POSITIONS[(from + dir + n) % n]!;
    onChange(next.id);
    refs.current[next.id]?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label="Watermark position"
      className="grid aspect-[9/12] w-[104px] grid-cols-3 grid-rows-3 gap-1 rounded-lg border bg-muted p-1.5"
    >
      {POSITIONS.map((p, i) => {
        const on = p.id === value;
        return (
          <button
            key={p.id}
            ref={(el) => {
              refs.current[p.id] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={p.label}
            title={p.label}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(p.id)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                e.preventDefault();
                move(i, 1);
              } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault();
                move(i, -1);
              }
            }}
            className={cn(
              p.cell,
              'rounded-md border transition-[background-color,border-color,transform] duration-(--duration-fast) active:scale-90',
              on
                ? 'border-primary bg-primary shadow-xs'
                : 'border-border-strong bg-card hover:border-subtle hover:bg-accent',
            )}
          />
        );
      })}
    </div>
  );
}

function AssetChoice({
  asset,
  active,
  onPick,
}: {
  asset: BrandAssetView;
  active: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      aria-label={asset.name}
      title={asset.name}
      onClick={onPick}
      className={cn(
        'relative flex size-14 items-center justify-center overflow-hidden rounded-lg border bg-muted transition-[border-color,box-shadow] duration-(--duration-fast) hover:border-subtle',
        active && 'border-primary shadow-[0_0_0_1px_var(--primary)]',
      )}
    >
      {(asset.thumbUrl ?? asset.url) ? (
        <img
          src={(asset.thumbUrl ?? asset.url) as string}
          alt=""
          draggable={false}
          className="size-full object-contain p-1.5"
        />
      ) : (
        <ImageIcon className="size-5 text-subtle" aria-hidden />
      )}
    </button>
  );
}

export function WatermarkSection() {
  const s = useKitSession();
  const wm = s.spec.watermark;
  const set = (patch: Partial<Watermark>, immediate = false) =>
    s.update('watermark', (w) => ({ ...w, ...patch }), { immediate });
  const candidates = [...s.byKind.logo, ...s.byKind.image];
  const asset = s.assetById(wm.assetId);
  const [aspect, setAspect] = React.useState<PreviewAspect>(s.spec.defaults.aspect);
  const [guide, setGuide] = React.useState<'none' | 'tiktok' | 'reels' | 'shorts' | 'all'>('all');

  const box = watermarkPreviewBox(aspect, wm, assetAspect(asset));
  const vertical = box.canvas.height >= box.canvas.width * 0.9;
  const ins = safeInsets(guide === 'none' ? 'none' : guide, vertical);
  const imgSrc = asset ? (asset.url ?? asset.thumbUrl) : null;

  return (
    <Section
      id="watermark"
      description="Your logo on every clip: position, size and opacity, kept clear of each platform’s buttons and captions."
    >
      <div className="grid gap-6 @3xl:grid-cols-[minmax(0,1fr)_minmax(240px,300px)]">
        <div className="flex min-w-0 flex-col gap-5">
          <FieldRow label="Logo">
            {candidates.length ? (
              <div role="radiogroup" aria-label="Watermark logo" className="flex flex-wrap gap-2">
                <button
                  type="button"
                  role="radio"
                  aria-checked={wm.assetId === null}
                  aria-label="No watermark logo"
                  title="None"
                  onClick={() => set({ assetId: null }, true)}
                  className={cn(
                    'flex size-14 items-center justify-center rounded-lg border border-dashed text-xs text-muted-foreground transition-colors hover:border-subtle',
                    wm.assetId === null && 'border-primary text-primary-text',
                  )}
                >
                  None
                </button>
                {candidates.map((a) => (
                  <AssetChoice
                    key={a.id}
                    asset={a}
                    active={wm.assetId === a.id}
                    onPick={() => set({ assetId: a.id }, true)}
                  />
                ))}
              </div>
            ) : (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Stamp className="size-4 text-subtle" aria-hidden />
                <span>
                  No logo to choose yet.{' '}
                  <button
                    type="button"
                    onClick={() => goToSection('logos')}
                    className="rounded-xs text-primary-text underline underline-offset-2"
                  >
                    Add one in Logos / Watermarks
                  </button>
                  .
                </span>
              </p>
            )}
          </FieldRow>

          <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
            <FieldRow label="Position">
              <PositionGrid value={wm.position} onChange={(position) => set({ position }, true)} />
            </FieldRow>
            <div className="flex min-w-[240px] flex-1 flex-col gap-3.5">
              <SliderRow
                label="Size"
                value={wm.sizePct}
                min={3}
                max={60}
                step={0.5}
                decimals={1}
                unit="%"
                hint="Logo width as a share of the frame width."
                onChange={(sizePct) => set({ sizePct })}
              />
              <SliderRow
                label="Opacity"
                value={Math.round(wm.opacity * 100)}
                min={5}
                max={100}
                unit="%"
                onChange={(v) => set({ opacity: v / 100 })}
              />
              <SliderRow
                label="Margin"
                value={wm.marginPct}
                min={0}
                max={15}
                step={0.5}
                decimals={1}
                unit="%"
                hint="Distance from the edge, as a share of the short side."
                onChange={(marginPct) => set({ marginPct })}
              />
            </div>
          </div>

          <FieldRow
            label="Safe area"
            htmlFor="wm-safe"
            hint="Keeps the logo out of the zones where TikTok, Reels and Shorts draw their own interface."
          >
            <SelectField
              id="wm-safe"
              label="Safe area"
              value={wm.safeArea}
              options={SAFE_OPTIONS}
              onChange={(safeArea) => set({ safeArea }, true)}
              className="max-w-sm"
            />
          </FieldRow>
          <SwitchRow
            label="Add the watermark to new clips"
            description="Turn off to keep the logo set up here but leave it off by default."
            checked={s.spec.defaults.watermarkOn}
            onChange={(v) =>
              s.update('defaults', (d) => ({ ...d, watermarkOn: v }), { immediate: true })
            }
          />
        </div>

        <div className="flex min-w-0 flex-col items-center gap-3">
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            <Segmented
              size="sm"
              label="Preview format"
              value={aspect}
              onValueChange={setAspect}
              options={PREVIEW_ASPECTS.map((a) => ({ value: a, label: a }))}
            />
          </div>
          <div
            className={cn(
              'w-full',
              aspect === '16:9'
                ? 'max-w-[300px]'
                : aspect === '1:1'
                  ? 'max-w-[240px]'
                  : aspect === '4:5'
                    ? 'max-w-[220px]'
                    : 'max-w-[190px]',
            )}
          >
            <PhoneFrame
              width={box.canvas.width}
              height={box.canvas.height}
              label={`Watermark preview, ${aspect}`}
              testId="watermark-preview"
              className="w-full"
            >
              {vertical && guide !== 'none' ? (
                <div
                  aria-hidden
                  data-testid="safe-overlay"
                  className="pointer-events-none absolute inset-0"
                >
                  <div
                    className="absolute inset-x-0 top-0 bg-danger/15"
                    style={{ height: `${ins.top * 100}%` }}
                  />
                  <div
                    className="absolute inset-x-0 bottom-0 bg-danger/15"
                    style={{ height: `${ins.bottom * 100}%` }}
                  />
                  <div
                    className="absolute inset-y-0 left-0 bg-danger/15"
                    style={{ width: `${ins.left * 100}%` }}
                  />
                  <div
                    className="absolute inset-y-0 right-0 bg-danger/15"
                    style={{ width: `${ins.right * 100}%` }}
                  />
                  <div
                    className="absolute border border-dashed border-danger/60"
                    style={{
                      top: `${ins.top * 100}%`,
                      bottom: `${ins.bottom * 100}%`,
                      left: `${ins.left * 100}%`,
                      right: `${ins.right * 100}%`,
                    }}
                  />
                </div>
              ) : null}
              <div
                data-testid="watermark-box"
                data-rect={`${box.rect.x},${box.rect.y},${box.rect.w},${box.rect.h}`}
                data-canvas={`${box.canvas.width}x${box.canvas.height}`}
                className="absolute"
                style={{
                  left: `${box.left}%`,
                  top: `${box.top}%`,
                  width: `${box.width}%`,
                  height: `${box.height}%`,
                  opacity: wm.opacity,
                  transition:
                    'left 200ms var(--ease-standard), top 200ms var(--ease-standard), width 120ms linear, height 120ms linear',
                }}
              >
                {imgSrc ? (
                  <img
                    src={imgSrc}
                    alt={asset?.name ?? 'Watermark'}
                    draggable={false}
                    className="size-full object-contain"
                  />
                ) : (
                  <div className="flex size-full items-center justify-center rounded-sm border border-dashed border-primary-text/70 bg-primary-soft text-primary-text">
                    <Stamp className="size-[40%]" aria-hidden />
                  </div>
                )}
              </div>
            </PhoneFrame>
          </div>
          <p className="text-center text-xs text-muted-foreground" data-testid="watermark-readout">
            {box.rect.w}×{box.rect.h} px at ({box.rect.x}, {box.rect.y}) on {box.canvas.width}×
            {box.canvas.height}
          </p>
          {vertical ? (
            <FieldRow label="Guides" className="w-full items-center">
              <Segmented
                size="sm"
                label="Safe-area guides"
                value={guide}
                onValueChange={setGuide}
                options={[
                  { value: 'none', label: 'Off' },
                  { value: 'all', label: 'All' },
                  { value: 'tiktok', label: SAFE_AREAS.tiktok!.label },
                  { value: 'reels', label: 'Reels' },
                  { value: 'shorts', label: 'Shorts' },
                ]}
              />
            </FieldRow>
          ) : (
            <p className="text-center text-xs text-subtle">
              Platform interface only covers vertical video, so no safe-area guides here.
            </p>
          )}
        </div>
      </div>
    </Section>
  );
}
