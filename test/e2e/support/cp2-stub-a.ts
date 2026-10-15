/**
 * TEST-ONLY stand-in for main's CP2 caption + subtitle behaviour (UI-A): caption styles (the REAL 14 presets from
 * electron/main/services/captions/styles.ts), REAL libass previews (renderPreview, i.e. ffmpeg + libass), subtitle
 * cues derived from the real transcript + edits (chunking, breaks, merges, hidden words, shifts), save revisions and
 * outdated-clip counts, video-level exports, set-style / restyle / reframe.
 *
 * Every request and response passes through the REAL zod contract in clipfern-stub.ts, so this file cannot drift from
 * shared/ipc.ts. Merge into the main stub with one line:
 *     const a = await handleCp2a(state, channel, payload); if (a) return a.value;
 *
 * `restyle`, `reframe` and clip-level subtitle exports are delegated to UI-B's stub (`stubB`), which owns the clip
 * drawer behaviour, and logged here as well.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { encodeIpcError } from '../../../shared/ipc';
import { captionStyleSchema, subtitleEditsSchema } from '../../../shared/cp2';
import type { CaptionStyle, Cue, SubtitleEdits } from '../../../shared/cp2';
import type { Transcript, VideoView } from '../../../shared/pipeline';
import { builtinStyles } from '../../../electron/main/services/captions/styles';
import { renderPreview } from '../../../electron/main/services/captions/preview';
import { ASSETS_DIR, CLIP_THUMBS } from './cp1-fixtures';
import type { Cp1State } from './cp1-sim';
import { stubB } from './cp2-stub-b';

const fail = (msg: string, code: 'FAILED' | 'NOT_FOUND' = 'FAILED') =>
  new Error(encodeIpcError(code, msg));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ROOT = path.resolve(__dirname, '../../..');
const FONTS_DIR = path.join(ROOT, 'electron/main/assets/fonts');
const PREVIEW_DIR = path.join(ASSETS_DIR, 'cp2a-previews');
const PREVIEW_W = 540;
const PREVIEW_H = 960;
const PREVIEW_VERSION = 'v1';

function ffmpegBin(): string {
  for (const p of ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg']) if (fs.existsSync(p)) return p;
  return 'ffmpeg';
}

/* ----------------------------------------------------------------------------------------------- state */

export interface Cp2aState {
  styles: CaptionStyle[];
  counter: number;
  /** Saved subtitle edits and revision per video. */
  subs: Map<string, SubtitleEdits>;
  /** channel -> error thrown by the next call(s) */
  failures: Map<string, { message: string; times: number }>;
  /** ms every `subtitles:save` takes (lets tests observe "Saving…"). */
  saveDelayMs: number;
  /** ms every `captions:preview` takes on top of the real render. */
  previewDelayMs: number;
  /** While set, previews wait for it (tests of the dimmed "updating" state). */
  previewGate: Promise<void> | null;
  /** Concurrent `captions:preview` calls right now, and the highest value seen (gallery limits itself to 2 + 1 live). */
  previewsInFlight: number;
  maxPreviewsInFlight: number;
  log: {
    previews: {
      style: CaptionStyle;
      text: string | undefined;
      clipId: string | undefined;
      activeWord: number;
      aspect: string;
    }[];
    savedStyles: CaptionStyle[];
    deletedStyles: string[];
    styleSelections: { id: string; styleId: string }[];
    saves: { videoId: string; edits: SubtitleEdits }[];
    exports: { videoId: string; clipId: string | undefined; format: string }[];
    restyles: { ids: string[]; styleId: string | undefined; reframeMode: string | undefined }[];
    reframes: { ids: string[]; mode: string }[];
  };
}

const states = new WeakMap<Cp1State, Cp2aState>();
export function cp2a(state: Cp1State): Cp2aState {
  let s = states.get(state);
  if (!s) {
    s = {
      styles: builtinStyles(),
      counter: 0,
      subs: new Map(),
      failures: new Map(),
      saveDelayMs: 0,
      previewDelayMs: 0,
      previewGate: null,
      previewsInFlight: 0,
      maxPreviewsInFlight: 0,
      log: {
        previews: [],
        savedStyles: [],
        deletedStyles: [],
        styleSelections: [],
        saves: [],
        exports: [],
        restyles: [],
        reframes: [],
      },
    };
    states.set(state, s);
  }
  return s;
}

/** Test controls. */
export function controls(state: Cp1State) {
  const a = cp2a(state);
  return {
    state: a,
    /** The next `times` calls of `channel` fail with `message`. */
    failNext(channel: string, message: string, times = 1) {
      a.failures.set(channel, { message, times });
    },
    /** Holds every `captions:preview` until the returned function is called. */
    holdPreviews(): () => void {
      let release!: () => void;
      a.previewGate = new Promise<void>((r) => (release = r));
      return () => {
        a.previewGate = null;
        release();
      };
    },
    /** Marks every rendered clip of a video as built from the current subtitle revision. */
    markClipsCurrent(videoId: string) {
      const rev = state.videos.find((v) => v.id === videoId)?.subtitleRev ?? 0;
      for (const c of state.clips) if (c.videoId === videoId && c.hasRender) c.subtitleRev = rev;
    },
  };
}

/* ----------------------------------------------------------------------------------- subtitle cues */

const MAX_CUE_WORDS = 7;
const MAX_CUE_CHARS = 42;

function wordTextOf(tr: Transcript, edits: SubtitleEdits, i: number): string {
  return (edits.words[String(i)]?.text ?? tr.words[i]?.w ?? '').trim();
}

/**
 * Server-side chunking: a new cue starts at every sentence start, after 7 words / 42 characters, and at every explicit
 * break; a forced merge suppresses an automatic break. Hidden words are skipped, shifts move words in time.
 */
export function deriveCues(tr: Transcript, edits: SubtitleEdits): Cue[] {
  const sentenceStarts = new Set(tr.sentences.map((s) => s.wordStart));
  const breaks = new Set(edits.breaks);
  const merges = new Set(edits.merges);
  const groups: { vis: number[] }[] = [];
  let cur: { vis: number[]; chars: number } | null = null;
  for (let i = 0; i < tr.words.length; i++) {
    if (edits.words[String(i)]?.hidden) continue;
    const text = wordTextOf(tr, edits, i);
    const auto =
      cur === null ||
      sentenceStarts.has(i) ||
      cur.vis.length >= MAX_CUE_WORDS ||
      cur.chars + 1 + text.length > MAX_CUE_CHARS;
    const brk = breaks.has(i) || (auto && !merges.has(i));
    if (cur === null || brk) {
      cur = { vis: [], chars: 0 };
      groups.push(cur);
    }
    cur.vis.push(i);
    cur.chars += text.length + (cur.vis.length > 1 ? 1 : 0);
  }
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  const time = (i: number) => {
    const shift = edits.words[String(i)]?.shift ?? 0;
    return { s: r3((tr.words[i]?.s ?? 0) + shift), e: r3((tr.words[i]?.e ?? 0) + shift) };
  };
  const cues: Cue[] = [];
  groups.forEach((g, k) => {
    const first = g.vis[0]!;
    const last = g.vis[g.vis.length - 1]!;
    const next = groups[k + 1]?.vis[0];
    const wordStart = k === 0 ? 0 : first;
    const wordEnd = next === undefined ? tr.words.length - 1 : next - 1;
    cues.push({
      id: wordStart,
      s: time(first).s,
      e: time(last).e,
      text: g.vis.map((i) => wordTextOf(tr, edits, i)).join(' '),
      wordStart,
      wordEnd: Math.max(wordEnd, last),
    });
  });
  return cues;
}

function outdatedCount(state: Cp1State, videoId: string): number {
  const rev = state.videos.find((v) => v.id === videoId)?.subtitleRev ?? 0;
  return state.clips.filter((c) => c.videoId === videoId && c.hasRender && c.subtitleRev < rev)
    .length;
}

/* ------------------------------------------------------------------------------------- previews */

fs.mkdirSync(PREVIEW_DIR, { recursive: true });

function previewBackground(state: Cp1State, clipId: string | undefined): string | null {
  if (!clipId) return null;
  const a = state.clipAssets[clipId];
  const file = a?.thumb ?? CLIP_THUMBS[0]!;
  const p = path.join(ASSETS_DIR, file);
  return fs.existsSync(p) ? p : null;
}

const inflightRenders = new Map<string, Promise<Buffer>>();

async function renderPreviewPng(
  state: Cp1State,
  p: {
    style: CaptionStyle;
    text: string | undefined;
    clipId: string | undefined;
    activeWord: number;
  },
): Promise<Buffer> {
  const bg = previewBackground(state, p.clipId);
  const { id: _id, name: _name, builtin: _builtin, ...look } = p.style;
  void _id;
  void _name;
  void _builtin;
  const key = createHash('sha1')
    .update(JSON.stringify([PREVIEW_VERSION, look, p.text ?? '', bg ?? '', p.activeWord]))
    .digest('hex');
  const file = path.join(PREVIEW_DIR, `${key}.png`);
  if (fs.existsSync(file)) return fs.readFileSync(file);
  const running = inflightRenders.get(key);
  if (running) return running;
  const job = renderPreview({
    ffmpegPath: ffmpegBin(),
    fontsDir: FONTS_DIR,
    style: p.style,
    text: p.text ?? '',
    activeWord: p.activeWord,
    width: PREVIEW_W,
    height: PREVIEW_H,
    backgroundPath: bg,
  })
    .then((png) => {
      fs.writeFileSync(file, png);
      return png;
    })
    .finally(() => inflightRenders.delete(key));
  inflightRenders.set(key, job);
  return job;
}

/* ------------------------------------------------------------------------------------- handlers */

const OWN = new Set([
  'captions:styles',
  'captions:fonts',
  'captions:saveStyle',
  'captions:deleteStyle',
  'captions:preview',
  'videos:setCaptionStyle',
  'subtitles:get',
  'subtitles:save',
  'subtitles:export',
  'clips:restyle',
  'clips:reframe',
]);
export const STUB_A_CHANNELS: readonly string[] = [...OWN];

const FONTS = [
  { family: 'Montserrat', weights: [800] },
  { family: 'Anton', weights: [400] },
  { family: 'Bebas Neue', weights: [400] },
  { family: 'Poppins', weights: [600, 700, 800] },
  { family: 'IBM Plex Mono', weights: [600] },
  { family: 'DM Serif Display', weights: [400] },
];

function videoOf(state: Cp1State, id: string): VideoView {
  const v = state.videos.find((x) => x.id === id);
  if (!v) throw fail('Video not found', 'NOT_FOUND');
  return v;
}

export async function handleCp2a(
  state: Cp1State,
  channel: string,
  payload: unknown,
): Promise<{ value: unknown } | null> {
  if (!OWN.has(channel)) return null;
  const a = cp2a(state);
  const f = a.failures.get(channel);
  if (f && f.times > 0) {
    f.times--;
    if (f.times === 0) a.failures.delete(channel);
    throw fail(f.message);
  }
  const p = payload as Record<string, unknown>;

  switch (channel) {
    case 'captions:styles':
      return { value: { styles: a.styles } };

    case 'captions:fonts':
      return { value: { fonts: FONTS } };

    case 'captions:saveStyle': {
      const style = captionStyleSchema.parse(p.style);
      a.log.savedStyles.push(style);
      const existing = a.styles.findIndex((s) => s.id === style.id && !s.builtin);
      if (existing >= 0) {
        const saved = { ...style, builtin: false };
        a.styles[existing] = saved;
        return { value: saved };
      }
      a.counter += 1;
      const saved = { ...style, id: `custom-${a.counter}`, builtin: false };
      a.styles.push(saved);
      return { value: saved };
    }

    case 'captions:deleteStyle': {
      const id = p.id as string;
      const target = a.styles.find((s) => s.id === id);
      if (!target) throw fail('That style does not exist.', 'NOT_FOUND');
      if (target.builtin)
        throw fail('Built-in presets cannot be deleted. Duplicate one to customise it.');
      a.log.deletedStyles.push(id);
      a.styles = a.styles.filter((s) => s.id !== id);
      return { value: { ok: true } };
    }

    case 'captions:preview': {
      const style = captionStyleSchema.parse(p.style);
      a.log.previews.push({
        style,
        text: p.text as string | undefined,
        clipId: p.clipId as string | undefined,
        activeWord: (p.activeWord as number) ?? 1,
        aspect: (p.aspect as string) ?? '9:16',
      });
      a.previewsInFlight += 1;
      a.maxPreviewsInFlight = Math.max(a.maxPreviewsInFlight, a.previewsInFlight);
      let png: Buffer;
      try {
        if (a.previewGate) await a.previewGate;
        if (a.previewDelayMs) await sleep(a.previewDelayMs);
        png = await renderPreviewPng(state, {
          style,
          text: p.text as string | undefined,
          clipId: p.clipId as string | undefined,
          activeWord: (p.activeWord as number) ?? 1,
        });
      } finally {
        a.previewsInFlight -= 1;
      }
      return {
        value: {
          dataUrl: `data:image/png;base64,${png.toString('base64')}`,
          width: PREVIEW_W,
          height: PREVIEW_H,
        },
      };
    }

    case 'videos:setCaptionStyle': {
      const v = videoOf(state, p.id as string);
      a.log.styleSelections.push({ id: v.id, styleId: p.styleId as string });
      v.options = { ...v.options, captionStyleId: p.styleId as string };
      v.updatedAt = Date.now();
      await state.emit?.('videos:updated', { ...v });
      return { value: { ok: true } };
    }

    case 'subtitles:get': {
      const videoId = p.videoId as string;
      videoOf(state, videoId);
      const tr = state.transcripts[videoId];
      const edits = a.subs.get(videoId) ?? subtitleEditsSchema.parse({});
      return {
        value: {
          cues: tr ? deriveCues(tr, edits) : [],
          edits,
          language: tr?.language ?? 'en',
          outdatedClips: outdatedCount(state, videoId),
        },
      };
    }

    case 'subtitles:save': {
      const videoId = p.videoId as string;
      const v = videoOf(state, videoId);
      const tr = state.transcripts[videoId];
      if (!tr) throw fail('This video has no transcript to caption yet.');
      const incoming = subtitleEditsSchema.parse(p.edits);
      a.log.saves.push({ videoId, edits: incoming });
      if (a.saveDelayMs) await sleep(a.saveDelayMs);
      const prev = a.subs.get(videoId);
      const next: SubtitleEdits = { ...incoming, rev: (prev?.rev ?? incoming.rev) + 1 };
      a.subs.set(videoId, next);
      v.subtitleRev = next.rev;
      v.updatedAt = Date.now();
      await state.emit?.('videos:updated', { ...v });
      return {
        value: {
          cues: deriveCues(tr, next),
          edits: next,
          outdatedClips: outdatedCount(state, videoId),
        },
      };
    }

    case 'subtitles:export': {
      // clip-level exports belong to the clip drawer (UI-B's stub); whole-video exports are recorded here
      if (p.clipId) return stubB.handle(state, channel, payload);
      a.log.exports.push({
        videoId: p.videoId as string,
        clipId: undefined,
        format: p.format as string,
      });
      const v = videoOf(state, p.videoId as string);
      const stem = v.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .slice(0, 40);
      return {
        value: { saved: true, path: `/home/demo/Downloads/${stem}.${p.format as string}` },
      };
    }

    case 'clips:restyle': {
      a.log.restyles.push({
        ids: p.ids as string[],
        styleId: p.styleId as string | undefined,
        reframeMode: p.reframeMode as string | undefined,
      });
      return stubB.handle(state, channel, payload);
    }

    case 'clips:reframe': {
      a.log.reframes.push({ ids: p.ids as string[], mode: p.mode as string });
      return stubB.handle(state, channel, payload);
    }
  }
  return null;
}
