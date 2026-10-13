import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../shared/cp2';
import {
  applyChatEvent,
  inlineTimestamps,
  parseAppHref,
  parseClock,
  parseInline,
  parseMarkdown,
  registerSeeker,
  seekSource,
  useChatStreams,
} from '../../renderer/lib/cp2-chat';

describe('timestamps', () => {
  it('parses mm:ss and h:mm:ss', () => {
    expect(parseClock('0:05')).toBe(5);
    expect(parseClock('12:30')).toBe(750);
    expect(parseClock('1:02:03')).toBe(3723);
    expect(parseClock('1:75')).toBeNull();
    expect(parseClock('abc')).toBeNull();
  });
  it('turns [mm:ss] markers into time nodes, ranges seek to the start, junk stays text', () => {
    expect(parseInline('see [1:02] now')).toEqual([
      { t: 'text', text: 'see ' },
      { t: 'time', sec: 62, label: '1:02' },
      { t: 'text', text: ' now' },
    ]);
    expect(parseInline('[12:30–13:10]')).toEqual([{ t: 'time', sec: 750, label: '12:30–13:10' }]);
    expect(parseInline('[1:02:03]')).toEqual([{ t: 'time', sec: 3723, label: '1:02:03' }]);
    expect(parseInline('[99:99] [note]')).toEqual([{ t: 'text', text: '[99:99] [note]' }]);
  });
  it('lists the distinct timestamps in order', () => {
    expect(inlineTimestamps('a [0:10] b **[0:20]** c [0:10]\n\n- [0:30]').map((t) => t.sec)).toEqual([10, 20, 30]);
  });
});

describe('markdown', () => {
  it('parses headings, lists, quotes, rules and paragraphs', () => {
    const blocks = parseMarkdown('# Title\n\nHello **world**\nsecond line\n\n- a\n- b\n\n1. x\n2. y\n\n> quote\n\n---');
    expect(blocks.map((b) => b.t)).toEqual(['h', 'p', 'ul', 'ol', 'quote', 'hr']);
    expect(blocks[0]).toMatchObject({ t: 'h', level: 1 });
    expect(blocks[2]).toMatchObject({ t: 'ul' });
    expect((blocks[2] as { items: unknown[] }).items).toHaveLength(2);
    const p = blocks[1] as { inline: { t: string }[] };
    expect(p.inline.map((n) => n.t)).toEqual(['text', 'bold', 'br', 'text']);
  });
  it('code blocks: closed, and still open while streaming', () => {
    const closed = parseMarkdown('```ts\nconst a = 1;\n```\nafter');
    expect(closed[0]).toEqual({ t: 'code', lang: 'ts', text: 'const a = 1;', open: false });
    expect(closed[1]).toMatchObject({ t: 'p' });
    const open = parseMarkdown('```\npartial');
    expect(open[0]).toEqual({ t: 'code', lang: '', text: 'partial', open: true });
  });
  it('half-streamed markers stay literal until they close', () => {
    expect(parseInline('this is **bo')).toEqual([{ t: 'text', text: 'this is **bo' }]);
    expect(parseInline('this is **bo**')).toEqual([
      { t: 'text', text: 'this is ' },
      { t: 'bold', children: [{ t: 'text', text: 'bo' }] },
    ]);
  });
  it('never produces HTML: tags are plain text nodes', () => {
    const inline = parseInline('<img src=x onerror=alert(1)> <b>x</b>');
    expect(inline).toEqual([{ t: 'text', text: '<img src=x onerror=alert(1)> <b>x</b>' }]);
    expect(JSON.stringify(parseMarkdown('<script>alert(1)</script>'))).not.toContain('"t":"html"');
  });
  it('only http(s) links become link nodes', () => {
    expect(parseInline('[docs](https://example.com/a?b=1)')).toEqual([
      { t: 'link', text: 'docs', url: 'https://example.com/a?b=1' },
    ]);
    expect(parseInline('[x](javascript:alert(1))')).toEqual([{ t: 'text', text: '[x](javascript:alert(1))' }]);
  });
  it('inline code, italics and nesting', () => {
    expect(parseInline('`a *b*` and *c*')).toEqual([
      { t: 'code', text: 'a *b*' },
      { t: 'text', text: ' and ' },
      { t: 'italic', children: [{ t: 'text', text: 'c' }] },
    ]);
  });
});

describe('href routing', () => {
  it('seek, clip and plain routes', () => {
    expect(parseAppHref('/library/video/?id=v1&t=125')).toEqual({ kind: 'seek', videoId: 'v1', sec: 125 });
    expect(parseAppHref('/library/video/?id=v1&tab=clips&clip=c9&view=hook')).toMatchObject({
      kind: 'clip',
      videoId: 'v1',
      clipId: 'c9',
      view: 'hook',
    });
    expect(parseAppHref('/library/video/?id=v1&clip=c9&view=bogus')).toMatchObject({ kind: 'clip', view: null });
    expect(parseAppHref('/settings/models/')).toEqual({ kind: 'route', url: '/settings/models/' });
    expect(parseAppHref('/library/video?id=v1&tab=notes')).toMatchObject({ kind: 'route' });
  });
});

describe('seeker registry', () => {
  it('the most recent accepting handler wins; unregistering falls back', () => {
    const log: string[] = [];
    const off1 = registerSeeker((v, t) => (log.push(`page:${v}:${t}`), true));
    const off2 = registerSeeker((v, t) => (v === 'v1' ? (log.push(`drawer:${t}`), true) : false));
    expect(seekSource('v1', 5)).toBe(true);
    expect(seekSource('v2', 7)).toBe(true);
    off2();
    expect(seekSource('v1', 9)).toBe(true);
    off1();
    expect(seekSource('v1', 11)).toBe(false);
    expect(log).toEqual(['drawer:5', 'page:v2:7', 'page:v1:9']);
  });
});

describe('chat event folding', () => {
  const qc = new QueryClient();
  beforeEach(() => {
    useChatStreams.setState({ streams: {}, pending: {}, sendErrors: {} });
    qc.clear();
  });
  const stream = (id = 't1') => useChatStreams.getState().streams[id];
  const final: ChatMessage = {
    id: 'm2',
    threadId: 't1',
    role: 'assistant',
    text: 'Hello world',
    citations: [{ t: 3, label: 'x' }],
    actions: [],
    createdAt: 5,
  };
  it('start -> deltas -> citation -> action -> done', () => {
    applyChatEvent(qc, { type: 'start', threadId: 't1', messageId: 'm2' });
    applyChatEvent(qc, { type: 'delta', threadId: 't1', messageId: 'm2', text: 'Hello ' });
    applyChatEvent(qc, { type: 'delta', threadId: 't1', messageId: 'm2', text: 'world' });
    applyChatEvent(qc, { type: 'citation', threadId: 't1', messageId: 'm2', citation: { t: 3, label: 'x' } });
    applyChatEvent(qc, { type: 'citation', threadId: 't1', messageId: 'm2', citation: { t: 3, label: 'x' } });
    const a = { id: 'a1', tool: 'create_clip' as const, input: {}, status: 'running' as const, summary: null, href: null };
    applyChatEvent(qc, { type: 'action', threadId: 't1', messageId: 'm2', action: a });
    applyChatEvent(qc, { type: 'action', threadId: 't1', messageId: 'm2', action: { ...a, status: 'done', summary: 'ok' } });
    expect(stream()).toMatchObject({ text: 'Hello world', phase: 'streaming', messageId: 'm2' });
    expect(stream()?.citations).toHaveLength(1); // de-duplicated
    expect(stream()?.actions).toEqual([{ ...a, status: 'done', summary: 'ok' }]); // upserted by id
    qc.setQueryData(['chat:messages', { threadId: 't1' }], { items: [] });
    applyChatEvent(qc, { type: 'done', threadId: 't1', message: final });
    expect(stream()).toBeUndefined();
    expect(qc.getQueryData<{ items: ChatMessage[] }>(['chat:messages', { threadId: 't1' }])?.items).toEqual([final]);
  });
  it('a delta without a start still creates the stream; error keeps the partial text', () => {
    applyChatEvent(qc, { type: 'delta', threadId: 't1', messageId: 'm9', text: 'abc' });
    applyChatEvent(qc, { type: 'error', threadId: 't1', message: 'boom' });
    expect(stream()).toMatchObject({ text: 'abc', phase: 'error', error: 'boom' });
  });
  it('done replaces an already stored message instead of duplicating it', () => {
    qc.setQueryData(['chat:messages', { threadId: 't1' }], { items: [{ ...final, text: 'partial' }] });
    applyChatEvent(qc, { type: 'done', threadId: 't1', message: final });
    const items = qc.getQueryData<{ items: ChatMessage[] }>(['chat:messages', { threadId: 't1' }])!.items;
    expect(items).toHaveLength(1);
    expect(items[0]!.text).toBe('Hello world');
  });
});
