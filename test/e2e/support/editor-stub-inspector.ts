import type { Page } from '@playwright/test';
import { encodeIpcError, invokeContract } from '../../../shared/ipc';
import { installClipfernStub, makeState, type StubState } from './clipfern-stub';
import type { Harness } from './harness';

/**
 * Stubbed bridge + session opener for the Inspector's Playwright tests (TEST-ONLY).
 *
 * `window.clipfern` is the contract-validating CP1/CP2 stub (caption styles + REAL libass previews included); on top of
 * it this file answers the CP3 `editor:*` channels the inspector uses — beats, reframe, resync, LUT import, thumbnails —
 * with deterministic data, validating every request and response against shared/ipc.ts. The page under test is the
 * inspector lab route (test/e2e/support/inspector-lab, built by build-lab.sh) which exposes the editor store as
 * `window.__editor`.
 */

export interface EditorStubState {
  calls: { channel: string; payload: unknown }[];
  /** channel → error message thrown by the next call(s) */
  failures: Map<string, { message: string; times: number }>;
  /** ms every call of a channel takes */
  delayMs: Record<string, number>;
  /** Overrides for the canned answers. */
  beats: number[];
}

export const BEAT_INTERVAL = 0.5;

const fail = (msg: string) => new Error(encodeIpcError('FAILED', msg));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const svgFrame = (hue: number) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},45%,34%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360},40%,18%)"/></linearGradient></defs><rect width="160" height="90" fill="url(#g)"/><circle cx="52" cy="38" r="12" fill="hsl(${hue},30%,70%)"/><rect x="38" y="52" width="28" height="38" rx="8" fill="hsl(${hue},30%,70%)"/></svg>`,
  )}`;

function answer(es: EditorStubState, channel: string, payload: Record<string, unknown>): unknown {
  switch (channel) {
    case 'editor:beats':
      return { beats: es.beats };
    case 'editor:reframe': {
      const start = payload.startSec as number;
      const end = payload.endSec as number;
      const span = end - start;
      const n = Math.max(2, Math.round(span * 4)); // 4 keys / second → exercises the thinning
      const keyframes = Array.from({ length: n + 1 }, (_, i) => {
        const t = (span * i) / n;
        const p = i / n;
        // a face drifting left → right with a small wobble
        return {
          t: Math.round(t * 1000) / 1000,
          x: Math.round((0.12 + 0.4 * p + 0.01 * Math.sin(i)) * 10000) / 10000,
          y: 0,
          w: 0.3164,
          h: 1,
        };
      });
      return { keyframes, faceCoverage: 0.82 };
    }
    case 'editor:resyncSubtitles': {
      const a = payload.srcStartSec as number;
      const b = payload.srcEndSec as number;
      const inner0 = a + 0.25;
      const inner1 = b - 0.25;
      const sentence = ['Welcome', 'back', 'to', 'the', 'show'];
      const step = (inner1 - inner0) / sentence.length;
      return {
        words: [
          { w: 'uh', s: a, e: a + 0.18 }, // belongs to the neighbouring caption: must be dropped
          ...sentence.map((w, i) => ({ w, s: inner0 + i * step, e: inner0 + (i + 1) * step })),
          { w: 'so', s: b - 0.18, e: b },
        ],
      };
    }
    case 'editor:importAssets':
      return {
        canceled: false,
        assets: [
          {
            id: 'a_lut_teal',
            kind: 'lut',
            name: 'Teal & Orange.cube',
            source: { kind: 'upload', key: 'k/teal.cube', fileName: 'teal.cube' },
          },
        ],
      };
    case 'editor:thumbStrip':
      return { dataUrl: svgFrame(200), tileW: 160, tileH: 90, cols: 1, times: [payload.startSec] };
    default:
      throw fail(`editor stub: ${channel} is not implemented`);
  }
}

export interface LabSession {
  page: Page;
  state: StubState;
  editor: EditorStubState;
  problems: string[];
  close: () => Promise<void>;
  /** Evaluates `fn(store state, arg)` in the page. */
  read: <T, A = undefined>(fn: (s: LabState, arg: A) => T, arg?: A) => Promise<T>;
  select: (...ids: string[]) => Promise<void>;
  selectTrack: (id: string) => Promise<void>;
  setPlayhead: (sec: number) => Promise<void>;
  item: <T = Record<string, unknown>>(id: string) => Promise<T>;
  /** JSON of the whole project (compare before / after to prove an undo restored everything). */
  snapshot: () => Promise<string>;
  undoOnce: () => Promise<void>;
  calls: (channel: string) => unknown[];
  storeLog: (fn: string) => Promise<unknown[][]>;
}

/** The slice of the store tests read (loose on purpose: the page owns the real types). */
export interface LabState {
  project: {
    canvas: Record<string, unknown>;
    tracks: {
      id: string;
      muted: boolean;
      gain: number;
      speech: boolean;
      ducking: Record<string, number | boolean>;
      items: Record<string, unknown>[];
    }[];
    assets: Record<string, unknown>[];
  };
  playheadSec: number;
  snapEnabled: boolean;
  safeArea: string | null;
  showGrid: boolean;
  selection: {
    itemIds: string[];
    trackId: string | null;
    keyframe: { itemId: string; prop: string; index: number } | null;
  };
  canUndo: boolean;
  undo: () => void;
  redo: () => void;
}

export interface LabOptions {
  theme?: 'dark' | 'light';
  width?: number;
  height?: number;
  reducedMotion?: boolean;
  /** Skip loading the fixture project (the empty store). */
  autoload?: boolean;
}

export async function openInspectorLab(h: Harness, opts: LabOptions = {}): Promise<LabSession> {
  const {
    theme = 'dark',
    width = 1440,
    height = 900,
    reducedMotion = false,
    autoload = true,
  } = opts;
  const context = await h.browser.newContext({
    viewport: { width, height },
    colorScheme: theme,
    reducedMotion: reducedMotion ? 'reduce' : 'no-preference',
    deviceScaleFactor: 1,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning')
      problems.push(`console.${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('request', (r) => {
    if (!r.url().startsWith(h.base) && !r.url().startsWith('data:') && !r.url().startsWith('blob:'))
      problems.push(`EXTERNAL REQUEST: ${r.url()}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.url()}`);
  });

  const state = makeState('configured', 'linux', { assetBase: h.base });
  await installClipfernStub(page, state);

  const editor: EditorStubState = {
    calls: [],
    failures: new Map(),
    delayMs: {},
    beats: Array.from(
      { length: 160 },
      (_, i) => Math.round((0.25 + i * BEAT_INTERVAL) * 1000) / 1000,
    ),
  };
  await page.exposeFunction('__editorInvoke', async (channel: string, payload: unknown) => {
    const spec = invokeContract[channel as keyof typeof invokeContract];
    if (!spec) throw new Error(`Unknown channel: ${channel}`);
    const input = spec.input.parse(payload);
    editor.calls.push({ channel, payload: input });
    const wait = editor.delayMs[channel];
    if (wait) await sleep(wait);
    const f = editor.failures.get(channel);
    if (f && f.times > 0) {
      f.times -= 1;
      throw fail(f.message);
    }
    return spec.output.parse(answer(editor, channel, input as Record<string, unknown>));
  });
  await page.addInitScript(() => {
    const w = window as unknown as {
      clipfern: { invoke: (c: string, p?: unknown) => Promise<unknown> };
      __editorInvoke: (c: string, p: unknown) => Promise<unknown>;
    };
    const orig = w.clipfern.invoke;
    w.clipfern.invoke = (channel, payload) =>
      channel.startsWith('editor:') ? w.__editorInvoke(channel, payload) : orig(channel, payload);
  });
  await context.addInitScript((t: string) => {
    try {
      localStorage.setItem('clipfern.theme', t);
    } catch {
      /* ignore */
    }
  }, theme);

  await page.goto(`${h.base}/inspector-lab/${autoload ? '' : '?autoload=0'}`);
  await page.waitForFunction(
    () => (window as unknown as { __labReady?: boolean }).__labReady === true,
  );
  await page.getByTestId('inspector').waitFor();
  await page.waitForLoadState('networkidle');

  const read: LabSession['read'] = (fn, arg) =>
    page.evaluate(
      ([src, a]) => {
        const store = (window as unknown as { __editor: { getState: () => unknown } }).__editor;
        // evaluates the caller's function inside the page
        const f = new Function(`return (${src as string})`)() as (
          s: unknown,
          a: unknown,
        ) => unknown;
        return f(store.getState(), a);
      },
      [fn.toString(), arg] as const,
    ) as Promise<never>;

  const session: LabSession = {
    page,
    state,
    editor,
    problems,
    close: () => context.close(),
    read,
    select: (...ids) =>
      read(
        (s, i) => (s as unknown as { select: (x: string[]) => void }).select(i),
        ids,
      ) as Promise<void>,
    selectTrack: (id) =>
      read(
        (s, i) => (s as unknown as { selectTrack: (x: string) => void }).selectTrack(i),
        id,
      ) as Promise<void>,
    setPlayhead: (sec) =>
      read(
        (s, i) => (s as unknown as { setPlayhead: (x: number) => void }).setPlayhead(i),
        sec,
      ) as Promise<void>,
    item: (id) =>
      read(
        (s, i) => s.project.tracks.flatMap((t) => t.items).find((x) => x.id === i) ?? null,
        id,
      ) as Promise<never>,
    snapshot: () => read((s) => JSON.stringify(s.project)),
    undoOnce: () => read((s) => s.undo()),
    calls: (channel) => editor.calls.filter((c) => c.channel === channel).map((c) => c.payload),
    storeLog: (fn) =>
      page.evaluate(
        (f) =>
          (window as unknown as { __editorLog: { fn: string; args: unknown[] }[] }).__editorLog
            .filter((l) => l.fn === f)
            .map((l) => l.args),
        fn,
      ),
  };
  return session;
}
