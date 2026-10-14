'use client';

import * as React from 'react';
import { CheckCircle2, CircleAlert, Loader2, UploadCloud, X } from 'lucide-react';
import { BRAND_FORMATS, type BrandAssetKind } from '@shared/brand';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { KIND_NOUN, stageLabel } from '@/lib/brand/helpers';
import { useKitSession } from '@/lib/brand/kit-session';
import { rowsOfKind, type UploadRow } from '@/lib/brand/uploads';

/**
 * The upload panel every asset section shares (BRIEF §7): "Drop a file here, or browse." with the supported formats
 * under it. Dropped files go through `window.clipfern.pathForFile` → `brand:addFiles`; "browse" opens the native file
 * dialog (`brand:browse`). Wrong file types are rejected on the spot with a clear message.
 */
export function UploadPanel({
  kind,
  compact,
}: {
  kind: BrandAssetKind;
  /** Slim single-row layout once the section already has files. */
  compact?: boolean;
}) {
  const s = useKitSession();
  const fmt = BRAND_FORMATS[kind];
  const noun = KIND_NOUN[kind];
  const [over, setOver] = React.useState(false);
  const depth = React.useRef(0);
  const rows = rowsOfKind(s.uploads, kind);
  const busy = rows.some((r) => r.state !== 'error');

  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  const onEnter = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth.current += 1;
    setOver(true);
  };
  const onLeave = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setOver(false);
  };
  const onDrop = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth.current = 0;
    setOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length) void s.addFiles(kind, files);
  };

  return (
    <div className="flex flex-col gap-2.5">
      <div
        role="group"
        aria-label={`${noun.section} upload`}
        data-testid={`upload-${kind}`}
        data-over={over || undefined}
        onDragEnter={onEnter}
        onDragOver={(e) => {
          if (hasFiles(e)) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
          }
        }}
        onDragLeave={onLeave}
        onDrop={onDrop}
        className={cn(
          'relative flex items-center rounded-xl border border-dashed text-center transition-[border-color,background-color,transform,box-shadow] duration-(--duration-base) ease-(--ease-standard)',
          compact ? 'gap-3.5 px-4 py-3 text-left' : 'flex-col justify-center gap-1.5 px-4 py-7',
          over
            ? 'scale-[1.005] border-primary bg-primary-soft shadow-[0_0_0_4px_var(--primary-soft)]'
            : 'border-border-strong bg-muted/30 hover:border-subtle',
        )}
      >
        <span
          className={cn(
            'flex shrink-0 items-center justify-center rounded-lg transition-colors duration-(--duration-fast)',
            compact ? 'size-9' : 'mb-1 size-10',
            over ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
          )}
        >
          {busy ? (
            <Loader2 className="size-[18px] animate-spin" aria-hidden />
          ) : (
            <UploadCloud className="size-[18px]" aria-hidden />
          )}
        </span>
        <p className={cn('text-sm font-medium text-foreground', compact && 'min-w-0 flex-1')}>
          {over ? (
            <>Drop to add {noun.many}</>
          ) : (
            <>
              Drop a file here, or{' '}
              <button
                type="button"
                onClick={() => void s.browse(kind)}
                aria-label={`Browse for ${noun.many}`}
                className="rounded-xs text-primary-text underline underline-offset-2 hover:text-foreground"
              >
                browse
              </button>
              .
            </>
          )}{' '}
          <span className="block text-xs font-normal text-muted-foreground">
            Supported: {fmt.label}
          </span>
        </p>
      </div>
      <UploadRows rows={rows} kind={kind} />
    </div>
  );
}

function UploadRows({ rows, kind }: { rows: UploadRow[]; kind: BrandAssetKind }) {
  const s = useKitSession();
  if (!rows.length) return null;
  return (
    <ul className="flex flex-col gap-1.5" aria-label="Upload progress" aria-live="polite">
      {rows.map((r) => (
        <li
          key={r.id}
          data-testid={`upload-row-${r.state}`}
          className={cn(
            'flex items-center gap-3 rounded-lg border px-3 py-2 text-sm',
            r.state === 'error' ? 'border-danger/35 bg-danger-soft' : 'bg-muted/40',
          )}
        >
          {r.state === 'error' ? (
            <CircleAlert className="size-4 shrink-0 text-danger" aria-hidden />
          ) : r.state === 'done' ? (
            <CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden />
          ) : (
            <Loader2 className="size-4 shrink-0 animate-spin text-primary-text" aria-hidden />
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium text-foreground">{r.name}</p>
            {r.state === 'error' ? (
              <p role="alert" className="text-xs text-muted-foreground">
                {r.message}
              </p>
            ) : (
              <div className="mt-1 flex items-center gap-2">
                <div
                  role="progressbar"
                  aria-label={`${r.name} progress`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={r.fraction === null ? undefined : Math.round(r.fraction * 100)}
                  className="h-1 flex-1 overflow-hidden rounded-full bg-border-strong"
                >
                  <div
                    className={cn(
                      'h-full rounded-full bg-primary transition-[width] duration-(--duration-base) ease-(--ease-standard)',
                      r.fraction === null && 'w-1/3 animate-indeterminate',
                    )}
                    style={r.fraction === null ? undefined : { width: `${Math.round(r.fraction * 100)}%` }}
                  />
                </div>
                <span className="w-32 shrink-0 text-right text-xs text-muted-foreground">
                  {r.state === 'done' ? 'Done' : stageLabel(r.stage)}
                  {r.fraction !== null && r.state !== 'done' ? ` ${Math.round(r.fraction * 100)}%` : ''}
                </span>
              </div>
            )}
          </div>
          {r.state === 'error' ? (
            <div className="flex shrink-0 items-center gap-1">
              <Button size="xs" variant="outline" onClick={() => void s.browse(kind)}>
                Choose another file
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Dismiss error for ${r.name}`}
                onClick={() => s.dismissUpload(r.id)}
              >
                <X />
              </Button>
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
