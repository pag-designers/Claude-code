import {
  StubAnthropic,
  type StubReply,
  type WireBody,
  type WireBlock,
} from '../unit/llm-stub-server';

/**
 * TEST-ONLY TOOLING - a scripted stand-in for the Claude API used by the end-to-end runs (NO real model
 * is involved and nothing here says anything about real answer quality).
 * It reads the real prompts Clipfern sends (sentence lines "S12 [03:41] text", the <candidates> table
 * and the constraints) and answers with schema-valid JSON derived from the real transcript and the
 * real heuristic candidates, so the entire pipeline can be exercised offline. It says NOTHING about the
 * quality of real model output.
 *
 * CP2 request kinds, recognised by the output schema / tools of the request:
 *   highlights ({segments, transition}) - 3-4 spans cut from the candidate sentences it can parse;
 *   hooks ({tiktok, reels, shorts} of {text, spoken, angle}) - 5x3 variants made of word windows of the clip text;
 *   metadata ({tiktok, reels, shorts} of {title, ..., postingTime}) - from the clip title and frequent words;
 *   thumbnails ({ranking, overlayText}) - ranks the "Frame K" images by position;
 *   retrieval ({windows}) - two windows per slice;
 *   chat (a request with `tools` and no structured output) - a short streamed answer that cites [mm:ss]
 *     clocks copied from the transcript lines, plus one `create_clip` tool call when the user text asks
 *     to "make a clip", then a closing sentence after the tool_result.
 */

interface Sent {
  id: number;
  t: number;
  text: string;
}

const clockToSec = (h: string | undefined, m: string, s: string) =>
  (h ? Number(h) * 3600 : 0) + Number(m) * 60 + Number(s);

function userText(body: WireBody): string {
  return body.messages
    .filter((m) => m.role === 'user')
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : m.content.map((b: WireBlock) => b.text).join('\n'),
    )
    .join('\n');
}

function parseSentences(text: string): Sent[] {
  const out: Sent[] = [];
  const re = /^S(\d+) \[(?:(\d+):)?(\d+):(\d+)\] (?:\{[^}]*\} )?(.*)$/gm;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push({ id: Number(m[1]), t: clockToSec(m[2], m[3] ?? '0', m[4] ?? '0'), text: m[5] ?? '' });
  }
  return out;
}

const words = (s: string, n: number) => s.split(/\s+/).filter(Boolean).slice(0, n).join(' ');
const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function rank(body: WireBody): unknown {
  const text = userText(body);
  const sents = parseSentences(text);
  const max = Number(/at most (\d+) moment/.exec(text)?.[1] ?? 3);
  const lines = text.split('\n').filter((l) => /^\S+ \| S\d+-S\d+ \|/.test(l));
  const cands = lines.map((l) => {
    const m =
      /^(\S+) \| S(\d+)-S(\d+) \| [^|]*\| hook=([\d.]+) energy=([\d.]+) rate=([\d.-]+) laugh=([\d.]+) selfc=([\d.]+)[^|]*\| "(.*)"$/.exec(
        l,
      );
    if (!m) return null;
    const hook = Number(m[4]);
    const energy = Number(m[5]);
    const laugh = Number(m[7]);
    const selfc = Number(m[8]);
    const total = Math.round(Math.min(88, 42 + 30 * hook + 10 * energy + 12 * selfc + 6 * laugh));
    return {
      id: m[1]!,
      a: Number(m[2]),
      b: Number(m[3]),
      hook,
      energy,
      selfc,
      laugh,
      total,
      snippet: m[9] ?? '',
    };
  });
  const ranked = cands
    .filter((c): c is NonNullable<typeof c> => c !== null)
    .sort((x, y) => y.total - x.total);
  const used: [number, number][] = [];
  const moments = [];
  for (const c of ranked) {
    if (moments.length >= max) break;
    if (used.some(([a, b]) => !(c.b < a || c.a > b))) continue;
    used.push([c.a, c.b]);
    const first = sents.find((s) => s.id === c.a);
    const kw = (first?.text ?? c.snippet)
      .split(/\W+/)
      .filter((w) => w.length > 6)
      .slice(0, 3);
    const split = (v: number, cap: number) => Math.max(0, Math.min(cap, Math.round(v)));
    const scale = c.total / 100;
    moments.push({
      candidateId: c.id,
      startSentence: c.a,
      endSentence: c.b,
      title: titleCase(words((first?.text ?? c.snippet).replace(/[.!?]+$/, ''), 9)).slice(0, 60),
      hook: titleCase(words(c.snippet.replace(/\.\.\.$/, ''), 7)),
      whyItWorks: `Scripted e2e stub: derived from heuristic signals (hook ${c.hook.toFixed(2)}, energy ${c.energy.toFixed(2)}).`,
      keywords: kw,
      scores: {
        hook: split(25 * scale * 1.05, 25),
        retention: split(25 * scale, 25),
        emotion: split(20 * scale * 0.9, 20),
        clarity: split(15 * scale * 1.05, 15),
        shareability: split(15 * scale * 0.95, 15),
      },
      confidence: 0.6,
    });
  }
  return { moments, windowNotes: moments.length ? '' : 'No candidates in this window.' };
}

function overview(sents: Sent[]) {
  return {
    summary: `${words(
      sents
        .slice(0, 4)
        .map((s) => s.text)
        .join(' '),
      60,
    )} (scripted e2e summary)`,
    tone: 'conversational, informative',
    participants: ['Host', 'Guest'],
    takeaways: sents
      .filter((_, i) => i % Math.max(1, Math.floor(sents.length / 5)) === 0)
      .slice(0, 5)
      .map((s) => words(s.text, 18)),
  };
}

function notes(sents: Sent[]) {
  const pick = (n: number) =>
    sents.filter((_, i) => i % Math.max(1, Math.floor(sents.length / n)) === 0).slice(0, n);
  return {
    keyPoints: pick(6).map((s) => words(s.text, 16)),
    quotes: pick(3).map((s) => ({ text: s.text, sentence: s.id })),
    numbers: [],
    claims: pick(2).map((s) => ({ text: words(s.text, 16), sentence: s.id })),
    actionItems: [],
  };
}

function understand(body: WireBody, yt: boolean): unknown {
  const text = userText(body);
  const sents = parseSentences(text);
  const tail = { topics: ['interview', 'community'], entities: [], keywords: ['interview'] };
  if (yt) {
    const n = (text.match(/=== CHAPTER \d+:/g) ?? []).length;
    return {
      overview: overview(sents),
      chapterSummaries: Array.from({ length: n }, (_, index) => ({
        index,
        summary: `Chapter ${index} summary (scripted).`,
      })),
      notes: notes(sents),
      ...tail,
    };
  }
  const n = Math.max(2, Math.min(6, Math.round(sents.length / 40)));
  const per = Math.max(1, Math.floor(sents.length / n));
  return {
    overview: overview(sents),
    chapters: Array.from({ length: n }, (_, i) => {
      const first = sents[i * per] ?? sents[0]!;
      return {
        title: titleCase(words(first.text.replace(/[.!?]+$/, ''), 6)),
        startSentence: i === 0 ? (sents[0]?.id ?? 0) : first.id,
        summary: `${words(first.text, 14)} (scripted).`,
      };
    }),
    notes: notes(sents),
    ...tail,
  };
}

/* ----------------------------------------------- CP2 request kinds ---------------------------------------------- */

/** All content blocks of all messages, flattened (text, image, tool_use, tool_result ...). */
type AnyBlock = {
  type: string;
  text?: string;
  content?: unknown;
  id?: string;
  tool_use_id?: string;
};
function allBlocks(body: WireBody): AnyBlock[] {
  return body.messages.flatMap((m) =>
    typeof m.content === 'string'
      ? [{ type: 'text', text: m.content }]
      : (m.content as unknown as AnyBlock[]),
  );
}

interface Candidate {
  id: string;
  score: number;
  sentences: { id: number; start: number; len: number; text: string }[];
}

function parseCandidates(text: string): Candidate[] {
  const out: Candidate[] = [];
  const re = /<candidate id="([^"]+)"[^>]*?(?: score="(\d+)")?>([\s\S]*?)<\/candidate>/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const sentences: Candidate['sentences'] = [];
    const lre = /^S(\d+) \[(?:(\d+):)?(\d+):(\d+), (\d+)s\] (?:\{[^}]*\} )?(.*)$/gm;
    for (let l = lre.exec(m[3] ?? ''); l; l = lre.exec(m[3] ?? '')) {
      sentences.push({
        id: Number(l[1]),
        start: clockToSec(l[2], l[3] ?? '0', l[4] ?? '0'),
        len: Number(l[5]),
        text: l[6] ?? '',
      });
    }
    out.push({ id: m[1] ?? '', score: Number(m[2] ?? 0), sentences });
  }
  return out;
}

function highlights(body: WireBody): unknown {
  const text = userText(body);
  const cands = parseCandidates(text).filter((c) => c.sentences.length > 0);
  const range = /between (\d+) and (\d+) seconds/.exec(text);
  const minSec = Number(range?.[1] ?? 60);
  const maxSec = Number(range?.[2] ?? 90);
  const n = Math.min(4, cands.length);
  const per = Math.min(24, Math.max(9, (minSec + maxSec) / 2 / Math.max(1, n)));
  // strongest candidate first (hook), the rest by score; the story is NOT chronological
  const chosen = [...cands].sort((a, b) => b.score - a.score).slice(0, n);
  const segments = chosen.map((c, i) => {
    let len = 0;
    let end = 0;
    while (end < c.sentences.length - 1 && len < per) len += c.sentences[end++]!.len + 0.4;
    return {
      candidateId: c.id,
      startSentence: c.sentences[0]!.id,
      endSentence: c.sentences[Math.max(0, end)]!.id,
      role:
        i === 0
          ? 'Opening hook (scripted)'
          : i === n - 1
            ? 'Payoff (scripted)'
            : 'Escalation (scripted)',
    };
  });
  const first = chosen[0]?.sentences[0]?.text ?? 'Highlights';
  return {
    segments,
    transition: 'crossfade',
    title: titleCase(words(first.replace(/[.!?]+$/, ''), 8)).slice(0, 60),
    hook: words(first, 8),
    whyItWorks:
      'Scripted e2e stand-in: strongest-scored clip first, others by score; crossfade chosen without looking at content.',
  };
}

const STOPWORDS = new Set(
  'that this with from have they there their what when your about would could should because which while where were been being them then than into over only just like also very more most some such'.split(
    ' ',
  ),
);

function clipTextOf(body: WireBody): { title: string; text: string } {
  const t = userText(body);
  return {
    title: /^Clip title: (.*)$/m.exec(t)?.[1] ?? 'Clip',
    text: /<clip_text>\n([\s\S]*?)\n<\/clip_text>/.exec(t)?.[1] ?? '',
  };
}

function hooks(body: WireBody): unknown {
  const { text } = clipTextOf(body);
  const w = text.split(/\s+/).filter(Boolean);
  const angles = ['curiosity', 'number', 'story', 'question', 'contrarian'];
  const make = (k: number, style: 'tiktok' | 'reels' | 'shorts') => {
    const span =
      w.length > 8 ? w.slice((k * 6) % (w.length - 7), ((k * 6) % (w.length - 7)) + 7) : w;
    const raw = span.join(' ').replace(/[.!?,;:]+$/, '');
    const t =
      style === 'tiktok'
        ? raw.toLowerCase()
        : style === 'reels'
          ? `${titleCase(raw)}.`
          : `${titleCase(raw)} (${k + 1})`;
    return {
      text: t,
      spoken: k % 2 === 0 ? `${raw}, and here is why.` : null,
      angle: angles[k % 5]!,
    };
  };
  const set = (style: 'tiktok' | 'reels' | 'shorts') =>
    Array.from({ length: 5 }, (_, k) => make(k, style));
  return { tiktok: set('tiktok'), reels: set('reels'), shorts: set('shorts') };
}

function metadata(body: WireBody): unknown {
  const { title, text } = clipTextOf(body);
  const freq = new Map<string, number>();
  for (const x of text.toLowerCase().match(/[a-z]{5,}/g) ?? [])
    if (!STOPWORDS.has(x)) freq.set(x, (freq.get(x) ?? 0) + 1);
  const tags = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k)
    .slice(0, 4);
  while (tags.length < 3) tags.push(['clips', 'story', 'video'][tags.length] ?? 'clip');
  const one = (day: number | null, hour: number, max: number) => ({
    title: title.slice(0, max),
    description: `${words(text, 24)} (scripted e2e description)`,
    hashtags: tags,
    postingTime: {
      dayOfWeek: day,
      hour,
      reason: 'Scripted e2e stand-in value, not a recommendation.',
    },
  });
  return { tiktok: one(2, 18, 90), reels: one(4, 19, 100), shorts: one(null, 17, 100) };
}

function thumbnails(body: WireBody): unknown {
  const n = allBlocks(body).filter((b) => b.type === 'image').length;
  const { title } = clipTextOf(body);
  return {
    ranking: Array.from({ length: n }, (_, i) => ({
      frame: i + 1,
      note: 'Scripted e2e stand-in: ranked by position.',
    })),
    overlayText: words(title, 3),
  };
}

function retrieval(body: WireBody): unknown {
  const ids = parseSentences(userText(body)).map((s) => s.id);
  if (ids.length === 0) return { windows: [] };
  const at = (f: number) => ids[Math.min(ids.length - 1, Math.floor(ids.length * f))]!;
  return {
    windows: [
      {
        startSentence: at(0.1),
        endSentence: ids[Math.min(ids.length - 1, ids.indexOf(at(0.1)) + 8)]!,
        relevance: 7,
      },
      {
        startSentence: at(0.6),
        endSentence: ids[Math.min(ids.length - 1, ids.indexOf(at(0.6)) + 8)]!,
        relevance: 5,
      },
    ],
  };
}

const clockOf = (t: string) => /^S\d+ \[([\d:]+)\]/.exec(t)?.[1] ?? '00:00';

function chat(body: WireBody): StubReply {
  const blocks = allBlocks(body);
  const last = body.messages[body.messages.length - 1]!;
  const lastBlocks =
    typeof last.content === 'string' ? [] : (last.content as unknown as AnyBlock[]);
  const results = lastBlocks.filter((b) => b.type === 'tool_result');
  if (results.length) {
    const said = results.map((r) => (typeof r.content === 'string' ? r.content : 'ok')).join(' ');
    return { text: `Scripted e2e stand-in: all done. ${said}`, thinking: true };
  }
  const textBlocks = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '');
  const question = [...textBlocks].reverse().find((t) => !t.startsWith('<')) ?? '';
  const lines = textBlocks
    .join('\n')
    .split('\n')
    .filter((l) => /^S\d+ \[[\d:]+\]/.test(l));
  const qWords = new Set(question.toLowerCase().match(/[a-z]{4,}/g) ?? []);
  const scored = lines
    .map((l, i) => ({
      l,
      i,
      s: (l.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => qWords.has(w)).length,
    }))
    .sort((a, b) => b.s - a.s || a.i - b.i);
  const top = scored.slice(0, 2).sort((a, b) => a.i - b.i);
  const cite = (l: string) => `[${clockOf(l)}]`;
  const body1 = top.length
    ? `Scripted e2e stand-in answer. ${words(top[0]!.l.replace(/^S\d+ \[[\d:]+\] (?:\{[^}]*\} )?/, ''), 18)} ${cite(top[0]!.l)}` +
      (top[1]
        ? ` Also: ${words(top[1].l.replace(/^S\d+ \[[\d:]+\] (?:\{[^}]*\} )?/, ''), 12)} ${cite(top[1].l)}`
        : '')
    : "Scripted e2e stand-in answer. I don't know - the transcript is empty.";
  if (/make (me )?(a |the )?clip/i.test(question) && top[0]) {
    const sec = (l: string) =>
      clockToSec(undefined, ...(clockOf(l).split(':').slice(-2) as [string, string]));
    const start = sec(top[0].l);
    const next = lines[Math.min(lines.length - 1, top[0].i + 4)];
    const end = Math.max(start + 10, next ? sec(next) : start + 20);
    return {
      text: 'Scripted e2e stand-in: creating that clip.',
      thinking: true,
      toolUses: [
        {
          name: 'create_clip',
          input: {
            startSec: start,
            endSec: end,
            title: titleCase(
              words(question.replace(/make (me )?(a |the )?clip( of| about)?/i, ''), 6) ||
                'Chat clip',
            ),
          },
        },
      ],
    };
  }
  return { text: body1, thinking: true };
}

export function smartReply(body: WireBody): StubReply {
  const schema = body.output_config?.format?.schema as
    { properties?: Record<string, unknown> } | undefined;
  const props = Object.keys(schema?.properties ?? {});
  const hasTools = Array.isArray((body as { tools?: unknown }).tools);
  let doc: unknown;
  if (!schema && hasTools) return chat(body);
  if (props.includes('moments')) doc = rank(body);
  else if (props.includes('chapterSummaries')) doc = understand(body, true);
  else if (props.includes('segments') && props.includes('transition')) doc = highlights(body);
  else if (props.includes('ranking') && props.includes('overlayText')) doc = thumbnails(body);
  else if (props.includes('windows')) doc = retrieval(body);
  else if (props.includes('tiktok') && props.includes('reels'))
    doc = JSON.stringify(schema).includes('postingTime') ? metadata(body) : hooks(body);
  else doc = understand(body, false);
  return { text: JSON.stringify(doc), thinking: true };
}

export async function startSmartAnthropicStub(): Promise<StubAnthropic> {
  const stub = new StubAnthropic();
  stub.replies = [(body) => smartReply(body)];
  return stub.start();
}
