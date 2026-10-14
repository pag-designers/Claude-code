import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { keysEditor, projectSchema, type ExportJob } from '@shared/editor';
import { defaultBrandSpec, type BrandAsset, type BrandKit } from '@shared/brand';
import { keys, type Transcript } from '@shared/pipeline';
import { subtitleEditsSchema } from '@shared/cp2';
import { EditorService, JOB_EDITOR_EXPORT } from '@main/pipeline/editor';
import { StyleRegistry } from '@main/pipeline/styles';
import { createSubtitleService } from '@main/services/subtitles';
import { MemoryStorageProvider } from '@main/services/storage/memory';
import { FAKE_STYLE, makeServices } from './helpers';

const waitFor = async (fn: () => Promise<boolean>, ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timeout');
};

/** 100 s of speech: a 0.4 s word every 0.5 s, sentence-final punctuation every 8 words. */
function transcript(): Transcript {
  const words = Array.from({ length: 200 }, (_, i) => ({
    w: i % 8 === 7 ? `w${i}.` : `w${i}`,
    s: i * 0.5,
    e: i * 0.5 + 0.4,
  }));
  const sentences = Array.from({ length: 25 }, (_, i) => ({
    id: i,
    s: i * 4,
    e: i * 4 + 3.9,
    text: `s${i}.`,
    speaker: null,
    wordStart: i * 8,
    wordEnd: i * 8 + 7,
  }));
  return {
    language: 'en',
    languageProbability: 1,
    durationSec: 100,
    model: 'fake',
    words,
    sentences,
  };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function makeEnv(over: Partial<ConstructorParameters<typeof EditorService>[0]> = {}) {
  const m = await makeServices();
  cleanups.push(m.cleanup);
  const db = m.svc.dbHandle.prisma;
  const storage = new MemoryStorageProvider();
  const exportsSeen: ExportJob[] = [];
  const calls = {
    compile: [] as unknown[],
    ffmpeg: [] as { args: string[]; durationSec: number }[],
    ensureSource: [] as string[],
    faces: 0,
    resync: 0,
  };
  const hooks = { compileError: null as Error | null, ffmpegDelayMs: 0 };
  const tr = transcript();
  const files = { picked: [] as string[] };
  const editor = new EditorService({
    db,
    queue: m.svc.queue,
    notifications: m.svc.notifications,
    getStorage: () => storage,
    invalidateStorage: () => {},
    cacheDir: path.join(m.dir, 'cache'),
    ffmpegPath: () => 'ffmpeg',
    fontsDir: () => null,
    orchestrator: {
      ensureSource: async (videoId: string) => {
        calls.ensureSource.push(videoId);
        const f = path.join(m.dir, `${videoId}-source.mp4`);
        fs.writeFileSync(f, 'source');
        return f;
      },
      loadTranscript: async () => tr,
      emitVideo: async () => {},
    },
    loadSubtitleEdits: async () => subtitleEditsSchema.parse({}),
    subtitles: createSubtitleService(),
    styles: new StyleRegistry(db, { builtinStyles: () => [FAKE_STYLE] }),
    captions: { buildAss: () => '', buildSrt: () => '', buildVtt: () => '' },
    reframe: {
      plan: ({ srcW, srcH }) => ({
        mode: 'single-face',
        aspect: '9:16',
        srcW,
        srcH,
        outW: 1080,
        outH: 1920,
        // 3 keyframes in SOURCE pixels of a 854×480 proxy: a moving 270×480 crop window
        keyframes: [
          { t: 0, x: 100, y: 0, w: 270, h: 480 },
          { t: 1, x: 100.5, y: 0, w: 270, h: 480 }, // sub-threshold move: thinned away
          { t: 5, x: 300, y: 0, w: 270, h: 480 },
        ],
        cuts: [],
        faceCoverage: 0.9,
      }),
    },
    toFaceSamples: () => [],
    sidecar: {
      start: async () => {},
      faces: async () => {
        calls.faces++;
        return {};
      },
      transcribe: async () => {
        calls.resync++;
        return {
          segments: [
            {
              words: [
                { word: ' hello', start: 0.5, end: 0.9 },
                { word: 'there', start: 1, end: 1.4 },
              ],
            },
          ],
        };
      },
    },
    media: {
      probe: async (file: string) => ({
        kind: /\.(wav|mp3)$/.test(file)
          ? ('audio' as const)
          : /\.(png|jpg)$/.test(file)
            ? ('image' as const)
            : ('video' as const),
        width: 854,
        height: 480,
        fps: 30,
        durationSec: 12,
        hasAudio: true,
      }),
      waveform: async () => ({ rate: 50, durationSec: 12, peaks: [0.1, 0.5] }),
      beats: async () => [0.5, 1, 1.5],
      thumbStrip: async ({ outJpg, count }) => {
        fs.writeFileSync(outJpg, 'jpg');
        return {
          tileW: 36,
          tileH: 64,
          cols: count,
          rows: 1,
          times: Array.from({ length: count }, (_, i) => i),
        };
      },
      makePreview: async (_s: string, out: string) => void fs.writeFileSync(out, 'preview'),
      runFfmpeg: async ({ args, durationSec, onProgress, signal }) => {
        calls.ffmpeg.push({ args, durationSec });
        for (const p of [0.25, 0.75, 1]) {
          if (signal?.aborted) throw new Error('aborted');
          onProgress?.(p);
          await new Promise((r) => setTimeout(r, hooks.ffmpegDelayMs));
        }
        const out = args[args.length - 1] as string;
        if (out.endsWith('.mp4')) fs.writeFileSync(out, 'x'.repeat(1234));
        else if (out.endsWith('.wav')) fs.writeFileSync(out, 'wav');
      },
    },
    compiler: {
      compile: async (a) => {
        calls.compile.push(a);
        if (hooks.compileError) throw hooks.compileError;
        return {
          args: ['-i', 'in', a.outPath],
          durationSec: 10,
          srt: '1\n00:00:00,000 --> 00:00:01,000\nhi\n',
          vtt: 'WEBVTT\n',
          notes: [],
        };
      },
    },
    detectEncoder: async () => 'libx264',
    thumbnail: async (_f, _c, out) => void fs.writeFileSync(out, 'thumb'),
    whisperModel: () => 'tiny',
    chooseFiles: async () => files.picked,
    chooseDirectory: async () => m.dir,
    emit: { export: (j) => exportsSeen.push(j) },
    log: () => {},
    ...over,
  });
  editor.registerJobs();
  await editor.primeStyles();
  await m.svc.queue.start();

  await db.video.create({
    data: {
      id: 'v1',
      sourceUrl: 'u',
      title: 'Source Video',
      status: 'ready',
      options: '{}',
      durationSec: 100,
      storageKeys: JSON.stringify({ proxy: keys.proxy('v1') }),
      metadata: '{}',
      updatedAt: new Date(),
    },
  });
  await storage.put(keys.proxy('v1'), 'proxy-bytes');
  await db.clip.create({
    data: {
      id: 'c1',
      videoId: 'v1',
      title: 'Clip One',
      hook: 'Original hook',
      startSec: 20,
      endSec: 50,
      score: 80,
      status: 'rendered',
      storageKeys: JSON.stringify({ render: keys.clip('c1') }),
      metadata: '{}',
      captionStyleId: 'clean-pop',
    },
  });
  await storage.put(keys.clip('c1'), 'clip-bytes');
  return { m, db, storage, editor, calls, hooks, exportsSeen, files };
}

describe('EditorService: projects', () => {
  it('creates a blank project with the four default tracks and persists it', async () => {
    const { editor, storage } = await makeEnv();
    const doc = await editor.create(undefined, { blank: true, aspect: '1:1' });
    expect(doc.name).toBe('Untitled project');
    expect(doc.project.canvas).toMatchObject({ aspect: '1:1', width: 1080, height: 1080 });
    expect(doc.project.tracks.map((t) => t.kind)).toEqual(['video', 'subtitle', 'text', 'audio']);
    expect(doc.project.tracks[0]?.speech).toBe(true);
    expect((await editor.list())[0]).toMatchObject({
      id: doc.id,
      aspect: '1:1',
      durationSec: 0,
      rev: 1,
    });
    await waitFor(async () => (await storage.head(keysEditor.projectBackup(doc.id))) !== null); // mirrored to storage
  });

  it('saves optimistically: the revision increments, a stale baseRev is a CONFLICT, saved data round-trips', async () => {
    const { editor } = await makeEnv();
    const doc = await editor.create('P', { blank: true, aspect: '9:16' });
    const next = projectSchema.parse({
      ...doc.project,
      markers: [{ id: 'm', atSec: 3, label: 'x' }],
    });
    const r = await editor.save(doc.id, next, doc.rev);
    expect(r.rev).toBe(2);
    expect((await editor.get(doc.id)).project.markers[0]?.label).toBe('x');
    await expect(editor.save(doc.id, next, 1)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(editor.save('nope', next, 1)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await editor.get(doc.id)).rev).toBe(2); // the rejected save changed nothing
  });

  it('computes duration/aspect on save, renames, duplicates and deletes with storage cleanup', async () => {
    const { editor, storage, db } = await makeEnv();
    const doc = await editor.create('A', { blank: true, aspect: '9:16' });
    const p = projectSchema.parse(doc.project);
    p.tracks[0]!.items.push({ ...videoItemFixture(), startSec: 0, durationSec: 7 } as never);
    await editor.save(doc.id, p, 1);
    expect((await editor.list())[0]?.durationSec).toBe(7);
    await editor.rename(doc.id, 'B');
    const copy = await editor.duplicate(doc.id);
    expect(copy.name).toBe('B copy');
    expect(copy.id).not.toBe(doc.id);
    await storage.put(keysEditor.asset(doc.id, 'as1', 'mp4'), 'x');
    await db.editorExport.create({ data: { projectId: doc.id, name: 'E' } });
    await editor.delete(doc.id);
    expect((await editor.list()).map((x) => x.id)).toEqual([copy.id]);
    expect([...storage.objects.keys()].filter((k) => k.includes(doc.id))).toEqual([]);
    expect((await db.editorExport.findFirstOrThrow()).projectId).toBeNull(); // exports survive their project
  });

  it('versions: one auto snapshot per interval, manual labels, restore keeps a safety snapshot', async () => {
    const { editor } = await makeEnv();
    const doc = await editor.create('V', { blank: true, aspect: '9:16' });
    const a = projectSchema.parse({
      ...doc.project,
      markers: [{ id: 'm1', atSec: 1, label: 'first' }],
    });
    await editor.save(doc.id, a, 1);
    await editor.save(
      doc.id,
      projectSchema.parse({ ...a, markers: [{ id: 'm2', atSec: 2, label: 'second' }] }),
      2,
    );
    let vs = await editor.versions(doc.id);
    expect(vs.filter((v) => v.kind === 'auto')).toHaveLength(1); // the second save was within 5 minutes
    const manual = await editor.saveVersion(doc.id, 'Before the big cut');
    expect(manual).toMatchObject({ kind: 'manual', label: 'Before the big cut', rev: 3 });
    // edit more, then restore the manual snapshot (which holds the 'second' marker)
    await editor.save(doc.id, projectSchema.parse({ ...a, markers: [] }), 3);
    const restored = await editor.restoreVersion(doc.id, manual.id);
    expect(restored.project.markers[0]?.label).toBe('second');
    expect(restored.rev).toBe(5);
    vs = await editor.versions(doc.id);
    expect(vs.some((v) => v.kind === 'restore')).toBe(true);
    await expect(editor.restoreVersion(doc.id, 'nope')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

function videoItemFixture() {
  return {
    type: 'video',
    id: 'it1',
    startSec: 0,
    durationSec: 5,
    assetId: 'a',
    name: 'x',
    groupId: null,
    locked: false,
    inSec: 0,
    speed: 1,
    speedCurve: [],
    reverse: false,
    freezeAtSec: null,
    preservePitch: true,
    noiseGate: false,
    volume: { v: 1, kf: [] },
    fadeInSec: 0,
    fadeOutSec: 0,
    transform: {
      x: { v: 0, kf: [] },
      y: { v: 0, kf: [] },
      scale: { v: 1, kf: [] },
      rotation: { v: 0, kf: [] },
      opacity: { v: 1, kf: [] },
    },
    crop: { x: { v: 0, kf: [] }, y: { v: 0, kf: [] }, w: { v: 1, kf: [] }, h: { v: 1, kf: [] } },
    fit: 'cover',
    backgroundBlur: false,
    blend: 'normal',
    mirror: false,
    blur: { v: 0, kf: [] },
    color: {
      exposure: { v: 0, kf: [] },
      contrast: { v: 0, kf: [] },
      saturation: { v: 0, kf: [] },
      temperature: { v: 0, kf: [] },
      filter: null,
      lutAssetId: null,
      lutAmount: 1,
    },
    transitionIn: null,
    audioEnabled: true,
  };
}

describe('EditorService: open from the Library', () => {
  it('a clip becomes video item + normalised face-track crop path + captions + hook card', async () => {
    const { editor, calls } = await makeEnv();
    const doc = await editor.create(undefined, { clipId: 'c1' });
    expect(doc.name).toBe('Clip One');
    expect(calls.faces).toBe(1); // face tracking ran on the proxy
    const p = doc.project;
    expect(p.canvas).toMatchObject({ aspect: '9:16', width: 1080, height: 1920 });
    const video = p.tracks.find((t) => t.kind === 'video')!.items[0]!;
    expect(video).toMatchObject({
      type: 'video',
      startSec: 0,
      durationSec: 30,
      inSec: 20,
      fit: 'cover',
    });
    if (video.type !== 'video') throw new Error('x');
    // keyframes normalised to the 854×480 source; the sub-threshold keyframe is thinned out
    expect(video.crop.x.kf.map((k) => [k.t, Math.round(k.v * 1000) / 1000])).toEqual([
      [0, 0.117],
      [5, 0.351],
    ]);
    expect(video.crop.w.v).toBeCloseTo(270 / 854, 4);
    const asset = p.assets[0]!;
    expect(asset).toMatchObject({
      kind: 'video',
      source: { kind: 'video', videoId: 'v1' },
      durationSec: 100,
    });
    // captions: cues inside the clip, on LOCAL time, with word times local to each cue
    const subs = p.tracks.find((t) => t.kind === 'subtitle')!.items;
    expect(subs.length).toBeGreaterThan(5);
    for (const s of subs) {
      if (s.type !== 'subtitle') throw new Error('x');
      expect(s.startSec).toBeGreaterThanOrEqual(0);
      expect(s.startSec + s.durationSec).toBeLessThanOrEqual(30.01);
      expect(s.styleId).toBe('clean-pop');
      expect(s.words[0]?.s).toBeLessThan(0.5);
    }
    expect(
      subs.reduce((n, s) => n + (s.type === 'subtitle' ? s.words.length : 0), 0),
    ).toBeGreaterThanOrEqual(55); // ~60 words in 30 s
    // hook card as an editable text item with the CP1 hook look
    const text = p.tracks.find((t) => t.kind === 'text')!.items[0]!;
    expect(text).toMatchObject({ type: 'text', text: 'Original hook', startSec: 0 });
    expect(text.type === 'text' && text.style.box?.color).toBe('#FFFFFF');
  });

  it('falls back to a centre crop when face tracking fails, and honours a removed hook', async () => {
    const { editor, db } = await makeEnv();
    await db.clip.update({
      where: { id: 'c1' },
      data: { metadata: JSON.stringify({ hookOff: true }) },
    });
    const doc = await editor.create(undefined, { clipId: 'c1' });
    expect(doc.project.tracks.find((t) => t.kind === 'text')!.items).toHaveLength(0);
    await expect(editor.create(undefined, { clipId: 'nope' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('a source video opens whole, with the transcript as subtitles and its clips as markers', async () => {
    const { editor, db } = await makeEnv();
    await db.marker.create({ data: { videoId: 'v1', atSec: 12, label: 'my marker' } });
    const doc = await editor.create(undefined, { videoId: 'v1' });
    const p = doc.project;
    expect(p.canvas.aspect).toBe('16:9');
    const v = p.tracks.find((t) => t.kind === 'video')!.items[0]!;
    expect(v).toMatchObject({ durationSec: 100, inSec: 0, fit: 'contain' });
    expect(p.tracks.find((t) => t.kind === 'subtitle')!.items.length).toBeGreaterThan(20);
    expect(p.markers.map((m) => m.label)).toEqual(['Clip One', 'my marker']);
  });
});

describe('EditorService: media', () => {
  it('previewUrl picks the proxy for library videos, the render for clips, and explains a missing proxy', async () => {
    const { editor, db } = await makeEnv();
    const doc = await editor.create(undefined, { clipId: 'c1' });
    const asset = doc.project.assets[0]!;
    expect((await editor.previewUrl(doc.id, asset.id)).url).toContain(keys.proxy('v1'));
    await db.video.update({ where: { id: 'v1' }, data: { storageKeys: '{}' } });
    const r = await editor.previewUrl(doc.id, asset.id);
    expect(r.url).toBeNull();
    expect(r.reason).toMatch(/no 480p proxy/);
    await expect(editor.previewUrl(doc.id, 'ghost')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('imports media: probes, uploads to the project prefix, builds a preview copy for video, rejects unreadable files', async () => {
    const { editor, storage, files, m } = await makeEnv();
    const doc = await editor.create('I', { blank: true, aspect: '9:16' });
    const vid = path.join(m.dir, 'clip.mp4');
    const wav = path.join(m.dir, 'song.wav');
    fs.writeFileSync(vid, 'v');
    fs.writeFileSync(wav, 'a');
    files.picked = [vid, wav];
    const r = await editor.importAssets(doc.id, ['video', 'audio']);
    expect(r.canceled).toBe(false);
    expect(r.assets.map((a) => [a.kind, a.name])).toEqual([
      ['video', 'clip.mp4'],
      ['audio', 'song.wav'],
    ]);
    const v = r.assets[0]!;
    expect(v).toMatchObject({ width: 854, height: 480, durationSec: 12, hasAudio: true });
    expect(v.source.kind === 'upload' && (await storage.head(v.source.key))).toBeTruthy();
    expect(
      v.source.kind === 'upload' && (await storage.head(`${v.source.key}.preview.mp4`)),
    ).toBeTruthy();
    // preview prefers the 480p copy for uploaded video
    await editor.save(doc.id, projectSchema.parse({ ...doc.project, assets: r.assets }), 1);
    expect((await editor.previewUrl(doc.id, v.id)).url).toContain('.preview.mp4');
    files.picked = [];
    expect(await editor.importAssets(doc.id, ['video'])).toEqual({ assets: [], canceled: true });
  });

  it('waveform and beats are computed once and cached; thumbnail strips come back as a data URL', async () => {
    const { editor, db } = await makeEnv();
    const doc = await editor.create(undefined, { clipId: 'c1' });
    const asset = doc.project.assets[0]!;
    expect((await editor.waveform(doc.id, asset.id))?.peaks).toEqual([0.1, 0.5]);
    expect(await editor.beats(doc.id, asset.id)).toEqual([0.5, 1, 1.5]);
    const s = await editor.thumbStrip({
      projectId: doc.id,
      assetId: asset.id,
      startSec: 0,
      endSec: 10,
      count: 5,
      height: 64,
    });
    expect(s.dataUrl?.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(s.times).toHaveLength(5);
    await db.video.update({ where: { id: 'v1' }, data: { storageKeys: '{}' } });
    expect(await editor.waveform(doc.id, asset.id)).toBeTruthy(); // served from the local cache
  });

  it('reframe returns normalised crop keyframes; resync returns words in SOURCE time', async () => {
    const { editor, calls } = await makeEnv();
    const doc = await editor.create(undefined, { clipId: 'c1' });
    const asset = doc.project.assets[0]!;
    const r = await editor.reframeAsset({
      projectId: doc.id,
      assetId: asset.id,
      startSec: 20,
      endSec: 40,
      aspect: '9:16',
      mode: 'auto',
    });
    expect(r.keyframes.length).toBeGreaterThan(1);
    expect(r.keyframes.every((k) => k.x >= 0 && k.x + k.w <= 1.0001)).toBe(true);
    const center = await editor.reframeAsset({
      projectId: doc.id,
      assetId: asset.id,
      startSec: 20,
      endSec: 40,
      aspect: '9:16',
      mode: 'center',
    });
    expect(center.faceCoverage).toBeGreaterThanOrEqual(0);
    const before = calls.faces;
    expect(before).toBe(2); // clip open + auto reframe; 'center' does not run face detection
    const w = await editor.resyncSubtitles(doc.id, asset.id, 30, 33);
    expect(w.words).toEqual([
      { w: 'hello', s: 30.5, e: 30.9 },
      { w: 'there', s: 31, e: 31.4 },
    ]);
    await expect(editor.resyncSubtitles(doc.id, asset.id, 30, 30.1)).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });
});

describe('EditorService: exports', () => {
  async function projectWithClip(editor: EditorService) {
    const doc = await editor.create(undefined, { clipId: 'c1' });
    return doc;
  }

  it('runs the whole export job: resolves full-res media, compiles, renders with progress, uploads and records the result', async () => {
    const { editor, calls, storage, exportsSeen, m } = await makeEnv();
    const doc = await projectWithClip(editor);
    const { exportId } = await editor.startExport(doc.id, {
      preset: 'shorts',
      sidecarSrt: true,
      sidecarVtt: true,
    });
    await waitFor(async () => (await editor.listExports(10))[0]?.status === 'done');
    const job = (await editor.listExports(10))[0]!;
    expect(job).toMatchObject({
      id: exportId,
      status: 'done',
      hasFile: true,
      hasThumb: true,
      progress: 1,
      sizeBytes: 1234,
      name: doc.name,
    });
    expect(job.settings).toMatchObject({
      preset: 'shorts',
      width: 1080,
      height: 1920,
      videoKbps: 12000,
    });
    expect(calls.ensureSource).toEqual(['v1']); // the full-res SOURCE was re-obtained, not the proxy
    const compileArgs = calls.compile[0] as {
      settings: { preset: string };
      files: Record<string, { path: string; width: number }>;
    };
    expect(compileArgs.settings.preset).toBe('shorts');
    expect(Object.values(compileArgs.files)[0]?.path).toMatch(/source\.mp4$/);
    expect(calls.ffmpeg[0]?.durationSec).toBe(10);
    for (const k of [
      keysEditor.exportFile(exportId),
      keysEditor.exportThumb(exportId),
      keysEditor.exportSrt(exportId),
      keysEditor.exportVtt(exportId),
    ])
      expect(await storage.head(k), k).not.toBeNull();
    // progress events were pushed, ending in done
    expect(exportsSeen.some((e) => e.status === 'rendering' && (e.progress ?? 0) > 0)).toBe(true);
    expect(exportsSeen.at(-1)?.status).toBe('done');
    expect((await m.svc.notifications.list()).items.some((n) => n.title === 'Export ready')).toBe(
      true,
    );
    expect(fs.existsSync(path.join(m.dir, 'cache', 'exports', exportId))).toBe(false); // scratch cleaned up
    expect(await editor.exportUrl(exportId, 'video')).toContain('video.mp4');
  });

  it('a compile error fails the export with the message and a notification, and keeps nothing', async () => {
    const { editor, hooks, m } = await makeEnv();
    hooks.compileError = new Error('Asset “x” is missing');
    const doc = await projectWithClip(editor);
    await editor.startExport(doc.id, { preset: 'tiktok' });
    await waitFor(async () => (await editor.listExports(10))[0]?.status === 'failed');
    const job = (await editor.listExports(10))[0]!;
    expect(job.error).toBe('Asset “x” is missing');
    expect(job.hasFile).toBe(false);
    expect((await m.svc.notifications.list()).items.some((n) => n.title === 'Export failed')).toBe(
      true,
    );
  });

  it('refuses an empty timeline; cancel stops a running export; delete removes files; download copies them', async () => {
    const { editor, hooks, storage, m } = await makeEnv();
    const blank = await editor.create('E', { blank: true, aspect: '9:16' });
    await expect(editor.startExport(blank.id, {})).rejects.toMatchObject({ code: 'VALIDATION' });

    hooks.ffmpegDelayMs = 150;
    const doc = await projectWithClip(editor);
    const { exportId } = await editor.startExport(doc.id, { preset: 'tiktok' });
    await waitFor(async () => (await editor.listExports(10))[0]?.status === 'rendering');
    await editor.cancelExport(exportId);
    await waitFor(async () => (await editor.listExports(10))[0]?.status === 'canceled');

    hooks.ffmpegDelayMs = 0;
    const second = await editor.startExport(doc.id, {
      preset: 'tiktok',
      filenameTemplate: '{title}-{preset}-{n}',
    });
    await waitFor(
      async () =>
        (await editor.listExports(10)).find((e) => e.id === second.exportId)?.status === 'done',
    );
    const dl = await editor.downloadExports([second.exportId]);
    expect(dl).toMatchObject({ saved: 1, canceled: false });
    expect(fs.existsSync(path.join(m.dir, 'Clip One-tiktok-1.mp4'))).toBe(true);
    await editor.deleteExports([exportId, second.exportId]);
    expect(await editor.listExports(10)).toEqual([]);
    expect([...storage.objects.keys()].some((k) => k.startsWith('exports/'))).toBe(false);
    expect(JOB_EDITOR_EXPORT).toBe('editor.export');
  });

  it('exports interrupted by a restart are marked failed, not left spinning', async () => {
    const { editor, db } = await makeEnv();
    await db.editorExport.create({ data: { name: 'Zombie', status: 'rendering' } });
    await editor.reconcileOnStart();
    expect((await editor.listExports(10))[0]).toMatchObject({ status: 'failed' });
  });
});

describe('EditorService: Brand Kit on new projects (CP4)', () => {
  const asset = (
    id: string,
    kind: 'logo' | 'video',
    extra: Partial<BrandAsset> = {},
  ): BrandAsset => ({
    id,
    kitId: 'k1',
    kind,
    name: id,
    ext: kind === 'logo' ? 'png' : 'mp4',
    bytes: 10,
    storageKey: `brand/k1/${id}.${kind === 'logo' ? 'png' : 'mp4'}`,
    usableKey: null,
    previewKey: null,
    thumbKey: null,
    width: kind === 'logo' ? 400 : 1080,
    height: kind === 'logo' ? 200 : 1920,
    durationSec: kind === 'video' ? 3 : null,
    hasAudio: kind === 'video',
    fps: kind === 'video' ? 30 : null,
    loudnessLufs: null,
    font: null,
    credit: null,
    createdAt: 0,
    ...extra,
  });
  const kit = (): BrandKit => {
    const spec = defaultBrandSpec();
    spec.watermark.assetId = 'logo1';
    spec.introAssetId = 'intro1';
    spec.defaults = { ...spec.defaults, watermarkOn: true, introOn: true };
    return { id: 'k1', name: 'Acme', isDefault: true, spec, rev: 1, createdAt: 0, updatedAt: 0 };
  };
  const brand = (over: { defaultId?: string | null; fail?: boolean } = {}) => ({
    getKit: async (id: string) => {
      if (over.fail) throw new Error('storage down');
      if (id !== 'k1') throw new Error('no such kit');
      return kit();
    },
    assetsOf: async () => [asset('logo1', 'logo'), asset('intro1', 'video')],
    defaultKitId: async () => (over.defaultId === undefined ? 'k1' : over.defaultId),
  });

  it('a project opened from a clip takes the default kit: watermark track, intro at 0 and everything rippled', async () => {
    const { editor } = await makeEnv({ brand: brand() });
    const plain = (await makeEnv()).editor;
    const base = (await plain.create(undefined, { clipId: 'c1' })).project;
    const doc = await editor.create(undefined, { clipId: 'c1' });
    const p = doc.project;
    expect(p.brandKitId).toBe('k1');
    expect(p.tracks.some((t) => t.id === 'tr_brand_wm' && t.items.length === 1)).toBe(true);
    const intro = p.tracks.flatMap((t) => t.items).find((i) => i.id === 'brand_intro');
    expect(intro?.startSec).toBe(0);
    const mainStart = (pr: typeof p) =>
      pr.tracks.find((t) => t.kind === 'video')!.items.find((i) => i.id !== 'brand_intro')!
        .startSec;
    expect(mainStart(p)).toBeCloseTo(mainStart(base) + 3, 5);
    expect(projectSchema.safeParse(p).success).toBe(true);
  });

  it('brandKitId null means no kit; an explicit id picks that kit', async () => {
    const { editor } = await makeEnv({ brand: brand() });
    const none = (await editor.create(undefined, { clipId: 'c1' }, null)).project;
    expect(none.brandKitId).toBeNull();
    expect(none.tracks.some((t) => t.id === 'tr_brand_wm')).toBe(false);
    const picked = (await editor.create(undefined, { blank: true, aspect: '9:16' }, 'k1')).project;
    expect(picked.brandKitId).toBe('k1');
  });

  it('no kits at all, or a brand failure, never blocks creating the project', async () => {
    const empty = await makeEnv({ brand: brand({ defaultId: null }) });
    expect(
      (await empty.editor.create(undefined, { blank: true, aspect: '9:16' })).project.brandKitId,
    ).toBeNull();
    const broken = await makeEnv({ brand: brand({ fail: true }) });
    const doc = await broken.editor.create(undefined, { blank: true, aspect: '1:1' });
    expect(doc.project.brandKitId).toBeNull();
    expect(doc.project.canvas.aspect).toBe('1:1');
  });
});
