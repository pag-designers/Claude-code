/**
 * LIVE smoke check of the LLM layer against the real Anthropic API.
 *
 *   ANTHROPIC_API_KEY=sk-ant-... node scripts/llm-smoke.mjs <transcript.json> [options]
 *
 * <transcript.json> is a `Transcript` (shared/pipeline.ts), e.g. the fixtures produced by the
 * media engineer (`news-3min.transcript.json`, `news-full.transcript.json`).
 * Options:  --windows=N      rank the first N windows (default 2)
 *           --window-sec=S   window length in seconds (default 600)
 *           --preset=30-60   clip length preset: 15-30 | 30-60 | 60-90 (default 30-60)
 *           --clips=N        clips wanted for the whole video (default 10)
 *           --prompt="..."   steering prompt; when given, window 1 is run twice (plain, then steered)
 *                            so you can see the second run hit the prompt cache
 *           --dry-run        no API call and no key needed: print prompt sizes and the cost estimate
 *           --cp2            CP2 mode (see runSmokeCp2): hooks, metadata, highlights, a 3-turn chat with a
 *                            tool call (and thumbnails with --frames=<dir of jpgs>) on the transcript
 *           --frames=DIR     (--cp2) rank the first 6 .jpg/.png files of DIR as thumbnail candidates
 *           --long-hours=H   (--cp2 --dry-run) also price a chat on an H-hour video (default 6)
 *
 * What it does: understand() on the whole transcript, then rankMoments() on the first N windows with
 * naive heuristic candidates, printing overview, chapters, every moment and - from the API's own usage
 * numbers - the dollars spent (the same CostTracker maths as the app). A run of the 3-minute
 * fixture costs a few cents; the 19-minute one well under a dollar.
 *
 * What to look at: do the clips start on a hook and end on a payoff, are scores spread out (not all
 * 80+), is `cacheRead` > 0 on the second call, and is the cost in line with the estimate.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  durationRange,
  pipelineOptionsSchema,
  totalScore,
  transcriptSchema,
} from '@shared/pipeline';
import type { Transcript } from '@shared/pipeline';
import { DEFAULT_SETTINGS } from '@shared/settings';
import type { CostSummary } from '@shared/domain';
import { computeCostUsd, type Usage } from '../cost';
import type { CostPort } from './budget';
import { estimateRunCost, momentsPerWindow, naiveCandidates, splitWindows } from './estimate';
import { estimateCp2Cost, toHighlightCandidates } from './estimate2';
import { createLlmService } from './index';
import { fmtClock } from './transcript';

export interface SmokeOptions {
  windows?: number;
  windowSec?: number;
  preset?: '15-30' | '30-60' | '60-90';
  clips?: number;
  prompt?: string;
  dryRun?: boolean;
  baseUrl?: string;
  /** --cp2: directory with candidate thumbnail frames. */
  frames?: string;
  /** --cp2 --dry-run: also price a chat on a video of this many hours. */
  longHours?: number;
  /** Where lines go; defaults to stdout. */
  print?: (line: string) => void;
}

export interface SmokeResult {
  calls: { purpose: string; model: string; usage: Usage; usd: number }[];
  totalUsd: number;
  momentCount: number;
}

export function loadTranscript(path: string): Transcript {
  const raw: unknown = JSON.parse(fs.readFileSync(path, 'utf8'));
  const candidate = (raw as { transcript?: unknown }).transcript ?? raw;
  const parsed = transcriptSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(
      `${path} is not a Transcript: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}

const usd = (n: number) => `$${n.toFixed(4)}`;

export async function runSmoke(
  apiKey: string | null,
  transcriptJsonPath: string,
  opts: SmokeOptions = {},
): Promise<SmokeResult> {
  const print = opts.print ?? ((l: string) => void process.stdout.write(`${l}\n`));
  const transcript = loadTranscript(transcriptJsonPath);
  const options = pipelineOptionsSchema.parse({
    clipPreset: opts.preset ?? '30-60',
    clipCount: opts.clips ?? 10,
    prompt: opts.prompt ?? '',
  });
  const range = durationRange(options);
  const windowSec = opts.windowSec ?? 600;
  const title =
    transcriptJsonPath
      .split('/')
      .pop()
      ?.replace(/\.transcript\.json$/, '') ?? 'Smoke test video';

  const est = estimateRunCost({ transcript, title, options, windowSec });
  print(
    `Transcript: ${transcript.sentences.length} sentences, ${fmtClock(transcript.durationSec)} ` +
      `(${transcript.language}), ${est.windows} window(s) of ~${windowSec}s`,
  );
  print(
    `Estimate for the WHOLE video: understand ${usd(est.understand.usd)} + moments ${usd(est.moments.usd)} ` +
      `= ${usd(est.totalUsd)} (a steered re-run of all windows: ~${usd(est.steeredRerunUsd)})`,
  );
  est.assumptions.forEach((a) => print(`  - ${a}`));
  if (opts.dryRun) return { calls: [], totalUsd: 0, momentCount: 0 };
  if (!apiKey) throw new Error('Set ANTHROPIC_API_KEY (or use --dry-run).');

  // ---- in-memory cost tracker with the app's pricing maths
  const calls: SmokeResult['calls'] = [];
  const cost: CostPort = {
    record: (model, purpose, usage) => {
      const u = computeCostUsd(model, usage);
      calls.push({ purpose, model, usage, usd: u });
      return Promise.resolve(u);
    },
    summary: () => {
      const spent = calls.reduce((a, c) => a + c.usd, 0);
      const s: CostSummary = {
        month: 'smoke',
        spentUsd: spent,
        projectedUsd: spent,
        targetUsd: DEFAULT_SETTINGS.budgetTargetUsd,
        hardCapUsd: DEFAULT_SETTINGS.budgetHardCapUsd,
        calls: calls.length,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        level: 'ok',
      };
      return Promise.resolve(s);
    },
  };
  const llm = createLlmService({
    getApiKey: () => apiKey,
    getSettings: () => Promise.resolve(DEFAULT_SETTINGS),
    cost,
    baseUrl: opts.baseUrl,
    log: (m) => print(`  [llm] ${m}`),
    onBudget: (l) => print(`  [budget] ${l}`),
  });

  // ---- 1. understand
  print('\n=== understand() ===');
  const t0 = Date.now();
  const analysis = await llm.understand({
    info: { title, channel: null, description: null, chapters: [] },
    transcript,
    onProgress: () => {},
  });
  print(`(${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  print(`Summary: ${analysis.overview.summary}`);
  print(
    `Tone: ${analysis.overview.tone}   Participants: ${analysis.overview.participants.join(', ')}`,
  );
  analysis.overview.takeaways.forEach((t, i) => print(`  ${i + 1}. ${t}`));
  print('Chapters:');
  analysis.chapters.forEach((c) =>
    print(`  ${fmtClock(c.start)}-${fmtClock(c.end)}  ${c.title} - ${c.summary}`),
  );
  print(
    `Notes: ${analysis.notes.keyPoints.length} key points, ${analysis.notes.quotes.length} quotes, ` +
      `${analysis.notes.numbers.length} numbers, ${analysis.notes.claims.length} claims, ` +
      `${analysis.notes.actionItems.length} action items`,
  );
  print(`Topics: ${analysis.topics.join(', ')}`);

  // ---- 2. rank the first N windows
  const windows = splitWindows(transcript.sentences, windowSec).slice(0, opts.windows ?? 2);
  const perWindow = momentsPerWindow(
    options.clipCount,
    est.windows,
    Math.min(windowSec, transcript.durationSec),
    range,
  );
  let momentCount = 0;
  const runWindow = async (wi: number, prompt: string) => {
    const w = windows[wi]!;
    const candidates = naiveCandidates(w.sentences, range, 15);
    print(
      `\n=== rankMoments() window ${wi + 1}/${windows.length} ${fmtClock(w.startSec)}-${fmtClock(w.endSec)}` +
        `${prompt ? `  steering: "${prompt}"` : ''}  (${candidates.length} naive candidates) ===`,
    );
    const t1 = Date.now();
    const moments = await llm.rankMoments({
      videoId: 'smoke',
      info: { title, channel: null },
      analysis: { overview: analysis.overview, topics: analysis.topics },
      options: { ...options, prompt },
      window: { startSec: w.startSec, endSec: w.endSec },
      sentences: w.sentences,
      candidates,
      maxClips: perWindow,
    });
    print(`(${((Date.now() - t1) / 1000).toFixed(1)}s) ${moments.length} moment(s)`);
    for (const m of moments) {
      print(
        `\n  [${totalScore(m.breakdown)}] ${fmtClock(m.startSec)}-${fmtClock(m.endSec)} (${Math.round(m.endSec - m.startSec)}s)  ${m.title}`,
      );
      print(
        `      hook: "${m.hook}"   confidence ${m.confidence.toFixed(2)}   candidate ${m.candidateId ?? '-'}`,
      );
      print(`      why:  ${m.whyItWorks}`);
      const b = m.breakdown;
      print(
        `      hook ${b.hook}/25  retention ${b.retention}/25  emotion ${b.emotion}/20  clarity ${b.clarity}/15  share ${b.shareability}/15   keywords: ${m.keywords.join(', ')}`,
      );
      const text = transcript.sentences.filter(
        (s) => s.s >= m.startSec - 0.01 && s.e <= m.endSec + 0.01,
      );
      if (text.length) {
        print(`      first: ${text[0]!.text}`);
        print(`      last:  ${text[text.length - 1]!.text}`);
      }
    }
    momentCount += moments.length;
  };
  for (let i = 0; i < windows.length; i++) await runWindow(i, i === 0 ? '' : options.prompt);
  if (options.prompt && windows.length) await runWindow(0, options.prompt); // steered re-run -> cache hit

  // ---- 3. cost table
  print('\n=== API usage and cost (API-reported tokens, app pricing) ===');
  print('purpose      model               input  cacheRead cacheWrite   output        cost');
  for (const c of calls) {
    print(
      `${c.purpose.padEnd(12)} ${c.model.padEnd(18)} ${String(c.usage.inputTokens).padStart(7)} ${String(c.usage.cacheReadTokens ?? 0).padStart(9)} ${String(c.usage.cacheWriteTokens ?? 0).padStart(10)} ${String(c.usage.outputTokens).padStart(8)} ${usd(c.usd).padStart(11)}`,
    );
  }
  const total = calls.reduce((a, c) => a + c.usd, 0);
  print(`TOTAL ${usd(total)} for ${calls.length} call(s)`);
  return { calls, totalUsd: total, momentCount };
}

/* ------------------------------------------------- CP2 smoke ------------------------------------------------- */

function makeCostPort(calls: SmokeResult['calls']): CostPort {
  return {
    record: (model, purpose, usage) => {
      const u = computeCostUsd(model, usage);
      calls.push({ purpose, model, usage, usd: u });
      return Promise.resolve(u);
    },
    summary: () => {
      const spent = calls.reduce((a, c) => a + c.usd, 0);
      const s: CostSummary = {
        month: 'smoke',
        spentUsd: spent,
        projectedUsd: spent,
        targetUsd: DEFAULT_SETTINGS.budgetTargetUsd,
        hardCapUsd: DEFAULT_SETTINGS.budgetHardCapUsd,
        calls: calls.length,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        level: 'ok',
      };
      return Promise.resolve(s);
    },
  };
}

const wrap = (text: string, indent: string, width = 110) =>
  text
    .split('\n')
    .flatMap((para) => {
      const out: string[] = [];
      let line = '';
      for (const w of para.split(/\s+/)) {
        if (line && line.length + w.length + 1 > width) {
          out.push(line);
          line = w;
        } else line = line ? `${line} ${w}` : w;
      }
      out.push(line);
      return out;
    })
    .map((l) => indent + l)
    .join('\n');

/**
 * CP2 live check: the calls the Library/Chat drawer make, on a real transcript, with the app's own
 * pricing. WITHOUT a key (`dryRun`) it prints prompt sizes and cost estimates only.
 *
 * Run it, then LOOK at: are the 5 hooks per platform really different and true to the clip? is the
 * highlight order a story (strong opener, payoff last) and the transition justified? do the chat
 * answers cite times that match the transcript, say "I don't know" when the video does not say, and
 * does ONLY the "make a clip" turn call a tool? is `cacheRead` > 0 from chat turn 2 on?
 */
export async function runSmokeCp2(
  apiKey: string | null,
  transcriptJsonPath: string,
  opts: SmokeOptions = {},
): Promise<SmokeResult> {
  const print = opts.print ?? ((l: string) => void process.stdout.write(`${l}\n`));
  const transcript = loadTranscript(transcriptJsonPath);
  const title =
    path.basename(transcriptJsonPath).replace(/\.transcript\.json$/, '') || 'Smoke test video';
  const sentences = transcript.sentences.filter((s) => s.text.trim());

  // ---- estimate (always)
  const est = estimateCp2Cost({
    transcript,
    title,
    longVideoHours: opts.dryRun ? (opts.longHours ?? 6) : undefined,
  });
  print(
    `Transcript: ${sentences.length} sentences, ${fmtClock(transcript.durationSec)} (${transcript.language}); ` +
      `~${Math.round(est.transcriptTokens / 1000)}K prompt tokens -> chat path: ${est.chatPath === 'whole' ? 'whole transcript in the cached prefix' : 'retrieval (Haiku picks windows)'}`,
  );
  print('\nEstimated cost per call kind (first call = cache write; follow-ups read the cache):');
  print(
    'kind                                          model                          input  cWrite   cRead  output        USD',
  );
  for (const c of est.calls) {
    print(
      `${c.kind.padEnd(45)} ${c.model.slice(0, 30).padEnd(30)} ${String(c.inputTokens).padStart(6)} ${String(c.cacheWriteTokens).padStart(7)} ${String(c.cacheReadTokens).padStart(7)} ${String(c.outputTokens).padStart(7)} ${usd(c.usd).padStart(10)}`,
    );
  }
  est.assumptions.forEach((a) => print(`  - ${a}`));
  if (opts.dryRun) return { calls: [], totalUsd: 0, momentCount: 0 };
  if (!apiKey) throw new Error('Set ANTHROPIC_API_KEY (or use --dry-run).');

  const calls: SmokeResult['calls'] = [];
  const llm = createLlmService({
    getApiKey: () => apiKey,
    getSettings: () => Promise.resolve(DEFAULT_SETTINGS),
    cost: makeCostPort(calls),
    baseUrl: opts.baseUrl,
    log: (m) => print(`  [llm] ${m}`),
    onBudget: (l) => print(`  [budget] ${l}`),
  });
  const timed = async <T>(label: string, f: () => Promise<T>): Promise<T> => {
    print(`\n=== ${label} ===`);
    const t0 = Date.now();
    const r = await f();
    print(`(${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    return r;
  };

  const info = { title, channel: null };
  const cands = toHighlightCandidates(sentences, 8);
  const top = cands[0];
  if (!top) throw new Error('The transcript is too short to cut a clip from.');
  const clip = {
    title: top.title,
    hook: null,
    startSec: top.startSec,
    endSec: top.endSec,
    text: top.text,
    whyItWorks: null,
    score: null,
  };
  print(
    `\nTest clip: ${fmtClock(clip.startSec)}-${fmtClock(clip.endSec)}  "${clip.text.slice(0, 120)}..."`,
  );

  // ---- 1. hooks
  const hooks = await timed('writeHooks()', () => llm.writeHooks({ info, clip }));
  for (const p of ['tiktok', 'reels', 'shorts'] as const) {
    print(`${p}:`);
    hooks[p].forEach((h, i) =>
      print(`  ${i + 1}. [${h.angle}] ${h.text}${h.spoken ? `   (say: "${h.spoken}")` : ''}`),
    );
  }

  // ---- 2. metadata
  const meta = await timed('writeMeta()', () =>
    llm.writeMeta({ info, clip, hook: hooks.tiktok[0]?.text ?? null }),
  );
  for (const p of ['tiktok', 'reels', 'shorts'] as const) {
    const m = meta[p];
    print(`${p}: ${m.title}`);
    print(wrap(m.description, '    '));
    print(`    ${m.hashtags.map((h) => `#${h}`).join(' ')}`);
    print(
      `    post: ${m.postingTime.dayOfWeek === null ? 'any day' : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][m.postingTime.dayOfWeek]} ${m.postingTime.hour}:00 - ${m.postingTime.reason}`,
    );
  }

  // ---- 3. highlights
  const plan = await timed(`composeHighlights() from ${cands.length} candidates`, () =>
    llm.composeHighlights({
      info,
      analysis: null,
      candidates: cands,
      prompt: opts.prompt ?? '',
      minSec: 45,
      maxSec: 90,
    }),
  );
  print(`"${plan.title}"   hook: "${plan.hook}"   transition: ${plan.transition}`);
  plan.segments.forEach((s, i) => {
    const text = sentences
      .filter((x) => x.s >= s.startSec - 0.01 && x.e <= s.endSec + 0.01)
      .map((x) => x.text)
      .join(' ');
    print(
      `  ${i + 1}. ${fmtClock(s.startSec)}-${fmtClock(s.endSec)} (${Math.round(s.endSec - s.startSec)}s) ${s.role}`,
    );
    print(wrap(text.slice(0, 220), '       '));
  });
  print(wrap(`Why it works: ${plan.whyItWorks}`, '  '));

  // ---- 4. thumbnails (optional)
  if (opts.frames) {
    const files = fs
      .readdirSync(opts.frames)
      .filter((f) => /\.(jpe?g|png)$/i.test(f))
      .sort()
      .slice(0, 6)
      .map((f, index) => ({ index, file: path.join(opts.frames!, f) }));
    if (files.length === 0) print(`\n(no .jpg/.png files in ${opts.frames}; thumbnails skipped)`);
    else {
      const r = await timed(`rankThumbnails() on ${files.length} frames`, () =>
        llm.rankThumbnails({ clip, frames: files }),
      );
      r.ranking.forEach((x) =>
        print(`  #${x.rank} ${path.basename(files[x.index]!.file)}: ${x.note}`),
      );
      print(`  overlay text: "${r.overlayText}"`);
    }
  } else
    print('\n(thumbnails skipped: pass --frames=<dir with .jpg files> to test the vision ranking)');

  // ---- 5. chat: 3 turns, the last one asks for an action
  print('\n=== chat(): 3 turns ===');
  const history: { role: 'user' | 'assistant'; text: string }[] = [];
  const executed: string[] = [];
  const questions = [
    'Give me a three-sentence summary of this video, with timestamps.',
    'What is the single most surprising or quotable thing that is said? When?',
    'Make a clip of that moment.',
  ];
  for (const [n, q] of questions.entries()) {
    print(`\n> ${q}`);
    const before = calls.length;
    const t0 = Date.now();
    const cites: string[] = [];
    const r = await llm.chat({
      info: { title, channel: null, description: null },
      analysis: null,
      transcript,
      clip: null,
      history,
      userText: q,
      executeTool: (name, input) => {
        executed.push(name);
        return Promise.resolve({
          ok: true,
          summary: `(smoke test: ${name} was NOT really executed) ${JSON.stringify(input)}`,
        });
      },
      onDelta: () => {},
      onCitation: (c) => cites.push(c.label),
      onAction: (a) =>
        print(
          `  [action ${a.status}] ${a.tool} ${JSON.stringify(a.input)}${a.summary ? ` -> ${a.summary}` : ''}`,
        ),
    });
    print(wrap(r.text, '  '));
    print(
      `  citations: ${cites.join(', ') || '-'}   (${((Date.now() - t0) / 1000).toFixed(1)}s, ${calls.length - before} model call(s))`,
    );
    const c = calls[calls.length - 1];
    if (c)
      print(
        `  last call: input ${c.usage.inputTokens}, cacheRead ${c.usage.cacheReadTokens ?? 0}, cacheWrite ${c.usage.cacheWriteTokens ?? 0}, output ${c.usage.outputTokens}`,
      );
    history.push({ role: 'user', text: q }, { role: 'assistant', text: r.text });
    if (n < 2 && executed.length)
      print('  !! a tool was called although the user did not ask for an action');
  }
  print(
    executed.length === 1 && executed[0] === 'create_clip'
      ? '\nTool use OK: exactly one create_clip, on the third turn.'
      : `\nTool calls: ${executed.join(', ') || 'none'} (expected exactly one create_clip on turn 3)`,
  );

  // ---- cost table
  print('\n=== API usage and cost (API-reported tokens, app pricing) ===');
  print('purpose      model               input  cacheRead cacheWrite   output        cost');
  for (const c of calls) {
    print(
      `${c.purpose.padEnd(12)} ${c.model.padEnd(18)} ${String(c.usage.inputTokens).padStart(7)} ${String(c.usage.cacheReadTokens ?? 0).padStart(9)} ${String(c.usage.cacheWriteTokens ?? 0).padStart(10)} ${String(c.usage.outputTokens).padStart(8)} ${usd(c.usd).padStart(11)}`,
    );
  }
  const total = calls.reduce((a, c) => a + c.usd, 0);
  print(`TOTAL ${usd(total)} for ${calls.length} call(s)`);
  return { calls, totalUsd: total, momentCount: plan.segments.length };
}
