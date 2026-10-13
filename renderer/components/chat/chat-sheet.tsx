'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown,
  Bookmark,
  Check,
  Film,
  History,
  MessageSquarePlus,
  Scissors,
  SendHorizontal,
  Sparkles,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import type { ChatMessage } from '@shared/cp2';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { Tip } from '@/components/ui/tooltip';
import { TextArea } from '@/components/library/drawer-fields';
import { useClipLookup, useClipUi } from '@/lib/cp2-clips';
import {
  parseAppHref,
  scopeKey,
  seekSource,
  sendChat,
  useChatMessages,
  useChatStreams,
  useChatThreads,
  useChatUi,
  useMarkers,
  usePeek,
  type ChatScope,
} from '@/lib/cp2-chat';
import { timeAgo } from '@/lib/format';
import { invoke, ipcKey } from '@/lib/ipc';
import { normalizeHref } from '@/lib/hrefs';
import { useVideo } from '@/lib/library';
import { cn } from '@/lib/utils';
import { AssistantMessage, ErrorBubble, StoredAssistant, UserBubble } from './chat-messages';
import { TimeChip } from './chat-markdown';
import { SourcePeek } from './source-peek';

/* ------------------------------------------------------------------------------------- header menus */

function MarkersMenu({ videoId, onSeek }: { videoId: string; onSeek: (sec: number) => void }) {
  const qc = useQueryClient();
  const q = useMarkers(videoId);
  const items = [...(q.data?.items ?? [])].sort((a, b) => a.atSec - b.atSec);
  const remove = async (id: string) => {
    try {
      await invoke('markers:delete', { id });
      await qc.invalidateQueries({ queryKey: ipcKey('markers:list', { videoId }) });
    } catch (e) {
      toast.error('Could not delete the marker', {
        description: e instanceof Error ? e.message : undefined,
      });
    }
  };
  return (
    <Popover>
      <Tip content="Markers">
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Markers" data-testid="chat-markers">
            <Bookmark />
            {items.length > 0 ? (
              <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                {items.length}
              </span>
            ) : null}
          </Button>
        </PopoverTrigger>
      </Tip>
      <PopoverContent align="end" className="z-[90] w-80 p-0" data-testid="chat-markers-menu">
        <div className="border-b px-3.5 py-2.5">
          <p className="text-sm font-semibold">Markers</p>
          <p className="text-xs text-muted-foreground">
            Moments you or the chat flagged in this video.
          </p>
        </div>
        {q.isPending ? (
          <div className="space-y-2 p-3">
            <Skeleton className="h-7 w-full" />
            <Skeleton className="h-7 w-full" />
          </div>
        ) : q.isError ? (
          <p className="p-4 text-sm text-danger">{q.error.message}</p>
        ) : items.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            No markers yet. Ask the chat to “add a marker where they talk about pricing”.
          </p>
        ) : (
          <ul className="scrollbar-thin max-h-72 overflow-y-auto p-1.5">
            {items.map((m) => (
              <li
                key={m.id}
                className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent"
              >
                <TimeChip sec={m.atSec} onSeek={onSeek} />
                <span className="min-w-0 flex-1 truncate text-sm" title={m.label}>
                  {m.label}
                </span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Delete marker ${m.label}`}
                  className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                  onClick={() => void remove(m.id)}
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}

function ThreadsMenu({
  scope,
  activeId,
  onPick,
  onNew,
}: {
  scope: ChatScope;
  activeId: string | null;
  onPick: (id: string) => void;
  onNew: () => void;
}) {
  const qc = useQueryClient();
  const q = useChatThreads(scope, true);
  const [confirm, setConfirm] = React.useState<string | null>(null);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const items = [...(q.data?.items ?? [])].sort((a, b) => b.updatedAt - a.updatedAt);
  const del = async (id: string) => {
    try {
      await invoke('chat:delete', { threadId: id });
      setConfirm(null);
      if (id === activeId) onNew();
      await qc.invalidateQueries({ queryKey: ['chat:threads'] });
    } catch (e) {
      toast.error('Could not delete the conversation', {
        description: e instanceof Error ? e.message : undefined,
      });
    }
  };
  return (
    <Popover open={menuOpen} onOpenChange={setMenuOpen}>
      <Tip content="Conversations">
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Conversations"
            data-testid="chat-threads"
          >
            <History />
          </Button>
        </PopoverTrigger>
      </Tip>
      <PopoverContent align="end" className="z-[90] w-80 p-0" data-testid="chat-threads-menu">
        <div className="flex items-center justify-between border-b px-3.5 py-2.5">
          <p className="text-sm font-semibold">Conversations</p>
          <Button
            size="xs"
            variant="soft"
            onClick={() => {
              setMenuOpen(false);
              onNew();
            }}
            data-testid="chat-new-thread"
          >
            <MessageSquarePlus /> New chat
          </Button>
        </div>
        {q.isPending ? (
          <div className="space-y-2 p-3">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : items.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            No conversations about this {scope.clipId ? 'clip' : 'video'} yet.
          </p>
        ) : (
          <ul className="scrollbar-thin max-h-80 overflow-y-auto p-1.5" aria-label="Conversations">
            {items.map((t) => (
              <li
                key={t.id}
                data-testid="chat-thread"
                data-active={t.id === activeId || undefined}
                className={cn(
                  'group flex items-center gap-1 rounded-md pr-1',
                  t.id === activeId ? 'bg-primary-soft' : 'hover:bg-accent',
                )}
              >
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    onPick(t.id);
                  }}
                  className="min-w-0 flex-1 px-2.5 py-2 text-left"
                >
                  <span className="block truncate text-sm font-medium">{t.title}</span>
                  <span className="block text-2xs text-subtle">{timeAgo(t.updatedAt)}</span>
                </button>
                {confirm === t.id ? (
                  <span className="flex items-center gap-0.5">
                    <Button
                      variant="danger-ghost"
                      size="xs"
                      onClick={() => void del(t.id)}
                      data-testid="chat-thread-delete-confirm"
                    >
                      <Check /> Delete
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Keep conversation"
                      onClick={() => setConfirm(null)}
                    >
                      <X />
                    </Button>
                  </span>
                ) : (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Delete conversation ${t.title}`}
                    className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                    onClick={() => setConfirm(t.id)}
                    data-testid="chat-thread-delete"
                  >
                    <Trash2 />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}

/* ----------------------------------------------------------------------------------------- composer */

function Composer({
  busy,
  onSend,
  onStop,
  inputRef,
  draft,
  setDraft,
  placeholder,
}: {
  busy: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  draft: string;
  setDraft: (s: string) => void;
  placeholder: string;
}) {
  const submit = () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft('');
    onSend(text);
  };
  React.useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft, inputRef]);
  return (
    <div className="border-t bg-popover p-3">
      <div className="flex items-end gap-2 rounded-xl border border-input bg-field p-1.5 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/25">
        <TextArea
          ref={inputRef}
          rows={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          maxLength={4000}
          placeholder={placeholder}
          aria-label="Message"
          data-testid="chat-input"
          className="min-h-9 flex-1 resize-none border-0 bg-transparent px-2 py-1.5 shadow-none ring-0 hover:border-0 focus-visible:border-0 focus-visible:ring-0"
        />
        {busy ? (
          <Button
            variant="danger"
            size="icon"
            aria-label="Stop generating"
            onClick={onStop}
            data-testid="chat-stop"
          >
            <Square className="fill-current" />
          </Button>
        ) : (
          <Button
            variant="primary"
            size="icon"
            aria-label="Send message"
            disabled={!draft.trim()}
            onClick={submit}
            data-testid="chat-send"
          >
            <SendHorizontal />
          </Button>
        )}
      </div>
      <p className="mt-1.5 flex items-center gap-2 px-1 text-2xs text-subtle">
        <span>
          <Kbd keys={['enter']} /> send
        </span>
        <span>
          <Kbd keys={['shift', 'enter']} /> new line
        </span>
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------------------------- panel */

function suggestionsFor(clip: boolean) {
  return [
    {
      id: 'linkedin',
      label: 'Summarize this for LinkedIn',
      text: 'Summarize this for LinkedIn',
      send: true,
    },
    { id: 'find', label: 'Find the part where…', text: 'Find the part where ', send: false },
    {
      id: 'story',
      label: 'Make a clip of the best story',
      text: 'Make a clip of the best story',
      send: true,
    },
    ...(clip
      ? [{ id: 'hook', label: 'Rewrite this hook', text: 'Rewrite this hook', send: true }]
      : [
          {
            id: 'takeaways',
            label: 'What are the key takeaways?',
            text: 'What are the key takeaways?',
            send: true,
          },
        ]),
  ];
}

export function ChatPanel({ scope }: { scope: ChatScope }) {
  const qc = useQueryClient();
  const router = useRouter();
  const key = scopeKey(scope);
  const video = useVideo(scope.videoId);
  const clip = useClipLookup(scope.clipId ?? '');
  const threadsQ = useChatThreads(scope, true);
  const storedThread = useChatUi((s) => s.threads[key]);
  const setThread = useChatUi((s) => s.setThread);
  const latest = [...(threadsQ.data?.items ?? [])].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const threadId: string | null = storedThread === undefined ? (latest?.id ?? null) : storedThread;
  const messagesQ = useChatMessages(threadId);
  const stream = useChatStreams((s) => (threadId ? s.streams[threadId] : undefined));
  const pending = useChatStreams((s) => s.pending[threadId ?? `new:${key}`]);
  const sendError = useChatStreams((s) => s.sendErrors[threadId ?? `new:${key}`]);
  const requestOpen = useClipUi((s) => s.requestOpen);

  const [draft, setDraft] = React.useState('');
  const inputRef = React.useRef<HTMLTextAreaElement | null>(null);
  const scroller = React.useRef<HTMLDivElement | null>(null);
  const [stick, setStick] = React.useState(true);
  // the signature at the moment the user scrolled away: anything newer than that is "unseen"
  const [seenSig, setSeenSig] = React.useState<string | null>(null);

  const messages = React.useMemo(() => messagesQ.data?.items ?? [], [messagesQ.data]);
  const visibleStream =
    stream && !messages.some((m) => m.id === stream.messageId && stream.messageId)
      ? stream
      : undefined;
  const streaming =
    visibleStream?.phase === 'streaming' || (!!pending && !visibleStream && !sendError);
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const contextTitle = scope.clipId
    ? (clip?.title ?? 'this clip')
    : (video.data?.video.title ?? 'this video');

  /* ---- actions ---- */
  const onSeek = React.useCallback(
    (sec: number) => {
      // the page's players first; the in-panel peek when none of them can show the moment
      if (!seekSource(scope.videoId, sec)) usePeek.getState().show(scope.videoId, sec);
    },
    [scope.videoId],
  );
  const onOpenHref = React.useCallback(
    (href: string) => {
      const parsed = parseAppHref(href);
      if (parsed.kind === 'seek') {
        onSeek(parsed.sec);
        return;
      }
      if (parsed.kind === 'clip') requestOpen(parsed.clipId, parsed.view);
      router.push(normalizeHref(parsed.url));
    },
    [onSeek, requestOpen, router],
  );
  const send = React.useCallback(
    (text: string) => {
      setStick(true);
      void sendChat(qc, scope, threadId, text);
    },
    [qc, scope, threadId],
  );
  const stop = () => {
    if (!threadId) return;
    useChatStreams.getState().patch(threadId, (s) => (s ? { ...s, phase: 'stopped' } : s));
    void invoke('chat:cancel', { threadId })
      .then(() => qc.invalidateQueries({ queryKey: ipcKey('chat:messages', { threadId }) }))
      .catch((e: Error) => toast.error('Could not stop the answer', { description: e.message }));
  };
  const regenerate = () => {
    const text = lastUser?.text;
    if (text) send(text);
  };
  const newThread = () => {
    setThread(scope, null);
    useChatStreams.getState().setSendError(`new:${key}`, undefined);
    setDraft('');
    window.setTimeout(() => inputRef.current?.focus(), 0);
  };

  /* ---- scroll: follow the stream unless the user scrolled away ---- */
  const signature = `${messages.length}:${visibleStream?.text.length ?? 0}:${visibleStream?.actions.length ?? 0}:${pending ? 1 : 0}:${sendError ? 1 : 0}`;
  const signatureRef = React.useRef(signature);
  React.useEffect(() => {
    signatureRef.current = signature;
  });
  const unseen = !stick && seenSig !== null && seenSig !== signature;
  React.useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick) el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  React.useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [threadId]);

  const loadingMessages = !!threadId && messagesQ.isPending && !pending;
  const empty =
    !loadingMessages && messages.length === 0 && !pending && !visibleStream && !sendError;
  const suggestions = suggestionsFor(!!scope.clipId);

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="chat-panel-body">
      <header className="flex flex-col gap-2 border-b px-4 pb-3 pt-3.5">
        <div className="flex items-center gap-2">
          <span className="flex size-7 items-center justify-center rounded-lg bg-primary-soft text-primary-text">
            <Sparkles className="size-4" aria-hidden />
          </span>
          <DialogPrimitive.Title className="font-display text-lg font-semibold">
            AI Chat
          </DialogPrimitive.Title>
          <span className="ml-auto flex items-center gap-0.5">
            <MarkersMenu videoId={scope.videoId} onSeek={onSeek} />
            <ThreadsMenu
              scope={scope}
              activeId={threadId}
              onPick={(id) => setThread(scope, id)}
              onNew={newThread}
            />
            <Tip content="New chat">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="New chat"
                onClick={newThread}
                data-testid="chat-new"
              >
                <MessageSquarePlus />
              </Button>
            </Tip>
            <DialogPrimitive.Close asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Close chat"
                data-testid="chat-close"
              >
                <X />
              </Button>
            </DialogPrimitive.Close>
          </span>
        </div>
        <DialogPrimitive.Description asChild>
          <div
            className="flex min-w-0 items-center gap-1.5 rounded-lg border bg-muted/50 px-2.5 py-1.5 text-xs text-muted-foreground"
            data-testid="chat-context"
          >
            {scope.clipId ? (
              <Scissors className="size-3.5 shrink-0" aria-hidden />
            ) : (
              <Film className="size-3.5 shrink-0" aria-hidden />
            )}
            <span className="shrink-0">Chatting about:</span>
            <span className="min-w-0 truncate font-semibold text-foreground" title={contextTitle}>
              {contextTitle}
            </span>
          </div>
        </DialogPrimitive.Description>
      </header>

      <SourcePeek videoId={scope.videoId} />
      <div className="relative min-h-0 flex-1">
        <div
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            if (near !== stick) {
              setStick(near);
              setSeenSig(near ? null : signatureRef.current);
            }
          }}
          role="log"
          aria-label="Conversation"
          className="scrollbar-thin flex h-full flex-col gap-4 overflow-y-auto px-4 py-4"
          data-testid="chat-scroller"
        >
          {loadingMessages ? (
            <div className="space-y-3" aria-busy>
              <Skeleton className="ml-auto h-9 w-2/3" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : null}

          {empty ? (
            <div
              className="my-auto flex flex-col items-center gap-4 py-6 text-center"
              data-testid="chat-empty"
            >
              <span className="flex size-12 items-center justify-center rounded-xl border border-border-strong bg-raised text-primary-text shadow-sm">
                <Sparkles className="size-5" aria-hidden />
              </span>
              <div>
                <p className="font-display text-lg font-semibold">
                  Ask anything about {scope.clipId ? 'this clip' : 'this video'}
                </p>
                <p className="mx-auto mt-1 max-w-xs text-sm text-muted-foreground">
                  Answers cite the transcript with timestamps you can click, and Clipfern can act on
                  them: make clips, add markers, write metadata.
                </p>
              </div>
              <div className="flex flex-wrap justify-center gap-2" data-testid="chat-suggestions">
                {suggestions.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => {
                      if (s.send) send(s.text);
                      else {
                        setDraft(s.text);
                        inputRef.current?.focus();
                      }
                    }}
                    data-testid={`chat-suggestion-${s.id}`}
                    className="rounded-full border border-border-strong px-3 py-1.5 text-sm text-muted-foreground transition-colors duration-(--duration-fast) hover:border-primary/60 hover:bg-primary-soft hover:text-primary-text"
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {messages.map((m: ChatMessage) =>
            m.role === 'user' ? (
              <UserBubble key={m.id} text={m.text} />
            ) : (
              <StoredAssistant
                key={m.id}
                message={m}
                isLast={m.id === lastAssistant?.id && !visibleStream && !pending}
                onSeek={onSeek}
                onOpenHref={onOpenHref}
                onRegenerate={regenerate}
              />
            ),
          )}

          {pending &&
          !messages.some(
            (m) => m.role === 'user' && m.text === pending.text && m.createdAt >= pending.at - 1000,
          ) ? (
            <UserBubble text={pending.text} pending />
          ) : null}

          {visibleStream ? (
            <AssistantMessage
              text={visibleStream.text}
              citations={visibleStream.citations}
              actions={visibleStream.actions}
              streaming={visibleStream.phase === 'streaming'}
              stopped={visibleStream.phase === 'stopped'}
              onSeek={onSeek}
              onOpenHref={onOpenHref}
            />
          ) : pending && !sendError ? (
            <AssistantMessage
              text=""
              citations={[]}
              actions={[]}
              streaming
              onSeek={onSeek}
              onOpenHref={onOpenHref}
            />
          ) : null}

          {visibleStream?.phase === 'error' ? (
            <ErrorBubble
              message={visibleStream.error ?? 'The answer stopped unexpectedly.'}
              onRetry={regenerate}
            />
          ) : null}
          {sendError ? (
            <ErrorBubble message={sendError.message} onRetry={() => send(sendError.text)} />
          ) : null}
        </div>
        {unseen ? (
          <Button
            variant="secondary"
            size="xs"
            onClick={() => {
              const el = scroller.current;
              if (el) el.scrollTop = el.scrollHeight;
              setStick(true);
              setSeenSig(null);
            }}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full shadow-md"
            data-testid="chat-jump-latest"
          >
            <ArrowDown /> New messages
          </Button>
        ) : null}
      </div>

      <Composer
        busy={streaming}
        onSend={send}
        onStop={stop}
        inputRef={inputRef}
        draft={draft}
        setDraft={setDraft}
        placeholder={
          scope.clipId
            ? 'Ask about this clip, or “rewrite this hook”…'
            : 'Ask about this video, or “make a clip of…”'
        }
      />
    </div>
  );
}

/** Non-modal right-hand panel: the page and the source player stay interactive while the chat is open. */
export function ChatSheet({
  scope,
  open,
  onOpenChange,
}: {
  scope: ChatScope;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          data-chat-panel
          data-testid="chat-panel"
          aria-describedby={undefined}
          onInteractOutside={(e) => e.preventDefault()}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement | null)
              ?.querySelector<HTMLTextAreaElement>('textarea')
              ?.focus();
          }}
          className={cn(
            'app-no-drag fixed bottom-3 right-3 top-14 z-[70] flex w-[min(440px,calc(100vw-24px))] flex-col overflow-hidden rounded-2xl border border-border-strong bg-popover text-foreground shadow-lg outline-none',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-right-6 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-right-6',
          )}
        >
          <ChatPanel key={scopeKey(scope)} scope={scope} />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
