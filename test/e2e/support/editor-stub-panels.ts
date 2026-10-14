/**
 * TEST-ONLY stand-in for main's CP3 editor persistence + export behaviour as the editor PANELS see it (project list,
 * create/rename/duplicate/delete, versions, asset import, beats/waveform, export jobs and their pushed events).
 *
 * Every request and response passes through the REAL zod contract in clipfern-stub.ts, so this file cannot drift from
 * shared/ipc.ts. Hooked into the main stub with one line:
 *     const ed = await handleEditorPanels(state, channel, payload); if (ed) return ed.value;
 *
 * Nothing is seeded by default (an empty Edited / Exported tab is a real state). Specs call `seedEditor(state)` from
 * `open(..., { prepare })`, and drive export progress by hand with `editorControls(state)`.
 */
import { encodeIpcError } from '../../../shared/ipc';
import {
  exportJobSchema,
  projectSchema,
  projectVersionSchema,
  resolveExportSettings,
  trackSchema,
  videoItemSchema,
  type Asset,
  type EditorProjectDoc,
  type EditorProjectSummary,
  type ExportJob,
  type Project,
  type ProjectVersion,
} from '../../../shared/editor';
import { projectDuration } from '../../../shared/editor-eval';
import type { Cp1State } from './cp1-sim';

const fail = (msg: string, code: 'FAILED' | 'NOT_FOUND' | 'CONFLICT' = 'FAILED') =>
  new Error(encodeIpcError(code, msg));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface EditorStubState {
  docs: Map<string, EditorProjectDoc & { createdAt: number }>;
  /** Snapshot per version id, newest versions first in `versions`. */
  versions: Map<string, ProjectVersion[]>;
  snapshots: Map<string, Project>;
  exports: ExportJob[];
  counter: number;
  /** Results handed out by the next `editor:importAssets` calls (empty queue = the user cancels the dialog). */
  importQueue: { assets: Asset[]; canceled: boolean }[];
  /** Files the user imported: main has them in storage before the renderer saves the project. */
  uploads: Map<string, Asset>;
  beats: Record<string, number[]>;
  /** channel -> error thrown by the next call(s) */
  failures: Map<string, { message: string; times: number }>;
  /** ms `editor:create` takes (lets tests see "Preparing your project…"). */
  createDelayMs: number;
  /** ms `editor:export` takes before answering. */
  exportDelayMs: number;
  /** When set, `editor:save` answers with a revision conflict once. */
  conflictOnSave: boolean;
  log: {
    creates: unknown[];
    saves: { id: string; baseRev: number; items: number; project: Project }[];
    renames: { id: string; name: string }[];
    duplicates: string[];
    deletes: string[];
    saveVersions: { id: string; label: string | undefined }[];
    restores: { id: string; versionId: string }[];
    imports: { projectId: string; kinds: string[] }[];
    beats: string[];
    exports: {
      projectId: string;
      settings: ReturnType<typeof resolveExportSettings>;
      rawSettings: unknown;
    }[];
    cancels: string[];
    exportDeletes: string[][];
    downloads: string[][];
    previews: string[];
  };
}

const states = new WeakMap<Cp1State, EditorStubState>();
export function editorState(state: Cp1State): EditorStubState {
  let s = states.get(state);
  if (!s) {
    s = {
      docs: new Map(),
      versions: new Map(),
      snapshots: new Map(),
      exports: [],
      counter: 0,
      importQueue: [],
      uploads: new Map(),
      beats: {},
      failures: new Map(),
      createDelayMs: 0,
      exportDelayMs: 0,
      conflictOnSave: false,
      log: {
        creates: [],
        saves: [],
        renames: [],
        duplicates: [],
        deletes: [],
        saveVersions: [],
        restores: [],
        imports: [],
        beats: [],
        exports: [],
        cancels: [],
        exportDeletes: [],
        downloads: [],
        previews: [],
      },
    };
    states.set(state, s);
  }
  return s;
}

const assetUrl = (state: Cp1State, f: string) => `${state.assetBase}/__assets/${f}`;

/* ------------------------------------------------------------------------------- documents */

export function videoAsset(id: string, name: string, over: Partial<Asset> = {}): Asset {
  return {
    id,
    kind: 'video',
    name,
    source: { kind: 'clip', clipId: id },
    durationSec: 30,
    width: 1080,
    height: 1920,
    fps: 30,
    hasAudio: true,
    beats: null,
    ...over,
  };
}

export function uploadAsset(
  id: string,
  kind: Asset['kind'],
  fileName: string,
  over: Partial<Asset> = {},
): Asset {
  return {
    id,
    kind,
    name: fileName,
    source: { kind: 'upload', key: `editor/p/assets/${id}`, fileName },
    durationSec: kind === 'image' || kind === 'lut' ? null : 20,
    width: kind === 'image' ? 1200 : null,
    height: kind === 'image' ? 800 : null,
    fps: null,
    hasAudio: kind === 'audio',
    beats: null,
    ...over,
  };
}

/** Two back-to-back clips on the main video track: the smallest project a transition can be applied to. */
export function twoClipProject(
  aspect: '9:16' | '1:1' | '16:9' | '4:5' = '9:16',
  clipIds: [string, string] = ['c1', 'c2'],
): Project {
  const a = videoAsset(clipIds[0], 'First clip', { source: { kind: 'clip', clipId: clipIds[0] } });
  const b = videoAsset(`${clipIds[1]}-asset`, 'Second clip', {
    source: { kind: 'clip', clipId: clipIds[1] },
  });
  const dims = {
    '9:16': [1080, 1920],
    '1:1': [1080, 1080],
    '16:9': [1920, 1080],
    '4:5': [1080, 1350],
  }[aspect];
  return projectSchema.parse({
    canvas: { aspect, width: dims[0], height: dims[1] },
    tracks: [
      {
        id: 'tr_video',
        kind: 'video',
        name: 'Video',
        speech: true,
        items: [
          videoItemSchema.parse({
            type: 'video',
            id: 'it_a',
            assetId: a.id,
            startSec: 0,
            durationSec: 8,
            name: 'First clip',
          }),
          videoItemSchema.parse({
            type: 'video',
            id: 'it_b',
            assetId: b.id,
            startSec: 8,
            durationSec: 8,
            name: 'Second clip',
          }),
        ],
      },
      trackSchema.parse({ id: 'tr_text', kind: 'text', name: 'Text', items: [] }),
      trackSchema.parse({ id: 'tr_audio', kind: 'audio', name: 'Music', items: [] }),
    ],
    assets: [a, b],
    origin: { clipId: clipIds[0], videoId: null },
  });
}

export function blankProject(aspect: '9:16' | '1:1' | '16:9' | '4:5' = '9:16'): Project {
  const dims = {
    '9:16': [1080, 1920],
    '1:1': [1080, 1080],
    '16:9': [1920, 1080],
    '4:5': [1080, 1350],
  }[aspect];
  return projectSchema.parse({
    canvas: { aspect, width: dims[0], height: dims[1] },
    tracks: [
      { id: 'tr_video', kind: 'video', name: 'Video', speech: true, items: [] },
      { id: 'tr_sub', kind: 'subtitle', name: 'Subtitles', items: [] },
      { id: 'tr_text', kind: 'text', name: 'Text', items: [] },
      { id: 'tr_audio', kind: 'audio', name: 'Music', items: [] },
    ],
    assets: [],
  });
}

export function addDoc(
  state: Cp1State,
  doc: {
    id: string;
    name: string;
    project: Project;
    rev?: number;
    updatedAt?: number;
    createdAt?: number;
  },
): EditorProjectDoc {
  const ed = editorState(state);
  const now = Date.now();
  const full = {
    id: doc.id,
    name: doc.name,
    rev: doc.rev ?? 1,
    project: doc.project,
    updatedAt: doc.updatedAt ?? now,
    createdAt: doc.createdAt ?? doc.updatedAt ?? now,
  };
  ed.docs.set(doc.id, full);
  if (!ed.versions.has(doc.id)) ed.versions.set(doc.id, []);
  return full;
}

function summaryOf(
  state: Cp1State,
  d: EditorProjectDoc & { createdAt: number },
): EditorProjectSummary {
  const clipId = d.project.origin.clipId;
  const thumb =
    clipId && state.clipAssets[clipId]
      ? state.clipAssets[clipId]!.thumb
      : d.project.origin.videoId
        ? 'v1.jpg'
        : null;
  return {
    id: d.id,
    name: d.name,
    rev: d.rev,
    clipId,
    videoId: d.project.origin.videoId,
    durationSec: projectDuration(d.project),
    aspect: d.project.canvas.aspect,
    thumbUrl: thumb ? assetUrl(state, thumb) : null,
    updatedAt: d.updatedAt,
    createdAt: d.createdAt,
  };
}

export function addVersion(
  state: Cp1State,
  projectId: string,
  v: { kind: ProjectVersion['kind']; label: string | null; createdAt?: number; project?: Project },
): ProjectVersion {
  const ed = editorState(state);
  const doc = ed.docs.get(projectId);
  if (!doc) throw new Error(`no project ${projectId}`);
  const version = projectVersionSchema.parse({
    id: `ver_${++ed.counter}`,
    projectId,
    rev: doc.rev,
    label: v.label,
    kind: v.kind,
    createdAt: v.createdAt ?? Date.now(),
  });
  ed.snapshots.set(version.id, structuredClone(v.project ?? doc.project));
  ed.versions.set(projectId, [version, ...(ed.versions.get(projectId) ?? [])]);
  return version;
}

/** A realistic set of projects: from a clip (two clips cut together), a blank square, and one from a source video. */
export function seedEditor(state: Cp1State): void {
  const now = Date.now();
  const h = 3_600_000;
  const clipId = state.clips.find((c) => c.hasRender)?.id ?? 'c1';
  const clip2 = state.clips.filter((c) => c.hasRender)[1]?.id ?? 'c2';
  addDoc(state, {
    id: 'ep-clip',
    name: 'Founder story, rough cut',
    project: twoClipProject('9:16', [clipId, clip2]),
    updatedAt: now - 2 * h,
    createdAt: now - 30 * h,
  });
  addDoc(state, {
    id: 'ep-blank',
    name: 'Untitled square',
    project: blankProject('1:1'),
    updatedAt: now - 26 * h,
    createdAt: now - 27 * h,
  });
  const vid = state.videos[0]?.id ?? 'vid-interview';
  addDoc(state, {
    id: 'ep-video',
    name: 'Interview highlights',
    project: { ...blankProject('16:9'), origin: { clipId: null, videoId: vid } },
    updatedAt: now - 5 * 24 * h,
    createdAt: now - 6 * 24 * h,
  });
  addVersion(state, 'ep-clip', { kind: 'auto', label: null, createdAt: now - 3 * h });
  addVersion(state, 'ep-clip', {
    kind: 'manual',
    label: 'Before the b-roll pass',
    createdAt: now - 150 * 60_000,
  });
}

/** Finished, running, failed and canceled exports. */
export function seedExports(state: Cp1State): void {
  const ed = editorState(state);
  const now = Date.now();
  const settings = (preset: 'tiktok' | 'reels' | 'youtube-1080p') =>
    resolveExportSettings({ preset }, { width: 1080, height: 1920, fps: 30 });
  const mk = (p: Partial<ExportJob> & { id: string; name: string }): ExportJob =>
    exportJobSchema.parse({
      projectId: 'ep-clip',
      status: 'done',
      progress: 1,
      message: null,
      error: null,
      settings: settings('tiktok'),
      durationSec: 16,
      sizeBytes: 21_400_000,
      hasFile: true,
      hasThumb: true,
      createdAt: now - 3_600_000,
      finishedAt: now - 3_500_000,
      ...p,
    });
  ed.exports = [
    mk({
      id: 'ex-run',
      name: 'Interview highlights',
      projectId: 'ep-video',
      status: 'rendering',
      progress: 0.42,
      message: 'Encoding video',
      hasFile: false,
      hasThumb: false,
      sizeBytes: null,
      finishedAt: null,
      createdAt: now - 60_000,
    }),
    mk({
      id: 'ex-done',
      name: 'Founder story, rough cut',
      createdAt: now - 2 * 3_600_000,
      finishedAt: now - 2 * 3_600_000 + 40_000,
    }),
    mk({
      id: 'ex-yt',
      name: 'Interview highlights',
      projectId: 'ep-video',
      settings: settings('youtube-1080p'),
      durationSec: 95,
      sizeBytes: 141_000_000,
      createdAt: now - 30 * 3_600_000,
      finishedAt: now - 30 * 3_600_000 + 90_000,
    }),
    mk({
      id: 'ex-fail',
      name: 'Untitled square',
      projectId: 'ep-blank',
      status: 'failed',
      progress: 0.31,
      error: 'ffmpeg exited with code 1: Unable to open the LUT file',
      hasFile: false,
      hasThumb: false,
      durationSec: null,
      sizeBytes: null,
      createdAt: now - 50 * 3_600_000,
      finishedAt: now - 50 * 3_600_000 + 12_000,
    }),
  ];
}

/* ---------------------------------------------------------------------------- test controls */

export function editorControls(state: Cp1State) {
  const ed = editorState(state);
  const emit = async (job: ExportJob) => {
    const i = ed.exports.findIndex((x) => x.id === job.id);
    if (i >= 0) ed.exports[i] = job;
    await state.emit?.('editor:export', job);
  };
  const get = (id: string) => {
    const j = ed.exports.find((x) => x.id === id);
    if (!j) throw new Error(`no export ${id}`);
    return j;
  };
  return {
    state: ed,
    failNext(channel: string, message: string, times = 1) {
      ed.failures.set(channel, { message, times });
    },
    /** Pushes a progress event for an export. */
    async progress(id: string, progress: number, message: string) {
      await emit(exportJobSchema.parse({ ...get(id), status: 'rendering', progress, message }));
    },
    async finish(id: string, over: Partial<ExportJob> = {}) {
      await emit(
        exportJobSchema.parse({
          ...get(id),
          status: 'done',
          progress: 1,
          message: null,
          durationSec: 16,
          sizeBytes: 18_300_000,
          hasFile: true,
          hasThumb: true,
          finishedAt: Date.now(),
          ...over,
        }),
      );
    },
    async failJob(id: string, error: string) {
      await emit(
        exportJobSchema.parse({
          ...get(id),
          status: 'failed',
          error,
          message: null,
          finishedAt: Date.now(),
        }),
      );
    },
    lastExport(): ExportJob {
      const j = ed.exports[0];
      if (!j) throw new Error('no exports yet');
      return j;
    },
  };
}

/* ------------------------------------------------------------------------------- handler */

export const EDITOR_PANEL_CHANNELS: readonly string[] = [
  'editor:list',
  'editor:create',
  'editor:get',
  'editor:save',
  'editor:rename',
  'editor:duplicate',
  'editor:delete',
  'editor:versions',
  'editor:saveVersion',
  'editor:restoreVersion',
  'editor:previewUrl',
  'editor:importAssets',
  'editor:waveform',
  'editor:beats',
  'editor:thumbStrip',
  'editor:export',
  'editor:exportCancel',
  'exports:list',
  'exports:url',
  'exports:delete',
  'exports:download',
];

export async function handleEditorPanels(
  state: Cp1State,
  channel: string,
  payload: unknown,
): Promise<{ value: unknown } | null> {
  if (!EDITOR_PANEL_CHANNELS.includes(channel)) return null;
  const ed = editorState(state);
  const p = (payload ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- test stub: the real contract already validated the payload
  const failure = ed.failures.get(channel);
  if (failure && failure.times > 0) {
    failure.times -= 1;
    throw fail(failure.message);
  }
  const doc = (id: string) => {
    const d = ed.docs.get(id);
    if (!d) throw fail('That project no longer exists.', 'NOT_FOUND');
    return d;
  };
  const findAsset = (projectId: string, assetId: string): Asset | undefined =>
    ed.docs.get(projectId)?.project.assets.find((x) => x.id === assetId) ?? ed.uploads.get(assetId);
  const publicDoc = (d: EditorProjectDoc & { createdAt: number }): EditorProjectDoc => ({
    id: d.id,
    name: d.name,
    rev: d.rev,
    project: d.project,
    updatedAt: d.updatedAt,
  });

  switch (channel) {
    case 'editor:list':
      return {
        value: {
          items: [...ed.docs.values()]
            .map((d) => summaryOf(state, d))
            .sort((a, b) => b.updatedAt - a.updatedAt),
        },
      };

    case 'editor:create': {
      ed.log.creates.push(p);
      if (ed.createDelayMs) await sleep(ed.createDelayMs);
      const id = `ep-new-${++ed.counter}`;
      let project: Project;
      let name = (p.name as string | undefined) ?? 'Untitled project';
      if ('clipId' in p.from) {
        const c = state.clips.find((x) => x.id === p.from.clipId);
        if (!c) throw fail('That clip no longer exists.', 'NOT_FOUND');
        project = twoClipProject(c.aspect, [c.id, c.id]);
        project = {
          ...project,
          tracks: project.tracks.map((t) =>
            t.kind === 'video' ? { ...t, items: t.items.slice(0, 1) } : t,
          ),
          assets: project.assets.slice(0, 1),
        };
        name = p.name ?? c.title;
      } else if ('videoId' in p.from) {
        const v = state.videos.find((x) => x.id === p.from.videoId);
        if (!v) throw fail('That video no longer exists.', 'NOT_FOUND');
        project = { ...blankProject('9:16'), origin: { clipId: null, videoId: v.id } };
        name = p.name ?? v.title;
      } else {
        project = blankProject(p.from.aspect);
      }
      return { value: publicDoc(addDoc(state, { id, name, project, rev: 1 }) as never) };
    }

    case 'editor:get':
      return { value: publicDoc(doc(p.id)) };

    case 'editor:save': {
      const d = doc(p.id);
      if (ed.conflictOnSave) {
        ed.conflictOnSave = false;
        throw fail('This project was saved from another window.', 'CONFLICT');
      }
      if (p.baseRev !== d.rev) throw fail('Revision conflict.', 'CONFLICT');
      d.rev += 1;
      d.updatedAt = Date.now();
      d.project = p.project;
      ed.log.saves.push({
        id: p.id,
        baseRev: p.baseRev,
        items: d.project.tracks.reduce((n, t) => n + t.items.length, 0),
        project: structuredClone(d.project),
      });
      return { value: { rev: d.rev, updatedAt: d.updatedAt } };
    }

    case 'editor:rename': {
      const d = doc(p.id);
      d.name = p.name;
      d.updatedAt = Date.now();
      ed.log.renames.push({ id: p.id, name: p.name });
      return { value: { ok: true } };
    }

    case 'editor:duplicate': {
      const d = doc(p.id);
      ed.log.duplicates.push(p.id);
      const id = `ep-copy-${++ed.counter}`;
      const copy = addDoc(state, {
        id,
        name: `${d.name} copy`,
        project: structuredClone(d.project),
        rev: 1,
      });
      return { value: publicDoc(copy as never) };
    }

    case 'editor:delete': {
      doc(p.id);
      ed.docs.delete(p.id);
      ed.log.deletes.push(p.id);
      return { value: { ok: true } };
    }

    case 'editor:versions':
      doc(p.id);
      return { value: { items: ed.versions.get(p.id) ?? [] } };

    case 'editor:saveVersion': {
      doc(p.id);
      ed.log.saveVersions.push({ id: p.id, label: p.label });
      return {
        value: addVersion(state, p.id, {
          kind: 'manual',
          label: p.label?.trim() ? p.label.trim() : null,
        }),
      };
    }

    case 'editor:restoreVersion': {
      const d = doc(p.id);
      const snap = ed.snapshots.get(p.versionId);
      if (!snap) throw fail('That version no longer exists.', 'NOT_FOUND');
      ed.log.restores.push({ id: p.id, versionId: p.versionId });
      addVersion(state, p.id, { kind: 'restore', label: null });
      d.project = structuredClone(snap);
      d.rev += 1;
      d.updatedAt = Date.now();
      return { value: publicDoc(d) };
    }

    case 'editor:previewUrl': {
      ed.log.previews.push(p.assetId);
      const a = findAsset(p.projectId, p.assetId);
      if (!a) return { value: { url: null, reason: 'Unknown asset' } };
      if (a.source.kind === 'clip') {
        const ca = state.clipAssets[a.source.clipId];
        return {
          value: { url: ca ? assetUrl(state, ca.render) : null, reason: ca ? null : 'No render' },
        };
      }
      if (a.kind === 'image') return { value: { url: assetUrl(state, 'c3.jpg'), reason: null } };
      if (a.kind === 'video')
        return { value: { url: assetUrl(state, 'clip-b.webm'), reason: null } };
      return { value: { url: null, reason: 'Audio has no picture' } };
    }

    case 'editor:importAssets': {
      ed.log.imports.push({ projectId: p.projectId, kinds: p.kinds });
      await sleep(30);
      const next = ed.importQueue.shift();
      for (const a of next?.assets ?? []) {
        ed.uploads.set(a.id, a);
        // main has the file (and its probe) before the renderer saves the project; other stubs look assets up in the doc
        const doc = ed.docs.get(p.projectId);
        if (doc && !doc.project.assets.some((x) => x.id === a.id))
          doc.project = { ...doc.project, assets: [...doc.project.assets, a] };
      }
      return { value: next ?? { assets: [], canceled: true } };
    }

    case 'editor:waveform': {
      const a = findAsset(p.projectId, p.assetId);
      if (!a || !a.hasAudio) return { value: null };
      const rate = 10;
      const dur = a.durationSec ?? 20;
      const peaks = Array.from({ length: Math.round(dur * rate) }, (_, i) =>
        Math.min(1, 0.25 + 0.7 * Math.abs(Math.sin(i / 7)) * (0.6 + 0.4 * Math.sin(i / 23))),
      );
      return { value: { rate, durationSec: dur, peaks } };
    }

    case 'editor:beats': {
      ed.log.beats.push(p.assetId);
      const beats =
        ed.beats[p.assetId] ??
        Array.from({ length: 24 }, (_, i) => Math.round(i * 0.5 * 1000) / 1000);
      return { value: { beats } };
    }

    case 'editor:thumbStrip':
      return { value: { dataUrl: null, tileW: 36, tileH: p.height, cols: 1, times: [] } };

    case 'editor:export': {
      if (ed.exportDelayMs) await sleep(ed.exportDelayMs);
      const d = doc(p.projectId);
      const settings = resolveExportSettings(p.settings, d.project.canvas);
      ed.log.exports.push({ projectId: p.projectId, settings, rawSettings: p.settings });
      const id = `ex-${++ed.counter}`;
      const job = exportJobSchema.parse({
        id,
        projectId: p.projectId,
        name: d.name,
        status: 'queued',
        progress: 0,
        message: 'Waiting in the queue',
        error: null,
        settings,
        durationSec: projectDuration(d.project),
        sizeBytes: null,
        hasFile: false,
        hasThumb: false,
        createdAt: Date.now(),
        finishedAt: null,
      });
      ed.exports = [job, ...ed.exports];
      // main pushes the first event right after answering
      setTimeout(() => void state.emit?.('editor:export', job), 10);
      return { value: { exportId: id } };
    }

    case 'editor:exportCancel': {
      ed.log.cancels.push(p.id);
      const j = ed.exports.find((x) => x.id === p.id);
      if (j) {
        const canceled = exportJobSchema.parse({
          ...j,
          status: 'canceled',
          message: null,
          finishedAt: Date.now(),
        });
        ed.exports = ed.exports.map((x) => (x.id === p.id ? canceled : x));
        setTimeout(() => void state.emit?.('editor:export', canceled), 10);
      }
      return { value: { ok: true } };
    }

    case 'exports:list':
      return {
        value: {
          items: [...ed.exports].sort((a, b) => b.createdAt - a.createdAt).slice(0, p.limit ?? 100),
        },
      };

    case 'exports:url': {
      const j = ed.exports.find((x) => x.id === p.id);
      if (!j) return { value: { url: null } };
      if (p.kind === 'thumb')
        return { value: { url: j.hasThumb ? assetUrl(state, 'c2.jpg') : null } };
      return { value: { url: j.hasFile ? assetUrl(state, 'clip-a.webm') : null } };
    }

    case 'exports:delete': {
      ed.log.exportDeletes.push(p.ids);
      ed.exports = ed.exports.filter((x) => !p.ids.includes(x.id));
      return { value: { ok: true } };
    }

    case 'exports:download': {
      ed.log.downloads.push(p.ids);
      const saved = ed.exports.filter((x) => p.ids.includes(x.id) && x.hasFile).length;
      return {
        value: { saved, dir: saved ? '/home/demo/Videos/Clipfern' : null, canceled: false },
      };
    }
  }
  return null;
}
