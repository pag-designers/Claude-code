import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BudgetExceededError } from '@main/pipeline/contracts';
import type { ChatRunInput, ChatToolResult } from '@main/pipeline/contracts2';
import { MAX_ITERATIONS } from '@main/services/chat/chat';
import { estimateTokens } from '@main/services/llm/transcript';
import type { Sentence } from '@shared/pipeline';
import { makeSentences, makeTranscript } from './llm-fixtures';
import { StubAnthropic, type StubReply, type WireBody } from './llm-stub-server';
import {
  allText,
  expectNoForbiddenParams,
  info,
  makeCost,
  makeV2,
  TEST_KEY,
  wireBlocks,
  wireSystem,
  wireTools,
} from './llm2-harness';

const stub = new StubAnthropic();
beforeAll(async () => {
  await stub.start();
});
afterAll(async () => {
  await stub.stop();
});
beforeEach(() => stub.reset());

type Action = Parameters<ChatRunInput['onAction']>[0];

function mk(over: Partial<ChatRunInput> = {}, exec?: ChatRunInput['executeTool']) {
  const deltas: string[] = [];
  const citations: { t: number; label: string }[] = [];
  const actions: Action[] = [];
  const executed: { name: string; input: Record<string, unknown> }[] = [];
  const input: ChatRunInput = {
    info: { title: info.title, channel: info.channel, description: info.description },
    analysis: null,
    transcript: makeTranscript(),
    clip: null,
    history: [],
    userText: 'What happened with the customers?',
    executeTool:
      exec ??
      ((name, i) => {
        executed.push({ name, input: i });
        return Promise.resolve<ChatToolResult>({
          ok: true,
          summary: `Ran ${name}.`,
          href: `/x/${name}`,
        });
      }),
    onDelta: (d) => deltas.push(d),
    onCitation: (c) => citations.push(c),
    onAction: (a) => actions.push({ ...a }),
    ...over,
  };
  return { input, deltas, citations, actions, executed };
}

const say = (text: string, extra: Partial<StubReply> = {}): StubReply => ({
  text,
  thinking: true,
  ...extra,
});
const call = (name: string, input: unknown, id?: string) => ({
  name,
  input,
  ...(id ? { id } : {}),
});
const lastMsg = (b: WireBody) => b.messages[b.messages.length - 1]!;
const blocksOf = (m: { content: unknown }) =>
  (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content) as {
    type: string;
    [k: string]: unknown;
  }[];

/* ----------------------------------------------- request shape ----------------------------------------------- */

describe('chat() - request shape (whole-transcript path)', () => {
  it('streams with strict + eager tools, the cached prefix first, and none of the forbidden parameters', async () => {
    stub.replies = [say('They lost 40% [00:57].')];
    const { service } = makeV2(stub);
    const { input } = mk();
    await service.chat(input);
    const b = stub.requests[0]!.body;
    expectNoForbiddenParams(b);
    expect(b.model).toBe('claude-sonnet-5-5');
    expect(b.output_config?.effort).toBe('low');
    expect(b.output_config).not.toHaveProperty('format'); // chat is free text + tools
    // tools: the five of the brief, strict, eager streaming, closed schemas, every property required
    const tools = wireTools(b);
    expect(tools.map((t) => t.name)).toEqual([
      'create_clip',
      'add_marker',
      'write_metadata',
      'rewrite_hook',
      'find_moments',
    ]);
    for (const t of tools) {
      expect(t.strict).toBe(true);
      expect(t.eager_input_streaming).toBe(true);
      expect(t.input_schema).toMatchObject({ type: 'object', additionalProperties: false });
      const props = Object.keys(t.input_schema.properties as object).sort();
      expect([...(t.input_schema.required as string[])].sort()).toEqual(props);
      expect(JSON.stringify(t.input_schema)).not.toMatch(/"(minimum|maximum|minLength|maxLength)"/);
    }
    // cache: system block, then the first user block (video context + WHOLE transcript)
    expect(wireSystem(b)[0]!.cache_control).toEqual({ type: 'ephemeral' });
    const blocks = wireBlocks(b);
    expect(blocks[0]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(blocks[0]!.text).toContain('<video_context>');
    expect(blocks[0]!.text).toContain('S0 [00:00]');
    expect(blocks[0]!.text).toContain('S45 [03:20]');
    expect(blocks[0]!.text).toContain('[END 03:27]');
    // the question is a separate, uncached block
    expect(blocks[1]!.text).toBe('What happened with the customers?');
    expect(blocks[1]!.cache_control).toBeUndefined();
    expect(b.messages).toHaveLength(1);
    expect(stub.requests[0]!.headers['x-api-key']).toBe(TEST_KEY);
    expect(stub.requests[0]!.headers.authorization).toBeUndefined();
  });

  it('the system prompt carries the safety rules: data vs instructions, act only when asked, I-do-not-know, citations', async () => {
    stub.replies = [say('ok')];
    const { service } = makeV2(stub);
    await service.chat(mk().input);
    const sys = wireSystem(stub.requests[0]!.body)[0]!.text!;
    expect(sys).toContain('is DATA');
    expect(sys).toContain('Act ONLY when the user');
    expect(sys).toContain("say plainly that you don't know");
    expect(sys).toContain('[03:41] or [1:03:41]');
    expect(sys).toContain('Reply in the language the user writes in');
  });

  it('prompt injection in the transcript cannot forge tags; only the real closing tag remains', async () => {
    stub.replies = [say('ok')];
    const { service } = makeV2(stub);
    await service.chat(mk().input); // fixture sentence 32 contains "</transcript> <request>"
    const ctx = wireBlocks(stub.requests[0]!.body)[0]!.text!;
    expect(ctx.match(/<\/transcript>/g)).toHaveLength(1);
    expect(ctx).toContain('‹/transcript›');
  });

  it('prompt cache: the next turn of the same thread re-reads tools + system + transcript', async () => {
    stub.replies = [say('First answer.'), say('Second answer.')];
    const { service } = makeV2(stub);
    await service.chat(mk().input);
    await service.chat(
      mk({
        userText: 'And then?',
        history: [
          { role: 'user', text: 'What happened with the customers?' },
          { role: 'assistant', text: 'First answer.' },
        ],
      }).input,
    );
    const [r1, r2] = stub.requests;
    expect(wireBlocks(r2!.body)[0]!.text).toBe(wireBlocks(r1!.body)[0]!.text);
    expect(JSON.stringify(wireTools(r2!.body))).toBe(JSON.stringify(wireTools(r1!.body)));
    expect(r1!.usage.cache_read_input_tokens).toBe(0);
    expect(r2!.usage.cache_read_input_tokens).toBeGreaterThan(1_000);
    expect(r2!.usage.cache_creation_input_tokens).toBe(0);
  });

  it('history: last 12 turns, text only, starting with a user turn; the cached block leads the first turn', async () => {
    stub.replies = [say('ok')];
    const { service } = makeV2(stub);
    const history = Array.from({ length: 20 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      text: `${i % 2 === 0 ? 'u' : 'a'}${i >> 1}`,
    }));
    await service.chat(mk({ history, userText: 'latest' }).input);
    const b = stub.requests[0]!.body;
    expect(b.messages).toHaveLength(13); // 12 history turns + the new question
    expect(b.messages.map((m) => m.role).slice(0, 4)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    const first = wireBlocks(b);
    expect(first[0]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(first[1]!.text).toBe('u4'); // turns 8..19 -> starts with u4
    expect(JSON.stringify(b.messages.slice(1))).not.toContain('"cache_control"');
    expect(blocksOf(lastMsg(b))[0]!.text).toBe('latest');
  });

  it('history that would start with an assistant turn drops that turn', async () => {
    stub.replies = [say('ok')];
    const { service } = makeV2(stub);
    const history = Array.from({ length: 13 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      text: `t${i}`,
    }));
    await service.chat(mk({ history, userText: 'q' }).input);
    const b = stub.requests[0]!.body;
    expect(b.messages[0]!.role).toBe('user');
    expect(wireBlocks(b)[1]!.text).toBe('t2'); // last 12 = t1..t12 -> t1 is an assistant turn, dropped
  });

  it('clip context is part of the cached block; analysis summary and chapters too', async () => {
    stub.replies = [say('ok')];
    const { service } = makeV2(stub);
    await service.chat(
      mk({
        clip: {
          id: 'clip-7',
          title: 'He called every customer',
          hook: 'The first million was the easy part',
          startSec: 57.2,
          endSec: 107.6,
          text: 'We lost forty percent.',
          whyItWorks: null,
          score: 82,
        },
        analysis: {
          overview: {
            summary: 'A founder nearly shuts down.',
            tone: 'candid',
            participants: [],
            takeaways: [],
          },
          chapters: [
            { title: 'Churn', start: 57, end: 100, summary: 'Customers leave.', source: 'ai' },
          ],
          notes: { keyPoints: [], quotes: [], numbers: [], claims: [], actionItems: [] },
          topics: ['startups'],
          entities: [],
          keywords: [],
        },
      }).input,
    );
    const ctx = wireBlocks(stub.requests[0]!.body)[0]!.text!;
    expect(ctx).toContain('<clip_context id="clip-7">');
    expect(ctx).toContain('AI summary: A founder nearly shuts down.');
    expect(ctx).toContain('- 00:57 Churn - Customers leave.');
  });
});

/* ------------------------------------------- streaming + citations ------------------------------------------- */

describe('chat() - streaming and citations', () => {
  it('deltas rebuild the returned text; markers split across deltas are parsed once; invented times are not reported', async () => {
    stub.replies = [
      say('x', {
        textChunks: [
          'The founder lost 40% of customers [00:',
          '57] and called each one [01',
          ':31]. Nothing at [59:59] though. Again [00:57] and a range [01:04-01:20].',
        ],
      }),
    ];
    const { service } = makeV2(stub);
    const { input, deltas, citations } = mk();
    const r = await service.chat(input);
    expect(deltas.join('')).toBe(r.text);
    expect(r.text).toContain('[00:57]'); // markers stay in the text so the UI can linkify them
    expect(r.text).toContain('[59:59]'); // ... even the invalid one (it is simply not a citation)
    expect(citations).toEqual([
      { t: 57, label: '00:57' },
      { t: 91, label: '01:31' },
      { t: 64, label: '01:04-01:20' },
    ]);
    expect(r.citations).toEqual(citations);
  });

  it('citations beyond the video are dropped (duration 207 s), h:mm:ss accepted for long videos', async () => {
    stub.replies = [say('See [03:25] and [03:30] and [1:00:00].')];
    const { service } = makeV2(stub);
    const { input, citations } = mk();
    await service.chat(input);
    expect(citations.map((c) => c.t)).toEqual([205]);
  });

  it('a refusal is an error (cost still recorded)', async () => {
    stub.replies = [
      {
        stopReason: 'refusal',
        text: '',
        stopDetails: { type: 'refusal', category: 'general_harms', explanation: null },
      },
    ];
    const cost = makeCost();
    const { service } = makeV2(stub, { cost });
    await expect(service.chat(mk().input)).rejects.toMatchObject({ code: 'refusal' });
    expect(cost.rows).toHaveLength(1);
  });

  it('max_tokens on a text answer: keeps the text, says it was cut off', async () => {
    stub.replies = [say('A long answer that', { stopReason: 'max_tokens' })];
    const { service } = makeV2(stub);
    const r = await service.chat(mk().input);
    expect(r.text).toContain('A long answer that');
    expect(r.text).toContain('cut off - ask me to continue');
  });

  it('pause_turn: the turn is appended and the request repeated', async () => {
    stub.replies = [say('Working on it. ', { stopReason: 'pause_turn' }), say('Final.')];
    const { service } = makeV2(stub);
    const r = await service.chat(mk().input);
    expect(stub.requests).toHaveLength(2);
    expect(stub.requests[1]!.body.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(r.text).toBe('Working on it. Final.');
  });

  it('an empty reply without any action is an error, not a blank message', async () => {
    stub.replies = [{ text: '', stopReason: 'end_turn' }];
    const { service } = makeV2(stub);
    await expect(service.chat(mk().input)).rejects.toMatchObject({ code: 'invalid-output' });
  });
});

/* -------------------------------------------------- tool loop -------------------------------------------------- */

describe('chat() - tool loop', () => {
  it('runs a tool, feeds back an exact-id tool_result, appends the assistant turn verbatim, and continues to the answer', async () => {
    stub.replies = [
      say('Sure, cutting that.', {
        toolUses: [
          call(
            'create_clip',
            { startSec: 57, endSec: 91, title: 'He called every customer' },
            'toolu_ABC',
          ),
        ],
      }),
      say('Done - the clip is ready [00:57].'),
    ];
    const { service } = makeV2(stub);
    const { input, executed, actions, deltas, citations } = mk({
      userText: 'Make a clip of the customer calls',
    });
    const r = await service.chat(input);

    expect(stub.requests).toHaveLength(2);
    // executed with validated + sentence-snapped input
    expect(executed).toEqual([
      {
        name: 'create_clip',
        input: { startSec: 57.2, endSec: 91, title: 'He called every customer' },
      },
    ]);
    // action cards: running then done, same id as the tool_use
    expect(actions.map((a) => [a.id, a.tool, a.status, a.summary, a.href])).toEqual([
      ['toolu_ABC', 'create_clip', 'running', null, null],
      ['toolu_ABC', 'create_clip', 'done', 'Ran create_clip.', '/x/create_clip'],
    ]);
    // second request: [user, assistant(thinking + text + tool_use), user(tool_result)]
    const m = stub.requests[1]!.body.messages;
    expect(m.map((x) => x.role)).toEqual(['user', 'assistant', 'user']);
    const asst = blocksOf(m[1]!);
    expect(asst.map((x) => x.type)).toEqual(['thinking', 'text', 'tool_use']);
    expect(asst[0]).toMatchObject({ type: 'thinking', signature: 'sig' }); // thinking replayed unchanged
    expect(asst[2]).toMatchObject({ id: 'toolu_ABC', name: 'create_clip' });
    expect(blocksOf(m[2]!)).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_ABC', content: 'Ran create_clip.' },
    ]);
    // tools + system + first message are byte-identical -> still a cache hit
    expect(JSON.stringify(wireTools(stub.requests[1]!.body))).toBe(
      JSON.stringify(wireTools(stub.requests[0]!.body)),
    );
    expect(stub.requests[1]!.usage.cache_read_input_tokens).toBeGreaterThan(1_000);
    // the text of both iterations is joined by a blank line and fully streamed
    expect(r.text).toBe('Sure, cutting that.\n\nDone - the clip is ready [00:57].');
    expect(deltas.join('')).toBe(r.text);
    expect(citations).toEqual([{ t: 57, label: '00:57' }]);
  });

  it('parallel tool calls: every call runs in block order and ALL results come back in ONE user message', async () => {
    stub.replies = [
      say('', {
        text: undefined,
        toolUses: [
          call('add_marker', { atSec: 30, label: 'Sponsor ends' }, 'toolu_1'),
          call('add_marker', { atSec: 57, label: 'The pivot' }, 'toolu_2'),
          call('find_moments', { prompt: 'the funniest moments' }, 'toolu_3'),
        ],
      }),
      say('Added two markers and started a search.'),
    ];
    const { service } = makeV2(stub);
    const { input, executed, actions } = mk({
      userText: 'Mark 0:30 and 0:57 and find the funny parts',
    });
    await service.chat(input);
    expect(executed.map((e) => e.name)).toEqual(['add_marker', 'add_marker', 'find_moments']);
    const results = blocksOf(lastMsg(stub.requests[1]!.body));
    expect(results.map((r) => [r.type, r.tool_use_id])).toEqual([
      ['tool_result', 'toolu_1'],
      ['tool_result', 'toolu_2'],
      ['tool_result', 'toolu_3'],
    ]);
    expect(actions.filter((a) => a.status === 'done').map((a) => a.id)).toEqual([
      'toolu_1',
      'toolu_2',
      'toolu_3',
    ]);
  });

  it('invalid tool input becomes an is_error result with a helpful message; nothing is executed; the model can retry', async () => {
    stub.replies = [
      say('', {
        text: undefined,
        toolUses: [
          call('create_clip', { startSec: 9999, endSec: 10020, title: 'Nope' }, 'toolu_bad1'),
          call('add_marker', { atSec: 10, label: 'L'.repeat(81) }, 'toolu_bad2'),
          call('create_clip', { startSec: 60, endSec: 90, title: 'T'.repeat(81) }, 'toolu_bad3'),
          call('create_clip', { startSec: 60, endSec: 61, title: 'Too short' }, 'toolu_bad4'),
          call('create_clip', { startSec: 0, endSec: 200, title: 'Too long' }, 'toolu_bad5'),
          call('delete_everything', {}, 'toolu_bad6'),
        ],
      }),
      say('', {
        text: undefined,
        toolUses: [call('create_clip', { startSec: 60, endSec: 90, title: 'Fixed' }, 'toolu_ok')],
      }),
      say('Created it.'),
    ];
    const { service } = makeV2(stub);
    const { input, executed, actions } = mk();
    const r = await service.chat(input);
    const res = blocksOf(lastMsg(stub.requests[1]!.body)) as unknown as {
      tool_use_id: string;
      is_error: boolean;
      content: string;
    }[];
    expect(res.every((x) => x.is_error)).toBe(true);
    expect(res.map((x) => x.tool_use_id)).toEqual([
      'toolu_bad1',
      'toolu_bad2',
      'toolu_bad3',
      'toolu_bad4',
      'toolu_bad5',
      'toolu_bad6',
    ]);
    expect(res[0]!.content).toContain('outside the video (0 to 207 seconds, i.e. 03:27)');
    expect(res[1]!.content).toContain('81 characters; use at most 80');
    expect(res[2]!.content).toContain('title has 81 characters');
    expect(res[3]!.content).toContain('minimum is 3');
    expect(res[4]!.content).toContain('at most 180 seconds');
    expect(res[5]!.content).toBe('Unknown tool "delete_everything".');
    expect(executed).toHaveLength(1); // only the corrected call ran
    expect(executed[0]!.input).toMatchObject({ title: 'Fixed' });
    expect(actions.filter((a) => a.status === 'failed')).toHaveLength(6);
    expect(r.text).toContain('Created it.');
  });

  it('a throwing or failing executeTool is reported to the model as an error result; secrets are redacted', async () => {
    stub.replies = [
      say('', {
        text: undefined,
        toolUses: [
          call('add_marker', { atSec: 5, label: 'a' }, 'toolu_t1'),
          call('add_marker', { atSec: 6, label: 'b' }, 'toolu_t2'),
        ],
      }),
      say('One failed, one did not.'),
    ];
    const { service, logs } = makeV2(stub);
    let n = 0;
    const { input, actions } = mk({}, () => {
      n++;
      if (n === 1) throw new Error(`database locked (key ${TEST_KEY})`);
      return Promise.resolve({ ok: false, summary: 'Marker limit reached.' });
    });
    await service.chat(input);
    const res = blocksOf(lastMsg(stub.requests[1]!.body)) as unknown as {
      is_error: boolean;
      content: string;
    }[];
    expect(res[0]).toMatchObject({ is_error: true });
    expect(res[0]!.content).toMatch(/^The action failed: database locked/);
    expect(res[1]).toMatchObject({ is_error: true, content: 'Marker limit reached.' });
    expect(JSON.stringify([res, actions, logs])).not.toContain(TEST_KEY);
    expect(actions.map((a) => a.status)).toEqual(['running', 'failed', 'running', 'failed']);
  });

  it(`stops after ${MAX_ITERATIONS} model calls when the model keeps calling tools`, async () => {
    stub.replies = [
      say('', { text: undefined, toolUses: [call('add_marker', { atSec: 5, label: 'again' })] }),
    ];
    const { service } = makeV2(stub);
    const { input, executed } = mk();
    const r = await service.chat(input);
    expect(stub.requests).toHaveLength(MAX_ITERATIONS);
    expect(executed).toHaveLength(MAX_ITERATIONS);
    expect(r.text).toContain('stopped here to stay within limits');
  });

  it('caps the number of actions per message at 8; extra calls get an error result', async () => {
    stub.replies = [
      say('', {
        text: undefined,
        toolUses: Array.from({ length: 10 }, (_, i) =>
          call('add_marker', { atSec: i + 1, label: `m${i}` }, `toolu_${i}`),
        ),
      }),
      say('Added some.'),
    ];
    const { service } = makeV2(stub);
    const { input, executed } = mk();
    await service.chat(input);
    expect(executed).toHaveLength(8);
    const res = blocksOf(lastMsg(stub.requests[1]!.body)) as unknown as {
      is_error?: boolean;
      content: string;
    }[];
    expect(res).toHaveLength(10);
    expect(res[8]).toMatchObject({ is_error: true });
    expect(res[8]!.content).toContain('Too many actions');
  });

  it('max_tokens that cut a tool call off never executes it', async () => {
    stub.replies = [
      say('Ok', {
        stopReason: 'max_tokens',
        toolUses: [call('create_clip', { startSec: 60, endSec: 90, title: 'Cut' })],
      }),
    ];
    const { service } = makeV2(stub);
    const { input, executed } = mk();
    const r = await service.chat(input);
    expect(executed).toHaveLength(0);
    expect(r.text).toContain('cut off before I could finish the action');
  });

  it('clip tools need the open clip: write_metadata without one is refused; with one the clipId is filled in', async () => {
    const calls = [
      say('', {
        text: undefined,
        toolUses: [call('write_metadata', { platform: 'all' }, 'toolu_m')],
      }),
      say('Need a clip first.'),
    ];
    stub.replies = calls;
    const { service } = makeV2(stub);
    const none = mk({ userText: 'Write the metadata' });
    await service.chat(none.input);
    expect(none.executed).toHaveLength(0);
    expect(
      (blocksOf(lastMsg(stub.requests[1]!.body))[0] as unknown as { content: string }).content,
    ).toContain('No clip is open');

    stub.reset();
    stub.replies = [
      say('', {
        text: undefined,
        toolUses: [
          call('write_metadata', { platform: 'tiktok' }, 'toolu_m'),
          call('rewrite_hook', { clipId: null, instruction: 'more provocative' }, 'toolu_h'),
          call('rewrite_hook', { clipId: 'other-clip', instruction: null }, 'toolu_x'),
        ],
      }),
      say('Done.'),
    ];
    const clip = {
      id: 'clip-7',
      title: 'T',
      hook: null,
      startSec: 0,
      endSec: 30,
      text: 'hello there',
      whyItWorks: null,
      score: null,
    };
    const withClip = mk({ clip, userText: 'metadata for tiktok and a punchier hook' });
    await service.chat(withClip.input);
    expect(withClip.executed).toEqual([
      { name: 'write_metadata', input: { platform: 'tiktok', clipId: 'clip-7' } },
      { name: 'rewrite_hook', input: { clipId: 'clip-7', instruction: 'more provocative' } },
    ]);
    expect(
      (blocksOf(lastMsg(stub.requests[1]!.body))[2] as unknown as { content: string }).content,
    ).toContain('Unknown clip id "other-clip"');
  });

  it('an unparseable streamed tool input is re-issued once (no text had been shown)', async () => {
    stub.replies = [
      say('', {
        text: undefined,
        toolUses: [call('add_marker', {})],
        rawToolJson: '{"atSec": 5 "label" !!',
      }),
      say('Plain answer.'),
    ];
    const { service } = makeV2(stub);
    const r = await service.chat(mk().input);
    expect(r.text).toBe('Plain answer.');
    expect(stub.requests).toHaveLength(2);
  });
});

/* ------------------------------------------------ abort / errors ------------------------------------------------ */

describe('chat() - abort and failures', () => {
  it('abort while the answer is streaming rejects with AbortError and runs nothing', async () => {
    stub.replies = [say('Partial answer that never ends', { hang: true })];
    const { service } = makeV2(stub);
    const ac = new AbortController();
    const { input, executed, deltas } = mk({ signal: ac.signal, onDelta: undefined });
    input.onDelta = (d) => {
      deltas.push(d);
      ac.abort();
    };
    await expect(service.chat(input)).rejects.toMatchObject({ name: 'AbortError' });
    expect(executed).toHaveLength(0);
    expect(stub.requests).toHaveLength(1);
  });

  it('abort while a tool_use is streaming', async () => {
    stub.replies = [
      say('', {
        text: undefined,
        toolUses: [call('add_marker', { atSec: 5, label: 'x' })],
        hangInToolUse: true,
      }),
    ];
    const { service } = makeV2(stub);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 80);
    const { input, executed } = mk({ signal: ac.signal });
    await expect(service.chat(input)).rejects.toMatchObject({ name: 'AbortError' });
    expect(executed).toHaveLength(0);
  });

  it('abort during a tool: the loop stops, no further request is made', async () => {
    stub.replies = [
      say('', { text: undefined, toolUses: [call('add_marker', { atSec: 5, label: 'x' })] }),
      say('never'),
    ];
    const { service } = makeV2(stub);
    const ac = new AbortController();
    const { input } = mk({ signal: ac.signal }, () => {
      ac.abort();
      return Promise.resolve({ ok: true, summary: 'Marker added.' });
    });
    await expect(service.chat(input)).rejects.toMatchObject({ name: 'AbortError' });
    expect(stub.requests).toHaveLength(1);
  });

  it('a stream that breaks AFTER text was shown is not retried (it would repeat the text)', async () => {
    stub.replies = [say('Hello there my friend', { sseErrorAfterText: true })];
    const { service } = makeV2(stub);
    const { input, deltas } = mk();
    await expect(service.chat(input)).rejects.toBeInstanceOf(Error);
    expect(stub.requests).toHaveLength(1);
    expect(deltas.length).toBeGreaterThan(0);
  });

  it('a 400 that names eager_input_streaming is retried once without it - and remembered', async () => {
    stub.replies = [
      {
        status: 400,
        errorType: 'invalid_request_error',
        errorMessage: 'tools.0.eager_input_streaming: not supported together with strict',
      },
      say('ok'),
      say('ok again'),
    ];
    const { service, logs } = makeV2(stub);
    await service.chat(mk().input);
    await service.chat(mk().input);
    expect(stub.requests).toHaveLength(3);
    expect(wireTools(stub.requests[0]!.body)[0]).toHaveProperty('eager_input_streaming', true);
    for (const r of stub.requests.slice(1)) {
      expect(wireTools(r.body)[0]).not.toHaveProperty('eager_input_streaming');
      expect(wireTools(r.body)[0]).toHaveProperty('strict', true);
    }
    expect(logs.some((l) => l.includes('eager_input_streaming rejected'))).toBe(true);
  });

  it('a 400 that names strict drops it too; a 401 is typed and never leaks the key', async () => {
    stub.replies = [
      {
        status: 400,
        errorType: 'invalid_request_error',
        errorMessage: 'tools.0.strict: Extra inputs are not permitted',
      },
      say('ok'),
    ];
    const { service } = makeV2(stub);
    await service.chat(mk().input);
    expect(wireTools(stub.requests[1]!.body)[0]).not.toHaveProperty('strict');

    stub.reset();
    stub.replies = [
      {
        status: 401,
        errorType: 'authentication_error',
        errorMessage: `invalid x-api-key ${TEST_KEY}`,
      },
    ];
    const logsAndErr = makeV2(stub);
    let err: unknown;
    try {
      await logsAndErr.service.chat(mk().input);
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: 'auth' });
    expect(JSON.stringify([String(err), logsAndErr.logs])).not.toContain(TEST_KEY);
  });

  it('no key / empty message: nothing is sent', async () => {
    const off = makeV2(stub, { key: null });
    await expect(off.service.chat(mk().input)).rejects.toMatchObject({ code: 'no-key' });
    const on = makeV2(stub);
    await expect(on.service.chat(mk({ userText: '   ' }).input)).rejects.toMatchObject({
      code: 'bad-request',
    });
    expect(stub.requests).toHaveLength(0);
  });
});

/* ---------------------------------------------------- budget ---------------------------------------------------- */

describe('chat() - budget and cost', () => {
  it('hard cap: BudgetExceededError, nothing sent', async () => {
    const { service } = makeV2(stub, { cost: makeCost({ spentUsd: 75 }) });
    await expect(service.chat(mk().input)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(stub.requests).toHaveLength(0);
  });

  it('over the monthly target the fast model answers', async () => {
    stub.replies = [say('ok')];
    const { service, logs } = makeV2(stub, { cost: makeCost({ spentUsd: 31 }) });
    await service.chat(mk().input);
    expect(stub.requests[0]!.body.model).toBe('claude-haiku-5-5');
    expect(logs.some((l) => l.includes('over monthly target'))).toBe(true);
  });

  it('every call is recorded with purpose "chat" and cache tokens; each loop iteration is one row', async () => {
    stub.replies = [
      say('', { text: undefined, toolUses: [call('add_marker', { atSec: 5, label: 'x' })] }),
      say('Marked.'),
    ];
    const cost = makeCost();
    const { service } = makeV2(stub, { cost });
    await service.chat(mk().input);
    expect(cost.rows.map((r) => r.purpose)).toEqual(['chat', 'chat']);
    expect(cost.rows[0]!.cacheWrites).toBeGreaterThan(0);
    expect(cost.rows[1]!.cachedTokens).toBeGreaterThan(0);
    expect(cost.rows[1]!.costUsd).toBeLessThan(cost.rows[0]!.costUsd);
  });
});

/* ------------------------------------------- retrieval (long videos) ------------------------------------------- */

/** ~4500 sentences = ~150K estimated tokens, 5 s each (6.25 h). Sentence 2500 mentions a zeppelin. */
function longSentences(n = 4500): Sentence[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i,
    s: i * 5,
    e: i * 5 + 4.5,
    text:
      i === 2500
        ? 'And then the zeppelin landed right on the stage in front of everybody there.'
        : `Sentence number ${i} talks about topic ${i % 50} with some more filler words to pad it out nicely.`,
    speaker: i % 7 < 4 ? 'S1' : 'S2',
    wordStart: 0,
    wordEnd: 0,
  }));
}
const longTranscript = () => {
  const sentences = longSentences();
  return {
    language: 'en',
    languageProbability: 1,
    durationSec: 4500 * 5,
    model: 'tiny',
    words: [],
    sentences,
  };
};
const isRetrieval = (b: WireBody) =>
  Object.keys(
    (b.output_config?.format?.schema as { properties?: object } | undefined)?.properties ?? {},
  ).includes('windows');

describe('chat() - retrieval path (transcript > ~60K tokens)', () => {
  const retrievalReply = (b: WireBody): StubReply => {
    const stable = wireBlocks(b)[0]!.text!;
    const first = Number(/^S(\d+) \[/m.exec(stable)![1]);
    const last = [...stable.matchAll(/^S(\d+) \[/gm)].at(-1)![1]!;
    const win = (a: number, z: number, rel: number) => ({
      startSentence: a,
      endSentence: z,
      relevance: rel,
    });
    return {
      text: JSON.stringify({
        windows: [
          win(first + 10, first + 20, 4),
          win(Number(last) - 30, Number(last) - 20, 9),
          win(999_999, 1_000_000, 10), // invented ids: must be ignored
        ],
      }),
    };
  };
  const reply = (b: WireBody): StubReply =>
    isRetrieval(b)
      ? retrievalReply(b)
      : say('The zeppelin landed [11:07:30]... I only looked at part of the video.');

  it('Haiku picks windows per ~70K-token slice; Sonnet answers from those excerpts only; both calls are recorded as "chat"', async () => {
    stub.replies = [reply];
    const cost = makeCost();
    const { service, logs } = makeV2(stub, { cost });
    const { input, citations } = mk({
      transcript: longTranscript(),
      userText: 'Where did the zeppelin land?',
    });
    const r = await service.chat(input);

    const retr = stub.requests.filter((x) => isRetrieval(x.body));
    const gen = stub.requests.filter((x) => !isRetrieval(x.body));
    expect(gen).toHaveLength(1);
    expect(retr.length).toBeGreaterThanOrEqual(2);
    for (const q of retr) {
      expect(q.body.model).toBe('claude-haiku-5-5');
      expect(q.body.output_config?.effort).toBe('low');
      expectNoForbiddenParams(q.body);
      expect(wireBlocks(q.body)[0]!.cache_control).toEqual({ type: 'ephemeral' });
      expect(estimateTokens(wireBlocks(q.body)[0]!.text!)).toBeLessThan(75_000); // stays on Haiku's cheap rate card
      expect(wireBlocks(q.body)[1]!.text).toContain(
        '<question>Where did the zeppelin land?</question>',
      );
    }
    const g = gen[0]!.body;
    expect(g.model).toBe('claude-sonnet-5-5');
    const ctx = wireBlocks(g)[0]!.text!;
    expect(ctx).toContain('<video_context>');
    expect(ctx).not.toContain('<transcript>'); // the full transcript is NOT in the prompt
    expect(allText(g).length).toBeLessThan(80_000);
    const blocks = wireBlocks(g);
    expect(blocks[0]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(blocks[1]!.text).toContain('<transcript_excerpts');
    expect(blocks[1]!.cache_control).toBeUndefined();
    expect(blocks.at(-1)!.text).toBe('Where did the zeppelin land?');
    // the excerpts contain the valid windows (+-2 sentences of margin) and not the invented one
    expect(blocks[1]!.text).toMatch(/^S8 \[/m);
    expect(blocks[1]!.text!.match(/\[excerpt \d+:/g)!.length).toBeGreaterThanOrEqual(4); // 2 windows per slice
    expect(blocks[1]!.text).not.toContain('S999999');
    expect(blocks[1]!.text).toMatch(/\[excerpt 1: 0:00:40-/); // h:mm:ss clock for a 6 h video
    // purposes
    expect(cost.rows.every((x) => x.purpose === 'chat')).toBe(true);
    expect(cost.rows).toHaveLength(retr.length + 1);
    expect(logs.some((l) => l.includes('retrieving relevant windows'))).toBe(true);
    // [11:07:30] = 40050 s is beyond this 22,500 s video: kept in the text, not reported as a citation
    expect(citations).toEqual([]);
    expect(r.text).toContain('only looked at part of the video');
  }, 60_000);

  it('the next question about the same long video re-reads the retrieval slices from the prompt cache', async () => {
    stub.replies = [reply];
    const { service } = makeV2(stub);
    const t = longTranscript();
    await service.chat(mk({ transcript: t, userText: 'First question about the stage?' }).input);
    const n1 = stub.requests.length;
    await service.chat(mk({ transcript: t, userText: 'Second question about topic 7?' }).input);
    const second = stub.requests.slice(n1).filter((x) => isRetrieval(x.body));
    expect(second.length).toBeGreaterThanOrEqual(2);
    for (const q of second) expect(q.usage.cache_read_input_tokens).toBeGreaterThan(10_000);
  }, 60_000);

  it('when the retrieval model fails to produce usable output, keyword matching takes over (logged)', async () => {
    stub.replies = [
      (b) => (isRetrieval(b) ? { text: 'definitely not json' } : say('It landed on the stage.')),
    ];
    const { service, logs } = makeV2(stub);
    const { input } = mk({ transcript: longTranscript(), userText: 'Tell me about the zeppelin' });
    const r = await service.chat(input);
    expect(r.text).toBe('It landed on the stage.');
    const gen = stub.requests.find((x) => !isRetrieval(x.body))!;
    expect(wireBlocks(gen.body)[1]!.text).toContain('zeppelin');
    expect(logs.some((l) => l.includes('keyword matching'))).toBe(true);
  }, 60_000);

  it('authentication errors during retrieval are NOT swallowed by the fallback', async () => {
    stub.replies = [{ status: 401, errorType: 'authentication_error', errorMessage: 'bad key' }];
    const { service } = makeV2(stub);
    await expect(service.chat(mk({ transcript: longTranscript() }).input)).rejects.toMatchObject({
      code: 'auth',
    });
  }, 60_000);

  it('sentences are never silently dropped: a transcript just under the threshold stays on the whole-transcript path', async () => {
    stub.replies = [say('ok')];
    const { service } = makeV2(stub);
    const t = { ...longTranscript(), sentences: longSentences(1500) };
    await service.chat(mk({ transcript: t }).input);
    expect(stub.requests).toHaveLength(1);
    expect(wireBlocks(stub.requests[0]!.body)[0]!.text).toContain('S1499 [');
  });
});

describe('fixture sanity', () => {
  it('makeSentences/makeTranscript are what the assertions above assume', () => {
    expect(makeSentences()).toHaveLength(46);
    expect(makeTranscript().durationSec).toBe(207);
  });
});
