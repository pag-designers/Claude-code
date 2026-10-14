import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captionStyleSchema, type CaptionStyle } from '../../shared/cp2';
import { builtinStyles } from '../../electron/main/services/captions/styles';
import {
  TILE_CONCURRENCY,
  clearPreviewCache,
  copyAsCustom,
  fetchPreview,
  peekPreview,
  previewKey,
  styleRenderKey,
} from '../../renderer/lib/cp2-captions';
import {
  TOOL_ROUTE_IDS,
  TOOL_ROUTE_META,
  isToolRouteId,
  slugify,
  summaryToMarkdown,
  toolHref,
} from '../../renderer/lib/cp2-tools';
import { TOOLS, isToolAvailable } from '../../renderer/lib/tools';
import type { VideoAnalysis } from '../../shared/pipeline';

const base = (): CaptionStyle => builtinStyles()[0]!;

describe('style render key', () => {
  it('ignores id, name and builtin (a rename never re-renders) and key order', () => {
    const a = base();
    const b: CaptionStyle = { ...a, id: 'custom-9', name: 'Renamed', builtin: false };
    expect(styleRenderKey(a)).toBe(styleRenderKey(b));
    const shuffled = JSON.parse(JSON.stringify(a)) as CaptionStyle;
    const reordered = captionStyleSchema.parse({ ...shuffled, font: { ...shuffled.font } });
    expect(styleRenderKey(reordered)).toBe(styleRenderKey(a));
  });

  it('changes with any visual field', () => {
    const a = base();
    expect(styleRenderKey({ ...a, fill: '#FF0000' })).not.toBe(styleRenderKey(a));
    expect(styleRenderKey({ ...a, font: { ...a.font, sizePct: 9 } })).not.toBe(styleRenderKey(a));
    expect(styleRenderKey({ ...a, layout: { ...a.layout, yPct: 70 } })).not.toBe(styleRenderKey(a));
  });

  it('distinct presets have distinct keys', () => {
    const keys = new Set(builtinStyles().map(styleRenderKey));
    expect(keys.size).toBe(14);
  });

  it('preview keys include text, clip, aspect and active word, with stable defaults', () => {
    const style = base();
    expect(previewKey({ style })).toBe(previewKey({ style, aspect: '9:16', activeWord: 1 }));
    expect(previewKey({ style, text: 'x' })).not.toBe(previewKey({ style }));
    expect(previewKey({ style, clipId: 'c1' })).not.toBe(previewKey({ style }));
    expect(previewKey({ style, activeWord: 2 })).not.toBe(previewKey({ style }));
  });

  it('copyAsCustom makes a new custom, non-built-in style with a bounded name', () => {
    const c = copyAsCustom(base());
    expect(c.id).toMatch(/^custom-/);
    expect(c.builtin).toBe(false);
    expect(c.name).toBe('Clean Pop copy');
    expect(copyAsCustom({ ...base(), name: 'x'.repeat(40) }).name).toHaveLength(40);
    expect(copyAsCustom(base()).id).not.toBe(c.id);
    expect(captionStyleSchema.safeParse(c).success).toBe(true);
  });
});

describe('preview fetching', () => {
  let inflight = 0;
  let maxInflight = 0;
  let calls: unknown[] = [];
  let gate: Promise<void> = Promise.resolve();

  beforeEach(() => {
    clearPreviewCache();
    inflight = 0;
    maxInflight = 0;
    calls = [];
    gate = Promise.resolve();
    (globalThis as unknown as { window: unknown }).window = {
      clipfern: {
        platform: 'linux',
        on: () => () => undefined,
        invoke: async (channel: string, payload: unknown) => {
          if (channel !== 'captions:preview') throw new Error(`unexpected ${channel}`);
          calls.push(payload);
          inflight += 1;
          maxInflight = Math.max(maxInflight, inflight);
          await gate;
          await new Promise((r) => setTimeout(r, 5));
          inflight -= 1;
          return { dataUrl: `data:image/png;base64,${calls.length}`, width: 540, height: 960 };
        },
      },
    };
  });
  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  const styles = () =>
    builtinStyles().map((s, i) => ({
      ...s,
      fill: `#${(i + 1).toString(16).padStart(6, '0').toUpperCase()}`,
    }));

  it('runs at most two gallery tiles at once and renders every one of them', async () => {
    const all = styles().slice(0, 9);
    const out = await Promise.all(all.map((style) => fetchPreview({ style }, 'tile')));
    expect(out).toHaveLength(9);
    expect(calls).toHaveLength(9);
    expect(maxInflight).toBe(TILE_CONCURRENCY);
    expect(TILE_CONCURRENCY).toBe(2);
  });

  it('de-duplicates identical in-flight requests and serves repeats from the cache', async () => {
    const style = base();
    const [a, b] = await Promise.all([
      fetchPreview({ style }, 'tile'),
      fetchPreview({ style }, 'live'),
    ]);
    expect(a).toBe(b);
    expect(calls).toHaveLength(1);
    expect(peekPreview({ style })).toBe(a);
    await fetchPreview({ style: { ...style, name: 'Other name', id: 'x' } }, 'tile'); // same look
    expect(calls).toHaveLength(1);
    await fetchPreview({ style: { ...style, fill: '#00FF00' } }, 'tile');
    expect(calls).toHaveLength(2);
  });

  it('the live editor preview is never queued behind gallery tiles', async () => {
    let release!: () => void;
    gate = new Promise<void>((r) => (release = r));
    const tiles = styles()
      .slice(0, 5)
      .map((style) => fetchPreview({ style }, 'tile'));
    const live = fetchPreview({ style: { ...base(), fill: '#123456' } }, 'live');
    await new Promise((r) => setTimeout(r, 20));
    expect(inflight).toBe(3); // 2 tiles + the live render
    release();
    await Promise.all([...tiles, live]);
    expect(maxInflight).toBe(3);
  });

  it('sends the contract payload (explicit aspect and active word, optional fields only when set)', async () => {
    await fetchPreview({ style: base() }, 'live');
    await fetchPreview(
      { style: base(), text: 'hello', clipId: 'c1', activeWord: 3, aspect: '1:1' },
      'live',
    );
    expect(calls[0]).toMatchObject({ aspect: '9:16', activeWord: 1 });
    expect(calls[0]).not.toHaveProperty('text');
    expect(calls[0]).not.toHaveProperty('clipId');
    expect(calls[1]).toMatchObject({ text: 'hello', clipId: 'c1', activeWord: 3, aspect: '1:1' });
  });

  it('a failed render is not cached (retry renders again)', async () => {
    const w = (globalThis as unknown as { window: { clipfern: { invoke: unknown } } }).window;
    const original = w.clipfern.invoke as (c: string, p: unknown) => Promise<unknown>;
    let fail = true;
    w.clipfern.invoke = async (c: string, p: unknown) => {
      if (fail) throw new Error('ffmpeg exited with code 1');
      return original(c, p);
    };
    await expect(fetchPreview({ style: base() }, 'live')).rejects.toThrow('ffmpeg exited');
    fail = false;
    await expect(fetchPreview({ style: base() }, 'live')).resolves.toMatchObject({ width: 540 });
  });
});

describe('tool registry and helpers', () => {
  it('every standalone route is a hub tool with an href, and vice versa', () => {
    const routed = TOOLS.filter((t) => t.href?.startsWith('/tools/')).map((t) => t.id);
    expect([...routed].sort()).toEqual([...TOOL_ROUTE_IDS].sort());
    for (const id of TOOL_ROUTE_IDS) {
      expect(TOOLS.find((t) => t.id === id)!.href).toBe(`/tools/${id}/`);
      expect(TOOL_ROUTE_META[id].title.length).toBeGreaterThan(2);
    }
  });

  it('covers the brief: 12 tool cards + 3 LATER, with unavailable ones disabled', () => {
    expect(TOOLS).toHaveLength(15);
    expect(
      TOOLS.filter((t) => t.group === 'Later')
        .map((t) => t.name)
        .sort(),
    ).toEqual(['AI Video Generator', 'Game Clipping', 'Speech Enhancer']);
    const disabled = TOOLS.filter((t) => !isToolAvailable(t))
      .map((t) => t.name)
      .sort();
    expect(disabled).toEqual([
      'AI Video Generator',
      'B-roll',
      'Game Clipping',
      'Live Clipping',
      'Speech Enhancer',
    ]);
    expect(TOOLS.find((t) => t.id === 'ai-clipping')!.href).toBe('/');
    // CP3: the Video Editor card opens Library → Edited (projects, and new ones from a clip / video / blank)
    expect(TOOLS.find((t) => t.id === 'editor')!.href).toBe('/library/?tab=edited');
  });

  it('builds and recognises tool links', () => {
    expect(toolHref('summary')).toBe('/tools/summary/');
    expect(toolHref('hook', { video: 'v 1', clip: 'c1' })).toBe('/tools/hook/?video=v+1&clip=c1');
    expect(toolHref('reframe', { video: null })).toBe('/tools/reframe/');
    expect(isToolRouteId('summary')).toBe(true);
    expect(isToolRouteId('editor')).toBe(false);
    expect(isToolRouteId(null)).toBe(false);
  });

  it('slugify makes safe file stems', () => {
    expect(slugify('Community Conversations: Autism Awareness & Local Art')).toBe(
      'community-conversations-autism-awareness-local-art',
    );
    expect(slugify('  ***  ')).toBe('video');
    expect(slugify('Ünïcode — títle')).toBe('unicode-title');
    expect(slugify('a'.repeat(200))).toHaveLength(60);
  });

  it('summaryToMarkdown includes every analysis section and skips empty ones', () => {
    const a: VideoAnalysis = {
      overview: { summary: 'S.', tone: 'Warm', participants: ['A', 'B'], takeaways: ['T1'] },
      chapters: [{ title: 'Intro', start: 0, end: 60, summary: 'Hello', source: 'ai' }],
      notes: {
        keyPoints: ['K1'],
        quotes: [{ text: 'Q', at: 75 }],
        numbers: [],
        claims: [],
        actionItems: ['Do it'],
      },
      topics: ['x', 'y'],
      entities: [],
      keywords: ['k'],
    };
    const md = summaryToMarkdown(
      'My Video',
      { channel: 'Chan', durationSec: 3725, sourceUrl: 'https://y/u' },
      a,
    );
    expect(md.startsWith('# My Video\n')).toBe(true);
    expect(md).toContain('_Chan · 1:02:05 · Tone: Warm_');
    expect(md).toContain('Source: https://y/u');
    expect(md).toContain('## Summary\n\nS.');
    expect(md).toContain('**Participants:** A, B');
    expect(md).toContain('- **0:00 Intro**: Hello');
    expect(md).toContain('[1:15] Q');
    expect(md).not.toContain('## Numbers');
    expect(md).toContain('## Topics\n\nx, y');
    expect(md.endsWith('\n')).toBe(true);
  });
});
