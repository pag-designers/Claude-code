import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  captionStyleSchema,
  keys2,
  subtitleEditsSchema,
  type ChatEvent,
  type ClipHooks,
  type ClipMeta,
  type CaptionStyle,
} from '@shared/cp2';
import { keys, type Transcript } from '@shared/pipeline';
import { ChatService } from '@main/pipeline/chat';
import { Cp2Service, JOB_HIGHLIGHT, alignToWords } from '@main/pipeline/cp2';
import { JOB_RENDER, type PipelineOrchestrator } from '@main/pipeline/orchestrator';
import { StyleRegistry } from '@main/pipeline/styles';
import { toClipView, type ClipRow } from '@main/pipeline/views';
import type { LlmServiceV2 } from '@main/pipeline/contracts2';
import { MemoryStorageProvider } from '@main/services/storage/memory';
import { makeServices } from './helpers';

const STYLE = (id: string, builtin = true): CaptionStyle =>
  captionStyleSchema.parse({
    id,
    name: id,
    builtin,
    font: { family: 'Montserrat ExtraBold' },
    fill: '#FFFFFF',
    stroke: { color: '#000000' },
    shadow: { color: '#000000' },
    box: { color: '#000000' },
    highlight: { color: '#FFD60A', boxColor: '#FFD60A' },
    keywordColor: '#FFD60A',
    layout: {},
    chunking: {},
  });

const waitFor = async (fn: () => Promise<boolean>, ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timeout');
};

/** 10 minutes of fake speech: one 0.4 s word every 0.5 s, a sentence per 8 words. */
function transcript(): Transcript {
  const words = Array.from({ length: 1200 }, (_, i) => ({ w: `w${i}`, s: i * 0.5, e: i * 0.5 + 0.4 }));
  const sentences = Array.from({ length: 150 }, (_, i) => ({
    id: i,
    s: i * 4,
    e: i * 4 + 3.9,
    text: `Sentence number ${i}.`,
    speaker: null,
    wordStart: i * 8,
    wordEnd: i * 8 + 7,
  }));
  return { language: 'en', languageProbability: 1, durationSec: 600, model: 'fake', words, sentences };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function makeEnv() {
  const m = await makeServices();
  cleanups.push(m.cleanup);
  const db = m.svc.dbHandle.prisma;
  const storage = new MemoryStorageProvider();
  const tr = transcript();
  const calls = { rerender: [] as string[], queueRender: [] as string[], findMoments: [] as string[], emittedClips: [] as string[] };
  const orchestrator = {
    emitClip: async (id: string) => void calls.emittedClips.push(id),
    emitVideo: async () => {},
    loadTranscript: async () => tr,
    loadSignals: async () => ({
      hopSec: 0.5,
      durationSec: 600,
      loudness: [],
      speechRate: [],
      silences: [],
      laughter: [],
      speakerChanges: [],
      sceneCuts: [],
    }),
    loadAnalysis: async () => null,
    rerenderClip: async (id: string) => void calls.rerender.push(id),
    queueRender: async (_v: string, id: string) => void calls.queueRender.push(id),
    startMomentsRun: async (_v: string, prompt: string) => {
      calls.findMoments.push(prompt);
      return { runId: 'run1' };
    },
  } as unknown as PipelineOrchestrator;

  const hooks: Omit<ClipHooks, 'applied' | 'generatedAt'> = {
    tiktok: [0, 1, 2, 3, 4].map((i) => ({ text: `TT ${i}`, spoken: null, angle: 'curiosity' })),
    reels: [0, 1, 2, 3, 4].map((i) => ({ text: `IG ${i}`, spoken: null, angle: 'story' })),
    shorts: [0, 1, 2, 3, 4].map((i) => ({ text: `YT ${i}`, spoken: 'say this', angle: 'number' })),
  };
  const pm = (t: string) => ({ title: t, description: `${t} d`, hashtags: ['#a'], postingTime: { dayOfWeek: 2, hour: 18, reason: 'evening' } });
  const llmCalls = { hooks: 0, meta: 0, rank: 0, highlights: 0 };
  const llmState = { highlightSegments: [{ startSec: 100, endSec: 118, role: 'hook' }, { startSec: 30, endSec: 50, role: 'payoff' }], visionFails: false };
  const llm: LlmServiceV2 = {
    async composeHighlights() {
      llmCalls.highlights++;
      return { title: 'The reel', hook: 'Watch this', segments: llmState.highlightSegments, transition: 'crossfade', whyItWorks: 'story' };
    },
    async writeHooks() {
      llmCalls.hooks++;
      return hooks;
    },
    async writeMeta({ hook }) {
      llmCalls.meta++;
      return { tiktok: pm(`TT ${hook}`), reels: pm('IG'), shorts: pm('YT') } satisfies Omit<ClipMeta, 'generatedAt'>;
    },
    async rankThumbnails({ frames }) {
      llmCalls.rank++;
      if (llmState.visionFails) throw new Error('vision unavailable');
      return {
        ranking: frames.map((f) => ({ index: f.index, rank: frames.length - f.index, note: `n${f.index}` })),
        overlayText: 'WAIT FOR IT',
      };
    },
    async chat(input) {
      input.onDelta('Hello ');
      input.onCitation({ t: 12, label: 'intro' });
      input.onAction({ id: 'a1', tool: 'create_clip', input: {}, status: 'running', summary: null, href: null });
      const res = await input.executeTool('create_clip', { startSec: 60, endSec: 100, title: 'From chat' });
      input.onAction({ id: 'a1', tool: 'create_clip', input: {}, status: res.ok ? 'done' : 'failed', summary: res.summary, href: res.href ?? null });
      input.onDelta('world');
      return { text: 'Hello world', citations: [{ t: 12, label: 'intro' }] };
    },
  };

  const styles = new StyleRegistry(db, { builtinStyles: () => [STYLE('clean-pop'), STYLE('bold')] });
  const saved: { name: string; content: string }[] = [];
  const thumbState = { sampled: 0 };
  const cp2 = new Cp2Service({
    db,
    queue: m.svc.queue,
    orchestrator,
    styles,
    captions: {
      builtinStyles: () => [],
      buildAss: () => '',
      buildSrt: () => '',
      buildVtt: () => '',
      preview: async () => Buffer.from([137, 80, 78, 71]),
      fonts: () => [],
    },
    subtitles: {
      applyEdits: (w) => w.map((x, i) => ({ ...x, origIndex: i })),
      cues: (w, e) => [{ id: 0, s: w[0]?.s ?? 0, e: w[3]?.e ?? 1, text: `rev${e.rev}`, wordStart: 0, wordEnd: 3 }],
      editCueText: (_w, e) => e,
      splitCue: (_w, e) => e,
      mergeWithNext: (_w, e) => e,
      shiftCue: (_w, e) => e,
      toSrt: (cues, range) => `SRT ${cues.length} ${range ? `${range.startSec}-${range.endSec}` : 'all'}`,
      toVtt: () => 'WEBVTT',
    },
    thumbnails: {
      async sample({ outDir, count }) {
        thumbState.sampled++;
        return Array.from({ length: count }, (_, i) => {
          const file = path.join(outDir, `f${i}.jpg`);
          fs.writeFileSync(file, `jpg${i}`);
          return { t: i * 2 + 3, file };
        });
      },
      async score(frames) {
        return frames.map((f, i) => ({ ...f, sharpness: 0.5, face: 0.5, composition: 0.5, total: i / 10 }));
      },
      async compose(a) {
        fs.writeFileSync(a.outJpg, `composed:${a.overlayText ?? ''}:${fs.readFileSync(a.framePath, 'utf8')}`);
      },
    },
    moments: { generateCandidates: () => [], snap: ({ startSec, endSec }) => ({ startSec: startSec + 0.1, endSec: endSec - 0.1 }) },
    llm,
    frameScorer: async () => [],
    getStorage: () => storage,
    invalidateStorage: () => {},
    cacheDir: path.join(m.dir, 'cache'),
    ffmpegPath: () => 'ffmpeg',
    fontsDir: () => null,
    saveText: async (o, content) => {
      saved.push({ name: o.defaultName, content });
      return `/tmp/${o.defaultName}`;
    },
    emit: { markers: vi.fn() },
    log: () => {},
  });
  cp2.registerJobs();
  await m.svc.queue.start();

  await db.video.create({
    data: { id: 'v1', sourceUrl: 'u', title: 'Video One', status: 'ready', options: '{}', durationSec: 600, updatedAt: new Date() },
  });
  await db.clip.create({
    data: { id: 'c1', videoId: 'v1', title: 'Clip One', hook: 'Original hook', startSec: 20, endSec: 60, score: 80, status: 'rendered', storageKeys: JSON.stringify({ render: keys.clip('c1') }), metadata: '{}' },
  });
  await storage.put(keys.clip('c1'), 'mp4');
  fs.mkdirSync(path.join(m.dir, 'cache', 'v1'), { recursive: true });
  return { m, db, cp2, storage, calls, llmCalls, llmState, hooks, saved, thumbState, styles, llm, orchestrator };
}

describe('alignToWords', () => {
  const words = Array.from({ length: 60 }, (_, i) => ({ w: 'x', s: i * 0.5, e: i * 0.5 + 0.4 }));
  it('snaps to whole words with a little padding', () => {
    const r = alignToWords(words, 5.1, 14.9);
    expect(r.startSec).not.toBeNull();
    // first word with its midpoint inside = the one starting at 5.0 (ends 5.4); last = the one ending at 14.9
    expect(r.startSec).toBeCloseTo(5.0 - 0.12, 5);
    expect(r.endSec).toBeCloseTo(14.9 + 0.2, 5);
  });
  it('rejects spans with (almost) no speech', () => {
    expect(alignToWords(words, 100, 120)).toEqual({ startSec: null, endSec: null });
    expect(alignToWords(words, 1, 2.5).startSec).toBeNull();
  });
});

describe('StyleRegistry', () => {
  it('lists built-ins first, saves custom presets, duplicates a built-in into a new id, protects built-ins', async () => {
    const { styles, db } = await makeEnv();
    expect((await styles.list()).map((s) => s.id)).toEqual(['clean-pop', 'bold']);
    const copy = await styles.save({ ...STYLE('bold'), name: 'My bold' });
    expect(copy.id).not.toBe('bold');
    expect(copy.builtin).toBe(false);
    const updated = await styles.save({ ...copy, fill: '#FF0000' });
    expect(updated.id).toBe(copy.id);
    expect((await styles.get(copy.id)).fill).toBe('#FF0000');
    expect((await styles.list()).length).toBe(3);
    await expect(styles.delete('bold')).rejects.toThrow(/Built-in/);
    await db.clip.update({ where: { id: 'c1' }, data: { captionStyleId: copy.id } });
    await styles.delete(copy.id);
    expect((await db.clip.findUniqueOrThrow({ where: { id: 'c1' } })).captionStyleId).toBe('clean-pop');
    // an unknown id (deleted custom preset) must not break rendering: falls back to the default
    expect((await styles.get(copy.id)).id).toBe('clean-pop');
  });
});

describe('Cp2Service: subtitles', () => {
  it('saving bumps the revision, persists locally and in storage, and counts outdated rendered clips', async () => {
    const { cp2, db, storage } = await makeEnv();
    const r1 = await cp2.subtitlesSave('v1', subtitleEditsSchema.parse({ words: { '3': { text: 'fixed' } } }));
    expect(r1.edits.rev).toBe(1);
    expect(r1.outdatedClips).toBe(1); // c1 was rendered at rev 0
    expect((await db.video.findUniqueOrThrow({ where: { id: 'v1' } })).subtitleRev).toBe(1);
    expect(await storage.head(keys2.subtitleEdits('v1'))).not.toBeNull();
    expect((await cp2.loadEdits('v1')).words['3']?.text).toBe('fixed');
    await db.clip.update({ where: { id: 'c1' }, data: { subtitleRev: 1 } });
    const got = await cp2.subtitlesGet('v1');
    expect(got.outdatedClips).toBe(0);
    expect(got.cues[0]?.text).toBe('rev1');
    const r2 = await cp2.subtitlesSave('v1', r1.edits);
    expect(r2.edits.rev).toBe(2); // server decides the revision, not the caller
  });

  it('falls back to the storage copy when the local cache is gone', async () => {
    const { cp2, storage, m } = await makeEnv();
    await cp2.subtitlesSave('v1', subtitleEditsSchema.parse({ breaks: [8] }));
    fs.rmSync(path.join(m.dir, 'cache', 'v1', 'subtitle-edits.json'));
    expect((await cp2.loadEdits('v1')).breaks).toEqual([8]);
    expect(storage.objects.has(keys2.subtitleEdits('v1'))).toBe(true);
  });

  it('exports the whole video or one clip range through the save dialog', async () => {
    const { cp2, saved } = await makeEnv();
    const all = await cp2.subtitlesExport({ videoId: 'v1', format: 'srt' });
    expect(all).toEqual({ saved: true, path: '/tmp/video-one.srt' });
    await cp2.subtitlesExport({ videoId: 'v1', clipId: 'c1', format: 'vtt' });
    expect(saved[0]?.content).toBe('SRT 1 all');
    expect(saved[1]?.name).toBe('clip-one.vtt');
  });
});

describe('Cp2Service: hooks and metadata', () => {
  it('generates 5 variants per platform, applies one (re-render) and can remove the card', async () => {
    const { cp2, db, calls, llmCalls } = await makeEnv();
    const h = await cp2.hooksGenerate('c1');
    expect(llmCalls.hooks).toBe(1);
    expect(h.tiktok).toHaveLength(5);
    expect(h.applied).toBeNull();
    expect((await cp2.hooksGet('c1'))?.reels[2]?.text).toBe('IG 2');

    await cp2.hooksApply('c1', { platform: 'shorts', index: 3 });
    expect(calls.rerender).toEqual(['c1']);
    let row = await db.clip.findUniqueOrThrow({ where: { id: 'c1' } });
    expect(JSON.parse(row.metadata)).toMatchObject({ appliedHookText: 'YT 3', hookOff: false, hooks: { applied: { platform: 'shorts', index: 3 } } });
    expect(toClipView(row as ClipRow, null).hookApplied).toBe('YT 3');

    await cp2.hooksApply('c1', null);
    row = await db.clip.findUniqueOrThrow({ where: { id: 'c1' } });
    expect(toClipView(row as ClipRow, null).hookApplied).toBeNull();
    expect(toClipView(row as ClipRow, null).hasHooks).toBe(true);
    await expect(cp2.hooksApply('c1', { platform: 'tiktok', index: 9 })).rejects.toThrow(/does not exist/);
  });

  it('writes per-platform metadata using the applied hook and saves user edits', async () => {
    const { cp2, db } = await makeEnv();
    await expect(cp2.metaSave('c1', 'tiktok', { title: 'x', description: '', hashtags: [], postingTime: { dayOfWeek: null, hour: 9, reason: '' } })).rejects.toThrow(/Generate/);
    await cp2.hooksGenerate('c1');
    await cp2.hooksApply('c1', { platform: 'tiktok', index: 1 });
    const meta = await cp2.metaGenerate('c1');
    expect(meta.tiktok.title).toBe('TT TT 1');
    await cp2.metaSave('c1', 'reels', { ...meta.reels, title: 'Edited' });
    expect((await cp2.metaGet('c1'))?.reels.title).toBe('Edited');
    expect(toClipView((await db.clip.findUniqueOrThrow({ where: { id: 'c1' } })) as ClipRow, null).hasMeta).toBe(true);
  });
});

describe('Cp2Service: thumbnails', () => {
  it('samples, scores, ranks with the vision model, uploads candidates and lets the user pick one with overlay text', async () => {
    const { cp2, storage, db, m } = await makeEnv();
    const t = await cp2.thumbsGenerate('c1');
    expect(t.candidates).toHaveLength(8);
    // vision ranking wins over the heuristic total; candidate 0 is the best-ranked frame
    expect(t.candidates.map((c) => c.llmRank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(t.overlayText).toBe('WAIT FOR IT');
    for (let i = 0; i < 8; i++) expect(storage.objects.has(keys2.thumbCandidate('c1', i))).toBe(true);
    expect(await cp2.thumbUrl('c1', 0)).toMatch(/^memory:|^https?:|c0\.jpg/);
    expect(await cp2.thumbUrl('c1', 99)).toBeNull();

    const pick = t.candidates[2]!;
    await cp2.thumbsChoose('c1', pick.t, 'GO');
    const body = (await storage.get(keys.thumb('c1'))).toString();
    expect(body.startsWith('composed:GO:')).toBe(true);
    expect((await cp2.thumbsGet('c1'))).toMatchObject({ chosenT: pick.t, overlayText: 'GO' });
    expect(toClipView((await db.clip.findUniqueOrThrow({ where: { id: 'c1' } })) as ClipRow, null).hasThumbOptions).toBe(true);
    // temp frames are cleaned up
    expect(fs.existsSync(path.join(m.dir, 'cache', 'v1', 'thumbwork', 'c1'))).toBe(false);
    expect(fs.existsSync(path.join(m.dir, 'cache', 'v1', 'thumbwork', 'c1-choose'))).toBe(false);
  });

  it('falls back to the heuristic order when the vision call fails', async () => {
    const { cp2, llmState } = await makeEnv();
    llmState.visionFails = true;
    const t = await cp2.thumbsGenerate('c1');
    expect(t.candidates).toHaveLength(8);
    expect(t.candidates.every((c) => c.llmRank === null)).toBe(true);
    const totals = t.candidates.map((c) => c.scores.total);
    expect([...totals].sort((a, b) => b - a)).toEqual(totals);
  });

  it('refuses to work on a clip that has not been rendered', async () => {
    const { cp2, db } = await makeEnv();
    await db.clip.update({ where: { id: 'c1' }, data: { status: 'candidate' } });
    await expect(cp2.thumbsGenerate('c1')).rejects.toThrow(/Render the clip first/);
  });
});

describe('Cp2Service: one-click highlights', () => {
  it('composes a reel from the best clips, aligns the segments to words and queues the render', async () => {
    const { cp2, db, llmCalls } = await makeEnv();
    await db.clip.create({ data: { id: 'c2', videoId: 'v1', title: 'Two', startSec: 90, endSec: 130, score: 75, status: 'rendered', metadata: '{}' } });
    const { clipId } = await cp2.createHighlights('v1', 'make it punchy');
    const first = await db.clip.findUniqueOrThrow({ where: { id: clipId } });
    expect(first).toMatchObject({ kind: 'highlight', status: 'queued' });
    await waitFor(async () => (await db.job.count({ where: { kind: JOB_RENDER } })) === 1);
    expect(llmCalls.highlights).toBe(1);
    const row = await db.clip.findUniqueOrThrow({ where: { id: clipId } });
    const meta = JSON.parse(row.metadata) as { highlight: { segments: { startSec: number; endSec: number }[]; transition: string } };
    expect(row.title).toBe('The reel');
    // narrative order is preserved (hook first = later in the video) and each span is word-aligned
    expect(meta.highlight.segments.map((s) => Math.round(s.startSec))).toEqual([100, 30]);
    expect(meta.highlight.transition).toBe('crossfade');
    expect(row.endSec - row.startSec).toBeCloseTo(
      meta.highlight.segments.reduce((t, s) => t + (s.endSec - s.startSec), 0),
      5,
    );
    expect(await db.job.count({ where: { kind: JOB_HIGHLIGHT } })).toBe(1);
  });

  it('marks the reel failed (with a reason) when the model returns unusable segments', async () => {
    const { cp2, db, llmState } = await makeEnv();
    llmState.highlightSegments = [{ startSec: 5000, endSec: 5020, role: 'x' }, { startSec: 6000, endSec: 6020, role: 'y' }];
    const { clipId } = await cp2.createHighlights('v1');
    await waitFor(async () => (await db.clip.findUniqueOrThrow({ where: { id: clipId } })).status === 'failed');
    const row = await db.clip.findUniqueOrThrow({ where: { id: clipId } });
    expect(row.error).toMatch(/Not enough strong moments|usable highlight/);
  });
});

describe('Cp2Service: restyle, markers', () => {
  it('restyle validates the style, stores it and re-renders every clip', async () => {
    const { cp2, db, calls } = await makeEnv();
    await expect(cp2.restyle(['c1'], { styleId: 'nope' })).rejects.toThrow(/no longer exists/);
    await cp2.restyle(['c1'], { styleId: 'bold', reframeMode: 'center' });
    expect(calls.rerender).toEqual(['c1']);
    expect(await db.clip.findUniqueOrThrow({ where: { id: 'c1' } })).toMatchObject({ captionStyleId: 'bold', reframeMode: 'center' });
  });

  it('setVideoCaptionStyle updates the options and the not-yet-rendered clips only', async () => {
    const { cp2, db } = await makeEnv();
    await db.clip.create({ data: { id: 'c3', videoId: 'v1', title: 'Cand', startSec: 1, endSec: 40, status: 'candidate', metadata: '{}' } });
    await cp2.setVideoCaptionStyle('v1', 'bold');
    expect(JSON.parse((await db.video.findUniqueOrThrow({ where: { id: 'v1' } })).options).captionStyleId).toBe('bold');
    expect((await db.clip.findUniqueOrThrow({ where: { id: 'c3' } })).captionStyleId).toBe('bold');
    expect((await db.clip.findUniqueOrThrow({ where: { id: 'c1' } })).captionStyleId).toBe('clean-pop');
  });

  it('markers are listed in time order and deleting emits a change', async () => {
    const { cp2 } = await makeEnv();
    const b = await cp2.addMarker('v1', 50, 'later');
    await cp2.addMarker('v1', 5, 'early');
    expect((await cp2.listMarkers('v1')).map((x) => x.label)).toEqual(['early', 'later']);
    await cp2.deleteMarker(b.id);
    expect(await cp2.listMarkers('v1')).toHaveLength(1);
    await expect(cp2.addMarker('nope', 1, 'x')).rejects.toThrow(/not found/i);
  });

  it('preview returns a data URL of the rendered PNG', async () => {
    const { cp2 } = await makeEnv();
    const p = await cp2.previewStyle({ style: STYLE('bold'), aspect: '9:16', activeWord: 1 });
    expect(p.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect([p.width, p.height]).toEqual([540, 960]);
  });
});

describe('ChatService', () => {
  it('stores the thread, streams events in order and executes the model\'s tool (create_clip) for real', async () => {
    const { cp2, db, calls, llm, orchestrator } = await makeEnv();
    const events: ChatEvent[] = [];
    const chat = new ChatService({
      db,
      cp2,
      orchestrator,
      moments: { generateCandidates: () => [], snap: ({ startSec, endSec }) => ({ startSec, endSec }) },
      llm,
      emit: (e) => events.push(e),
      checkLlmReady: () => null,
      log: () => {},
    });
    const { threadId } = await chat.send({ videoId: 'v1', text: 'make me a clip of the middle' });
    await waitFor(async () => events.some((e) => e.type === 'done'));
    expect(events.map((e) => e.type)).toEqual(['start', 'delta', 'citation', 'action', 'action', 'delta', 'done']);
    const msgs = await chat.messages(threadId);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(msgs[1]?.text).toBe('Hello world');
    expect(msgs[1]?.citations).toEqual([{ t: 12, label: 'intro' }]);
    expect(msgs[1]?.actions[0]).toMatchObject({ id: 'a1', status: 'done' });
    expect(msgs[1]?.actions[0]?.summary).toMatch(/Created clip “From chat” \(1:00–1:40\)/);
    // the clip really exists and was queued for rendering
    const created = await db.clip.findFirstOrThrow({ where: { title: 'From chat' } });
    expect(calls.queueRender).toContain(created.id);
    expect((await chat.threads('v1'))[0]?.title).toBe('make me a clip of the middle');

    // follow-up in the same thread keeps history; deleting the thread removes its messages
    await chat.send({ videoId: 'v1', threadId, text: 'again' });
    await waitFor(async () => events.filter((e) => e.type === 'done').length === 2);
    expect((await chat.messages(threadId)).map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    await chat.delete(threadId);
    expect(await chat.messages(threadId)).toEqual([]);
  });

  it('reports a failed answer without losing the thread, and refuses when the key is missing', async () => {
    const { cp2, db, orchestrator } = await makeEnv();
    const events: ChatEvent[] = [];
    const llm = { chat: async () => { throw new Error('boom'); } } as unknown as LlmServiceV2;
    const mk = (ready: string | null) =>
      new ChatService({ db, cp2, orchestrator, moments: { generateCandidates: () => [], snap: ({ startSec, endSec }) => ({ startSec, endSec }) }, llm, emit: (e) => events.push(e), checkLlmReady: () => ready, log: () => {} });
    await expect(mk('Add your Anthropic API key').send({ videoId: 'v1', text: 'hi' })).rejects.toThrow(/Anthropic API key/);
    const chat = mk(null);
    const { threadId } = await chat.send({ videoId: 'v1', text: 'hi' });
    await waitFor(async () => events.some((e) => e.type === 'error'));
    expect(events.at(-1)).toMatchObject({ type: 'error', message: 'boom' });
    const msgs = await chat.messages(threadId);
    expect(msgs[1]?.text).toMatch(/did not work: boom/);
  });

  it('chat tools: unknown names fail softly; markers, hooks, metadata and find_moments execute', async () => {
    const { cp2, db, orchestrator, calls } = await makeEnv();
    const exec: { run?: (n: string, i: Record<string, unknown>) => Promise<{ ok: boolean; summary: string }> } = {};
    const llm = {
      chat: async (input: { executeTool: NonNullable<typeof exec.run> }) => {
        exec.run = input.executeTool;
        return { text: 'ok', citations: [] };
      },
    } as unknown as LlmServiceV2;
    const events: ChatEvent[] = [];
    const chat = new ChatService({ db, cp2, orchestrator, moments: { generateCandidates: () => [], snap: ({ startSec, endSec }) => ({ startSec, endSec }) }, llm, emit: (e) => events.push(e), checkLlmReady: () => null, log: () => {} });
    await chat.send({ videoId: 'v1', clipId: 'c1', text: 'go' });
    await waitFor(async () => events.some((e) => e.type === 'done'));
    const run = exec.run!;
    expect((await run('delete_everything', {})).ok).toBe(false);
    expect((await run('add_marker', { atSec: 42, label: 'Look here' })).summary).toMatch(/0:42/);
    expect((await run('add_marker', { label: 'no time' })).ok).toBe(false);
    expect((await run('rewrite_hook', {})).ok).toBe(true); // uses the thread's clip
    expect((await run('write_metadata', {})).ok).toBe(true);
    expect((await run('find_moments', { prompt: 'funny' })).ok).toBe(true);
    expect(calls.findMoments).toEqual(['funny']);
    expect((await run('create_clip', { startSec: 10, endSec: 10 })).ok).toBe(false);
    expect((await run('create_clip', { startSec: 0, endSec: 500 })).summary).toMatch(/3 minutes/);
    expect((await cp2.listMarkers('v1'))[0]?.label).toBe('Look here');
  });
});
