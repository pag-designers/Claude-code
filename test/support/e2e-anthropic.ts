import {
  StubAnthropic,
  type StubReply,
  type WireBody,
  type WireBlock,
} from '../unit/llm-stub-server';

/**
 * A scripted stand-in for the Claude API used by the CP1 end-to-end run (NO real model is involved).
 * It reads the real prompts Clipfern sends (sentence lines "S12 [03:41] text", the <candidates> table
 * and the constraints) and answers with schema-valid JSON derived from the real transcript and the
 * real heuristic candidates, so the entire pipeline can be exercised offline. It says NOTHING about the
 * quality of real model output.
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

export function smartReply(body: WireBody): StubReply {
  const props = Object.keys(
    (body.output_config?.format?.schema as { properties?: Record<string, unknown> } | undefined)
      ?.properties ?? {},
  );
  let doc: unknown;
  if (props.includes('moments')) doc = rank(body);
  else if (props.includes('chapterSummaries')) doc = understand(body, true);
  else doc = understand(body, false);
  return { text: JSON.stringify(doc), thinking: true };
}

export async function startSmartAnthropicStub(): Promise<StubAnthropic> {
  const stub = new StubAnthropic();
  stub.replies = [(body) => smartReply(body)];
  return stub.start();
}
