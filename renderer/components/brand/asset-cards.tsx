'use client';

import * as React from 'react';
import {
  Check,
  ExternalLink,
  Film,
  ImageIcon,
  Layers,
  MoreHorizontal,
  Music2,
  Palette,
  Pencil,
  Play,
  Trash2,
} from 'lucide-react';
import type { BrandAssetView } from '@shared/brand';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { invoke } from '@/lib/ipc';
import { cn } from '@/lib/utils';
import { formatDur, formatLufs, humanBytes, refsOfAsset, weightName } from '@/lib/brand/helpers';
import { useKitSession } from '@/lib/brand/kit-session';
import { goToSection, requestExtractColors } from '@/lib/brand/bus';
import { MiniPlayer } from './mini-player';
import { toast } from 'sonner';

/** Transparent-pixel checkerboard from tokens (logos are usually transparent PNG/SVG). */
const CHECKER: React.CSSProperties = {
  backgroundImage:
    'conic-gradient(var(--muted) 25%, var(--accent) 0 50%, var(--muted) 0 75%, var(--accent) 0)',
  backgroundSize: '14px 14px',
};

export interface CardActions {
  selected: boolean;
  anySelected: boolean;
  onSelect: (id: string, on: boolean, e: React.MouseEvent) => void;
  onDelete: (a: BrandAssetView) => void;
}

/* ---------------------------------------------------------------------------------- name editor ---- */

function NameEditor({
  asset,
  editing,
  setEditing,
}: {
  asset: BrandAssetView;
  editing: boolean;
  setEditing: (v: boolean) => void;
}) {
  if (!editing)
    return (
      <span className="truncate text-sm font-medium text-foreground" title={asset.name}>
        {asset.name}
      </span>
    );
  return <RenameInput asset={asset} onDone={() => setEditing(false)} />;
}

/** Mounted only while renaming, so its text always starts from the current name. */
function RenameInput({ asset, onDone }: { asset: BrandAssetView; onDone: () => void }) {
  const { renameAsset } = useKitSession();
  const [val, setVal] = React.useState(asset.name);
  const done = React.useRef(false);
  const commit = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    onDone();
    const v = val.trim();
    if (save && v && v !== asset.name) void renameAsset(asset.id, v.slice(0, 120));
  };
  return (
    <input
      autoFocus
      aria-label={`Rename ${asset.name}`}
      value={val}
      maxLength={120}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setVal(e.target.value)}
      onBlur={() => commit(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit(true);
        else if (e.key === 'Escape') commit(false);
        e.stopPropagation();
      }}
      className="h-6 min-w-0 flex-1 rounded-sm border border-ring bg-field px-1.5 text-sm text-foreground outline-none ring-2 ring-ring/25"
    />
  );
}

/* ----------------------------------------------------------------------------------- shared card ---- */

function CardShell({
  asset,
  actions,
  menuExtra,
  children,
  footer,
  badges,
  className,
  editing,
  setEditing,
  layout = 'overlay',
  testId = 'asset-card',
}: {
  asset: BrandAssetView;
  actions: CardActions;
  menuExtra?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  badges?: React.ReactNode;
  className?: string;
  editing: boolean;
  setEditing: (v: boolean) => void;
  /** `overlay`: controls float over the preview and the name sits underneath. `header`: a title row on top (audio). */
  layout?: 'overlay' | 'header';
  testId?: string;
}) {
  const { freshIds } = useKitSession();
  const select = (
    <span
      className={cn(
        'transition-opacity duration-(--duration-fast) focus-within:opacity-100 group-hover/card:opacity-100',
        layout === 'header' || actions.anySelected || actions.selected
          ? 'opacity-100'
          : 'opacity-0',
      )}
    >
      <Checkbox
        checked={actions.selected}
        aria-label={`Select ${asset.name}`}
        onCheckedChange={(v, e) => actions.onSelect(asset.id, v, e)}
        className="shadow-xs"
      />
    </span>
  );
  const menu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Actions for ${asset.name}`}
          className={cn(
            'flex size-7 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-[opacity,background-color] duration-(--duration-fast) hover:text-foreground focus-visible:opacity-100 group-hover/card:opacity-100 data-[state=open]:opacity-100',
            layout === 'overlay'
              ? 'bg-card/90 shadow-xs backdrop-blur-sm hover:bg-card'
              : 'hover:bg-accent',
          )}
        >
          <MoreHorizontal className="size-4" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onSelect={() => setEditing(true)}>
          <Pencil /> Rename
        </DropdownMenuItem>
        {menuExtra}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-danger [&_svg]:!text-danger"
          onSelect={() => actions.onDelete(asset)}
        >
          <Trash2 /> Delete…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
  return (
    <div
      data-testid={testId}
      data-asset-id={asset.id}
      data-selected={actions.selected || undefined}
      className={cn(
        'group/card relative flex h-full flex-col overflow-hidden rounded-lg border bg-card transition-[border-color,box-shadow,transform] duration-(--duration-base) ease-(--ease-standard)',
        'hover:border-border-strong hover:shadow-sm focus-within:border-border-strong',
        actions.selected && 'border-primary shadow-[0_0_0_1px_var(--primary)]',
        freshIds.has(asset.id) && 'animate-arrive',
        className,
      )}
    >
      {layout === 'header' ? (
        <div className="flex min-w-0 items-center gap-2 px-2.5 pt-2.5">
          {select}
          <div className="flex min-w-0 flex-1 items-center">
            <NameEditor asset={asset} editing={editing} setEditing={setEditing} />
          </div>
          {badges}
          {menu}
        </div>
      ) : null}
      {children}
      {layout === 'overlay' ? (
        <>
          <div className="absolute left-2 top-2 flex items-center gap-1.5">
            {select}
            {badges}
          </div>
          <div className="absolute right-2 top-2">{menu}</div>
        </>
      ) : null}
      <div
        className={cn(
          'flex min-w-0 flex-col gap-0.5 px-2.5 py-2',
          layout === 'overlay' && 'border-t',
        )}
      >
        {layout === 'overlay' ? (
          <div className="flex min-w-0 items-center gap-2">
            <NameEditor asset={asset} editing={editing} setEditing={setEditing} />
          </div>
        ) : null}
        {footer}
      </div>
    </div>
  );
}

const Meta = ({ children }: { children: React.ReactNode }) => (
  <span className="truncate text-xs text-muted-foreground">{children}</span>
);

function UsedBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-2xs font-semibold text-primary-foreground shadow-xs">
      <Check className="size-3" aria-hidden />
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------------------ logo / image card ---- */

export function ImageCard({ asset, actions }: { asset: BrandAssetView; actions: CardActions }) {
  const s = useKitSession();
  const [editing, setEditing] = React.useState(false);
  const refs = refsOfAsset(s.spec, asset.id);
  const src = asset.thumbUrl ?? asset.url;
  const dims = asset.width && asset.height ? `${asset.width}×${asset.height}` : null;
  const isWatermark = refs.includes('Watermark');
  return (
    <CardShell
      asset={asset}
      actions={actions}
      editing={editing}
      setEditing={setEditing}
      badges={isWatermark ? <UsedBadge>Watermark</UsedBadge> : null}
      menuExtra={
        <>
          <DropdownMenuItem
            onSelect={() => {
              s.update('watermark', (w) => ({ ...w, assetId: asset.id }), { immediate: true });
              toast.success('Watermark set', {
                description: asset.name,
                action: { label: 'Adjust', onClick: () => goToSection('watermark') },
              });
            }}
          >
            <Layers /> Use as watermark
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              goToSection('colors');
              requestExtractColors(asset.id);
            }}
          >
            <Palette /> Extract colors
          </DropdownMenuItem>
        </>
      }
      footer={
        <Meta>
          {[dims, humanBytes(asset.bytes), asset.ext.toUpperCase()].filter(Boolean).join(' · ')}
        </Meta>
      }
    >
      <div className="relative min-h-0 flex-1" style={CHECKER}>
        {src ? (
          <img
            src={src}
            alt={asset.name}
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={s.reportAssetError}
            className="size-full object-contain p-3"
          />
        ) : (
          <div className="flex size-full items-center justify-center text-subtle">
            <ImageIcon className="size-6" aria-hidden />
          </div>
        )}
      </div>
    </CardShell>
  );
}

/* ------------------------------------------------------------------------------------ video card ---- */

export function VideoCard({ asset, actions }: { asset: BrandAssetView; actions: CardActions }) {
  const s = useKitSession();
  const [editing, setEditing] = React.useState(false);
  const [hover, setHover] = React.useState(false);
  const [pinned, setPinned] = React.useState(false);
  const refs = refsOfAsset(s.spec, asset.id);
  const play = hover || pinned;
  const dims = asset.width && asset.height ? `${asset.width}×${asset.height}` : null;
  const credit = asset.credit;
  const reduce =
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  return (
    <CardShell
      asset={asset}
      actions={actions}
      editing={editing}
      setEditing={setEditing}
      badges={
        <>
          {refs.includes('Intro') ? <UsedBadge>Intro</UsedBadge> : null}
          {refs.includes('Outro') ? <UsedBadge>Outro</UsedBadge> : null}
        </>
      }
      menuExtra={
        <>
          <DropdownMenuItem
            onSelect={() => s.edit({ introAssetId: asset.id }, { immediate: true })}
          >
            <Film /> Use as intro
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => s.edit({ outroAssetId: asset.id }, { immediate: true })}
          >
            <Film /> Use as outro
          </DropdownMenuItem>
        </>
      }
      footer={
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="truncate">
            {[
              dims,
              asset.durationSec ? formatDur(asset.durationSec) : null,
              credit ? null : humanBytes(asset.bytes),
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
          {credit ? (
            <button
              type="button"
              disabled={!credit.url}
              onClick={() => credit.url && void invoke('shell:openExternal', { url: credit.url })}
              title={credit.url ? `Open ${credit.source} page` : undefined}
              className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-sm text-primary-text hover:underline disabled:text-muted-foreground disabled:no-underline"
            >
              {credit.source === 'pexels'
                ? 'Pexels'
                : credit.source === 'pixabay'
                  ? 'Pixabay'
                  : credit.source}
              {credit.author ? ` · ${credit.author}` : ''}
              {credit.url ? <ExternalLink className="size-3" aria-hidden /> : null}
            </button>
          ) : null}
        </span>
      }
    >
      <div
        className="relative min-h-0 flex-1 overflow-hidden bg-muted"
        onMouseEnter={() => !reduce && setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        {asset.thumbUrl ? (
          <img
            src={asset.thumbUrl}
            alt=""
            loading="lazy"
            draggable={false}
            onError={s.reportAssetError}
            className="size-full object-cover"
          />
        ) : (
          <div className="flex size-full items-center justify-center text-subtle">
            <Film className="size-6" aria-hidden />
          </div>
        )}
        {play && asset.previewUrl ? (
          <video
            src={asset.previewUrl}
            muted
            loop
            autoPlay
            playsInline
            aria-label={`Preview of ${asset.name}`}
            className="absolute inset-0 size-full object-cover"
          />
        ) : null}
        {asset.previewUrl ? (
          <button
            type="button"
            aria-label={`${pinned ? 'Stop' : 'Play'} preview of ${asset.name}`}
            aria-pressed={pinned}
            onClick={() => setPinned((v) => !v)}
            className={cn(
              'absolute bottom-2 left-2 flex size-7 items-center justify-center rounded-full bg-card/90 text-foreground shadow-xs backdrop-blur-sm transition-opacity duration-(--duration-fast) hover:bg-card focus-visible:opacity-100',
              play ? 'opacity-0' : 'opacity-100',
            )}
          >
            <Play className="size-3.5" fill="currentColor" aria-hidden />
          </button>
        ) : null}
        {asset.durationSec ? (
          <span className="absolute bottom-2 right-2 rounded-sm bg-card/90 px-1.5 py-0.5 font-mono text-2xs tabular-nums text-foreground shadow-xs">
            {formatDur(asset.durationSec)}
          </span>
        ) : null}
      </div>
    </CardShell>
  );
}

/* ------------------------------------------------------------------------------------ audio card ---- */

export function AudioCard({ asset, actions }: { asset: BrandAssetView; actions: CardActions }) {
  const s = useKitSession();
  const [editing, setEditing] = React.useState(false);
  const isBed = s.spec.musicBed.assetId === asset.id;
  const lufs = formatLufs(asset.loudnessLufs);
  return (
    <CardShell
      asset={asset}
      actions={actions}
      editing={editing}
      setEditing={setEditing}
      layout="header"
      menuExtra={
        <DropdownMenuItem
          onSelect={() =>
            s.update('musicBed', (m) => ({ ...m, assetId: asset.id }), { immediate: true })
          }
        >
          <Music2 /> Use as music bed
        </DropdownMenuItem>
      }
      footer={
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="truncate">
            {[formatDur(asset.durationSec), asset.ext.toUpperCase(), humanBytes(asset.bytes)].join(
              ' · ',
            )}
          </span>
          {isBed ? (
            <span className="shrink-0 rounded-full bg-primary-soft px-1.5 py-px text-2xs font-semibold text-primary-text">
              Music bed
            </span>
          ) : null}
          {lufs ? (
            <span
              className="ml-auto shrink-0 rounded-full bg-muted px-1.5 py-px font-mono text-2xs tabular-nums text-foreground"
              title="Integrated loudness of your original file. The preview you hear is normalised to -14 LUFS."
            >
              {lufs}
            </span>
          ) : null}
        </span>
      }
    >
      <div className="flex flex-1 items-center px-3 pt-2">
        <MiniPlayer
          className="w-full"
          src={asset.previewUrl}
          name={asset.name}
          durationSec={asset.durationSec}
        />
      </div>
    </CardShell>
  );
}

/* ------------------------------------------------------------------------------------- font card ---- */

export function FontCard({
  asset,
  actions,
  sample,
}: {
  asset: BrandAssetView;
  actions: CardActions;
  sample: string;
}) {
  const [editing, setEditing] = React.useState(false);
  const f = asset.font;
  const family = f?.family ?? asset.name;
  return (
    <CardShell
      asset={asset}
      actions={actions}
      editing={editing}
      setEditing={setEditing}
      footer={
        <Meta>
          {f
            ? `${family} · ${weightName(f.weight)} ${f.weight}${f.italic ? ' · Italic' : ''}`
            : 'Reading font…'}{' '}
          · {asset.ext.toUpperCase()}
        </Meta>
      }
    >
      <div className="flex min-h-0 flex-1 items-center overflow-hidden px-4 pb-1 pt-7">
        <p
          data-testid="font-sample"
          className="line-clamp-2 w-full break-words text-[26px] leading-[1.15] text-foreground"
          style={{
            fontFamily: f ? `"${f.family}", var(--font-sans)` : undefined,
            fontWeight: f?.weight ?? 400,
            fontStyle: f?.italic ? 'italic' : 'normal',
          }}
        >
          {sample || family}
        </p>
      </div>
    </CardShell>
  );
}
