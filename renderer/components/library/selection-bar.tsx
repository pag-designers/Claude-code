'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { CalendarClock, Download, PencilRuler, Star, Trash2, X } from 'lucide-react';
import type { ClipView } from '@shared/pipeline';
import { ApplyBrandPopover } from '@/components/brand-apply/apply-popover';
import { Button } from '@/components/ui/button';
import { DisabledTip } from '@/components/ui/tooltip';
import { spring } from '@/lib/motion';

const LATER = 'Coming in a later version';

/** Floating bulk-action bar; slides in when at least one clip is selected. */
export function SelectionBar({
  count,
  allFavorite,
  downloading,
  onDownload,
  onFavorite,
  onDelete,
  onClear,
  onOpenEditor,
  openingEditor,
  selectedClips,
}: {
  count: number;
  allFavorite: boolean;
  downloading?: boolean;
  onDownload: () => void;
  onFavorite: () => void;
  onDelete: () => void;
  onClear: () => void;
  /** Provided when exactly one clip is selected; otherwise the button explains why it is off. */
  onOpenEditor?: () => void;
  openingEditor?: boolean;
  /** The selected clips; enables "Apply Brand Kit…" (re-renders them with the chosen kit after a confirm). */
  selectedClips?: readonly ClipView[];
}) {
  return (
    <AnimatePresence>
      {count > 0 ? (
        <motion.div
          key="bar"
          initial={{ opacity: 0, y: 24, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 24, scale: 0.98 }}
          transition={spring.snappy}
          role="toolbar"
          aria-label="Selected clips"
          data-testid="selection-bar"
          className="sticky bottom-6 z-20 mx-auto flex w-fit max-w-full flex-wrap items-center gap-1.5 rounded-2xl border border-border-strong bg-popover px-2.5 py-2 shadow-lg"
        >
          <span className="flex items-center gap-2 pl-1.5 pr-2.5 text-sm font-semibold tabular-nums">
            <span className="flex h-6 min-w-6 items-center justify-center rounded-full bg-primary px-1.5 text-xs text-primary-foreground">
              {count}
            </span>
            selected
          </span>
          <span aria-hidden className="mx-1 h-5 w-px bg-border-strong" />
          <Button size="sm" variant="primary" loading={downloading} onClick={onDownload}>
            <Download /> Download
          </Button>
          <Button size="sm" variant="ghost" onClick={onFavorite}>
            <Star className={allFavorite ? 'fill-current' : undefined} />{' '}
            {allFavorite ? 'Unfavorite' : 'Favorite'}
          </Button>
          <DisabledTip reason={LATER}>
            <Button size="sm" variant="ghost" disabled>
              <CalendarClock /> Send to scheduler
            </Button>
          </DisabledTip>
          {onOpenEditor ? (
            <Button
              size="sm"
              variant="ghost"
              loading={openingEditor}
              onClick={onOpenEditor}
              data-testid="selection-open-editor"
            >
              <PencilRuler /> Open in editor
            </Button>
          ) : (
            <DisabledTip reason="Select a single clip to open it in the editor">
              <Button size="sm" variant="ghost" disabled>
                <PencilRuler /> Open in editor
              </Button>
            </DisabledTip>
          )}
          {selectedClips ? (
            <ApplyBrandPopover
              clips={selectedClips}
              label="Apply Brand Kit…"
              testId="selection-apply-brand"
            />
          ) : null}
          <Button size="sm" variant="danger-ghost" onClick={onDelete}>
            <Trash2 /> Delete
          </Button>
          <span aria-hidden className="mx-1 h-5 w-px bg-border-strong" />
          <Button size="icon-sm" variant="ghost" aria-label="Clear selection" onClick={onClear}>
            <X />
          </Button>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
