'use client';

import * as React from 'react';
import { Play } from 'lucide-react';
import { invoke } from '@/lib/ipc';
import { closeOpenMarkers, parseMarkdown, type Block, type Inline } from '@/lib/cp2-chat';
import { formatClock } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Renders model text WITHOUT ever touching innerHTML: `parseMarkdown` yields a small typed tree and every node is mapped
 * to a React element, so markup in a model answer can only ever become text. `[mm:ss]` markers become clickable chips.
 */

export function TimeChip({
  sec,
  label,
  onSeek,
}: {
  sec: number;
  label?: string;
  onSeek: (sec: number) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSeek(sec)}
      data-testid="chat-time"
      data-sec={sec}
      title={`Jump to ${formatClock(sec)} in the source video`}
      aria-label={`Jump to ${formatClock(sec)} in the source video`}
      className="mx-0.5 inline-flex h-5 items-center gap-0.5 rounded-full bg-primary-soft px-1.5 align-baseline text-xs font-semibold tabular-nums text-primary-text transition-colors duration-(--duration-fast) hover:bg-primary hover:text-primary-foreground"
    >
      <Play className="size-2.5 fill-current" aria-hidden />
      {label ?? formatClock(sec)}
    </button>
  );
}

function InlineNodes({ nodes, onSeek }: { nodes: Inline[]; onSeek: (sec: number) => void }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.t) {
          case 'text':
            return <React.Fragment key={i}>{n.text}</React.Fragment>;
          case 'br':
            return <br key={i} />;
          case 'bold':
            return (
              <strong key={i} className="font-semibold text-foreground">
                <InlineNodes nodes={n.children} onSeek={onSeek} />
              </strong>
            );
          case 'italic':
            return (
              <em key={i}>
                <InlineNodes nodes={n.children} onSeek={onSeek} />
              </em>
            );
          case 'code':
            return (
              <code
                key={i}
                className="rounded-xs bg-muted px-1 py-0.5 font-mono text-[0.92em] text-foreground"
              >
                {n.text}
              </code>
            );
          case 'time':
            return <TimeChip key={i} sec={n.sec} label={n.label} onSeek={onSeek} />;
          case 'link':
            return (
              <a
                key={i}
                href={n.url}
                onClick={(e) => {
                  e.preventDefault();
                  void invoke('shell:openExternal', { url: n.url }).catch(() => undefined);
                }}
                className="text-primary-text underline underline-offset-2 hover:no-underline"
                rel="noreferrer noopener"
              >
                {n.text}
              </a>
            );
        }
      })}
    </>
  );
}

const HEADING_CLASS: Record<1 | 2 | 3 | 4, string> = {
  1: 'mt-4 text-lg',
  2: 'mt-3.5 text-md',
  3: 'mt-3 text-base',
  4: 'mt-3 text-sm',
};

const BlockNode = React.memo(
  function BlockNode({ block, onSeek }: { block: Block; onSeek: (sec: number) => void }) {
    switch (block.t) {
      case 'p':
        return (
          <p className="leading-6">
            <InlineNodes nodes={block.inline} onSeek={onSeek} />
          </p>
        );
      case 'h': {
        const Tag = `h${Math.min(block.level + 2, 6)}` as 'h3' | 'h4' | 'h5' | 'h6';
        return (
          <Tag
            className={cn(
              'font-display font-semibold leading-snug text-foreground first:mt-0',
              HEADING_CLASS[block.level],
            )}
          >
            <InlineNodes nodes={block.inline} onSeek={onSeek} />
          </Tag>
        );
      }
      case 'ul':
        return (
          <ul className="ml-5 list-disc space-y-1 marker:text-subtle">
            {block.items.map((it, i) => (
              <li key={i} className="pl-0.5 leading-6">
                <InlineNodes nodes={it} onSeek={onSeek} />
              </li>
            ))}
          </ul>
        );
      case 'ol':
        return (
          <ol start={block.start} className="ml-5 list-decimal space-y-1 marker:text-subtle">
            {block.items.map((it, i) => (
              <li key={i} className="pl-0.5 leading-6">
                <InlineNodes nodes={it} onSeek={onSeek} />
              </li>
            ))}
          </ol>
        );
      case 'quote':
        return (
          <blockquote className="border-l-2 border-primary/60 pl-3 italic text-muted-foreground">
            <InlineNodes nodes={block.inline} onSeek={onSeek} />
          </blockquote>
        );
      case 'code':
        return (
          <pre className="scrollbar-thin overflow-x-auto rounded-lg border bg-muted/60 p-3 text-xs leading-5">
            <code className="font-mono">{block.text}</code>
          </pre>
        );
      case 'hr':
        return <hr className="border-border" />;
    }
  },
  (a, b) => a.onSeek === b.onSeek && JSON.stringify(a.block) === JSON.stringify(b.block),
);

export function ChatMarkdown({
  text,
  onSeek,
  className,
  streaming,
}: {
  text: string;
  onSeek: (sec: number) => void;
  className?: string;
  /** The answer is still arriving: unclosed bold / code at the end is closed for display. */
  streaming?: boolean;
}) {
  const blocks = React.useMemo(
    () => parseMarkdown(streaming ? closeOpenMarkers(text) : text),
    [text, streaming],
  );
  return (
    <div
      className={cn('flex flex-col gap-2.5 text-sm text-foreground', className)}
      data-testid="chat-markdown"
    >
      {blocks.map((b, i) => (
        <BlockNode key={i} block={b} onSeek={onSeek} />
      ))}
    </div>
  );
}
