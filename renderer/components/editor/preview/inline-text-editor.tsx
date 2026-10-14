'use client';

import * as React from 'react';

/**
 * Inline text editing over the preview: a transparent textarea laid on the text item's bounds, using the item's own
 * font size (scaled to the preview) and colour — the text IS content, so its colour is data, not a UI token. Enter
 * commits, Shift+Enter inserts a line break, Escape cancels, blur commits. Key events never leave the field, so
 * transport shortcuts can't fire while typing.
 */
export interface InlineTextEditorProps {
  initialText: string;
  /** CSS px, relative to the preview box. */
  box: { x: number; y: number; w: number; h: number };
  fontPx: number;
  fontFamily: string;
  fontWeight: number;
  align: 'left' | 'center' | 'right';
  lineHeight: number;
  color: string;
  onCommit(text: string): void;
  onCancel(): void;
}

export function InlineTextEditor(p: InlineTextEditorProps) {
  const ref = React.useRef<HTMLTextAreaElement>(null);
  const done = React.useRef(false);
  const [value, setValue] = React.useState(p.initialText);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.select();
  }, []);

  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit) p.onCommit(value);
    else p.onCancel();
  };

  return (
    <textarea
      ref={ref}
      data-testid="preview-text-editor"
      aria-label="Edit text"
      value={value}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(true)}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
          finish(false);
        } else if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          finish(true);
        }
      }}
      className="absolute resize-none overflow-hidden rounded-xs border border-primary bg-background/55 p-0 shadow-glow outline-none backdrop-blur-[2px]"
      style={{
        left: p.box.x,
        top: p.box.y,
        width: Math.max(48, p.box.w),
        height: Math.max(p.fontPx * p.lineHeight + 4, p.box.h),
        fontSize: p.fontPx,
        fontFamily: p.fontFamily,
        fontWeight: p.fontWeight,
        lineHeight: p.lineHeight,
        textAlign: p.align,
        color: p.color,
      }}
    />
  );
}
