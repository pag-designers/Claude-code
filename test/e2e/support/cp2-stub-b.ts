/**
 * TEST-ONLY stand-in for main's CP2 "clip intelligence" behaviour (UI-B): hooks, per-platform metadata, thumbnails,
 * reframe/restyle, steered moment runs, highlights, AI chat (streaming), markers, plus the few caption/subtitle channels
 * the drawer touches. Every request and response is validated by the REAL zod contract in shared/ipc.ts (see
 * `validated`), so this file cannot drift from the contract. Content is derived from the CP1 fixtures: the interview
 * transcript (real sentences + timings), the video analysis, the seeded clips, and REAL video frames extracted with
 * ffmpeg for thumbnail candidates.
 *
 * Merge into the main stub with one line:
 *     const b = await stubB.handle(state, channel, payload); if (b) return b.value;
 *
 * Behaviour is deterministic: nothing advances on its own unless `auto(ms)` is called. Tests drive it with `ctl`:
 *   ctl.chatStep(n)       emit the next n events of the pending chat answer
 *   ctl.runStep(runId)    a steered run finds its next clip
 *   ctl.finishRun / failRun
 *   ctl.setRender(clipId, p) / finishRender(clipId)   progress of a re-render
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  encodeIpcError,
  invokeContract,
  type InvokeChannel,
  type InvokeInput,
} from '../../../shared/ipc';
import { captionStyleSchema } from '../../../shared/cp2';
import type {
  CaptionStyle,
  ChatAction,
  ChatEvent,
  ChatMessage,
  ChatThread,
  ClipHooks,
  ClipMeta,
  ClipThumbnails,
  HookVariant,
  Marker,
  MomentRun,
  Platform,
  PlatformMeta,
} from '../../../shared/cp2';
import type { ClipView, Sentence, Transcript } from '../../../shared/pipeline';
import { ASSETS_DIR } from './cp1-fixtures';
import type { Cp1State } from './cp1-sim';

/* -------------------------------------------------------------------------------------------- helpers */

const fail = (msg: string, code: 'FAILED' | 'NOT_FOUND' = 'FAILED') =>
  new Error(encodeIpcError(code, msg));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const clock = (sec: number) => {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
};

function lcg(seed: string): () => number {
  let s = 2166136261;
  for (const ch of seed) s = Math.imul(s ^ ch.charCodeAt(0), 16777619) >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const STOP = new Set(
  'a an the and or but if then of to in on for with at by from is are was were be been this that these those it its as about what where when who how why do does did can could would should i you we they he she me my our your their there here part find clip make summarize rewrite hook into out up not no yes over just so than too very'.split(
    ' ',
  ),
);
const tokens = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));

function words(s: string, n: number): string {
  const w = s.replace(/[“”"]/g, '').trim().split(/\s+/);
  return w.length <= n ? w.join(' ') : `${w.slice(0, n).join(' ')}…`;
}

/* ------------------------------------------------------------------------------------- frame extraction */

const SCRATCH_VIDEO =
  '/tmp/claude-0/-home-user-Claude-code/389612c4-f895-58c2-a3c2-02cb884e9ba1/scratchpad/fixtures/news-3min.mp4';
const ROOT = path.resolve(__dirname, '../../..');

function findSourceVideo(): string | null {
  const env = process.env.CLIPFERN_FIXTURE_VIDEO;
  if (env && fs.existsSync(env)) return env;
  const dir = path.join(ROOT, 'test/fixtures');
  if (fs.existsSync(dir)) {
    const f = fs.readdirSync(dir).find((n) => /\.(mp4|mov|mkv)$/i.test(n));
    if (f) return path.join(dir, f);
  }
  return fs.existsSync(SCRATCH_VIDEO) ? SCRATCH_VIDEO : null;
}

function ffmpegBin(): string {
  for (const p of ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg']) if (fs.existsSync(p)) return p;
  return 'ffmpeg';
}

/** Dir (inside the static server's assets root) for candidate frames; served as /__assets/cp2b/<file>. */
export const FRAMES_DIR = path.join(ASSETS_DIR, 'cp2b');
let sourceDuration: number | null | undefined;
function srcDuration(src: string): number {
  if (sourceDuration) return sourceDuration;
  try {
    const out = execFileSync(ffmpegBin().replace(/ffmpeg$/, 'ffprobe'), [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'csv=p=0',
      src,
    ])
      .toString()
      .trim();
    sourceDuration = Math.max(20, Number(out) || 170);
  } catch {
    sourceDuration = 170;
  }
  return sourceDuration;
}

/** Extracts one real 9:16 frame at `at` seconds of the source (falls back to a synthetic test pattern). Cached on disk. */
export function ensureFrame(file: string, at: number, variant: number): string {
  fs.mkdirSync(FRAMES_DIR, { recursive: true });
  const out = path.join(FRAMES_DIR, file);
  if (fs.existsSync(out)) return `cp2b/${file}`;
  const src = findSourceVideo();
  const ff = ffmpegBin();
  try {
    if (src) {
      const t = ((at % (srcDuration(src) - 6)) + (srcDuration(src) - 6)) % (srcDuration(src) - 6);
      execFileSync(
        ff,
        [
          '-y',
          '-v',
          'error',
          '-ss',
          String(Math.max(0, t) + 3),
          '-i',
          src,
          '-frames:v',
          '1',
          '-vf',
          'crop=ih*9/16:ih,scale=360:640',
          '-q:v',
          '4',
          out,
        ],
        { stdio: 'pipe' },
      );
    } else {
      execFileSync(
        ff,
        [
          '-y',
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          `testsrc2=size=360x640:rate=1:duration=1,hue=h=${variant * 47}`,
          '-frames:v',
          '1',
          out,
        ],
        { stdio: 'pipe' },
      );
    }
  } catch {
    // last resort: a solid frame so the UI still has an image
    execFileSync(
      ff,
      [
        '-y',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=0x444466:s=360x640:d=1',
        '-frames:v',
        '1',
        out,
      ],
      { stdio: 'pipe' },
    );
  }
  return `cp2b/${file}`;
}

/* ----------------------------------------------------------------------------------------------- state */

type Auto = number | null;

interface ChatRun {
  threadId: string;
  userMessageId: string;
  events: ChatEvent[];
  cursor: number;
  canceled: boolean;
  /** partial text accumulated so far (used when canceled) */
  text: string;
  final: ChatMessage;
  /** Side effects of the answer (create the clip, add the marker...) run when its action card turns "done". */
  effects?: () => Promise<void> | void;
  effectsRan: boolean;
}

export interface BState {
  hooks: Map<string, ClipHooks>;
  meta: Map<string, ClipMeta>;
  thumbs: Map<string, ClipThumbnails & { files: string[] }>;
  runs: MomentRun[];
  runScripts: Map<string, { clips: Partial<ClipView>[]; cursor: number }>;
  threads: ChatThread[];
  messages: Map<string, ChatMessage[]>;
  markers: Marker[];
  counter: number;
  autoMs: Auto;
  /** channel -> error message thrown by the next call(s) */
  failures: Map<string, { message: string; times: number }>;
  /** next chat answer fails mid-stream */
  chatError: { message: string; afterEvents: number } | null;
  chatRuns: Map<string, ChatRun>;
  log: {
    calls: { channel: string; payload: unknown }[];
    exports: { clipId: string; format: string }[];
    chosen: { clipId: string; t: number; overlayText: string | null }[];
    applied: { clipId: string; choice: unknown }[];
    saved: { clipId: string; platform: Platform }[];
    reframed: { ids: string[]; mode: string }[];
    restyled: { ids: string[]; styleId: string }[];
    finds: { prompt: string; options: unknown }[];
    sends: { text: string; threadId: string | undefined; clipId: string | undefined }[];
  };
}

const states = new WeakMap<Cp1State, BState>();
export function bstate(state: Cp1State): BState {
  let b = states.get(state);
  if (!b) {
    b = {
      hooks: new Map(),
      meta: new Map(),
      thumbs: new Map(),
      runs: [],
      runScripts: new Map(),
      threads: [],
      messages: new Map(),
      markers: [],
      counter: 0,
      autoMs: null,
      failures: new Map(),
      chatError: null,
      chatRuns: new Map(),
      log: {
        calls: [],
        exports: [],
        chosen: [],
        applied: [],
        saved: [],
        reframed: [],
        restyled: [],
        finds: [],
        sends: [],
      },
    };
    states.set(state, b);
  }
  return b;
}

const nextId = (b: BState, prefix: string) => `${prefix}-${++b.counter}`;
const clipOf = (state: Cp1State, id: string): ClipView => {
  const c = state.clips.find((x) => x.id === id);
  if (!c) throw fail('Clip not found', 'NOT_FOUND');
  return c;
};
const videoOf = (state: Cp1State, id: string) => {
  const v = state.videos.find((x) => x.id === id);
  if (!v) throw fail('Video not found', 'NOT_FOUND');
  return v;
};
const pushClip = (state: Cp1State, c: ClipView) => state.emit?.('clips:updated', { ...c });

/** Sentences of the clip's range (real transcript text). */
function clipSentences(
  state: Cp1State,
  c: Pick<ClipView, 'videoId' | 'startSec' | 'endSec'>,
): Sentence[] {
  const tr = state.transcripts[c.videoId];
  if (!tr) return [];
  return tr.sentences.filter((s) => s.e > c.startSec && s.s < c.endSec);
}

/* ------------------------------------------------------------------------------------------ generators */

const ANGLES: Record<Platform, string[]> = {
  tiktok: ['curiosity', 'contrarian', 'number', 'question', 'story'],
  reels: ['story', 'curiosity', 'benefit', 'question', 'contrarian'],
  shorts: ['question', 'number', 'curiosity', 'benefit', 'contrarian'],
};

export function makeHooks(state: Cp1State, clip: ClipView): ClipHooks {
  const sents = clipSentences(state, clip);
  const first = sents[0]?.text ?? clip.hook ?? clip.title;
  const numMatch = sents
    .map(
      (s) =>
        s.text.match(
          /\b(\d[\d,]*|[A-Z][a-z]+ (?:hundred|thousand|years?)|forty|twenty|four hundred(?: and twelve)?)\b/i,
        )?.[0],
    )
    .find(Boolean);
  const topic = words(clip.title.replace(/[“”"]/g, ''), 6).replace(/…$/, '');
  const lower = topic.charAt(0).toLowerCase() + topic.slice(1);
  const mk = (platform: Platform): HookVariant[] => {
    const tone = platform === 'tiktok' ? 0 : platform === 'reels' ? 1 : 2;
    const raw: [string, string | null][] = [
      [
        ['Nobody talks about this part of', 'The quiet truth behind', 'Wait for it: '][tone]! +
          (tone === 2 ? ` ${lower}` : ` ${lower}`),
        tone === 0 ? 'Nobody really talks about this.' : null,
      ],
      [words(first, 9), null],
      [
        numMatch
          ? `${numMatch.charAt(0).toUpperCase()}${numMatch.slice(1)}: and it changes how you see this`
          : `Three seconds that change how you see ${lower}`,
        numMatch ? `${numMatch}. Let me explain.` : null,
      ],
      [['What if', 'Ever wonder if', 'Is'][tone]! + ` ${lower} is backwards?`, null],
      [
        [
          "I didn't expect this answer",
          'This answer stayed with me',
          'The answer that stopped the room',
        ][tone]!,
        'I was not ready for this answer.',
      ],
    ];
    return raw.map(([text, spoken], i) => ({
      text: words(text, 10).replace(/…$/, ''),
      spoken,
      angle: ANGLES[platform][i]!,
    }));
  };
  return {
    tiktok: mk('tiktok'),
    reels: mk('reels'),
    shorts: mk('shorts'),
    applied: null,
    generatedAt: Date.now(),
  };
}

export function makeMeta(state: Cp1State, clip: ClipView): ClipMeta {
  const analysis = state.analyses[clip.videoId];
  const kws = (analysis?.keywords ?? ['community', 'story']).map(
    (k) => `#${k.replace(/[^A-Za-z0-9]/g, '')}`,
  );
  const why = clip.whyItWorks ?? 'A moment worth sharing.';
  const base = (
    title: string,
    desc: string,
    tags: string[],
    day: number | null,
    hour: number,
    reason: string,
  ): PlatformMeta => ({
    title,
    description: desc,
    hashtags: tags,
    postingTime: { dayOfWeek: day, hour, reason },
  });
  const t = clip.title.replace(/[“”"]/g, '');
  return {
    tiktok: base(
      words(t, 12).replace(/…$/, ''),
      `${clip.hook ?? t}\n\n${why.split('. ')[0]}.\n\nFollow for more conversations like this.`,
      [...kws.slice(0, 4), '#fyp'],
      2,
      19,
      'Short-form viewing on TikTok tends to peak on weekday evenings after work.',
    ),
    reels: base(
      words(t, 14).replace(/…$/, ''),
      `${clip.hook ?? t}\n\n${why}\n\nSave this for later and send it to someone who needs it.`,
      [...kws.slice(0, 6), '#reels', '#community'],
      3,
      11,
      'Instagram engagement is steady late morning mid-week.',
    ),
    shorts: base(
      t.length > 100 ? `${t.slice(0, 96)}…` : t,
      `${clip.hook ?? t}\n\n${why}\n\nFrom the full conversation: ${clip.videoTitle ?? 'watch the full video'}.`,
      [...kws.slice(0, 3), '#Shorts'],
      null,
      17,
      'Shorts are discovered through browse feeds that are busiest in the early evening, any day of the week.',
    ),
    generatedAt: Date.now(),
  };
}

export function makeThumbs(state: Cp1State, clip: ClipView): ClipThumbnails & { files: string[] } {
  const rnd = lcg(clip.id);
  const n = 6;
  const files: string[] = [];
  const cands = Array.from({ length: n }, (_, i) => {
    const rel = Math.round(clip.durationSec * (0.06 + (0.88 * i) / (n - 1)) * 10) / 10;
    const abs = clip.startSec + rel;
    const f = `${clip.id.replace(/[^a-z0-9-]/gi, '_')}-${i}.jpg`;
    files.push(ensureFrame(f, abs, i));
    const sharp = 0.45 + rnd() * 0.5;
    const face = 0.3 + rnd() * 0.65;
    const comp = 0.4 + rnd() * 0.55;
    return {
      t: rel,
      key: `clips/${clip.id}/thumbs/c${i}.jpg`,
      scores: {
        sharpness: Math.round(sharp * 100) / 100,
        face: Math.round(face * 100) / 100,
        composition: Math.round(comp * 100) / 100,
        total: Math.round((sharp * 0.3 + face * 0.4 + comp * 0.3) * 100) / 100,
      },
      llmRank: null as number | null,
      llmNote: null as string | null,
    };
  });
  const order = cands.map((c, i) => [c.scores.total, i] as const).sort((a, b) => b[0] - a[0]);
  const notes = [
    'Clear, well-lit face looking near the camera with an open expression; strong contrast against the background.',
    'Sharp frame with good headroom, but the expression is neutral.',
    'Good composition; the subject is slightly off-centre, leaving room for overlay text.',
  ];
  order.slice(0, 3).forEach(([, idx], rank) => {
    cands[idx]!.llmRank = rank + 1;
    cands[idx]!.llmNote = notes[rank]!;
  });
  return { candidates: cands, chosenT: null, overlayText: null, generatedAt: Date.now(), files };
}

/* ------------------------------------------------------------------------------------- steered runs */

const RUN_RANGES: { from: number; to: number }[] = [
  { from: 8, to: 10 },
  { from: 12, to: 14 },
  { from: 19, to: 21 },
  { from: 32, to: 34 },
  { from: 45, to: 47 },
];

function scriptRunClips(state: Cp1State, videoId: string, runId: string, prompt: string) {
  const tr = state.transcripts[videoId];
  const v = videoOf(state, videoId);
  const rnd = lcg(runId);
  const picks = RUN_RANGES.slice(0, 3);
  return picks.map((r, i) => {
    const s = tr?.sentences[r.from];
    const e = tr?.sentences[r.to];
    const startSec = s ? Math.round((s.s - 0.15) * 100) / 100 : 20 + i * 30;
    const endSec = e ? Math.round((e.e + 0.2) * 100) / 100 : startSec + 28;
    const text =
      (tr?.sentences[r.from + 1] ?? tr?.sentences[r.from])?.text ?? 'A moment from the video';
    const total = 70 + Math.floor(rnd() * 18);
    return {
      title: words(text.replace(/[.!?]+$/, ''), 9).replace(/…$/, ''),
      hook: words(s?.text ?? text, 12),
      startSec,
      endSec,
      durationSec: Math.round((endSec - startSec) * 10) / 10,
      score: total,
      whyItWorks: `Matches “${prompt}”: ${words(text, 14)}`,
      videoTitle: v.title,
    } satisfies Partial<ClipView>;
  });
}

/* --------------------------------------------------------------------------------------------- chat */

function bestSentences(tr: Transcript | undefined, query: string, n: number): Sentence[] {
  if (!tr) return [];
  const q = new Set(tokens(query));
  const scored = tr.sentences
    .map((s) => ({ s, score: tokens(s.text).filter((w) => q.has(w)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.s.s - b.s.s)
    .slice(0, n)
    .map((x) => x.s)
    .sort((a, b) => a.s - b.s);
  return scored;
}

type Chunk =
  | { kind: 'text'; text: string }
  | { kind: 'cite'; t: number; label: string }
  | { kind: 'action'; action: ChatAction };

interface Answer {
  chunks: Chunk[];
  effects?: () => Promise<void> | void;
}

function chunkText(text: string): string[] {
  // 2–3 word chunks, keeping whitespace so markdown survives concatenation
  const parts = text.match(/\S+\s*|\n+/g) ?? [text];
  const out: string[] = [];
  for (let i = 0; i < parts.length; i += 3) out.push(parts.slice(i, i + 3).join(''));
  return out;
}

function buildAnswer(
  state: Cp1State,
  b: BState,
  ctx: { videoId: string; clipId: string | undefined },
  text: string,
): Answer {
  const video = videoOf(state, ctx.videoId);
  const tr = state.transcripts[ctx.videoId];
  const analysis = state.analyses[ctx.videoId];
  const clip = ctx.clipId ? state.clips.find((c) => c.id === ctx.clipId) : undefined;
  const lower = text.toLowerCase();
  const chunks: Chunk[] = [];
  const t = (s: string) =>
    chunks.push(...chunkText(s).map((x) => ({ kind: 'text' as const, text: x })));
  const cite = (s: Sentence) =>
    chunks.push({ kind: 'cite', t: Math.floor(s.s), label: words(s.text, 12) });
  const mkAction = (tool: ChatAction['tool'], input: Record<string, unknown>): ChatAction => ({
    id: nextId(b, 'act'),
    tool,
    input,
    status: 'running',
    summary: null,
    href: null,
  });
  const pushAction = (running: ChatAction, done: Partial<ChatAction>) => {
    chunks.push({ kind: 'action', action: running });
    chunks.push({ kind: 'action', action: { ...running, status: 'done', ...done } });
  };

  // ---- make / create a clip
  if (/(make|create|cut)\b.*\bclip|clip of/.test(lower)) {
    const hits = bestSentences(
      tr,
      text.replace(/\b(make|create|clip|of|the|best|story)\b/gi, ' '),
      1,
    );
    const pick = hits[0] ?? tr?.sentences[18];
    const startSec = Math.max(0, (pick?.s ?? 20) - 0.2);
    const endSec = startSec + 30;
    const title = words(pick?.text ?? 'The best story', 8).replace(/…$/, '');
    t(
      `Here is the strongest self-contained story I can find. It starts at **${clock(startSec)}** and works as a clip on its own: ${words(pick?.text ?? '', 18)}\n\nI am cutting it now.`,
    );
    const id = nextId(b, 'chat-clip');
    const running = mkAction('create_clip', { title, startSec, endSec });
    pushAction(running, {
      summary: `Created clip “${title}” (${clock(startSec)}–${clock(endSec)})`,
      href: `/library/video/?id=${ctx.videoId}&tab=clips&clip=${id}`,
    });
    return {
      chunks,
      effects: async () => {
        const base = state.clips.find((c) => c.videoId === ctx.videoId && c.kind === 'clip');
        if (!base) return;
        const created: ClipView = {
          ...base,
          id,
          title,
          hook: pick?.text ?? null,
          startSec,
          endSec,
          durationSec: 30,
          score: 76,
          rank: null,
          createdAt: Date.now(),
          favorite: false,
          runId: null,
          runPrompt: null,
          hookApplied: null,
          hasHooks: false,
          hasMeta: false,
          hasThumbOptions: false,
          status: 'rendered',
          renderProgress: null,
        };
        state.clipAssets[id] = state.clipAssets[base.id] ?? {
          thumb: 'c1.jpg',
          render: 'clip-a.webm',
        };
        state.clips.unshift(created);
        await pushClip(state, created);
      },
    };
  }

  // ---- rewrite the hook
  if (/rewrite.*hook|better hook|new hook/.test(lower)) {
    if (!clip) {
      t(
        'Open a clip first and I can rewrite its hook. Right now I am looking at the whole video, which has many hooks.',
      );
      return { chunks };
    }
    const sents = clipSentences(state, clip);
    const line = sents[1]?.text ?? clip.title;
    const hook = `${words(line.replace(/[.!?]+$/, ''), 8).replace(/…$/, '')}. Wait for it.`;
    t(
      `Your current hook is “${clip.hook ?? clip.title}”. It is accurate but it explains before it surprises.\n\nTry this instead:\n\n> ${hook}\n\nIt opens on the claim and promises a payoff, which is what the first two seconds need.`,
    );
    cite(sents[1] ?? sents[0]!);
    const running = mkAction('rewrite_hook', { clipId: clip.id });
    pushAction(running, {
      summary: `Added “${hook}” to TikTok hooks (variant 1)`,
      href: `/library/video/?id=${ctx.videoId}&tab=clips&clip=${clip.id}&view=hook`,
    });
    return {
      chunks,
      effects: async () => {
        const h = b.hooks.get(clip.id) ?? makeHooks(state, clip);
        h.tiktok = [{ text: hook, spoken: null, angle: 'curiosity' }, ...h.tiktok.slice(0, 4)];
        b.hooks.set(clip.id, h);
        clip.hasHooks = true;
        await pushClip(state, clip);
      },
    };
  }

  // ---- add a marker
  if (/marker|bookmark/.test(lower)) {
    const hits = bestSentences(tr, text.replace(/\b(add|marker|bookmark|where|at)\b/gi, ' '), 1);
    const pick = hits[0] ?? tr?.sentences[11];
    const at = Math.floor(pick?.s ?? 60);
    const label = words(pick?.text ?? 'Key moment', 7).replace(/…$/, '');
    t(
      `Done, I flagged the moment at [${clock(at)}] where they say: “${words(pick?.text ?? '', 16)}”.`,
    );
    const running = mkAction('add_marker', { atSec: at, label });
    pushAction(running, {
      summary: `Marker “${label}” at ${clock(at)}`,
      href: `/library/video/?id=${ctx.videoId}&t=${at}`,
    });
    return {
      chunks,
      effects: async () => {
        b.markers.push({
          id: nextId(b, 'mk'),
          videoId: ctx.videoId,
          atSec: at,
          label,
          createdAt: Date.now(),
        });
        await state.emit?.('markers:changed', { videoId: ctx.videoId });
      },
    };
  }

  // ---- write metadata
  if (/metadata|hashtags|title and description|caption for/.test(lower) && clip) {
    t(
      `I wrote a title, description and hashtags for **${clip.title}** on all three platforms. TikTok and Reels keep the hook in the first line; Shorts gets a searchable title under 100 characters.`,
    );
    const running = mkAction('write_metadata', { clipId: clip.id });
    pushAction(running, {
      summary: 'Metadata saved for TikTok, Reels and Shorts',
      href: `/library/video/?id=${ctx.videoId}&tab=clips&clip=${clip.id}&view=meta`,
    });
    return {
      chunks,
      effects: async () => {
        b.meta.set(clip.id, makeMeta(state, clip));
        clip.hasMeta = true;
        await pushClip(state, clip);
      },
    };
  }

  // ---- find moments (starts a steered run)
  if (/find moments|search for moments|more moments/.test(lower)) {
    const prompt = text.replace(/find moments( about)?/i, '').trim() || 'the best moments';
    t(`Starting a search for “${prompt}”. New clips will appear in the grid on the Clips tab.`);
    const running = mkAction('find_moments', { prompt });
    pushAction(running, {
      summary: `Searching for “${prompt}”`,
      href: `/library/video/?id=${ctx.videoId}&tab=clips`,
    });
    return {
      chunks,
      effects: async () => {
        const run: MomentRun = {
          id: nextId(b, 'run'),
          videoId: ctx.videoId,
          prompt,
          status: 'running',
          found: 0,
          error: null,
          createdAt: Date.now(),
          finishedAt: null,
        };
        b.runs.unshift(run);
        b.runScripts.set(run.id, {
          clips: scriptRunClips(state, ctx.videoId, run.id, prompt),
          cursor: 0,
        });
        await state.emit?.('moments:run', { ...run });
      },
    };
  }

  // ---- summarize for LinkedIn / social
  if (/summar|linkedin|tl;?dr|takeaways/.test(lower)) {
    const points = analysis?.notes.keyPoints.slice(0, 4) ?? [];
    const quote = analysis?.notes.quotes[0];
    t(
      `## LinkedIn post\n\n**${video.title}**\n\n${analysis?.overview.summary ?? 'A conversation worth your time.'}\n\n`,
    );
    t(`### What stood out\n\n`);
    points.forEach((p) => t(`- ${p}\n`));
    t(`\n`);
    if (quote) {
      t(`The line I keep coming back to: “${words(quote.text, 20)}” `);
      chunks.push({ kind: 'cite', t: Math.floor(quote.at), label: words(quote.text, 12) });
      t(`\n\n`);
    }
    t(
      `Worth a listen if you work with families or community programs. What would you change in your own space?\n\n\`#acceptance\` \`#community\``,
    );
    const hit = tr?.sentences[11];
    if (hit) chunks.push({ kind: 'cite', t: Math.floor(hit.s), label: words(hit.text, 12) });
    return { chunks };
  }

  // ---- find the part where… / question answering with real quotes
  const hits = bestSentences(tr, text, 3);
  if (hits.length === 0) {
    t(
      `I could not find anything about that in ${clip ? 'this clip' : 'the transcript'}. Try different words, or ask me to summarize what is covered.`,
    );
    return { chunks };
  }
  t(
    hits.length === 1
      ? 'I found one place where this comes up:\n\n'
      : `I found **${hits.length} places** where this comes up:\n\n`,
  );
  hits.forEach((s, i) => {
    t(`${i + 1}. [${clock(s.s)}] ${s.speaker ? `${s.speaker}: ` : ''}“${s.text}”\n`);
    cite(s);
  });
  t(`\nThe first one is the clearest. Say “make a clip of it” and I will cut it for you.`);
  return { chunks };
}

function chatEventsFor(
  b: BState,
  threadId: string,
  messageId: string,
  answer: Answer,
): { events: ChatEvent[]; final: ChatMessage } {
  const events: ChatEvent[] = [{ type: 'start', threadId, messageId }];
  let text = '';
  const citations: ChatMessage['citations'] = [];
  const actions = new Map<string, ChatAction>();
  for (const ch of answer.chunks) {
    if (ch.kind === 'text') {
      text += ch.text;
      events.push({ type: 'delta', threadId, messageId, text: ch.text });
    } else if (ch.kind === 'cite') {
      if (!citations.some((c) => c.t === ch.t)) citations.push({ t: ch.t, label: ch.label });
      events.push({
        type: 'citation',
        threadId,
        messageId,
        citation: { t: ch.t, label: ch.label },
      });
    } else {
      actions.set(ch.action.id, ch.action);
      events.push({ type: 'action', threadId, messageId, action: ch.action });
    }
  }
  const final: ChatMessage = {
    id: messageId,
    threadId,
    role: 'assistant',
    text,
    citations,
    actions: [...actions.values()],
    createdAt: Date.now(),
  };
  events.push({ type: 'done', threadId, message: final });
  void b;
  return { events, final };
}

/* ---------------------------------------------------------------------------------------- controls */

export interface StubBControls {
  b: BState;
  /** Emit the next `n` events of the pending chat answer in `threadId` (default: any). Resolves with how many were sent. */
  chatStep: (n?: number, threadId?: string) => Promise<number>;
  chatPending: () => { threadId: string; remaining: number }[];
  /** The next chat answer fails after `afterEvents` events with this message (stream error event). */
  failChatNext: (message: string, afterEvents?: number) => void;
  /** The next `times` calls to `channel` reject with `message`. */
  failNext: (channel: InvokeChannel, message: string, times?: number) => void;
  clearFailures: () => void;
  /** A steered run finds its next clip (returns false when the script is exhausted). */
  runStep: (runId?: string) => Promise<boolean>;
  finishRun: (runId?: string) => Promise<void>;
  failRun: (message: string, runId?: string) => Promise<void>;
  lastRun: () => MomentRun | undefined;
  setRender: (clipId: string, progress: number) => Promise<void>;
  finishRender: (clipId: string) => Promise<void>;
  /** Auto-advance chat, runs and renders on timers (for screenshots/demos). */
  auto: (ms: number | null) => void;
  seedHooks: (clipId: string, applied?: ClipHooks['applied']) => ClipHooks;
  seedMeta: (clipId: string) => ClipMeta;
  seedThumbs: (clipId: string, chosen?: boolean) => ClipThumbnails;
  seedThread: (videoId: string, clipId: string | null, qa: [string, string][]) => ChatThread;
  seedMarker: (videoId: string, atSec: number, label: string) => Marker;
  setRun: (run: Partial<MomentRun> & { videoId: string; prompt: string }) => MomentRun;
}

export function controls(state: Cp1State): StubBControls {
  const b = bstate(state);
  const emit = <E extends Parameters<NonNullable<Cp1State['emit']>>[0]>(
    e: E,
    p: Parameters<NonNullable<Cp1State['emit']>>[1],
  ) => state.emit?.(e, p as never);

  const ctl: StubBControls = {
    b,
    async chatStep(n = 1, threadId) {
      let sent = 0;
      for (const run of b.chatRuns.values()) {
        if (threadId && run.threadId !== threadId) continue;
        while (sent < n && run.cursor < run.events.length && !run.canceled) {
          const e = run.events[run.cursor++]!;
          await deliverChat(state, b, run, e);
          sent++;
        }
        if (run.cursor >= run.events.length || run.canceled) b.chatRuns.delete(run.threadId);
        if (sent >= n) break;
      }
      return sent;
    },
    chatPending: () =>
      [...b.chatRuns.values()].map((r) => ({
        threadId: r.threadId,
        remaining: r.events.length - r.cursor,
      })),
    failChatNext(message, afterEvents = 3) {
      b.chatError = { message, afterEvents };
    },
    failNext(channel, message, times = 1) {
      b.failures.set(channel, { message, times });
    },
    clearFailures() {
      b.failures.clear();
      b.chatError = null;
    },
    async runStep(runId) {
      const run = runId
        ? b.runs.find((r) => r.id === runId)
        : b.runs.find((r) => r.status === 'running');
      if (!run || run.status !== 'running') return false;
      const script = b.runScripts.get(run.id);
      const next = script?.clips[script.cursor];
      if (!script || !next) return false;
      script.cursor++;
      const base = state.clips.find((c) => c.videoId === run.videoId && c.kind === 'clip');
      const id = nextId(b, 'run-clip');
      const idx = (b.counter + script.cursor) % 9;
      const tpl = state.clips.filter((c) => c.videoId === run.videoId)[
        idx % Math.max(1, state.clips.length)
      ];
      const assets = (tpl && state.clipAssets[tpl.id]) ?? {
        thumb: 'c1.jpg',
        render: 'clip-a.webm',
      };
      state.clipAssets[id] = assets;
      const clip: ClipView = {
        ...(base as ClipView),
        ...next,
        id,
        runId: run.id,
        runPrompt: run.prompt,
        kind: 'clip',
        favorite: false,
        status: 'rendered',
        renderProgress: null,
        error: null,
        hasRender: true,
        hasThumb: true,
        rank: null,
        createdAt: Date.now(),
        hookApplied: null,
        hasHooks: false,
        hasMeta: false,
        hasThumbOptions: false,
        breakdown: base?.breakdown ?? null,
        confidence: 0.8,
        tags: [],
      };
      state.clips.unshift(clip);
      run.found++;
      await pushClip(state, clip);
      await emit('moments:run', { ...run });
      return true;
    },
    async finishRun(runId) {
      const run = runId
        ? b.runs.find((r) => r.id === runId)
        : b.runs.find((r) => r.status === 'running');
      if (!run) return;
      run.status = 'done';
      run.finishedAt = Date.now();
      await emit('moments:run', { ...run });
    },
    async failRun(message, runId) {
      const run = runId
        ? b.runs.find((r) => r.id === runId)
        : b.runs.find((r) => r.status === 'running');
      if (!run) return;
      run.status = 'failed';
      run.error = message;
      run.finishedAt = Date.now();
      await emit('moments:run', { ...run });
    },
    lastRun: () => b.runs[0],
    async setRender(clipId, progress) {
      const c = clipOf(state, clipId);
      Object.assign(c, { status: 'rendering', renderProgress: progress });
      await pushClip(state, c);
    },
    async finishRender(clipId) {
      const c = clipOf(state, clipId);
      Object.assign(c, {
        status: 'rendered',
        renderProgress: null,
        hasRender: true,
        hasThumb: true,
        layout: c.layout ?? 'single',
      });
      const h = b.hooks.get(clipId);
      c.hookApplied = h?.applied ? (h[h.applied.platform][h.applied.index]?.text ?? null) : null;
      await pushClip(state, c);
    },
    auto(ms) {
      b.autoMs = ms;
    },
    seedHooks(clipId, applied = null) {
      const c = clipOf(state, clipId);
      const h = { ...makeHooks(state, c), applied };
      b.hooks.set(clipId, h);
      c.hasHooks = true;
      c.hookApplied = applied ? (h[applied.platform][applied.index]?.text ?? null) : null;
      return h;
    },
    seedMeta(clipId) {
      const c = clipOf(state, clipId);
      const m = makeMeta(state, c);
      b.meta.set(clipId, m);
      c.hasMeta = true;
      return m;
    },
    seedThumbs(clipId, chosen = false) {
      const c = clipOf(state, clipId);
      const t = makeThumbs(state, c);
      if (chosen) {
        t.chosenT = t.candidates[0]!.t;
        t.overlayText = null;
      }
      b.thumbs.set(clipId, t);
      c.hasThumbOptions = true;
      return t;
    },
    seedThread(videoId, clipId, qa) {
      const th: ChatThread = {
        id: nextId(b, 'th'),
        videoId,
        clipId,
        title: words(qa[0]?.[0] ?? 'New chat', 6),
        updatedAt: Date.now() - b.counter * 1000,
      };
      b.threads.unshift(th);
      const msgs: ChatMessage[] = [];
      qa.forEach(([q, a], i) => {
        msgs.push({
          id: nextId(b, 'm'),
          threadId: th.id,
          role: 'user',
          text: q,
          citations: [],
          actions: [],
          createdAt: Date.now() - (qa.length - i) * 60_000,
        });
        msgs.push({
          id: nextId(b, 'm'),
          threadId: th.id,
          role: 'assistant',
          text: a,
          citations: [],
          actions: [],
          createdAt: Date.now() - (qa.length - i) * 60_000 + 3000,
        });
      });
      b.messages.set(th.id, msgs);
      return th;
    },
    seedMarker(videoId, atSec, label) {
      const m: Marker = { id: nextId(b, 'mk'), videoId, atSec, label, createdAt: Date.now() };
      b.markers.push(m);
      return m;
    },
    setRun(r) {
      const run: MomentRun = {
        id: nextId(b, 'run'),
        status: 'done',
        found: 0,
        error: null,
        createdAt: Date.now() - 60_000,
        finishedAt: Date.now() - 30_000,
        ...r,
      };
      b.runs.unshift(run);
      b.runScripts.set(run.id, {
        clips: scriptRunClips(state, run.videoId, run.id, run.prompt),
        cursor: 0,
      });
      return run;
    },
  };
  return ctl;
}

async function deliverChat(state: Cp1State, b: BState, run: ChatRun, e: ChatEvent) {
  if (e.type === 'delta') run.text += e.text;
  if (
    !run.effectsRan &&
    run.effects &&
    ((e.type === 'action' && e.action.status === 'done') || e.type === 'done')
  ) {
    run.effectsRan = true;
    await run.effects();
  }
  if (e.type === 'done') {
    const list = b.messages.get(run.threadId) ?? [];
    list.push(e.message);
    b.messages.set(run.threadId, list);
    const th = b.threads.find((t) => t.id === run.threadId);
    if (th) th.updatedAt = Date.now();
    await state.emit?.('chat:event', e);
    return;
  }
  await state.emit?.('chat:event', e);
}

async function runChatAuto(state: Cp1State, b: BState, run: ChatRun) {
  while (run.cursor < run.events.length && !run.canceled && b.autoMs !== null) {
    await sleep(b.autoMs);
    if (run.canceled) return;
    await deliverChat(state, b, run, run.events[run.cursor++]!);
  }
  if (run.cursor >= run.events.length || run.canceled) b.chatRuns.delete(run.threadId);
}

/* ---------------------------------------------------------------------------------------- handler */

const OWN: ReadonlySet<string> = new Set([
  'hooks:get',
  'hooks:generate',
  'hooks:apply',
  'meta:get',
  'meta:generate',
  'meta:save',
  'thumbs:get',
  'thumbs:generate',
  'thumbs:choose',
  'thumbs:url',
  'clips:reframe',
  'clips:restyle',
  'moments:find',
  'moments:runs',
  'moments:cancel',
  'highlights:create',
  'chat:threads',
  'chat:messages',
  'chat:send',
  'chat:cancel',
  'chat:delete',
  'markers:list',
  'markers:add',
  'markers:delete',
  'subtitles:export',
  'captions:styles',
  'captions:fonts',
  'captions:preview',
]);
/** Channels handled by this stub (the cp2b harness routes exactly these here). */
export const STUB_B_CHANNELS: readonly string[] = [...OWN];

const BUDGET_ERROR =
  'Monthly AI budget hard cap reached ($70.00 of $70.00). Raise the cap in Settings → Models & Budget to continue.';
export { BUDGET_ERROR };

function builtinStyle(id: string, name: string, fill: string, hi: string): CaptionStyle {
  return captionStyleSchema.parse({
    id,
    name,
    builtin: true,
    font: { family: 'Montserrat' },
    fill,
    stroke: { color: '#000000' },
    shadow: { color: '#000000' },
    box: { color: '#000000' },
    highlight: { color: hi, boxColor: hi },
    keywordColor: '#7CFFB2',
    layout: {},
    chunking: {},
  });
}

async function handle(
  state: Cp1State,
  channel: string,
  payload: unknown,
): Promise<{ value: unknown } | null> {
  if (!OWN.has(channel)) return null;
  const b = bstate(state);
  b.log.calls.push({ channel, payload });
  const f = b.failures.get(channel);
  if (f && f.times > 0) {
    f.times--;
    if (f.times === 0) b.failures.delete(channel);
    throw fail(f.message);
  }
  const p = payload as Record<string, unknown>;
  const ctl = controls(state);
  const auto = b.autoMs;

  switch (channel) {
    /* ---------------------------------------------------------------- hooks */
    case 'hooks:get':
      return { value: b.hooks.get(p.clipId as string) ?? null };
    case 'hooks:generate': {
      const c = clipOf(state, p.clipId as string);
      await sleep(auto ?? 250);
      const prev = b.hooks.get(c.id);
      const h = { ...makeHooks(state, c), applied: prev?.applied ?? null, generatedAt: Date.now() };
      // regenerate really changes the wording so tests can see it
      if (prev)
        h.tiktok = h.tiktok.map((v, i) => ({
          ...v,
          text: i === 0 ? `Fresh angle: ${v.text}` : v.text,
        }));
      b.hooks.set(c.id, h);
      c.hasHooks = true;
      await pushClip(state, c);
      state.costSpent += 0.01;
      return { value: h };
    }
    case 'hooks:apply': {
      const c = clipOf(state, p.clipId as string);
      const h = b.hooks.get(c.id);
      if (!h) throw fail('Generate hooks first.');
      const choice = p.choice as { platform: Platform; index: number } | null;
      if (choice && !h[choice.platform][choice.index])
        throw fail('That hook variant does not exist.');
      b.log.applied.push({ clipId: c.id, choice });
      h.applied = choice;
      Object.assign(c, { status: 'queued', renderProgress: null, error: null });
      await pushClip(state, c);
      if (auto !== null) void autoRender(state, b, c.id);
      return { value: { ok: true } };
    }

    /* ----------------------------------------------------------------- meta */
    case 'meta:get':
      return { value: b.meta.get(p.clipId as string) ?? null };
    case 'meta:generate': {
      const c = clipOf(state, p.clipId as string);
      await sleep(auto ?? 250);
      const prev = b.meta.get(c.id);
      const m = makeMeta(state, c);
      if (prev) m.tiktok.hashtags = [...m.tiktok.hashtags.slice(0, 3), '#regenerated'];
      b.meta.set(c.id, m);
      c.hasMeta = true;
      await pushClip(state, c);
      state.costSpent += 0.01;
      return { value: m };
    }
    case 'meta:save': {
      const m = b.meta.get(p.clipId as string);
      if (!m) throw fail('Nothing to save: generate metadata first.');
      m[p.platform as Platform] = p.meta as PlatformMeta;
      b.log.saved.push({ clipId: p.clipId as string, platform: p.platform as Platform });
      return { value: { ok: true } };
    }

    /* ----------------------------------------------------------- thumbnails */
    case 'thumbs:get': {
      const t = b.thumbs.get(p.clipId as string);
      if (!t) return { value: null };
      const { files: _files, ...rest } = t;
      void _files;
      return { value: rest };
    }
    case 'thumbs:generate': {
      const c = clipOf(state, p.clipId as string);
      await sleep(auto ?? 600);
      const t = makeThumbs(state, c);
      b.thumbs.set(c.id, t);
      c.hasThumbOptions = true;
      await pushClip(state, c);
      state.costSpent += 0.02;
      const { files: _files, ...rest } = t;
      void _files;
      return { value: rest };
    }
    case 'thumbs:choose': {
      const c = clipOf(state, p.clipId as string);
      const t = b.thumbs.get(c.id);
      if (!t) throw fail('Generate thumbnails first.');
      const idx = t.candidates.findIndex((x) => x.t === p.t);
      if (idx < 0) throw fail('That frame is not one of the candidates.');
      t.chosenT = p.t as number;
      t.overlayText = (p.overlayText as string | null) ?? null;
      const assets = state.clipAssets[c.id] ?? { thumb: 'c1.jpg', render: 'clip-a.webm' };
      state.clipAssets[c.id] = { ...assets, thumb: t.files[idx]! };
      c.hasThumb = true;
      b.log.chosen.push({ clipId: c.id, t: p.t as number, overlayText: t.overlayText });
      await pushClip(state, c);
      return { value: { ok: true } };
    }
    case 'thumbs:url': {
      const t = b.thumbs.get(p.clipId as string);
      const file = t?.files[p.index as number];
      return { value: { url: file ? `${state.assetBase}/__assets/${file}` : null } };
    }

    /* ------------------------------------------------------ reframe / style */
    case 'clips:reframe': {
      const ids = p.ids as string[];
      b.log.reframed.push({ ids, mode: p.mode as string });
      for (const id of ids) {
        const c = clipOf(state, id);
        Object.assign(c, {
          reframeMode: p.mode,
          status: 'queued',
          renderProgress: null,
          error: null,
        });
        await pushClip(state, c);
        if (auto !== null) void autoRender(state, b, id, 'reframe');
      }
      return { value: { ok: true } };
    }
    case 'clips:restyle': {
      const ids = p.ids as string[];
      b.log.restyled.push({ ids, styleId: (p.styleId as string) ?? '' });
      for (const id of ids) {
        const c = clipOf(state, id);
        Object.assign(c, {
          ...(p.styleId ? { captionStyleId: p.styleId } : {}),
          ...(p.reframeMode ? { reframeMode: p.reframeMode } : {}),
          status: 'queued',
          renderProgress: null,
          error: null,
        });
        await pushClip(state, c);
        if (auto !== null) void autoRender(state, b, id);
      }
      return { value: { ok: true } };
    }
    case 'subtitles:export': {
      b.log.exports.push({ clipId: (p.clipId as string) ?? '', format: p.format as string });
      return {
        value: {
          saved: true,
          path: `/home/demo/Downloads/${(p.clipId as string | undefined) ?? 'video'}.${p.format as string}`,
        },
      };
    }
    case 'captions:styles':
      return {
        value: {
          styles: [
            builtinStyle('clean-pop', 'Clean Pop', '#FFFFFF', '#FFE14D'),
            builtinStyle('hormozi-bold', 'Hormozi Bold', '#FFFFFF', '#35E27A'),
            builtinStyle('karaoke-highlight', 'Karaoke Highlight', '#FFFFFF', '#FF4D8D'),
          ],
        },
      };
    case 'captions:fonts':
      return { value: { fonts: [{ family: 'Montserrat', weights: [600, 800] }] } };
    case 'captions:preview':
      return {
        value: {
          dataUrl:
            'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
          width: 1080,
          height: 1920,
        },
      };

    /* ---------------------------------------------------------- steered runs */
    case 'moments:find': {
      const v = videoOf(state, p.videoId as string);
      if (v.status !== 'ready') throw fail('The video is still being processed.');
      b.log.finds.push({ prompt: p.prompt as string, options: p.options });
      const run: MomentRun = {
        id: nextId(b, 'run'),
        videoId: v.id,
        prompt: p.prompt as string,
        status: 'running',
        found: 0,
        error: null,
        createdAt: Date.now(),
        finishedAt: null,
      };
      b.runs.unshift(run);
      b.runScripts.set(run.id, {
        clips: scriptRunClips(state, v.id, run.id, run.prompt),
        cursor: 0,
      });
      state.costSpent += 0.03;
      await state.emit?.('moments:run', { ...run });
      if (auto !== null)
        void (async () => {
          for (let i = 0; i < 3; i++) {
            await sleep(auto * 2);
            if (run.status !== 'running') return;
            await ctl.runStep(run.id);
          }
          await sleep(auto);
          if (run.status === 'running') await ctl.finishRun(run.id);
        })();
      return { value: { runId: run.id } };
    }
    case 'moments:runs':
      return { value: { items: b.runs.filter((r) => r.videoId === p.videoId) } };
    case 'moments:cancel': {
      const run = b.runs.find((r) => r.id === p.runId);
      if (!run) throw fail('Run not found', 'NOT_FOUND');
      if (run.status === 'running') {
        run.status = 'canceled';
        run.finishedAt = Date.now();
        await state.emit?.('moments:run', { ...run });
      }
      return { value: { ok: true } };
    }

    /* ----------------------------------------------------------- highlights */
    case 'highlights:create': {
      const v = videoOf(state, p.videoId as string);
      const base = state.clips.find((c) => c.videoId === v.id && c.kind === 'clip');
      if (!base) throw fail('This video has no clips to build a highlight from yet.');
      const id = nextId(b, 'highlight');
      state.clipAssets[id] = state.clipAssets[base.id] ?? {
        thumb: 'c1.jpg',
        render: 'clip-a.webm',
      };
      const hl: ClipView = {
        ...base,
        id,
        kind: 'highlight',
        title: `Highlight reel: ${words(v.title, 5).replace(/…$/, '')}`,
        hook: 'The best moments, in story order.',
        whyItWorks:
          'Opens on the strongest claim, builds through two supporting stories and lands on the emotional payoff, with crossfades between beats.',
        startSec: 12,
        endSec: 92,
        durationSec: 80,
        score: 88,
        rank: null,
        favorite: false,
        status: 'queued',
        renderProgress: null,
        hasRender: false,
        hasThumb: false,
        runId: null,
        runPrompt: null,
        createdAt: Date.now(),
        hookApplied: null,
        hasHooks: false,
        hasMeta: false,
        hasThumbOptions: false,
        layout: null,
      };
      state.clips.unshift(hl);
      await sleep(auto ?? 120);
      await pushClip(state, hl);
      if (auto !== null) void autoRender(state, b, id);
      state.costSpent += 0.06;
      return { value: { clipId: id } };
    }

    /* ----------------------------------------------------------------- chat */
    case 'chat:threads': {
      const items = b.threads.filter(
        (t) => t.videoId === p.videoId && (p.clipId ? t.clipId === p.clipId : t.clipId === null),
      );
      return { value: { items } };
    }
    case 'chat:messages': {
      if (!b.threads.some((t) => t.id === p.threadId))
        throw fail('Conversation not found', 'NOT_FOUND');
      return { value: { items: b.messages.get(p.threadId as string) ?? [] } };
    }
    case 'chat:send': {
      const v = videoOf(state, p.videoId as string);
      b.log.sends.push({
        text: p.text as string,
        threadId: p.threadId as string | undefined,
        clipId: p.clipId as string | undefined,
      });
      let th = p.threadId ? b.threads.find((t) => t.id === p.threadId) : undefined;
      if (!th) {
        th = {
          id: nextId(b, 'th'),
          videoId: v.id,
          clipId: (p.clipId as string | undefined) ?? null,
          title: words(p.text as string, 6),
          updatedAt: Date.now(),
        };
        b.threads.unshift(th);
        b.messages.set(th.id, []);
      }
      const userMsg: ChatMessage = {
        id: nextId(b, 'm'),
        threadId: th.id,
        role: 'user',
        text: p.text as string,
        citations: [],
        actions: [],
        createdAt: Date.now(),
      };
      b.messages.get(th.id)!.push(userMsg);
      th.updatedAt = Date.now();
      const answer = buildAnswer(
        state,
        b,
        { videoId: v.id, clipId: p.clipId as string | undefined },
        p.text as string,
      );
      const asstId = nextId(b, 'm');
      const { events, final } = chatEventsFor(b, th.id, asstId, answer);
      const run: ChatRun = {
        threadId: th.id,
        userMessageId: userMsg.id,
        events,
        cursor: 0,
        canceled: false,
        text: '',
        final,
        effects: answer.effects,
        effectsRan: false,
      };
      if (b.chatError) {
        const err = b.chatError;
        b.chatError = null;
        run.events = [
          ...events.slice(0, Math.min(err.afterEvents, events.length - 1)),
          { type: 'error', threadId: th.id, message: err.message },
        ];
      }
      b.chatRuns.set(th.id, run);
      if (auto !== null) void runChatAuto(state, b, run);
      return { value: { threadId: th.id, messageId: userMsg.id } };
    }
    case 'chat:cancel': {
      const run = b.chatRuns.get(p.threadId as string);
      if (run) {
        run.canceled = true;
        b.chatRuns.delete(run.threadId);
        // main finishes the turn with whatever was produced so far
        const partial: ChatMessage = {
          ...run.final,
          text: run.text,
          citations: [],
          actions: [],
          createdAt: Date.now(),
        };
        if (run.text) {
          const list = b.messages.get(run.threadId) ?? [];
          list.push(partial);
          b.messages.set(run.threadId, list);
          await state.emit?.('chat:event', {
            type: 'done',
            threadId: run.threadId,
            message: partial,
          });
        }
      }
      return { value: { ok: true } };
    }
    case 'chat:delete': {
      b.threads = b.threads.filter((t) => t.id !== p.threadId);
      b.messages.delete(p.threadId as string);
      b.chatRuns.delete(p.threadId as string);
      return { value: { ok: true } };
    }

    /* -------------------------------------------------------------- markers */
    case 'markers:list':
      return { value: { items: b.markers.filter((m) => m.videoId === p.videoId) } };
    case 'markers:add': {
      const m: Marker = {
        id: nextId(b, 'mk'),
        videoId: p.videoId as string,
        atSec: p.atSec as number,
        label: p.label as string,
        createdAt: Date.now(),
      };
      b.markers.push(m);
      await state.emit?.('markers:changed', { videoId: m.videoId });
      return { value: m };
    }
    case 'markers:delete': {
      const m = b.markers.find((x) => x.id === p.id);
      b.markers = b.markers.filter((x) => x.id !== p.id);
      if (m) await state.emit?.('markers:changed', { videoId: m.videoId });
      return { value: { ok: true } };
    }
  }
  return null;
}

async function autoRender(state: Cp1State, b: BState, clipId: string, _why?: string) {
  const ms = b.autoMs ?? 400;
  for (const pr of [0.2, 0.55, 0.9]) {
    await sleep(ms);
    const c = state.clips.find((x) => x.id === clipId);
    if (!c) return;
    Object.assign(c, { status: 'rendering', renderProgress: pr });
    await pushClip(state, c);
  }
  await sleep(ms);
  await controls(state).finishRender(clipId);
}

export const stubB = {
  /** Handles CP2 clip-intelligence channels; resolves null for any other channel. */
  async handle(
    state: Cp1State,
    channel: string,
    payload: unknown,
  ): Promise<{ value: unknown } | null> {
    const res = await handle(state, channel, payload);
    return res;
  },
  channels: STUB_B_CHANNELS,
  controls,
  bstate,
  /** Validates the payload with the real contract (used by harnesses). */
  parse<C extends InvokeChannel>(channel: C, payload: unknown): InvokeInput<C> {
    return invokeContract[channel].input.parse(payload) as InvokeInput<C>;
  },
};
