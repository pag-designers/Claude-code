'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  ArrowUpRight,
  Bookmark,
  Captions,
  Check,
  CircleAlert,
  Hash,
  Loader2,
  RotateCcw,
  Scissors,
  Search,
  Sparkles,
} from 'lucide-react';
import type { ChatAction, ChatMessage, ChatToolName, Citation } from '@shared/cp2';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { CopyButton } from '@/components/library/drawer-fields';
import { classifyFailure } from '@/lib/pipeline-ui';
import { timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ChatMarkdown, TimeChip } from './chat-markdown';

/* ------------------------------------------------------------------------------------ user + assistant */

export function UserBubble({ text, pending }: { text: string; pending?: boolean }) {
  return (
    <div
      className="flex justify-end"
      data-testid="chat-user-msg"
      data-pending={pending || undefined}
    >
      <p
        className={cn(
          'max-w-[88%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-sm leading-6 text-primary-foreground',
          pending && 'opacity-75',
        )}
      >
        {text}
      </p>
    </div>
  );
}

function Avatar() {
  return (
    <span
      aria-hidden
      className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary-text"
    >
      <Sparkles className="size-3.5" />
    </span>
  );
}

function Sources({ citations, onSeek }: { citations: Citation[]; onSeek: (sec: number) => void }) {
  if (citations.length === 0) return null;
  return (
    <div className="mt-1 flex flex-col gap-1" data-testid="chat-sources">
      <span className="text-2xs font-semibold uppercase tracking-wider text-subtle">Sources</span>
      <ul className="flex flex-col gap-1">
        {citations.map((c) => (
          <li
            key={`${c.t}-${c.label}`}
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
          >
            <TimeChip sec={c.t} onSeek={onSeek} />
            <span className="min-w-0 truncate">{c.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const TOOL_META: Record<
  ChatToolName,
  { icon: React.ComponentType<{ className?: string }>; running: string; done: string; link: string }
> = {
  create_clip: {
    icon: Scissors,
    running: 'Creating a clip…',
    done: 'Clip created',
    link: 'Open clip',
  },
  add_marker: {
    icon: Bookmark,
    running: 'Adding a marker…',
    done: 'Marker added',
    link: 'Jump to marker',
  },
  write_metadata: {
    icon: Hash,
    running: 'Writing metadata…',
    done: 'Metadata written',
    link: 'View metadata',
  },
  rewrite_hook: {
    icon: Captions,
    running: 'Rewriting the hook…',
    done: 'Hook rewritten',
    link: 'View hooks',
  },
  find_moments: {
    icon: Search,
    running: 'Searching for moments…',
    done: 'Moments found',
    link: 'See the clips',
  },
};

/** Hint shown while a tool is still running, taken from what the model asked for. */
function inputHint(a: ChatAction): string | null {
  const i = a.input;
  const pick = (k: string) => (typeof i[k] === 'string' && i[k] ? (i[k] as string) : null);
  return pick('title') ?? pick('prompt') ?? pick('label') ?? pick('text') ?? pick('query');
}

export function ActionCard({
  action,
  onOpen,
}: {
  action: ChatAction;
  onOpen: (href: string) => void;
}) {
  const meta = TOOL_META[action.tool];
  const Icon = meta.icon;
  const running = action.status === 'running';
  const failed = action.status === 'failed';
  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-xl border px-3 py-2.5',
        failed
          ? 'border-danger/35 bg-danger-soft'
          : running
            ? 'bg-muted/50'
            : 'border-success/30 bg-success-soft',
      )}
      data-testid="chat-action"
      data-tool={action.tool}
      data-status={action.status}
    >
      <span
        className={cn(
          'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg',
          failed
            ? 'bg-danger-solid text-white'
            : running
              ? 'bg-primary-soft text-primary-text'
              : 'bg-success text-black',
        )}
      >
        {running ? (
          <Loader2 className="size-4 animate-spin" aria-hidden />
        ) : failed ? (
          <CircleAlert className="size-4" aria-hidden />
        ) : (
          <Check className="size-4" aria-hidden />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-sm font-semibold">
          <Icon className="size-3.5 text-muted-foreground" aria-hidden />
          {running ? meta.running : failed ? `${meta.done.split(' ')[0]} failed` : meta.done}
        </p>
        <p
          className="mt-0.5 text-xs leading-5 text-muted-foreground"
          data-testid="chat-action-summary"
        >
          {action.summary ??
            (running ? (inputHint(action) ? `“${inputHint(action)}”` : 'Working on it…') : '')}
        </p>
        {action.href && !running && !failed ? (
          <Button
            variant="link"
            size="xs"
            className="mt-1.5 h-auto text-xs"
            onClick={() => onOpen(action.href as string)}
            data-testid="chat-action-link"
          >
            {meta.link} <ArrowUpRight className="size-3" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function AssistantMessage({
  text,
  citations,
  actions,
  streaming,
  stopped,
  createdAt,
  isLast,
  onSeek,
  onOpenHref,
  onRegenerate,
}: {
  text: string;
  citations: Citation[];
  actions: ChatAction[];
  streaming?: boolean;
  stopped?: boolean;
  createdAt?: number;
  isLast?: boolean;
  onSeek: (sec: number) => void;
  onOpenHref: (href: string) => void;
  onRegenerate?: () => void;
}) {
  return (
    <div
      className="group flex gap-2.5"
      data-testid="chat-assistant-msg"
      data-streaming={streaming || undefined}
    >
      <Avatar />
      <div className="min-w-0 flex-1">
        <div aria-live="polite" aria-busy={streaming || undefined} data-testid="chat-answer">
          {text ? (
            <ChatMarkdown text={text} onSeek={onSeek} streaming={streaming} />
          ) : streaming ? (
            <span
              className="flex items-center gap-1.5 py-1 text-sm text-muted-foreground"
              data-testid="chat-thinking"
            >
              <span className="flex gap-1" aria-hidden>
                <span className="size-1.5 animate-pulse rounded-full bg-subtle" />
                <span className="size-1.5 animate-pulse rounded-full bg-subtle [animation-delay:150ms]" />
                <span className="size-1.5 animate-pulse rounded-full bg-subtle [animation-delay:300ms]" />
              </span>
              Reading the transcript…
            </span>
          ) : null}
          {streaming && text ? (
            <span
              aria-hidden
              className="ml-0.5 inline-block h-4 w-0.5 translate-y-0.5 animate-pulse bg-primary"
            />
          ) : null}
        </div>
        {actions.length > 0 ? (
          <div className="mt-2.5 flex flex-col gap-2" data-testid="chat-actions">
            {actions.map((a) => (
              <ActionCard key={a.id} action={a} onOpen={onOpenHref} />
            ))}
          </div>
        ) : null}
        {!streaming ? <Sources citations={citations} onSeek={onSeek} /> : null}
        {stopped ? (
          <p className="mt-1.5 text-xs text-subtle" data-testid="chat-stopped">
            Stopped. This is the partial answer.
          </p>
        ) : null}
        {!streaming && text ? (
          <div
            className="mt-1.5 flex items-center gap-1 opacity-0 transition-opacity duration-(--duration-fast) focus-within:opacity-100 group-hover:opacity-100 data-[last=true]:opacity-100"
            data-last={isLast}
          >
            <CopyButton text={text} label="Copy answer" testId="chat-copy" />
            {isLast && onRegenerate ? (
              <Tip content="Ask again">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Regenerate answer"
                  onClick={onRegenerate}
                  data-testid="chat-regenerate"
                >
                  <RotateCcw />
                </Button>
              </Tip>
            ) : null}
            {createdAt ? (
              <span className="ml-1 text-2xs text-subtle">{timeAgo(createdAt)}</span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** A persisted assistant message. */
export function StoredAssistant({
  message,
  ...rest
}: {
  message: ChatMessage;
  isLast: boolean;
  onSeek: (sec: number) => void;
  onOpenHref: (href: string) => void;
  onRegenerate?: () => void;
}) {
  return (
    <AssistantMessage
      text={message.text}
      citations={message.citations}
      actions={message.actions}
      createdAt={message.createdAt}
      {...rest}
    />
  );
}

/* --------------------------------------------------------------------------------------------- errors */

/** Failure bubble with a recovery link when the cause is known (budget cap, API key, network). */
export function ErrorBubble({
  message,
  onRetry,
  retrying,
}: {
  message: string;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const rec = classifyFailure(message);
  const known = rec.kind !== 'other';
  return (
    <div
      role="alert"
      className={cn(
        'flex gap-2.5 rounded-xl border px-3 py-2.5',
        rec.kind === 'budget'
          ? 'border-warning/35 bg-warning-soft'
          : 'border-danger/35 bg-danger-soft',
      )}
      data-testid="chat-error"
      data-kind={rec.kind}
    >
      <CircleAlert
        className={cn(
          'mt-0.5 size-4 shrink-0',
          rec.kind === 'budget' ? 'text-warning' : 'text-danger',
        )}
        aria-hidden
      />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-semibold">{known ? rec.title : 'The answer could not be completed'}</p>
        <p className="mt-0.5 text-xs leading-5 text-muted-foreground" data-testid="chat-error-text">
          {known ? rec.hint : message}
        </p>
        {known ? <p className="mt-1 text-2xs text-subtle">{message}</p> : null}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {rec.action ? (
            <Button asChild size="xs" variant="outline">
              <Link href={rec.action.href}>{rec.action.label}</Link>
            </Button>
          ) : null}
          {onRetry ? (
            <Button
              size="xs"
              variant="outline"
              loading={retrying}
              onClick={onRetry}
              data-testid="chat-retry"
            >
              <RotateCcw /> Try again
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
