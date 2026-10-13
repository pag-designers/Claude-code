'use client';

/**
 * AI Chat state and helpers (BRIEF §6 "AI Chat"). Everything pure (markdown, timestamps, href routing) is unit-tested;
 * the rest binds `chat:*` / `markers:*` and the `chat:event` stream.
 *
 * Streaming model: `chat:send` resolves as soon as the user message is stored; the answer arrives as `chat:event`s
 * (start / delta / citation / action / done / error). One hub subscription (ref-counted across launchers) folds them into
 * `useChatStreams`; on `done` the final message is written into the `chat:messages` cache and the stream is dropped.
 */
import * as React from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { create } from 'zustand';
import type { ChatAction, ChatEvent, ChatMessage, Citation } from '@shared/cp2';
import { invoke, ipcKey, on, useIpcEvent, useIpcQuery } from './ipc';
import { isDrawerView, type DrawerView } from './cp2-clips';

/* -------------------------------------------------------------------------------------- timestamps */

const CLOCK = String.raw`(?:\d{1,2}:)?\d{1,2}:\d{2}`;

/** "12:05" -> 725, "1:02:05" -> 3725; null when it is not a clock. */
export function parseClock(s: string): number | null {
  const m = new RegExp(`^(?:(\\d{1,2}):)?(\\d{1,2}):(\\d{2})$`).exec(s.trim());
  if (!m) return null;
  const [, h, mm, ss] = m;
  const sec = Number(ss);
  if (sec > 59) return null;
  return (h ? Number(h) * 3600 : 0) + Number(mm) * 60 + sec;
}

/* --------------------------------------------------------------------------------------- markdown */

export type Inline =
  | { t: 'text'; text: string }
  | { t: 'br' }
  | { t: 'bold'; children: Inline[] }
  | { t: 'italic'; children: Inline[] }
  | { t: 'code'; text: string }
  | { t: 'time'; sec: number; label: string }
  | { t: 'link'; text: string; url: string };

export type Block =
  | { t: 'p'; inline: Inline[] }
  | { t: 'h'; level: 1 | 2 | 3 | 4; inline: Inline[] }
  | { t: 'ul'; items: Inline[][] }
  | { t: 'ol'; start: number; items: Inline[][] }
  | { t: 'quote'; inline: Inline[] }
  | { t: 'code'; lang: string; text: string; open: boolean }
  | { t: 'hr' };

const INLINE_RE = new RegExp(
  [
    '(`[^`\\n]+`)', // 1 code
    '(\\*\\*[^*\\n]+?\\*\\*)', // 2 bold
    '(__[^_\\n]+?__)', // 3 bold (underscores)
    '(\\*[^*\\s][^*\\n]*?\\*)', // 4 italic
    '((?<![\\w])_[^_\\s][^_\\n]*?_(?![\\w]))', // 5 italic (underscores)
    `(\\[${CLOCK}(?:\\s*[–—-]\\s*${CLOCK})?\\])`, // 6 [mm:ss] or [mm:ss–mm:ss]
    '(\\[[^\\]\\n]+\\]\\(https?:\\/\\/[^)\\s]+\\))', // 7 link
  ].join('|'),
  'g',
);

/** Inline parser. Anything it does not recognise stays literal text, so a half-streamed `**bo` is just text. */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  const pushText = (s: string) => {
    if (!s) return;
    const parts = s.split('\n');
    parts.forEach((part, i) => {
      if (i > 0) out.push({ t: 'br' });
      if (part) out.push({ t: 'text', text: part });
    });
  };
  let last = 0;
  INLINE_RE.lastIndex = 0;
  for (let m = INLINE_RE.exec(src); m; m = INLINE_RE.exec(src)) {
    pushText(src.slice(last, m.index));
    last = m.index + m[0].length;
    const tok = m[0];
    if (m[1]) out.push({ t: 'code', text: tok.slice(1, -1) });
    else if (m[2] || m[3]) out.push({ t: 'bold', children: parseInline(tok.slice(2, -2)) });
    else if (m[4] || m[5]) out.push({ t: 'italic', children: parseInline(tok.slice(1, -1)) });
    else if (m[6]) {
      const inner = tok.slice(1, -1);
      const first = inner.split(/[–—-]/)[0] ?? inner;
      const sec = parseClock(first);
      if (sec === null) pushText(tok);
      else out.push({ t: 'time', sec, label: inner.replace(/\s+/g, '') });
    } else if (m[7]) {
      const close = tok.lastIndexOf('](');
      out.push({ t: 'link', text: tok.slice(1, close), url: tok.slice(close + 2, -1) });
    }
  }
  pushText(src.slice(last));
  return out;
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,4})\s+(.*?)\s*#*\s*$/;
const UL = /^\s{0,6}[-*•]\s+(.*)$/;
const OL = /^\s{0,6}(\d{1,3})[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;

/** Tiny, forgiving markdown block parser. Never produces HTML: the renderer maps these nodes to React elements. */
export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ t: 'p', inline: parseInline(para.join('\n')) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      let closed = false;
      for (i++; i < lines.length; i++) {
        const l = lines[i]!;
        if (new RegExp(`^\\s{0,3}${fence[1]![0]}{${fence[1]!.length},}\\s*$`).test(l)) {
          closed = true;
          break;
        }
        body.push(l);
      }
      blocks.push({ t: 'code', lang: fence[2] ?? '', text: body.join('\n'), open: !closed });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (HR.test(line)) {
      flush();
      blocks.push({ t: 'hr' });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flush();
      blocks.push({ t: 'h', level: h[1]!.length as 1 | 2 | 3 | 4, inline: parseInline(h[2]!) });
      continue;
    }
    const ul = UL.exec(line);
    if (ul) {
      flush();
      const items: Inline[][] = [parseInline(ul[1]!)];
      while (i + 1 < lines.length && UL.test(lines[i + 1]!)) items.push(parseInline(UL.exec(lines[++i]!)![1]!));
      blocks.push({ t: 'ul', items });
      continue;
    }
    const ol = OL.exec(line);
    if (ol) {
      flush();
      const items: Inline[][] = [parseInline(ol[2]!)];
      while (i + 1 < lines.length && OL.test(lines[i + 1]!)) items.push(parseInline(OL.exec(lines[++i]!)![2]!));
      blocks.push({ t: 'ol', start: Number(ol[1]), items });
      continue;
    }
    const q = QUOTE.exec(line);
    if (q) {
      flush();
      const qs = [q[1]!];
      while (i + 1 < lines.length && QUOTE.test(lines[i + 1]!)) qs.push(QUOTE.exec(lines[++i]!)![1]!);
      blocks.push({ t: 'quote', inline: parseInline(qs.join('\n')) });
      continue;
    }
    para.push(line);
  }
  flush();
  return blocks;
}

/** Plain text of a message (timestamps kept as `[mm:ss]`), for the copy button. */
export const messageCopyText = (m: Pick<ChatMessage, 'text'>) => m.text.trim();

/** Distinct timestamps cited inside the text, in order of appearance. */
export function inlineTimestamps(text: string): { sec: number; label: string }[] {
  const seen = new Set<number>();
  const out: { sec: number; label: string }[] = [];
  const walk = (nodes: Inline[]) => {
    for (const n of nodes) {
      if (n.t === 'time' && !seen.has(n.sec)) {
        seen.add(n.sec);
        out.push({ sec: n.sec, label: n.label });
      } else if (n.t === 'bold' || n.t === 'italic') walk(n.children);
    }
  };
  for (const b of parseMarkdown(text)) {
    if (b.t === 'p' || b.t === 'h' || b.t === 'quote') walk(b.inline);
    else if (b.t === 'ul' || b.t === 'ol') b.items.forEach(walk);
  }
  return out;
}

/* -------------------------------------------------------------------------------------- seeking */

type Seeker = (videoId: string, sec: number) => boolean;
const seekers: { id: number; fn: Seeker }[] = [];
let seekerId = 0;

/**
 * Anything that can show the source video at a moment registers here (the video page's proxy player, the clip drawer's
 * source mode). The most recently registered handler that accepts wins, so an open drawer beats the page behind it.
 */
export function registerSeeker(fn: Seeker): () => void {
  const id = ++seekerId;
  seekers.push({ id, fn });
  return () => {
    const at = seekers.findIndex((s) => s.id === id);
    if (at >= 0) seekers.splice(at, 1);
  };
}
export function seekSource(videoId: string, sec: number): boolean {
  for (let i = seekers.length - 1; i >= 0; i--) if (seekers[i]!.fn(videoId, sec)) return true;
  return false;
}

/** Launchers stack: ⌘/Ctrl+J belongs to the most recently mounted one (the open clip drawer beats the page). */
const launchers: number[] = [];
const launcherListeners = new Set<() => void>();
let launcherId = 0;
const notifyLaunchers = () => launcherListeners.forEach((l) => l());
const subscribeLaunchers = (l: () => void) => {
  launcherListeners.add(l);
  return () => launcherListeners.delete(l);
};
const topLauncher = () => launchers[launchers.length - 1] ?? 0;

/** True for the launcher that owns the keyboard shortcut right now. */
export function useLauncherOwner(): boolean {
  const [id] = React.useState(() => ++launcherId);
  React.useEffect(() => {
    launchers.push(id);
    notifyLaunchers();
    return () => {
      const at = launchers.indexOf(id);
      if (at >= 0) launchers.splice(at, 1);
      notifyLaunchers();
    };
  }, [id]);
  const top = React.useSyncExternalStore(subscribeLaunchers, topLauncher, () => 0);
  return top === id;
}

/* ----------------------------------------------------------------------------------- href routing */

export type AppHref =
  | { kind: 'seek'; videoId: string; sec: number }
  | { kind: 'clip'; videoId: string; clipId: string; view: DrawerView | null; url: string }
  | { kind: 'route'; url: string };

/**
 * Action cards carry an `href` from main. Supported shapes (see the contract notes in the CP2 report):
 *  - `/library/video/?id=V&t=SEC`                  seek the source player (no navigation)
 *  - `/library/video/?id=V&tab=clips&clip=C[&view=hook|meta|thumbnail|reframe]`   open the clip drawer (optionally on a tab)
 *  - anything else: normal in-app navigation
 */
export function parseAppHref(href: string): AppHref {
  let u: URL;
  try {
    u = new URL(href, 'http://app.local');
  } catch {
    return { kind: 'route', url: href };
  }
  const path = u.pathname.replace(/\/+$/, '');
  const id = u.searchParams.get('id');
  if (path === '/library/video' && id) {
    const t = u.searchParams.get('t');
    if (t !== null && Number.isFinite(Number(t)))
      return { kind: 'seek', videoId: id, sec: Math.max(0, Number(t)) };
    const clip = u.searchParams.get('clip');
    if (clip) {
      const view = u.searchParams.get('view');
      return {
        kind: 'clip',
        videoId: id,
        clipId: clip,
        view: isDrawerView(view) ? view : null,
        url: `${u.pathname}${u.search}`,
      };
    }
  }
  return { kind: 'route', url: `${u.pathname}${u.search}${u.hash}` };
}

/* ------------------------------------------------------------------------------------------ state */

export interface ChatScope {
  videoId: string;
  clipId: string | null;
}
export const scopeKey = (s: ChatScope) => `${s.videoId}:${s.clipId ?? ''}`;

interface ChatUi {
  open: boolean;
  scope: ChatScope | null;
  /** Active thread per scope; null = a fresh, not yet created thread. */
  threads: Record<string, string | null>;
  openChat: (scope: ChatScope) => void;
  closeChat: () => void;
  setThread: (scope: ChatScope, id: string | null) => void;
}

export const useChatUi = create<ChatUi>((set) => ({
  open: false,
  scope: null,
  threads: {},
  openChat: (scope) => set({ open: true, scope }),
  closeChat: () => set({ open: false }),
  setThread: (scope, id) => set((s) => ({ threads: { ...s.threads, [scopeKey(scope)]: id } })),
}));

export interface StreamState {
  messageId: string;
  text: string;
  citations: Citation[];
  actions: ChatAction[];
  phase: 'streaming' | 'error' | 'stopped';
  error: string | null;
}

export interface PendingUser {
  text: string;
  at: number;
}

interface ChatStreams {
  streams: Record<string, StreamState>;
  /** The user's message shown instantly, before `chat:messages` has it. Key = threadId or `new:<scope>`. */
  pending: Record<string, PendingUser | undefined>;
  /** `chat:send` itself rejected (no key, budget cap, bridge down): shown as an error bubble with a retry. */
  sendErrors: Record<string, { text: string; message: string } | undefined>;
  patch: (threadId: string, fn: (s: StreamState | undefined) => StreamState | undefined) => void;
  setPending: (key: string, p: PendingUser | undefined) => void;
  setSendError: (key: string, e: { text: string; message: string } | undefined) => void;
}

export const useChatStreams = create<ChatStreams>((set) => ({
  streams: {},
  pending: {},
  sendErrors: {},
  patch: (threadId, fn) =>
    set((st) => {
      const next = fn(st.streams[threadId]);
      const streams = { ...st.streams };
      if (next) streams[threadId] = next;
      else delete streams[threadId];
      return { streams };
    }),
  setPending: (key, p) => set((st) => ({ pending: { ...st.pending, [key]: p } })),
  setSendError: (key, e) => set((st) => ({ sendErrors: { ...st.sendErrors, [key]: e } })),
}));

const emptyStream = (messageId: string): StreamState => ({
  messageId,
  text: '',
  citations: [],
  actions: [],
  phase: 'streaming',
  error: null,
});

const upsertAction = (list: ChatAction[], a: ChatAction): ChatAction[] => {
  const at = list.findIndex((x) => x.id === a.id);
  if (at < 0) return [...list, a];
  const next = list.slice();
  next[at] = a;
  return next;
};

/** Folds one chat event into the stores/caches. Exported for unit tests. */
export function applyChatEvent(qc: QueryClient, e: ChatEvent): void {
  const { patch } = useChatStreams.getState();
  switch (e.type) {
    case 'start':
      patch(e.threadId, () => emptyStream(e.messageId));
      return;
    case 'delta':
      patch(e.threadId, (s) => {
        const base = s ?? emptyStream(e.messageId);
        return { ...base, text: base.text + e.text, phase: 'streaming' };
      });
      return;
    case 'citation':
      patch(e.threadId, (s) => {
        const base = s ?? emptyStream(e.messageId);
        if (base.citations.some((c) => c.t === e.citation.t && c.label === e.citation.label)) return base;
        return { ...base, citations: [...base.citations, e.citation] };
      });
      return;
    case 'action':
      patch(e.threadId, (s) => {
        const base = s ?? emptyStream(e.messageId);
        return { ...base, actions: upsertAction(base.actions, e.action) };
      });
      void qc.invalidateQueries({ queryKey: ['markers:list'] });
      return;
    case 'done': {
      const key = ipcKey('chat:messages', { threadId: e.threadId });
      const old = qc.getQueryData<{ items: ChatMessage[] }>(key);
      if (old) {
        const items = old.items.some((m) => m.id === e.message.id)
          ? old.items.map((m) => (m.id === e.message.id ? e.message : m))
          : [...old.items, e.message];
        qc.setQueryData(key, { items });
      } else void qc.invalidateQueries({ queryKey: key });
      patch(e.threadId, () => undefined);
      void qc.invalidateQueries({ queryKey: ['chat:threads'] });
      void qc.invalidateQueries({ queryKey: ['markers:list'] });
      void qc.invalidateQueries({ queryKey: ['cost:summary'] });
      return;
    }
    case 'error':
      patch(e.threadId, (s) => ({ ...(s ?? emptyStream('')), phase: 'error', error: e.message }));
      void qc.invalidateQueries({ queryKey: ['cost:summary'] });
      return;
  }
}

let hubRefs = 0;
let hubOff: (() => void) | null = null;
let pendingDeltas: ChatEvent[] = [];
let raf = 0;

function flushDeltas(qc: QueryClient) {
  raf = 0;
  const batch = pendingDeltas;
  pendingDeltas = [];
  // coalesce consecutive deltas of the same thread into one store write
  const out: ChatEvent[] = [];
  for (const e of batch) {
    const prev = out[out.length - 1];
    if (e.type === 'delta' && prev?.type === 'delta' && prev.threadId === e.threadId)
      out[out.length - 1] = { ...prev, text: prev.text + e.text };
    else out.push(e);
  }
  for (const e of out) applyChatEvent(qc, e);
}

/**
 * Subscribes ONCE to `chat:event` (ref-counted across launchers). Deltas are coalesced per animation frame so a fast
 * stream renders smoothly; every other event flushes the queue first so ordering is preserved.
 */
export function useChatHub(): void {
  const qc = useQueryClient();
  React.useEffect(() => {
    hubRefs++;
    if (hubRefs === 1)
      hubOff = on('chat:event', (e) => {
        if (e.type === 'delta') {
          pendingDeltas.push(e);
          if (!raf) raf = requestAnimationFrame(() => flushDeltas(qc));
          return;
        }
        if (pendingDeltas.length) {
          if (raf) cancelAnimationFrame(raf);
          flushDeltas(qc);
        }
        applyChatEvent(qc, e);
      });
    return () => {
      hubRefs--;
      if (hubRefs === 0) {
        hubOff?.();
        hubOff = null;
      }
    };
  }, [qc]);
}

/* ------------------------------------------------------------------------------------------ queries */

export function useChatThreads(scope: ChatScope | null, enabled: boolean) {
  return useIpcQuery(
    'chat:threads',
    { videoId: scope?.videoId ?? '', clipId: scope?.clipId ?? undefined },
    { enabled: enabled && !!scope, staleTime: 5_000 },
  );
}

export function useChatMessages(threadId: string | null) {
  return useIpcQuery('chat:messages', { threadId: threadId ?? '' }, {
    enabled: !!threadId,
    staleTime: 60_000,
  });
}

export function useMarkers(videoId: string, enabled = true) {
  const qc = useQueryClient();
  useIpcEvent('markers:changed', (p) => {
    if (p.videoId === videoId) void qc.invalidateQueries({ queryKey: ipcKey('markers:list', { videoId }) });
  });
  return useIpcQuery('markers:list', { videoId }, { enabled, staleTime: 30_000 });
}

/** Sends a message; a `new:` pending key is used until the thread exists. */
export async function sendChat(
  qc: QueryClient,
  scope: ChatScope,
  threadId: string | null,
  text: string,
): Promise<string | null> {
  const st = useChatStreams.getState();
  const key = threadId ?? `new:${scopeKey(scope)}`;
  st.setSendError(key, undefined);
  st.setPending(key, { text, at: Date.now() });
  if (threadId) st.patch(threadId, () => undefined);
  try {
    const res = await invoke('chat:send', {
      videoId: scope.videoId,
      clipId: scope.clipId ?? undefined,
      threadId: threadId ?? undefined,
      text,
    });
    if (!threadId) {
      useChatUi.getState().setThread(scope, res.threadId);
      st.setPending(key, undefined);
      st.setPending(res.threadId, { text, at: Date.now() });
    }
    await qc.invalidateQueries({ queryKey: ipcKey('chat:messages', { threadId: res.threadId }) });
    st.setPending(res.threadId, undefined);
    void qc.invalidateQueries({ queryKey: ['chat:threads'] });
    return res.threadId;
  } catch (e) {
    st.setPending(key, undefined);
    st.setSendError(key, { text, message: e instanceof Error ? e.message : 'Could not send' });
    return null;
  }
}
