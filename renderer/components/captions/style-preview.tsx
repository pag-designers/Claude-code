'use client';

import * as React from 'react';
import { ImageOff, Loader2, RefreshCw, TriangleAlert } from 'lucide-react';
import type { CaptionStyle } from '@shared/cp2';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { usePreview } from '@/lib/cp2-captions';

export const PREVIEW_DEBOUNCE_MS = 250;
/** Portrait safe area: where platform UI (captions, buttons, progress bar) leaves room (percent of the frame). */
const SAFE = { top: 8, bottom: 22, side: 6 } as const;

/**
 * The big live preview: a real libass render, requested 250 ms after the last edit. The previous image stays visible
 * (dimmed) while the next one renders, so dragging a slider never flashes empty. `style === null` means the draft is
 * invalid: nothing is requested and the last good image stays.
 */
export function StylePreview({
  style,
  clipId,
  invalidMessage,
}: {
  style: CaptionStyle | null;
  clipId?: string;
  invalidMessage?: string | null;
}) {
  const [word, setWord] = React.useState(1);
  const [sample, setSample] = React.useState<'default' | 'long'>('default');
  const [guides, setGuides] = React.useState(false);

  const text =
    sample === 'long' ? 'Nobody told me it would feel this good to finally ship it' : undefined;
  const request = React.useMemo(
    () => (style ? { style, text, clipId, activeWord: word } : null),
    [style, text, clipId, word],
  );
  const signature = request
    ? JSON.stringify([request.style, request.text, request.clipId, request.activeWord])
    : '';
  // The request is committed 250 ms after the last change; the first one is immediate. An invalid draft (request = null)
  // never replaces the committed request, so the last good image stays on screen.
  const reqRef = React.useRef(request);
  React.useEffect(() => {
    reqRef.current = request;
  });
  const [committed, setCommitted] = React.useState<{ sig: string; req: typeof request }>(() => ({
    sig: signature,
    req: request,
  }));
  React.useEffect(() => {
    if (!signature || committed.sig === signature) return;
    const id = window.setTimeout(
      () => setCommitted({ sig: signature, req: reqRef.current }),
      PREVIEW_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(id);
  }, [signature, committed.sig]);
  const p = usePreview(committed.req, 'live');
  const pending = !!signature && committed.sig !== signature;
  const busy = p.loading || pending;
  const yPct = style?.layout.yPct;

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center gap-3" data-testid="style-preview">
      <div
        className="relative min-h-0 w-full flex-1"
        style={{ containerType: 'size' }}
        data-state={p.error ? 'error' : busy ? 'loading' : 'ready'}
      >
        <div
          className="absolute left-1/2 top-1/2 overflow-hidden rounded-xl border border-border-strong bg-muted shadow-md"
          style={{
            aspectRatio: p.image ? `${p.image.width} / ${p.image.height}` : '9 / 16',
            height: 'min(100cqh, calc(100cqw * 16 / 9))',
            transform: 'translate(-50%, -50%)',
          }}
        >
          {p.image ? (
            <img
              src={p.image.dataUrl}
              alt="Live caption preview"
              data-testid="style-preview-img"
              draggable={false}
              className={cn(
                'size-full object-cover transition-opacity duration-(--duration-base)',
                busy && 'opacity-55',
              )}
            />
          ) : p.error ? null : (
            <div className="flex size-full items-center justify-center bg-muted text-subtle">
              <Loader2 className="size-5 animate-spin" aria-label="Rendering preview" />
            </div>
          )}
          {guides ? (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0"
              data-testid="safe-guide"
            >
              <div
                className="absolute border border-dashed border-primary-text/80"
                style={{
                  top: `${SAFE.top}%`,
                  bottom: `${SAFE.bottom}%`,
                  left: `${SAFE.side}%`,
                  right: `${SAFE.side}%`,
                }}
              />
              {yPct !== undefined ? (
                <div
                  className="absolute inset-x-0 h-px bg-primary-text/90"
                  style={{ top: `${yPct}%` }}
                />
              ) : null}
              <span className="absolute left-[7%] top-[9%] rounded bg-popover/80 px-1.5 py-0.5 text-2xs font-medium text-muted-foreground">
                Safe area
              </span>
            </div>
          ) : null}
          {busy && p.image ? (
            <span className="absolute right-2 top-2 flex items-center gap-1.5 rounded-full bg-popover/85 px-2 py-1 text-2xs font-medium text-muted-foreground backdrop-blur">
              <Loader2 className="size-3 animate-spin" aria-hidden /> Updating
            </span>
          ) : null}
          {p.error ? (
            <div
              role="alert"
              className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-popover/90 p-5 text-center"
            >
              <ImageOff className="size-5 text-danger" aria-hidden />
              <p className="text-sm font-semibold">Could not render the preview</p>
              <p className="selectable max-w-64 text-xs text-muted-foreground">{p.error}</p>
              <Button size="sm" variant="outline" onClick={p.retry}>
                <RefreshCw /> Retry
              </Button>
            </div>
          ) : null}
        </div>
      </div>

      {/* always reserved, so the preview does not jump when a field becomes invalid */}
      <p role="status" className="flex min-h-4 items-center gap-1.5 text-xs text-warning">
        {invalidMessage ? (
          <>
            <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
            {invalidMessage}
          </>
        ) : null}
      </p>

      <div className="flex w-full flex-wrap items-center justify-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Active word</span>
          <Segmented
            size="sm"
            label="Active word"
            value={String(word)}
            onValueChange={(v) => setWord(Number(v))}
            options={[0, 1, 2, 3].map((n) => ({ value: String(n), label: String(n + 1) }))}
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Sample</span>
          <Segmented
            size="sm"
            label="Sample text"
            value={sample}
            onValueChange={setSample}
            options={[
              { value: 'default', label: 'Short' },
              { value: 'long', label: 'Long' },
            ]}
          />
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <Switch checked={guides} onCheckedChange={setGuides} aria-label="Safe area guide" />
          Safe area
        </label>
      </div>
    </div>
  );
}
