/**
 * TEST-ONLY data + channel handlers for the editor SHELL + TIMELINE specs (CP3 editor-timeline).
 *
 * The in-memory persistence behind `editor:list|create|get|save|rename|versions|previewUrl|importAssets|beats|export…`
 * lives in editor-stub-panels.ts (one implementation of the contract, shared by every editor spec; `editor:save`
 * enforces `baseRev` and answers CONFLICT exactly like main). This file adds what the timeline needs on top:
 *   - realistic projects (`timelineProject`, `bigProject` with 3,000 items),
 *   - `editor:thumbStrip` backed by REAL frames (ffmpeg contact sheets of the generated fixture media) and
 *     `editor:waveform` with a speech-like envelope, so the filmstrip and waveform blocks can be reviewed visually,
 *   - small test controls (call log, failure injection).
 * Every request/response still passes through the REAL zod contract in clipfern-stub.ts, so nothing here can drift.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  audioItemSchema,
  imageItemSchema,
  projectSchema,
  shapeItemSchema,
  subtitleItemSchema,
  textItemSchema,
  trackSchema,
  videoItemSchema,
  type Asset,
  type Item,
  type Project,
  type Track,
} from '../../../shared/editor';
import type { Cp1State } from './cp1-sim';
import { addDoc, editorState } from './editor-stub-panels';

const exec = promisify(execFile);
const ASSETS_DIR =
  process.env.CLIPFERN_E2E_ASSETS ?? path.resolve(__dirname, '../../../.tmp/cp1-assets');

/* ----------------------------------------------------------------------------- projects --- */

export const TL_ASSETS: Asset[] = [
  {
    id: 'as_interview',
    kind: 'video',
    name: 'Interview — part 1',
    source: { kind: 'video', videoId: 'vid-interview' },
    durationSec: 120,
    width: 1920,
    height: 1080,
    fps: 30,
    hasAudio: true,
    beats: null,
  },
  {
    id: 'as_broll',
    kind: 'video',
    name: 'B-roll — city',
    source: { kind: 'clip', clipId: 'clip-broll' },
    durationSec: 40,
    width: 1080,
    height: 1920,
    fps: 30,
    hasAudio: false,
    beats: null,
  },
  {
    id: 'as_music',
    kind: 'audio',
    name: 'Lo-fi beat.mp3',
    source: { kind: 'upload', key: 'editor/tl/assets/as_music.mp3', fileName: 'lofi-beat.mp3' },
    durationSec: 90,
    width: null,
    height: null,
    fps: null,
    hasAudio: true,
    beats: Array.from({ length: 180 }, (_, i) => Math.round(i * 0.5 * 1000) / 1000),
  },
  {
    id: 'as_whoosh',
    kind: 'audio',
    name: 'Whoosh.wav',
    source: { kind: 'upload', key: 'editor/tl/assets/as_whoosh.wav', fileName: 'whoosh.wav' },
    durationSec: 2,
    width: null,
    height: null,
    fps: null,
    hasAudio: true,
    beats: null,
  },
  {
    id: 'as_logo',
    kind: 'image',
    name: 'Logo.png',
    source: { kind: 'upload', key: 'editor/tl/assets/as_logo.png', fileName: 'logo.png' },
    durationSec: null,
    width: 512,
    height: 512,
    fps: null,
    hasAudio: false,
    beats: null,
  },
];

const WORDS =
  'Welcome back to the show today we are talking about how small habits compound into big results and why the first ten minutes of your morning matter more than you think'.split(
    ' ',
  );

function cues(count: number, startAt = 0.4, per = 1.7): Item[] {
  const out: Item[] = [];
  for (let i = 0; i < count; i++) {
    const words = WORDS.slice((i * 3) % (WORDS.length - 4), ((i * 3) % (WORDS.length - 4)) + 4);
    const start = startAt + i * per;
    out.push(
      subtitleItemSchema.parse({
        type: 'subtitle',
        id: `cue_${i}`,
        startSec: start,
        durationSec: per - 0.15,
        words: words.map((w, k) => ({ w, s: k * 0.35, e: k * 0.35 + 0.3 })),
      }),
    );
  }
  return out;
}

/** The "everything" project: 7 tracks, every item type, a transition, keyframes, speed, fades, beats, markers. */
export function timelineProject(): Project {
  const video = (over: Record<string, unknown>) =>
    videoItemSchema.parse({ type: 'video', ...over });
  const tracks: Track[] = [
    trackSchema.parse({
      id: 'tr_video',
      kind: 'video',
      name: 'Video',
      speech: true,
      items: [
        video({
          id: 'v1',
          assetId: 'as_interview',
          startSec: 0,
          durationSec: 12,
          inSec: 5,
          name: 'Interview intro',
          fadeInSec: 0.6,
        }),
        video({
          id: 'v2',
          assetId: 'as_broll',
          startSec: 11.5,
          durationSec: 8,
          inSec: 3,
          name: 'City b-roll',
          transitionIn: { type: 'crossfade', durationSec: 0.5 },
        }),
        video({
          id: 'v3',
          assetId: 'as_interview',
          startSec: 20,
          durationSec: 12,
          inSec: 20,
          speed: 1.5,
          name: 'Answer one',
          fadeOutSec: 1,
        }),
        video({
          id: 'v4',
          assetId: 'as_interview',
          startSec: 33,
          durationSec: 9,
          inSec: 60,
          name: 'Answer two',
        }),
      ],
    }),
    trackSchema.parse({
      id: 'tr_overlay',
      kind: 'overlay',
      name: 'Overlay',
      items: [
        video({
          id: 'pip',
          assetId: 'as_broll',
          startSec: 4,
          durationSec: 6,
          inSec: 10,
          name: 'Picture in picture',
          transform: {
            scale: {
              v: 0.4,
              kf: [
                { t: 0, v: 0.3, ease: 'ease-out' },
                { t: 1.5, v: 0.4, ease: 'linear' },
                { t: 4, v: 0.4, ease: 'ease-in' },
              ],
            },
            x: {
              v: 0,
              kf: [
                { t: 0, v: 300, ease: 'linear' },
                { t: 4, v: 250, ease: 'linear' },
              ],
            },
          },
        }),
        video({
          id: 'pip2',
          assetId: 'as_broll',
          startSec: 22,
          durationSec: 5,
          inSec: 20,
          name: 'Cutaway',
        }),
      ],
    }),
    trackSchema.parse({
      id: 'tr_image',
      kind: 'image',
      name: 'Stickers',
      items: [
        imageItemSchema.parse({
          type: 'image',
          id: 'logo',
          assetId: 'as_logo',
          startSec: 0,
          durationSec: 42,
          name: 'Logo',
        }),
        shapeItemSchema.parse({
          type: 'shape',
          id: 'bar',
          shape: 'progress-bar',
          startSec: 0,
          durationSec: 42,
          name: 'Progress bar',
        }),
      ].sort((a, b) => a.startSec - b.startSec),
    }),
    trackSchema.parse({ id: 'tr_sub', kind: 'subtitle', name: 'Subtitles', items: cues(22) }),
    trackSchema.parse({
      id: 'tr_text',
      kind: 'text',
      name: 'Text',
      items: [
        textItemSchema.parse({
          type: 'text',
          id: 'hook',
          text: 'This habit changed my life',
          startSec: 0.5,
          durationSec: 3.5,
        }),
        textItemSchema.parse({
          type: 'text',
          id: 'cta',
          text: 'Follow for more',
          startSec: 36,
          durationSec: 5,
        }),
      ],
    }),
    trackSchema.parse({
      id: 'tr_music',
      kind: 'audio',
      name: 'Music',
      ducking: { enabled: true, reductionDb: 12, attackSec: 0.15, releaseSec: 0.5 },
      gain: 0.8,
      items: [
        audioItemSchema.parse({
          type: 'audio',
          id: 'music',
          assetId: 'as_music',
          startSec: 0,
          durationSec: 42,
          inSec: 4,
          name: 'Lo-fi beat',
          volume: { v: 0.7, kf: [] },
          fadeInSec: 2,
          fadeOutSec: 3,
        }),
      ],
    }),
    trackSchema.parse({
      id: 'tr_sfx',
      kind: 'sfx',
      name: 'Sound effects',
      items: [
        audioItemSchema.parse({
          type: 'audio',
          id: 'sfx1',
          assetId: 'as_whoosh',
          startSec: 11,
          durationSec: 2,
          name: 'Whoosh',
        }),
        audioItemSchema.parse({
          type: 'audio',
          id: 'sfx2',
          assetId: 'as_whoosh',
          startSec: 19.5,
          durationSec: 2,
          name: 'Whoosh',
        }),
      ],
    }),
  ];
  return projectSchema.parse({
    canvas: { aspect: '9:16', width: 1080, height: 1920, fps: 30 },
    tracks,
    assets: TL_ASSETS,
    markers: [
      { id: 'mk_1', atSec: 12, label: 'Cut to b-roll', color: '#F5A524' },
      { id: 'mk_2', atSec: 33, label: 'Answer two', color: '#F5A524' },
    ],
    origin: { clipId: null, videoId: 'vid-interview' },
  });
}

/** A project with `count` items spread over six tracks (for the virtualisation / 60 fps checks). */
export function bigProject(count = 3000): Project {
  const kinds: {
    id: string;
    kind: Track['kind'];
    type: 'video' | 'text' | 'subtitle' | 'audio' | 'image' | 'shape';
  }[] = [
    { id: 'b_video', kind: 'video', type: 'video' },
    { id: 'b_overlay', kind: 'overlay', type: 'video' },
    { id: 'b_text', kind: 'text', type: 'text' },
    { id: 'b_sub', kind: 'subtitle', type: 'subtitle' },
    { id: 'b_music', kind: 'audio', type: 'audio' },
    { id: 'b_sfx', kind: 'sfx', type: 'audio' },
  ];
  const per = Math.ceil(count / kinds.length);
  const tracks = kinds.map((k, ti) => {
    const items: Item[] = [];
    for (let i = 0; i < per; i++) {
      const start = i * 1.6 + ti * 0.05;
      const dur = 1.4;
      const id = `${k.id}_${i}`;
      if (k.type === 'video')
        items.push(
          videoItemSchema.parse({
            type: 'video',
            id,
            assetId: 'as_interview',
            startSec: start,
            durationSec: dur,
            inSec: (i * 1.6) % 100,
            name: `Clip ${i + 1}`,
          }),
        );
      else if (k.type === 'text')
        items.push(
          textItemSchema.parse({
            type: 'text',
            id,
            text: `Title ${i + 1}`,
            startSec: start,
            durationSec: dur,
          }),
        );
      else if (k.type === 'subtitle')
        items.push(
          subtitleItemSchema.parse({
            type: 'subtitle',
            id,
            startSec: start,
            durationSec: dur,
            words: [
              { w: `Caption`, s: 0, e: 0.4 },
              { w: `${i + 1}`, s: 0.5, e: 0.9 },
            ],
          }),
        );
      else
        items.push(
          audioItemSchema.parse({
            type: 'audio',
            id,
            assetId: k.kind === 'sfx' ? 'as_whoosh' : 'as_music',
            startSec: start,
            durationSec: dur,
            inSec: (i * 1.6) % 80,
          }),
        );
    }
    return trackSchema.parse({
      id: k.id,
      kind: k.kind,
      name: k.kind === 'sfx' ? 'Sound effects' : k.kind[0]!.toUpperCase() + k.kind.slice(1),
      speech: k.kind === 'video',
      items,
    });
  });
  return projectSchema.parse({
    canvas: { aspect: '9:16', width: 1080, height: 1920, fps: 30 },
    tracks,
    assets: TL_ASSETS,
    markers: [],
  });
}

/** Registers the demo projects in the in-memory store; call from `open(..., { prepare })`. */
export function seedTimeline(
  state: Cp1State,
  ids: { demo?: string; big?: string | false; empty?: string } = {},
): void {
  addDoc(state, {
    id: ids.demo ?? 'tl-demo',
    name: 'Morning habits — rough cut',
    project: timelineProject(),
    rev: 1,
  });
  if (ids.big !== false)
    addDoc(state, {
      id: ids.big ?? 'tl-big',
      name: 'Stress test (3,000 items)',
      project: bigProject(3000),
      rev: 1,
    });
  addDoc(state, {
    id: ids.empty ?? 'tl-empty',
    name: 'Untitled project',
    project: projectSchema.parse({
      canvas: { aspect: '9:16', width: 1080, height: 1920, fps: 30 },
      tracks: [
        { id: 'tr_video', kind: 'video', name: 'Video', speech: true, items: [] },
        { id: 'tr_sub', kind: 'subtitle', name: 'Subtitles', items: [] },
        { id: 'tr_text', kind: 'text', name: 'Text', items: [] },
        { id: 'tr_music', kind: 'audio', name: 'Music', items: [] },
      ],
      assets: TL_ASSETS,
    }),
    rev: 1,
  });
}

/* ------------------------------------------------------------------------------ channels --- */

const sprites = new Map<string, Promise<string | null>>();
export const thumbCalls: { assetId: string; startSec: number; endSec: number; count: number }[] =
  [];

function mediaFor(assetId: string, state: Cp1State): string | null {
  const a = TL_ASSETS.find((x) => x.id === assetId);
  if (!a || a.kind !== 'video') return null;
  const f =
    a.source.kind === 'video'
      ? 'proxy.webm'
      : ['clip-a.webm', 'clip-b.webm', 'clip-c.webm'][Math.abs(hash(assetId)) % 3]!;
  const p = path.join(ASSETS_DIR, f);
  void state;
  return fs.existsSync(p) ? p : null;
}
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);

async function spriteFor(
  file: string,
  start: number,
  end: number,
  count: number,
  tileW: number,
  tileH: number,
): Promise<string | null> {
  const key = `${file}|${start.toFixed(2)}|${end.toFixed(2)}|${count}|${tileW}x${tileH}`;
  let hit = sprites.get(key);
  if (!hit) {
    hit = (async () => {
      try {
        const span = Math.max(0.25, end - start);
        const cols = Math.min(count, 10);
        const rows = Math.ceil(count / cols);
        // loop short fixtures: seek within the file's own length
        const seek = Math.max(0, start % 7);
        const { stdout } = await exec(
          'ffmpeg',
          [
            '-v',
            'error',
            '-ss',
            String(seek),
            '-t',
            String(Math.min(span, 7)),
            '-i',
            file,
            '-vf',
            `fps=${(count / Math.min(span, 7)).toFixed(4)},scale=${tileW}:${tileH}:force_original_aspect_ratio=increase,crop=${tileW}:${tileH},tile=${cols}x${rows}`,
            '-frames:v',
            '1',
            '-q:v',
            '5',
            '-f',
            'image2pipe',
            '-c:v',
            'mjpeg',
            '-',
          ],
          { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 },
        );
        return `data:image/jpeg;base64,${Buffer.from(stdout).toString('base64')}`;
      } catch {
        return null;
      }
    })();
    sprites.set(key, hit);
  }
  return hit;
}

export async function handleEditorTimeline(
  state: Cp1State,
  channel: string,
  payload: unknown,
): Promise<{ value: unknown } | null> {
  const p = (payload ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- test stub: the real contract already validated the payload
  if (channel === 'editor:thumbStrip') {
    thumbCalls.push({ assetId: p.assetId, startSec: p.startSec, endSec: p.endSec, count: p.count });
    const file = mediaFor(p.assetId, state);
    const asset =
      editorState(state)
        .docs.get(p.projectId)
        ?.project.assets.find((a) => a.id === p.assetId) ??
      TL_ASSETS.find((a) => a.id === p.assetId);
    if (!file || !asset) return null;
    const h = p.height as number;
    const aspect = asset.width && asset.height ? asset.width / asset.height : 16 / 9;
    const tileW = Math.round(h * aspect);
    const count = p.count as number;
    const dataUrl = await spriteFor(file, p.startSec, p.endSec, count, tileW, h);
    const cols = Math.min(count, 10);
    const span = Math.max(0.25, p.endSec - p.startSec);
    return {
      value: {
        dataUrl,
        tileW,
        tileH: h,
        cols,
        times: Array.from({ length: count }, (_, i) => p.startSec + ((i + 0.5) * span) / count),
      },
    };
  }
  if (channel === 'editor:waveform') {
    const a =
      TL_ASSETS.find((x) => x.id === p.assetId) ??
      editorState(state)
        .docs.get(p.projectId)
        ?.project.assets.find((x) => x.id === p.assetId);
    if (!a || !a.hasAudio) return { value: null };
    const rate = 50;
    const dur = a.durationSec ?? 20;
    const seed = Math.abs(hash(a.id));
    const music = a.kind === 'audio' && a.id !== 'as_whoosh';
    const peaks = Array.from({ length: Math.round(dur * rate) }, (_, i) => {
      const t = i / rate;
      if (a.id === 'as_whoosh')
        return Math.max(
          0.03,
          Math.sin((Math.PI * t) / dur) ** 1.5 * (0.7 + 0.3 * Math.sin(i * 1.3)),
        );
      if (music) {
        const beat = Math.exp(-((t * 2) % 1) * 4); // kick every half second
        return Math.min(1, 0.22 + 0.55 * beat + 0.12 * Math.abs(Math.sin(i * 0.9 + seed)));
      }
      // speech: phrases with pauses
      const phrase = Math.max(0, Math.sin(t * 1.9 + seed) * 0.9 + 0.35);
      return Math.min(1, phrase * (0.35 + 0.65 * Math.abs(Math.sin(i * 0.7 + seed))) + 0.02);
    });
    return { value: { rate, durationSec: dur, peaks } };
  }
  return null;
}
