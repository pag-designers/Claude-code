import { describe, expect, it } from 'vitest';
import { CitationScanner, parseMarkers } from '@main/services/chat/citations';
import { buildMessages, trimHistory } from '@main/services/chat/chat';
import {
  EXCERPT_TOKEN_BUDGET,
  lexicalWindows,
  selectWindows,
  sliceSentences,
} from '@main/services/chat/retrieval';
import { CHAT_TOOLS, snapSpan, validateToolCall } from '@main/services/chat/tools';
import { estimateTokens } from '@main/services/llm/transcript';
import { makeSentences } from './llm-fixtures';

const S = makeSentences(); // 46 sentences, 207 s
const ctx = { durationSec: 207, sentences: S, clipId: null as string | null };

describe('validateToolCall()', () => {
  it('create_clip: snaps to whole sentences (clock is floored, so 57 means the sentence starting at 57.2)', () => {
    const r = validateToolCall(
      'create_clip',
      { startSec: 57, endSec: 91, title: ' A  title ' },
      ctx,
    );
    expect(r).toEqual({ ok: true, input: { startSec: 57.2, endSec: 91, title: 'A title' } });
  });
  it("create_clip: an end that is the NEXT line's clock snaps back to the end of the last sentence", () => {
    // S20 ends at 91.0, S21 starts at 91.4 -> the model reads "[01:31]" for both
    const r = validateToolCall('create_clip', { startSec: 60, endSec: 91, title: 't' }, ctx);
    expect(r).toMatchObject({ ok: true, input: { endSec: 91 } });
    const r2 = validateToolCall('create_clip', { startSec: 60, endSec: 95, title: 't' }, ctx);
    expect(r2).toMatchObject({ ok: true, input: { endSec: 95.4 } }); // S21 ends at 95.4
  });
  it('create_clip: an end slightly past the video is clamped, far past is an error', () => {
    expect(
      validateToolCall('create_clip', { startSec: 190, endSec: 208, title: 't' }, ctx),
    ).toMatchObject({
      ok: true,
      input: { endSec: 207 },
    });
    expect(
      validateToolCall('create_clip', { startSec: 100, endSec: 260, title: 't' }, ctx),
    ).toMatchObject({
      ok: false,
    });
  });
  it('create_clip: rejects reversed, NaN, too-short, too-long, over-long titles', () => {
    const bad = (i: object) => validateToolCall('create_clip', i, ctx);
    expect(bad({ startSec: 90, endSec: 60, title: 't' })).toMatchObject({ ok: false });
    expect(bad({ startSec: 'x', endSec: 60, title: 't' })).toMatchObject({ ok: false });
    expect(bad({ startSec: 10, endSec: 11, title: 't' })).toMatchObject({ ok: false });
    expect(bad({ startSec: 0, endSec: 200, title: 't' })).toMatchObject({ ok: false });
    expect(bad({ startSec: 10, endSec: 40, title: 'x'.repeat(81) })).toMatchObject({ ok: false });
    expect(bad({ startSec: 10, endSec: 40, title: '  ' })).toMatchObject({ ok: false });
    expect(bad({ startSec: 10, endSec: 40 })).toMatchObject({ ok: false }); // missing title
    expect(bad({ startSec: 10, endSec: 40, title: 'ok', extra: 1 })).toMatchObject({ ok: true }); // unknown keys ignored
  });
  it('add_marker: inside the video, label 1-80 chars', () => {
    expect(validateToolCall('add_marker', { atSec: 12.34, label: ' Pivot ' }, ctx)).toEqual({
      ok: true,
      input: { atSec: 12.3, label: 'Pivot' },
    });
    expect(validateToolCall('add_marker', { atSec: -1, label: 'x' }, ctx)).toMatchObject({
      ok: false,
    });
    expect(validateToolCall('add_marker', { atSec: 208, label: 'x' }, ctx)).toMatchObject({
      ok: false,
    });
    expect(validateToolCall('add_marker', { atSec: 5, label: '' }, ctx)).toMatchObject({
      ok: false,
    });
  });
  it('write_metadata / rewrite_hook need the open clip; clipId is normalised', () => {
    expect(validateToolCall('write_metadata', { platform: 'all' }, ctx)).toMatchObject({
      ok: false,
    });
    const c = { ...ctx, clipId: 'c-1' };
    expect(validateToolCall('write_metadata', { platform: 'reels' }, c)).toEqual({
      ok: true,
      input: { platform: 'reels', clipId: 'c-1' },
    });
    expect(validateToolCall('write_metadata', { platform: 'youtube' }, c)).toMatchObject({
      ok: false,
    });
    expect(validateToolCall('rewrite_hook', { clipId: null, instruction: ' ' }, c)).toEqual({
      ok: true,
      input: { clipId: 'c-1', instruction: null },
    });
    expect(validateToolCall('rewrite_hook', { clipId: 'zzz', instruction: null }, c)).toMatchObject(
      { ok: false },
    );
  });
  it('find_moments: 3-300 characters', () => {
    expect(validateToolCall('find_moments', { prompt: 'funny parts' }, ctx)).toMatchObject({
      ok: true,
    });
    expect(validateToolCall('find_moments', { prompt: 'a' }, ctx)).toMatchObject({ ok: false });
    expect(validateToolCall('find_moments', { prompt: 'a'.repeat(301) }, ctx)).toMatchObject({
      ok: false,
    });
  });
  it('unknown tools, non-objects and prototype names are rejected', () => {
    expect(validateToolCall('rm_rf', {}, ctx)).toMatchObject({ ok: false });
    expect(validateToolCall('toString', {}, ctx)).toMatchObject({ ok: false });
    expect(validateToolCall('add_marker', 'text', ctx)).toMatchObject({ ok: false });
    expect(validateToolCall('add_marker', null, ctx)).toMatchObject({ ok: false });
  });
});

describe('tool definitions', () => {
  it('are strict-compatible: closed objects, all properties required, no unsupported keywords', () => {
    expect(CHAT_TOOLS.map((t) => t.name)).toEqual([
      'create_clip',
      'add_marker',
      'write_metadata',
      'rewrite_hook',
      'find_moments',
    ]);
    for (const t of CHAT_TOOLS) {
      const sch = t.input_schema as unknown as {
        properties: object;
        required: string[];
        additionalProperties: boolean;
      };
      expect(sch.additionalProperties).toBe(false);
      expect([...sch.required].sort()).toEqual(Object.keys(sch.properties).sort());
      expect(JSON.stringify(sch)).not.toMatch(/minimum|maximum|minLength|maxLength|\$schema/);
      expect(t.description.length).toBeGreaterThan(40);
    }
    const rh = CHAT_TOOLS[3]!.input_schema as unknown as { properties: Record<string, unknown> };
    expect(JSON.stringify(rh.properties.clipId)).toContain('null'); // optional = nullable
  });
});

describe('snapSpan()', () => {
  it('leaves spans alone when no sentence boundary is near', () => {
    expect(snapSpan(S, 125, 150.3)).toEqual([125, 150.3]);
  });
  it('works without sentences', () => {
    expect(snapSpan([], 10, 20)).toEqual([10, 20]);
  });
});

describe('citation markers', () => {
  it('parses mm:ss, h:mm:ss and ranges; rejects impossible clocks', () => {
    expect(
      parseMarkers(
        'a [03:41] b [1:03:41] c [00:57-01:20] d [12:75] e [1:75:00] f (03:41) g [3:4]',
      ).map((m) => [m.t, m.label]),
    ).toEqual([
      [221, '03:41'],
      [3821, '1:03:41'],
      [57, '00:57-01:20'],
    ]);
  });
  it('CitationScanner: split markers, duplicates, unfinished bracket at the end, long text', () => {
    const sc = new CitationScanner(600);
    const out = [...['x [0', '4:1', '0] y [04:10] z [', '05:'], ...['00] w [9']].flatMap((d) =>
      sc.push(d),
    );
    expect(out).toEqual([
      { t: 250, label: '04:10' },
      { t: 300, label: '05:00' },
    ]);
    expect(sc.push('9:59]')).toEqual([]); // 599 s is inside 600 s but the marker was "[9" + "9:59]" = "[99:59]" -> invalid
    const sc2 = new CitationScanner(600);
    expect(sc2.push('[ok] text '.repeat(500) + '[00:10]')).toEqual([{ t: 10, label: '00:10' }]);
  });
});

describe('retrieval helpers', () => {
  const long = Array.from({ length: 400 }, (_, i) => ({
    id: i,
    s: i * 5,
    e: i * 5 + 4,
    text:
      i === 123
        ? 'The zeppelin landed on the stage.'
        : `Filler sentence ${i} about nothing in particular at all.`,
    speaker: null,
    wordStart: 0,
    wordEnd: 0,
  }));
  it('sliceSentences keeps slices under the token limit, in order, without losing sentences', () => {
    const slices = sliceSentences(long, 1_000);
    expect(slices.length).toBeGreaterThan(3);
    expect(slices.flat().map((s) => s.id)).toEqual(long.map((s) => s.id));
    for (const sl of slices)
      expect(estimateTokens(sl.map((s) => `S${s.id} [00:00] ${s.text}`).join('\n'))).toBeLessThan(
        1_300,
      );
  });
  it('selectWindows: most relevant first, widened by 2, merged when adjacent, chronological, within the token budget', () => {
    const w = selectWindows(
      [
        { i0: 50, i1: 55, relevance: 3 },
        { i0: 10, i1: 12, relevance: 9 },
        { i0: 57, i1: 60, relevance: 8 },
      ],
      long,
      false,
    );
    expect(w).toEqual([
      { i0: 8, i1: 14, relevance: 9 },
      { i0: 48, i1: 62, relevance: 8 },
    ]);
    const many = Array.from({ length: 300 }, (_, i) => ({ i0: i, i1: i, relevance: 5 }));
    const picked = selectWindows(many, long, false);
    const text = picked
      .map((p) =>
        long
          .slice(p.i0, p.i1 + 1)
          .map((s) => s.text)
          .join('\n'),
      )
      .join('\n');
    expect(estimateTokens(text)).toBeLessThan(EXCERPT_TOKEN_BUDGET * 1.2);
  });
  it('lexicalWindows finds the sentence that contains the rare query word', () => {
    const w = lexicalWindows('where did the zeppelin land?', long);
    expect(w[0]!.i0).toBeLessThanOrEqual(123);
    expect(w[0]!.i1).toBeGreaterThanOrEqual(123);
    expect(lexicalWindows('the and of', long)).toEqual([]);
  });
});

describe('message building', () => {
  it('trimHistory: blanks removed, long text capped, starts with user', () => {
    const h = trimHistory([
      { role: 'assistant', text: 'orphan' },
      { role: 'user', text: ' hi ' },
      { role: 'assistant', text: ' ' },
      { role: 'assistant', text: 'x'.repeat(5_000) },
    ]);
    expect(h.map((x) => x.role)).toEqual(['user', 'assistant']);
    expect(h[0]!.text).toBe('hi');
    expect(h[1]!.text).toHaveLength(4_000);
  });
  it('buildMessages: cache marker only on the context block; excerpts precede the question', () => {
    const m = buildMessages('CTX', [], '<transcript_excerpts>', 'Q?');
    expect(m).toHaveLength(1);
    expect(m[0]!.content).toEqual([
      { type: 'text', text: 'CTX', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: '<transcript_excerpts>' },
      { type: 'text', text: 'Q?' },
    ]);
  });
});
