/* eslint-disable @typescript-eslint/no-explicit-any -- test-only access to the page's untyped globals (window.__t) */
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { xFromTime } from './support/playback-media';
import {
  MEDIA_FILES,
  audioItem,
  canRun,
  createHarness,
  doc,
  makeProject,
  textItem,
  track,
  videoItem,
  type Harness,
  type Session,
} from './support/playback-harness';

/**
 * Playback engine + preview panel against the REAL <PreviewPlayer/>, editor store and WebGL2 compositor (SwiftShader), with
 * tiny REAL media (VP9/Opus WebM, WAV, PNG) served over HTTP and a contract-validated stub for the `editor:*` channels.
 * Playwright's Chromium cannot play H.264, so the test media are WebM; the engine is codec-agnostic.
 *   pnpm exec playwright test test/e2e/editor-playback.spec.ts           (CLIPFERN_E2E_OUT = private build dir)
 * Screenshots go to CLIPFERN_PLAYBACK_SHOTS (default .tmp/playback-shots).
 */
test.use({ trace: 'off', video: 'off', screenshot: 'off', actionTimeout: 10_000 });
test.skip(!canRun(), 'needs a Chromium binary');

let h: Harness;
test.beforeAll(async () => {
  test.setTimeout(240_000);
  h = await createHarness();
});
test.afterAll(async () => {
  await h?.close();
});

const SHOTS =
  process.env.CLIPFERN_PLAYBACK_SHOTS ?? path.resolve(__dirname, '../../.tmp/playback-shots');
const shot = (p: Page, name: string) => p.screenshot({ path: path.join(SHOTS, `${name}.png`) });

type T = {
  store: { getState(): Record<string, any>; setState(p: unknown): void };
  getEngine(): Record<string, any> | null;
  load(d: unknown): void;
  resize(w: number, hh: number): void;
  unmount(): void;
  remount(): void;
  whiteBlob(box?: unknown): { cx: number; cy: number; n: number } | null;
  meanColor(box: unknown): [number, number, number] | null;
};
declare global {
  interface Window {
    __t: T;
  }
}

const MEDIA = {
  clip: MEDIA_FILES.clip!,
  tone: MEDIA_FILES.tone!,
  pic: MEDIA_FILES.pic!,
  mute: MEDIA_FILES.mute!,
};
const open = (o: Parameters<Harness['open']>[0] = {}) =>
  h.open({ ...o, bridge: { previewUrls: MEDIA, ...o?.bridge } });
const load = (s: Session, project: ReturnType<typeof makeProject>) =>
  s.page.evaluate((d) => window.__t.load(d), doc(project));
const seek = (s: Session, t: number) =>
  s.page.evaluate((x) => window.__t.store.getState().setPlayhead(x), t);

/** Waits until the white square (a source-time probe) is drawn near x (0..1 of the preview width). */
async function waitForSquareAt(s: Session, x: number, tol = 0.035, box?: unknown) {
  await expect
    .poll(
      async () => {
        const b = await s.page.evaluate((bx) => window.__t.whiteBlob(bx), box ?? null);
        return b ? Math.abs(b.cx - x) : 9;
      },
      { timeout: 8000, intervals: [50, 100, 200] },
    )
    .toBeLessThan(tol);
}

const play = (s: Session) => s.page.evaluate(() => window.__t.store.getState().play());
const pause = (s: Session) => s.page.evaluate(() => window.__t.store.getState().pause());
const playhead = (s: Session) =>
  s.page.evaluate(() => window.__t.store.getState().playheadSec as number);
const stage = (s: Session) => s.page.getByTestId('preview-stage');
/** Clicks / drags are in CSS px relative to the preview stage's top-left. */
async function stageBox(s: Session) {
  const b = await stage(s).boundingBox();
  if (!b) throw new Error('no stage');
  return b;
}
const graph = (s: Session) =>
  s.page.evaluate(() => window.__t.getEngine()?.debugAudioGraph() ?? null);
const item = (s: Session, id: string) =>
  s.page.evaluate((i) => {
    for (const tr of window.__t.store.getState().project.tracks) {
      const it = tr.items.find((x: { id: string }) => x.id === i);
      if (it) return it;
    }
    return null;
  }, id);

const videoTrack = (items: Record<string, unknown>[], o: Record<string, unknown> = {}) =>
  track('video', items, { speech: true, ...o });

test.describe('picture follows the playhead', () => {
  test('pixels change as the playhead moves (paused scrubbing)', async () => {
    const s = await open();
    await load(s, makeProject({ tracks: [videoTrack([videoItem()])] }));
    for (const t of [0, 1, 2.2, 3.4, 4.6, 5.5, 0.5]) {
      await seek(s, t);
      await waitForSquareAt(s, xFromTime(t));
    }
    await seek(s, 3);
    await waitForSquareAt(s, xFromTime(3));
    await shot(s.page, 'scrub-t3');
    await expect(s.page.getByTestId('preview-timecode')).toHaveText('00:03:00');
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('item offsets: a later start and an in-point map timeline time to source time', async () => {
    const s = await open();
    await load(
      s,
      makeProject({
        tracks: [videoTrack([videoItem({ startSec: 2, durationSec: 3, inSec: 1.5 })])],
      }),
    );
    await seek(s, 2.0);
    await waitForSquareAt(s, xFromTime(1.5));
    await seek(s, 3.4);
    await waitForSquareAt(s, xFromTime(2.9));
    await s.close();
  });

  test('speed 2× shows the frame twice as far into the source', async () => {
    const s = await open();
    await load(s, makeProject({ tracks: [videoTrack([videoItem({ durationSec: 3, speed: 2 })])] }));
    for (const t of [0.5, 1, 2.2]) {
      await seek(s, t);
      await waitForSquareAt(s, xFromTime(t * 2));
    }
    await s.close();
  });

  test('reverse plays the source window backwards', async () => {
    const s = await open();
    await load(
      s,
      makeProject({
        tracks: [videoTrack([videoItem({ durationSec: 4, inSec: 1, reverse: true })])],
      }),
    );
    // window [1, 5] reversed: t=0 → 5, t=1 → 4, t=3.5 → 1.5
    for (const [t, src] of [
      [0.05, 4.95],
      [1, 4],
      [2.5, 2.5],
      [3.5, 1.5],
    ] as const) {
      await seek(s, t);
      await waitForSquareAt(s, xFromTime(src), 0.04);
    }
    await s.close();
  });

  test('freeze frame holds one source frame for the whole item', async () => {
    const s = await open();
    await load(
      s,
      makeProject({
        tracks: [videoTrack([videoItem({ durationSec: 4, freezeAtSec: 2.5, speed: 3 })])],
      }),
    );
    for (const t of [0.1, 1.5, 3.8]) {
      await seek(s, t);
      await waitForSquareAt(s, xFromTime(2.5));
    }
    await s.close();
  });

  test('a speed ramp (0.5× → 2×) shows the integrated source time', async () => {
    const s = await open();
    await load(
      s,
      makeProject({
        tracks: [
          videoTrack([
            videoItem({
              durationSec: 4,
              speedCurve: [
                { t: 0, v: 0.5, ease: 'linear' },
                { t: 4, v: 2, ease: 'linear' },
              ],
            }),
          ]),
        ],
      }),
    );
    // source(t) = 0.5 t + 0.1875 t²
    for (const t of [1, 2, 3.5]) {
      await seek(s, t);
      await waitForSquareAt(s, xFromTime(0.5 * t + 0.1875 * t * t), 0.04);
    }
    await s.close();
  });

  test('playing: the playhead keeps wall-clock time, the picture follows it, then stops at the end', async () => {
    const s = await open();
    await load(s, makeProject({ tracks: [videoTrack([videoItem({ durationSec: 3 })])] }));
    await seek(s, 0);
    await waitForSquareAt(s, xFromTime(0));
    await play(s);
    const samples = await s.page.evaluate(
      () =>
        new Promise<{ t: number; x: number | null; wall: number }[]>((resolve) => {
          const out: { t: number; x: number | null; wall: number }[] = [];
          const t0 = performance.now();
          const tick = () => {
            const st = window.__t.store.getState();
            const b = window.__t.whiteBlob();
            out.push({
              t: st.playheadSec,
              x: b ? b.cx : null,
              wall: (performance.now() - t0) / 1000,
            });
            if (performance.now() - t0 < 2200) setTimeout(tick, 80);
            else resolve(out);
          };
          tick();
        }),
    );
    // playhead ≈ wall time (± 0.25 s, includes the start latency)
    const mid = samples.find((x) => x.wall > 1.2)!;
    expect(Math.abs(mid.t - mid.wall)).toBeLessThan(0.35);
    // the picture is the frame of (about) the playhead
    const errs = samples
      .filter((x) => x.x !== null && x.t > 0.2 && x.t < 2.8)
      .map((x) => (Math.abs(x.x! - xFromTime(x.t)) * 320) / 45);
    expect(errs.length).toBeGreaterThan(10);
    errs.sort((a, b) => a - b);
    expect(errs[Math.floor(errs.length * 0.8)]).toBeLessThan(0.3); // 80th percentile within 0.3 s of the playhead
    // reached the end → paused at 3 s
    await expect.poll(() => s.page.evaluate(() => window.__t.store.getState().playing)).toBe(false);
    expect(await playhead(s)).toBeCloseTo(3, 0);
    await s.close();
  });

  test('performance: frame rate, per-frame cost and main-thread CPU while playing (1 layer and a 3-layer project)', async () => {
    const layers = {
      '1 layer': [videoTrack([videoItem({ durationSec: 6 })])],
      '3 layers + music': [
        videoTrack([videoItem({ durationSec: 6 })]),
        track('overlay', [
          videoItem({
            id: 'pip',
            startSec: 0,
            durationSec: 6,
            inSec: 1,
            transform: { scale: { v: 0.4, kf: [] }, x: { v: 250, kf: [] }, y: { v: -500, kf: [] } },
          }),
          textItem({ id: 'cap', durationSec: 6 }),
        ]),
        track('audio', [audioItem()], { ducking: { enabled: true } }),
      ],
    };
    for (const [name, tracks] of Object.entries(layers)) {
      const s = await open({ w: 360, h: 640 });
      await load(s, makeProject({ tracks }));
      await seek(s, 0);
      await waitForSquareAt(s, xFromTime(0));
      const cdp = await s.context.newCDPSession(s.page);
      await cdp.send('Performance.enable');
      const metric = async (n: string) =>
        (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === n)?.value ?? 0;
      await play(s);
      await s.page.waitForTimeout(600); // warm-up
      const task0 = await metric('TaskDuration');
      const t0 = Date.now();
      await s.page.waitForTimeout(3000);
      const cpu = ((await metric('TaskDuration')) - task0) / ((Date.now() - t0) / 1000);
      const st = await s.page.evaluate(() => window.__t.getEngine()?.debugState());
      await pause(s);
      const sec = st.render.sections as Record<string, number>;
      const ours = (sec.framesNeeded ?? 0) + (sec.pool ?? 0) + (sec.mixer ?? 0);
      console.log(
        `[playback perf: ${name}] fps≈${st.render.fps.toFixed(1)} p95Frame=${st.render.p95FrameMs.toFixed(1)}ms slow(>25ms)=${st.render.slowFrames} mainThreadCPU≈${(cpu * 100).toFixed(0)}% ` +
          `engine overhead=${ours.toFixed(2)}ms/frame (framesNeeded ${sec.framesNeeded?.toFixed(2)}, pool ${sec.pool?.toFixed(2)}, mixer ${sec.mixer?.toFixed(2)}) compositor=${sec.compositor?.toFixed(1)}ms/frame (software GL) clock=${st.clock.source}`,
      );
      // The engine itself must be negligible next to a frame budget; the compositor's cost is the renderer's (SwiftShader here).
      expect(ours).toBeLessThan(3);
      expect(st.render.fps).toBeGreaterThan(5);
      if (name !== '1 layer') await shot(s.page, 'playing-3-layers');
      await s.close();
    }
  });

  test('two items of the SAME asset visible at once get independent decoders (split screen)', async () => {
    const s = await open();
    const half = (y: number) => ({ scale: { v: 0.5, kf: [] }, y: { v: y, kf: [] } });
    await load(
      s,
      makeProject({
        tracks: [
          videoTrack([videoItem({ id: 'top', inSec: 0, transform: half(-480) })]),
          track('overlay', [videoItem({ id: 'bottom', inSec: 3, transform: half(480) })]),
        ],
      }),
    );
    await seek(s, 1);
    await expect
      .poll(
        async () => {
          const [a, b] = await s.page.evaluate(() => [
            window.__t.whiteBlob({ x0: 0, y0: 0.05, x1: 1, y1: 0.45 }),
            window.__t.whiteBlob({ x0: 0, y0: 0.55, x1: 1, y1: 0.95 }),
          ]);
          if (!a || !b) return 9;
          return (
            Math.abs(a.cx - (0.25 + 0.5 * xFromTime(1))) +
            Math.abs(b.cx - (0.25 + 0.5 * xFromTime(4)))
          );
        },
        { timeout: 8000 },
      )
      .toBeLessThan(0.08);
    const slots = await s.page.evaluate(
      () =>
        window.__t
          .getEngine()
          ?.debugState()
          .pool.filter((p: any) => p.assetId === 'clip').length,
    );
    expect(slots).toBe(2);
    await shot(s.page, 'split-screen');
    // and while playing both stay in sync (each shows its own source time)
    await play(s);
    await s.page.waitForTimeout(900);
    const t = await playhead(s);
    const [a, b] = await s.page.evaluate(() => [
      window.__t.whiteBlob({ x0: 0, y0: 0.05, x1: 1, y1: 0.45 }),
      window.__t.whiteBlob({ x0: 0, y0: 0.55, x1: 1, y1: 0.95 }),
    ]);
    await pause(s);
    expect(Math.abs(a!.cx - (0.25 + 0.5 * xFromTime(t)))).toBeLessThan(0.06);
    expect(Math.abs(b!.cx - (0.25 + 0.5 * xFromTime(t + 3)))).toBeLessThan(0.06);
    await s.close();
  });

  test('hard cuts between two parts of one source: the next picture is ready on the first frame', async () => {
    const s = await open();
    await load(
      s,
      makeProject({
        tracks: [
          videoTrack([
            videoItem({ id: 'a', startSec: 0, durationSec: 1.5, inSec: 0 }),
            videoItem({ id: 'b', startSec: 1.5, durationSec: 1.5, inSec: 4 }),
          ]),
        ],
      }),
    );
    await seek(s, 1.2);
    await waitForSquareAt(s, xFromTime(1.2));
    await play(s);
    const seen = await s.page.evaluate(
      () =>
        new Promise<{ t: number; x: number | null }[]>((resolve) => {
          const out: { t: number; x: number | null }[] = [];
          const t0 = performance.now();
          const tick = () => {
            const b = window.__t.whiteBlob();
            out.push({ t: window.__t.store.getState().playheadSec, x: b ? b.cx : null });
            if (performance.now() - t0 < 900) requestAnimationFrame(tick);
            else resolve(out);
          };
          tick();
        }),
    );
    await pause(s);
    // after the cut (t ≥ 1.6) the square belongs to the second part: source = 4 + (t − 1.5)
    const after = seen.filter((x) => x.t > 1.6 && x.x !== null);
    expect(after.length).toBeGreaterThan(3);
    for (const a of after) expect(Math.abs(a.x! - xFromTime(4 + (a.t - 1.5)))).toBeLessThan(0.12);
    const wrong = seen.filter(
      (x) => x.t > 1.6 && x.x !== null && Math.abs(x.x - xFromTime(x.t - 1.5 + 4)) > 0.12,
    );
    expect(wrong).toEqual([]);
    await s.close();
  });

  test('reverse shuttle (J) plays backwards: the playhead and the picture run back together', async () => {
    const s = await open();
    await load(s, makeProject({ tracks: [videoTrack([videoItem()])] }));
    await seek(s, 5);
    await waitForSquareAt(s, xFromTime(5));
    await s.page.evaluate(() => window.__t.store.getState().shuttle('J'));
    await s.page.waitForTimeout(1200);
    const t = await playhead(s);
    expect(t).toBeLessThan(4.3);
    expect(t).toBeGreaterThan(2.5);
    await s.page.evaluate(() => window.__t.store.getState().shuttle('K'));
    await waitForSquareAt(s, xFromTime(await playhead(s)), 0.06);
    await s.close();
  });
});

/* ------------------------------------------------------------------------------------------------ audio */

const SPEECH_CUES = [
  {
    type: 'subtitle',
    id: 'c1',
    startSec: 1.0,
    durationSec: 1.2,
    words: [
      { w: 'one', s: 0, e: 0.5 },
      { w: 'two', s: 0.5, e: 1 },
    ],
  },
  {
    type: 'subtitle',
    id: 'c2',
    startSec: 3.4,
    durationSec: 1.2,
    words: [{ w: 'three', s: 0, e: 1 }],
  },
];

test.describe('audio graph', () => {
  const duckingProject = () =>
    makeProject({
      tracks: [
        videoTrack([videoItem({ durationSec: 6 })]),
        track('subtitle', SPEECH_CUES),
        track('audio', [audioItem({ durationSec: 8, volume: { v: 0.8, kf: [] } })], {
          id: 'music',
          gain: 0.9,
          ducking: { enabled: true, reductionDb: 12, attackSec: 0.2, releaseSec: 0.5 },
        }),
      ],
    });

  test('video + music voices are created with the right gains; sound reaches the master (limiter) output', async () => {
    const s = await open();
    await load(s, duckingProject());
    await seek(s, 0.1);
    await play(s);
    await s.page.waitForTimeout(700);
    const g = await graph(s);
    expect(g).not.toBeNull();
    expect(g!.state).toBe('running');
    expect(g!.master.limiter.ratio).toBeGreaterThanOrEqual(10);
    expect(g!.voices.map((v: any) => v.itemId).sort()).toEqual(['m1', 'v1']);
    for (const v of g!.voices) {
      expect(v.kind).toBe('element');
      expect(v.state).toBe('playing');
      expect(v.paused).toBe(false);
      expect(v.effectiveGain).toBeCloseTo(v.expectedGain, 1);
    }
    const music = g!.voices.find((v: any) => v.itemId === 'm1');
    expect(music.expectedItemGain).toBeCloseTo(0.8, 2);
    expect(music.expectedGain).toBeCloseTo(0.8 * 0.9, 2);
    // real audio is flowing through the graph (tone ≈ 0.3–0.9 peak after gains and the limiter)
    const peaks: number[] = [];
    for (let i = 0; i < 6; i++) {
      peaks.push((await graph(s))!.master.peak);
      await s.page.waitForTimeout(60);
    }
    expect(Math.max(...peaks)).toBeGreaterThan(0.05);
    expect(Math.max(...peaks)).toBeLessThanOrEqual(1);
    await pause(s);
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('ducking: the music track dips ~12 dB under speech and recovers, matching duckGainAt', async () => {
    const s = await open();
    await load(s, duckingProject());
    await seek(s, 0.2);
    await play(s);
    const trace = await s.page.evaluate(
      () =>
        new Promise<{ t: number; duck: number; expected: number }[]>((resolve) => {
          const out: { t: number; duck: number; expected: number }[] = [];
          const t0 = performance.now();
          const tick = () => {
            const eng = window.__t.getEngine()!;
            const g = eng.debugAudioGraph();
            const tr = g?.tracks.find((x: any) => x.trackId === 'music');
            if (tr)
              out.push({
                t: window.__t.store.getState().playheadSec,
                duck: tr.duck,
                expected: tr.expectedDuck,
              });
            if (performance.now() - t0 < 4300) setTimeout(tick, 40);
            else resolve(out);
          };
          tick();
        }),
    );
    await pause(s);
    expect(trace.length).toBeGreaterThan(20);
    // `t` is the playhead of the last frame, the gain is read live: keep a frame (≤ 120 ms under software GL) of margin
    const inSpeech = trace.filter((x) => x.t > 1.3 && x.t < 1.9);
    const outside = trace.filter((x) => x.t > 0.2 && x.t < 0.55);
    const lin = Math.pow(10, -12 / 20);
    expect(inSpeech.length).toBeGreaterThan(3);
    for (const x of inSpeech) expect(x.duck).toBeCloseTo(lin, 1);
    for (const x of outside) expect(x.duck).toBeCloseTo(1, 1);
    // recovery after the first line, then the second dip
    const after = trace.filter((x) => x.t > 2.8 && x.t < 3.1);
    for (const x of after) expect(x.duck).toBeGreaterThan(0.9);
    const second = trace.filter((x) => x.t > 3.7 && x.t < 4.2);
    for (const x of second) expect(x.duck).toBeCloseTo(lin, 1);
    // the automation the browser actually ran equals the pure maths everywhere
    const worst = Math.max(...trace.map((x) => Math.abs(x.duck - x.expected)));
    expect(worst).toBeLessThan(0.06);
    await s.close();
  });

  test('speed and pitch: the element plays at the item speed with preservesPitch following the item flag', async () => {
    const s = await open();
    await load(
      s,
      makeProject({
        tracks: [
          videoTrack([videoItem({ id: 'fast', durationSec: 3, speed: 2, preservePitch: false })]),
          track('audio', [
            audioItem({ id: 'slow', durationSec: 6, speed: 0.5, preservePitch: true }),
          ]),
        ],
      }),
    );
    await seek(s, 0.1);
    await play(s);
    await s.page.waitForTimeout(500);
    const g = await graph(s);
    const fast = g!.voices.find((v: any) => v.itemId === 'fast');
    const slow = g!.voices.find((v: any) => v.itemId === 'slow');
    expect(fast.kind).toBe('element');
    expect(Math.abs(fast.playbackRate - 2)).toBeLessThan(0.15); // ± the ≤ 5 % drift nudge
    expect(fast.preservesPitch).toBe(false);
    expect(slow.kind).toBe('element');
    expect(Math.abs(slow.playbackRate - 0.5)).toBeLessThan(0.05);
    expect(slow.preservesPitch).toBe(true);
    // the audio elements stay on the timeline (drift correction): source time ≈ expected
    expect(Math.abs(fast.srcTime - fast.expectedSrcTime)).toBeLessThan(0.3);
    await pause(s);
    await s.close();
  });

  test('transport 2× doubles the element rate; shuttle beyond 2× and reverse are silent', async () => {
    const s = await open();
    await load(s, makeProject({ tracks: [videoTrack([videoItem({ durationSec: 6 })])] }));
    await seek(s, 0.1);
    await s.page.evaluate(() => window.__t.store.getState().shuttle('L'));
    await s.page.evaluate(() => window.__t.store.getState().shuttle('L'));
    await s.page.waitForTimeout(500);
    let g = await graph(s);
    expect(g!.anchor.rate).toBe(2);
    expect(g!.voices[0].playbackRate).toBeCloseTo(2, 1);
    await s.page.evaluate(() => window.__t.store.getState().shuttle('L')); // 4×
    await s.page.waitForTimeout(300);
    g = await graph(s);
    expect(g!.voices).toHaveLength(0);
    await pause(s);
    await s.close();
  });

  test('track mute and gain, hidden video tracks and audioEnabled=false', async () => {
    const s = await open();
    await load(
      s,
      makeProject({
        tracks: [
          videoTrack([videoItem({ id: 'withSound', durationSec: 6 })], { id: 'vt' }),
          track('overlay', [
            videoItem({ id: 'silentPip', assetId: 'mute', durationSec: 3 }),
            videoItem({ id: 'off', audioEnabled: false, startSec: 3, durationSec: 3 }),
          ]),
          track('audio', [audioItem()], { id: 'music', gain: 0.5 }),
        ],
      }),
    );
    await seek(s, 0.1);
    await play(s);
    await s.page.waitForTimeout(500);
    let g = await graph(s);
    expect(g!.voices.map((v: any) => v.itemId).sort()).toEqual(['m1', 'withSound']);
    expect(g!.tracks.find((t: any) => t.trackId === 'music').level).toBeCloseTo(0.5, 2);
    await s.page.evaluate(() => window.__t.store.getState().updateTrack('music', { muted: true }));
    await s.page.waitForTimeout(250);
    g = await graph(s);
    expect(g!.voices.map((v: any) => v.itemId)).toEqual(['withSound']);
    expect(g!.tracks.find((t: any) => t.trackId === 'music').level).toBe(0);
    await s.page.evaluate(() => window.__t.store.getState().updateTrack('vt', { hidden: true }));
    await s.page.waitForTimeout(250);
    g = await graph(s);
    expect(g!.voices).toHaveLength(0);
    await pause(s);
    await s.close();
  });

  test('item volume keyframes and fades drive the voice gain', async () => {
    const s = await open();
    await load(
      s,
      makeProject({
        tracks: [
          track(
            'audio',
            [
              audioItem({
                durationSec: 8,
                fadeInSec: 1.5,
                volume: {
                  v: 1,
                  kf: [
                    { t: 0, v: 1, ease: 'linear' },
                    { t: 3, v: 0.4, ease: 'linear' },
                  ],
                },
              }),
            ],
            { id: 'music' },
          ),
        ],
      }),
    );
    await seek(s, 0);
    await play(s);
    const trace = await s.page.evaluate(
      () =>
        new Promise<{ t: number; g: number; e: number }[]>((resolve) => {
          const out: { t: number; g: number; e: number }[] = [];
          const t0 = performance.now();
          const tick = () => {
            const v = window.__t.getEngine()!.debugAudioGraph()?.voices[0];
            if (v)
              out.push({
                t: window.__t.store.getState().playheadSec,
                g: v.gain,
                e: v.expectedItemGain,
              });
            if (performance.now() - t0 < 3200) setTimeout(tick, 50);
            else resolve(out);
          };
          tick();
        }),
    );
    await pause(s);
    expect(trace.length).toBeGreaterThan(30);
    const early = trace.find((x) => x.t > 0.5 && x.t < 0.9)!;
    expect(early.g).toBeCloseTo(early.e, 1);
    expect(early.g).toBeLessThan(0.55);
    const late = trace.filter((x) => x.t > 2.5).at(-1)!;
    expect(late.g).toBeCloseTo(late.e, 1);
    console.log(
      '[volume trace]',
      JSON.stringify(
        trace.map((x) => [+x.t.toFixed(2), +x.g.toFixed(2), +x.e.toFixed(2)]).slice(0, 12),
      ),
    );
    expect(Math.max(...trace.map((x) => Math.abs(x.g - x.e)))).toBeLessThan(0.1);
    await s.close();
  });

  test('only items inside the lookahead window get voices', async () => {
    const s = await open();
    await load(
      s,
      makeProject({
        tracks: [
          track('audio', [
            audioItem({ id: 'now', durationSec: 4 }),
            audioItem({ id: 'later', startSec: 20, durationSec: 4 }),
          ]),
        ],
      }),
    );
    await seek(s, 0.1);
    await play(s);
    await s.page.waitForTimeout(400);
    const g = await graph(s);
    expect(g!.voices.map((v: any) => v.itemId)).toEqual(['now']);
    await pause(s);
    await s.close();
  });

  test('reverse audio plays a decoded, time-reversed buffer (no <audio> element for it)', async () => {
    const s = await open();
    await load(
      s,
      makeProject({
        tracks: [
          track('audio', [audioItem({ id: 'rev', durationSec: 4, inSec: 1, reverse: true })], {
            id: 'music',
          }),
        ],
      }),
    );
    await seek(s, 0);
    await play(s);
    await expect
      .poll(
        async () => {
          const g = await graph(s);
          return g?.voices.find((v: any) => v.itemId === 'rev')?.state ?? 'none';
        },
        { timeout: 8000 },
      )
      .toBe('playing');
    const g = await graph(s);
    const v = g!.voices.find((x: any) => x.itemId === 'rev');
    expect(v.kind).toBe('buffer');
    expect(v.paused).toBeNull();
    expect(g!.buffers.reversed).toBe(1);
    await expect
      .poll(async () => (await graph(s))!.master.peak, { timeout: 4000 })
      .toBeGreaterThan(0.02);
    await pause(s);
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('audio scrub plays 80 ms grains while the playhead is dragged', async () => {
    const s = await open();
    await load(s, makeProject({ tracks: [track('audio', [audioItem({ durationSec: 8 })])] }));
    await s.page.evaluate(() => window.__t.getEngine()!.resumeAudio());
    await s.page.evaluate(() => window.__t.getEngine()!.scrub(1)); // kicks the decode
    await s.page.waitForTimeout(500);
    const before = (await graph(s))!.grains;
    for (let i = 0; i < 6; i++) {
      await s.page.evaluate((t) => window.__t.getEngine()!.scrub(t), 1 + i * 0.1);
      await s.page.waitForTimeout(60);
    }
    const after = (await graph(s))!.grains;
    expect(after - before).toBeGreaterThanOrEqual(5);
    expect((await graph(s))!.buffers.assets).toBe(1);
    await s.close();
  });

  test('pausing silences everything', async () => {
    const s = await open();
    await load(s, duckingProject());
    await play(s);
    await s.page.waitForTimeout(500);
    expect((await graph(s))!.voices.length).toBeGreaterThan(0);
    await pause(s);
    await s.page.waitForTimeout(250);
    const g = await graph(s);
    expect(g!.voices).toHaveLength(0);
    await s.close();
  });
});

/* ------------------------------------------------------------------------------------------------ panel */

const overlayProject = () =>
  makeProject({
    tracks: [
      videoTrack([videoItem({ durationSec: 6 })], { id: 'vt' }),
      track(
        'overlay',
        [
          textItem({ id: 'title', text: 'Hello', durationSec: 6 }),
          // a picture-in-picture image in the upper right
          {
            type: 'image',
            id: 'logo',
            assetId: 'pic',
            startSec: 0,
            durationSec: 6,
            transform: {
              x: { v: 300, kf: [] },
              y: { v: -600, kf: [] },
              scale: { v: 0.25, kf: [] },
            },
          },
        ],
        { id: 'ot' },
      ),
    ],
  });

/** CSS px → page coords for a point given in preview-stage fractions. */
async function at(s: Session, fx: number, fy: number) {
  const b = await stageBox(s);
  return { x: b.x + fx * b.width, y: b.y + fy * b.height };
}
const selection = (s: Session) =>
  s.page.evaluate(() => window.__t.store.getState().selection.itemIds as string[]);
const tf = (s: Session, id: string) =>
  s.page.evaluate((i) => {
    for (const tr of window.__t.store.getState().project.tracks) {
      const it = tr.items.find((x: { id: string }) => x.id === i);
      if (it)
        return {
          x: it.transform.x.v,
          y: it.transform.y.v,
          scale: it.transform.scale.v,
          rotation: it.transform.rotation.v,
        };
    }
    return null;
  }, id);

test.describe('panel overlays and interaction', () => {
  test('safe-area guides and the rule-of-thirds grid render from the store flags', async () => {
    const s = await open();
    await load(s, overlayProject());
    await seek(s, 1);
    await waitForSquareAt(s, xFromTime(1));
    await expect(s.page.getByTestId('safe-area-guides')).toHaveCount(0);
    await expect(s.page.getByTestId('grid-guides')).toHaveCount(0);
    await s.page.evaluate(() => window.__t.store.getState().setSafeArea('tiktok'));
    await s.page.evaluate(() => window.__t.store.getState().toggleGrid());
    const guides = s.page.getByTestId('safe-area-guides');
    await expect(guides).toBeVisible();
    await expect(guides).toHaveAttribute('data-safe-area', 'tiktok');
    await expect(guides).toContainText('TikTok safe area');
    await expect(s.page.getByTestId('grid-guides')).toBeVisible();
    // the dashed rectangle is the TikTok safe rect: 5 % left, 10 % top, 14 % right, 20 % bottom
    const box = await stageBox(s);
    const rect = await guides.locator('rect').boundingBox();
    expect(rect!.x - box.x).toBeCloseTo(0.05 * box.width, 0);
    expect(rect!.y - box.y).toBeCloseTo(0.1 * box.height, 0);
    expect(rect!.width).toBeCloseTo(box.width * (1 - 0.05 - 0.14), 0);
    expect(rect!.height).toBeCloseTo(box.height * (1 - 0.1 - 0.2), 0);
    await shot(s.page, 'safe-area-grid');
    await s.page.evaluate(() => window.__t.store.getState().setSafeArea('reels'));
    await expect(s.page.getByTestId('safe-area-guides')).toHaveAttribute('data-safe-area', 'reels');
    await s.page.evaluate(() => window.__t.store.getState().setSafeArea(null));
    await expect(s.page.getByTestId('safe-area-guides')).toHaveCount(0);
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('click selects the topmost item (hit test); clicking empty space is impossible with a full-bleed video, so it selects the video', async () => {
    const s = await open();
    await load(s, overlayProject());
    await seek(s, 1);
    await waitForSquareAt(s, xFromTime(1));
    const centre = await at(s, 0.5, 0.5);
    await s.page.mouse.click(centre.x, centre.y);
    expect(await selection(s)).toEqual(['title']);
    await expect(s.page.getByTestId('transform-handles')).toHaveCount(1);
    await expect(s.page.getByTestId('handle-scale-nw')).toBeVisible();
    await expect(s.page.getByTestId('handle-rotate')).toBeVisible();
    // the logo in the upper right
    const logo = await at(s, 0.5 + 300 / 1080, 0.5 - 600 / 1920);
    await s.page.mouse.click(logo.x, logo.y);
    expect(await selection(s)).toEqual(['logo']);
    // the lower left is only the video
    const low = await at(s, 0.15, 0.9);
    await s.page.mouse.click(low.x, low.y);
    expect(await selection(s)).toEqual(['v1']);
    await shot(s.page, 'selected-video');
    // shift-click adds / removes from the selection, no handles for multi-select (outlines only)
    const c2 = await at(s, 0.5, 0.5);
    await s.page.keyboard.down('Shift');
    await s.page.mouse.click(c2.x, c2.y);
    await s.page.keyboard.up('Shift');
    expect((await selection(s)).sort()).toEqual(['title', 'v1']);
    await expect(s.page.getByTestId('handle-scale-nw')).toHaveCount(0);
    await expect(s.page.getByTestId('transform-handles')).toHaveCount(2);
    await s.close();
  });

  test('dragging the body moves the item live and the whole drag is ONE undo step', async () => {
    const s = await open();
    await load(s, overlayProject());
    await seek(s, 1);
    await waitForSquareAt(s, xFromTime(1));
    const start = await at(s, 0.5, 0.5);
    await s.page.mouse.click(start.x, start.y);
    expect(await selection(s)).toEqual(['title']);
    const stack0 = await s.page.evaluate(() => ({
      canUndo: window.__t.store.getState().canUndo,
      label: window.__t.store.getState().undoLabel,
    }));
    const box = await stageBox(s);
    const k = 1080 / box.width; // canvas px per css px
    await s.page.mouse.move(start.x, start.y);
    await s.page.mouse.down();
    for (let i = 1; i <= 12; i++) {
      await s.page.mouse.move(start.x + 5 * i, start.y + 4 * i);
      if (i === 6) await s.page.waitForTimeout(80);
    }
    // live preview while the pointer is still down
    const mid = (await tf(s, 'title'))!;
    expect(mid.x).toBeGreaterThan(40 * k * 0.8);
    await s.page.mouse.up();
    const end = (await tf(s, 'title'))!;
    expect(end.x).toBeCloseTo(60 * k, -1);
    expect(end.y).toBeCloseTo(48 * k, -1);
    // one undo step brings it back exactly
    await s.page.evaluate(() => window.__t.store.getState().undo());
    expect(await tf(s, 'title')).toMatchObject({ x: 0, y: 0, scale: 1, rotation: 0 });
    const afterUndo = await s.page.evaluate(() => ({
      canUndo: window.__t.store.getState().canUndo,
      label: window.__t.store.getState().undoLabel,
    }));
    expect(afterUndo).toEqual(stack0);
    await s.page.evaluate(() => window.__t.store.getState().redo());
    expect((await tf(s, 'title'))!.x).toBeCloseTo(end.x, 6);
    await shot(s.page, 'after-drag');
    await s.close();
  });

  test('a click without movement does not edit anything (no undo step)', async () => {
    const s = await open();
    await load(s, overlayProject());
    await seek(s, 1);
    const c = await at(s, 0.5, 0.5);
    await s.page.mouse.click(c.x, c.y);
    await s.page.mouse.move(c.x, c.y);
    await s.page.mouse.down();
    await s.page.mouse.move(c.x + 1, c.y + 1);
    await s.page.mouse.up();
    expect(await s.page.evaluate(() => window.__t.store.getState().canUndo)).toBe(false);
    await s.close();
  });

  test('the corner handle scales, the rotation handle rotates (shift snaps to 15°), each as one undo step', async () => {
    const s = await open();
    await load(s, overlayProject());
    await seek(s, 1);
    const c = await at(s, 0.5, 0.5);
    await s.page.mouse.click(c.x, c.y);
    const se = await s.page.getByTestId('handle-scale-se').boundingBox();
    const sx = se!.x + se!.width / 2;
    const sy = se!.y + se!.height / 2;
    await s.page.mouse.move(sx, sy);
    await s.page.mouse.down();
    await s.page.mouse.move(sx + 25, sy + 25, { steps: 5 });
    await s.page.mouse.move(sx + 50, sy + 50, { steps: 5 });
    await s.page.mouse.up();
    const scaled = (await tf(s, 'title'))!;
    expect(scaled.scale).toBeGreaterThan(1.2);
    expect(scaled.x).toBeCloseTo(0, 3); // scaled about the centre
    await s.page.evaluate(() => window.__t.store.getState().undo());
    expect((await tf(s, 'title'))!.scale).toBe(1);
    await s.page.evaluate(() => window.__t.store.getState().redo());

    const rot = await s.page.getByTestId('handle-rotate').boundingBox();
    const rx = rot!.x + rot!.width / 2;
    const ry = rot!.y + rot!.height / 2;
    const cx = c.x;
    const cy = c.y;
    // sweep the handle ~40° clockwise around the centre
    const r = Math.hypot(rx - cx, ry - cy);
    const a0 = Math.atan2(ry - cy, rx - cx);
    await s.page.mouse.move(rx, ry);
    await s.page.mouse.down();
    await s.page.keyboard.down('Shift');
    for (let i = 1; i <= 8; i++) {
      const a = a0 + (i * 5 * Math.PI) / 180;
      await s.page.mouse.move(cx + r * Math.cos(a), cy + r * Math.sin(a));
    }
    await s.page.mouse.up();
    await s.page.keyboard.up('Shift');
    const rotated = (await tf(s, 'title'))!;
    expect(rotated.rotation % 15).toBeCloseTo(0, 5);
    expect(Math.abs(rotated.rotation)).toBeGreaterThan(30);
    await shot(s.page, 'rotated-scaled');
    await s.page.evaluate(() => window.__t.store.getState().undo());
    expect((await tf(s, 'title'))!.rotation).toBe(0);
    expect((await tf(s, 'title'))!.scale).toBeCloseTo(scaled.scale, 6); // only the rotation was undone
    await s.close();
  });

  test('snapping: dragging near the canvas centre snaps and draws a guide line', async () => {
    const s = await open();
    await load(s, overlayProject());
    await seek(s, 1);
    const c = await at(s, 0.5, 0.5);
    await s.page.mouse.click(c.x, c.y);
    await s.page.mouse.move(c.x, c.y);
    await s.page.mouse.down();
    await s.page.mouse.move(c.x + 60, c.y + 60, { steps: 4 });
    await s.page.mouse.move(c.x + 3, c.y + 3, { steps: 4 }); // within the 8 px snap radius of both centre lines
    await expect(s.page.getByTestId('snap-guide').first()).toBeVisible();
    await s.page.mouse.up();
    const t = (await tf(s, 'title'))!;
    expect(t.x).toBeCloseTo(0, 6);
    expect(t.y).toBeCloseTo(0, 6);
    await expect(s.page.getByTestId('snap-guide')).toHaveCount(0);
    await s.close();
  });

  test('double-click edits a text item inline: Enter commits (one undo step), Escape cancels', async () => {
    const s = await open();
    await load(s, overlayProject());
    await seek(s, 1);
    const c = await at(s, 0.5, 0.5);
    await s.page.mouse.dblclick(c.x, c.y);
    const ta = s.page.getByTestId('preview-text-editor');
    await expect(ta).toBeVisible();
    await expect(ta).toBeFocused();
    await expect(ta).toHaveValue('Hello');
    await shot(s.page, 'inline-text-edit');
    await ta.fill('World');
    // typing never triggers transport shortcuts
    await ta.press('Space');
    expect(await s.page.evaluate(() => window.__t.store.getState().playing)).toBe(false);
    await ta.fill('World');
    await ta.press('Enter');
    await expect(ta).toHaveCount(0);
    expect((await item(s, 'title'))!.text).toBe('World');
    await s.page.evaluate(() => window.__t.store.getState().undo());
    expect((await item(s, 'title'))!.text).toBe('Hello');
    // Escape cancels
    await s.page.mouse.dblclick(c.x, c.y);
    await s.page.getByTestId('preview-text-editor').fill('Nope');
    await s.page.keyboard.press('Escape');
    await expect(s.page.getByTestId('preview-text-editor')).toHaveCount(0);
    expect((await item(s, 'title'))!.text).toBe('Hello');
    // double-click on a non-text item does nothing
    const low = await at(s, 0.15, 0.9);
    await s.page.mouse.dblclick(low.x, low.y);
    await expect(s.page.getByTestId('preview-text-editor')).toHaveCount(0);
    await s.close();
  });

  test('keyboard focus: shortcuts typed in the preview reach the store, once', async () => {
    const s = await open();
    await load(s, overlayProject());
    await seek(s, 1);
    // a global listener like the shell's must not see a shortcut the preview already handled
    await s.page.evaluate(() => {
      (window as unknown as { __seen: string[] }).__seen = [];
      window.addEventListener('keydown', (e) =>
        (window as unknown as { __seen: string[] }).__seen.push(`${e.key}:${e.defaultPrevented}`),
      );
    });
    const c = await at(s, 0.5, 0.5);
    await s.page.mouse.click(c.x, c.y);
    await expect(s.page.getByTestId('preview-root')).toBeFocused();
    await s.page.keyboard.press('ArrowRight');
    expect(await playhead(s)).toBeCloseTo(1 + 1 / 30, 3);
    await s.page.keyboard.press('Shift+ArrowRight');
    expect(await playhead(s)).toBeCloseTo(1 + 11 / 30, 3);
    await s.page.keyboard.press('Space');
    expect(await s.page.evaluate(() => window.__t.store.getState().playing)).toBe(true);
    await s.page.keyboard.press('Space');
    expect(await s.page.evaluate(() => window.__t.store.getState().playing)).toBe(false);
    // unhandled keys still bubble to the global listener
    await s.page.keyboard.press('q');
    const seen = await s.page.evaluate(() => (window as unknown as { __seen: string[] }).__seen);
    expect(seen).toContain('q:false');
    expect(seen.filter((x) => x.startsWith(' ')).length).toBe(0); // Space never reached window: handled & stopped
    await s.close();
  });

  test('timecode (mm:ss:ff) and the resolution badge', async () => {
    const s = await open();
    await load(s, makeProject({ tracks: [videoTrack([videoItem()])], canvas: { fps: 24 } }));
    await seek(s, 62.5);
    await expect(s.page.getByTestId('preview-timecode')).toHaveText('01:02:12');
    await expect(s.page.getByTestId('preview-resolution')).toHaveText('1080×1920');
    await s.close();
  });

  test('the canvas keeps the project aspect, is letterboxed, DPR-aware and follows container resizes', async () => {
    const s = await open({ w: 600, h: 500, dpr: 2, width: 1000, height: 800 });
    await load(s, makeProject({ tracks: [videoTrack([videoItem()])] }));
    await seek(s, 1);
    await waitForSquareAt(s, xFromTime(1));
    const info = () =>
      s.page.evaluate(() => {
        const c = document.querySelector('[data-testid="preview-canvas"]') as HTMLCanvasElement;
        const r = c.getBoundingClientRect();
        return { bw: c.width, bh: c.height, cw: r.width, ch: r.height, dpr: devicePixelRatio };
      });
    const a = await info();
    expect(a.cw / a.ch).toBeCloseTo(9 / 16, 2);
    expect(a.ch).toBeLessThanOrEqual(500 - 24);
    expect(a.dpr).toBe(2);
    expect(a.bw / a.bh).toBeCloseTo(9 / 16, 2);
    expect(a.bw).toBeGreaterThan(a.cw); // DPR-aware buffer…
    expect(Math.max(a.bw, a.bh)).toBeLessThanOrEqual(960); // …capped at proxy resolution
    await shot(s.page, 'letterbox-portrait');
    await s.page.evaluate(() => window.__t.resize(700, 300));
    await expect.poll(async () => (await info()).ch).toBeLessThanOrEqual(300 - 24);
    const b = await info();
    expect(b.cw / b.ch).toBeCloseTo(9 / 16, 2);
    await waitForSquareAt(s, xFromTime(1));
    await shot(s.page, 'letterbox-wide');
    // a landscape project fills the width instead
    await s.page.evaluate(() =>
      window.__t.store.getState().setCanvas({ aspect: '16:9', width: 1920, height: 1080 }),
    );
    await expect
      .poll(async () => {
        const i = await info();
        return i.cw / i.ch;
      })
      .toBeCloseTo(16 / 9, 1);
    await s.close();
  });

  test('light theme: tokens only (no hard-coded colours leak into the layout)', async () => {
    const s = await open({ theme: 'light' });
    await s.page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await load(s, overlayProject());
    await seek(s, 1);
    await s.page.evaluate(() => window.__t.store.getState().setSafeArea('shorts'));
    const c = await at(s, 0.5, 0.5);
    await s.page.mouse.click(c.x, c.y);
    await shot(s.page, 'light-theme');
    const bg = await s.page
      .getByTestId('preview-root')
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe('rgba(0, 0, 0, 0)');
    await s.close();
  });
});

/* ------------------------------------------------------------------------------------------------ states */

test.describe('loading and error states', () => {
  test('a missing proxy shows a clear error with the reason, a retry recovers', async () => {
    const s = await open({
      bridge: {
        previewUrls: {
          clip: { reason: 'this video has no 480p proxy' },
          tone: MEDIA.tone,
          pic: MEDIA.pic,
          mute: MEDIA.mute,
        },
      },
    });
    await load(s, makeProject({ tracks: [videoTrack([videoItem()])] }));
    const err = s.page.getByTestId('preview-error');
    await expect(err).toBeVisible();
    await expect(err).toContainText('Preview unavailable: this video has no 480p proxy');
    await shot(s.page, 'error-no-proxy');
    const before = s.calls.filter((c) => c.channel === 'editor:previewUrl').length;
    s.bridge.previewUrls.clip = MEDIA.clip; // the proxy appeared
    await s.page.getByTestId('preview-retry').click();
    await expect(err).toHaveCount(0);
    expect(s.calls.filter((c) => c.channel === 'editor:previewUrl').length).toBeGreaterThan(before);
    await waitForSquareAt(s, xFromTime(0));
    await s.close();
  });

  test('assets that are not on screen do not block the picture; unavailable audio shows a small warning', async () => {
    const s = await open({
      bridge: {
        previewUrls: {
          clip: MEDIA.clip,
          tone: { reason: 'the music file is gone' },
          pic: MEDIA.pic,
          mute: MEDIA.mute,
        },
      },
    });
    await load(
      s,
      makeProject({ tracks: [videoTrack([videoItem()]), track('audio', [audioItem()])] }),
    );
    await waitForSquareAt(s, xFromTime(0));
    await expect(s.page.getByTestId('preview-error')).toHaveCount(0);
    await expect(s.page.getByTestId('preview-audio-warning')).toContainText(
      'Audio unavailable: the music file is gone',
    );
    await s.close();
  });

  test('a loading skeleton shows while media loads and disappears when the picture is ready', async () => {
    const s = await open({ bridge: { previewDelayMs: 900 } });
    await load(s, makeProject({ tracks: [videoTrack([videoItem()])] }));
    await expect(s.page.getByTestId('preview-loading')).toBeVisible();
    await shot(s.page, 'loading');
    await expect(s.page.getByTestId('preview-loading')).toHaveCount(0, { timeout: 10_000 });
    await waitForSquareAt(s, xFromTime(0));
    await s.close();
  });

  test('a decode failure (media that is not a video) ends in the error state, not an endless spinner', async () => {
    const s = await open({
      bridge: {
        previewUrls: {
          clip: { file: 'pic.png' },
          tone: MEDIA.tone,
          pic: MEDIA.pic,
          mute: MEDIA.mute,
        },
      },
    });
    await load(s, makeProject({ tracks: [videoTrack([videoItem()])] }));
    await expect(s.page.getByTestId('preview-error')).toBeVisible({ timeout: 15_000 });
    await expect(s.page.getByTestId('preview-error')).toContainText('Preview unavailable');
    await s.close();
  });

  test('an unknown asset id is reported by the bridge reason', async () => {
    const s = await open({ bridge: { previewUrls: {} } });
    await load(s, makeProject({ tracks: [videoTrack([videoItem()])] }));
    await expect(s.page.getByTestId('preview-error')).toContainText(
      'Preview unavailable: unknown asset clip',
    );
    await s.close();
  });
});

/* ------------------------------------------------------------------------------------------------ lifecycle & caches */

test.describe('engine lifecycle and caches', () => {
  test('the panel creates the engine; unmount disposes it; remount works again', async () => {
    const s = await open();
    await load(s, makeProject({ tracks: [videoTrack([videoItem()])] }));
    await waitForSquareAt(s, xFromTime(0));
    expect(await s.page.evaluate(() => window.__t.getEngine() !== null)).toBe(true);
    expect(await s.page.evaluate(() => window.__t.getEngine()!.projectId)).toBe('proj1');
    await s.page.evaluate(() => window.__t.unmount());
    await expect.poll(() => s.page.evaluate(() => window.__t.getEngine())).toBeNull();
    await s.page.evaluate(() => window.__t.remount());
    await waitForSquareAt(s, xFromTime(0));
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('loading a project with a different id swaps the engine (and the media)', async () => {
    const s = await open();
    await load(s, makeProject({ tracks: [videoTrack([videoItem()])] }));
    await waitForSquareAt(s, xFromTime(0));
    await s.page.evaluate(
      (d) => window.__t.load(d),
      doc(makeProject({ tracks: [videoTrack([videoItem({ inSec: 2 })])] }), 'proj2'),
    );
    await expect.poll(() => s.page.evaluate(() => window.__t.getEngine()?.projectId)).toBe('proj2');
    await waitForSquareAt(s, xFromTime(2));
    const ids = s.calls
      .filter((c) => c.channel === 'editor:previewUrl')
      .map((c) => (c.payload as { projectId: string }).projectId);
    expect(ids).toContain('proj1');
    expect(ids).toContain('proj2');
    await s.close();
  });

  test('waveform and thumbnail caches fetch once, notify, and serve from cache', async () => {
    const s = await open();
    await load(
      s,
      makeProject({ tracks: [videoTrack([videoItem()]), track('audio', [audioItem()])] }),
    );
    await waitForSquareAt(s, xFromTime(0));
    const r = await s.page.evaluate(async () => {
      const eng = window.__t.getEngine()!;
      let changes = 0;
      const off = eng.onCacheChange(() => changes++);
      const first = eng.waveform('tone');
      const strip1 = eng.thumbStrip('clip', 0, 6, 4);
      await new Promise((r) => setTimeout(r, 400));
      const wave = eng.waveform('tone');
      const strip = eng.thumbStrip('clip', 0.02, 5.98, 4);
      off();
      return {
        first,
        strip1,
        wave: wave && { rate: wave.rate, n: wave.peaks.length },
        strip: strip && { cols: strip.cols, tileW: strip.tileW, n: strip.times.length },
        changes,
      };
    });
    expect(r.first).toBeNull();
    expect(r.strip1).toBeNull();
    expect(r.wave).toEqual({ rate: 25, n: 200 });
    expect(r.strip).toEqual({ cols: 4, tileW: 1, n: 4 });
    expect(r.changes).toBeGreaterThanOrEqual(2);
    // warm-up already fetched the waveform: only one call for the asset
    const waveCalls = s.calls.filter((c) => c.channel === 'editor:waveform');
    expect(waveCalls.length).toBe(1);
    await s.close();
  });

  test('media URLs are fetched once per asset and reused by video, audio and image consumers', async () => {
    const s = await open();
    await load(s, overlayProject());
    await seek(s, 1);
    await waitForSquareAt(s, xFromTime(1));
    const calls = s.calls
      .filter((c) => c.channel === 'editor:previewUrl')
      .map((c) => (c.payload as { assetId: string }).assetId);
    expect(new Set(calls).size).toBe(calls.length);
    await s.close();
  });
});
