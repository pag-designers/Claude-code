'use client';

/**
 * CP2 clip intelligence: hooks, per-platform metadata, thumbnails, reframe, steered moment runs and highlights.
 * Pure helpers first (unit-tested in test/unit/renderer-cp2b-*.test.ts), then the TanStack Query hooks that bind the
 * CP2 channels. Cache writes mirror what main pushes, so a tab opened late shows the same state as one opened early.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { create } from 'zustand';
import type { ClipView, PipelineOptionsInput } from '@shared/pipeline';
import {
  PLATFORMS,
  type ClipHooks,
  type ClipMeta,
  type ClipThumbnails,
  type MomentRun,
  type Platform,
  type PlatformMeta,
  type ReframeMode,
} from '@shared/cp2';
import type { InvokeInput } from '@shared/ipc';
import { invoke, ipcKey, useIpcEvent, useIpcQuery, type IpcCallError } from './ipc';
import { patchClipsInCache } from './pipeline-cache';
import { useAllClips } from './library';

/* ------------------------------------------------------------------------------------------------ platforms */

export const PLATFORM_SHORT: Record<Platform, string> = {
  tiktok: 'TikTok',
  reels: 'Reels',
  shorts: 'Shorts',
};

export interface PlatformSpec {
  /** Hard cap on the title field (null = the platform has no separate title). */
  titleMax: number | null;
  /** Hard cap on the whole posted text: description (+ title line for caption-only platforms) + hashtags. */
  captionMax: number;
  hashtagMax: number | null;
  /** Hashtags above this many are ignored/penalised by the platform (shown as a warning, not an error). */
  hashtagSoft: number | null;
  titleHint: string;
  descHint: string;
  hashtagHint: string;
}

/** Documented platform limits (BRIEF §4.11). TikTok/Reels have one caption field; Shorts has title + description. */
export const PLATFORM_SPECS: Record<Platform, PlatformSpec> = {
  tiktok: {
    titleMax: null,
    captionMax: 2200,
    hashtagMax: null,
    hashtagSoft: 5,
    titleHint: 'TikTok has no separate title: this becomes the first line of the caption.',
    descHint: 'Caption limit is 2,200 characters, counted with the title line and hashtags.',
    hashtagHint: '3–5 focused hashtags usually beat a long list on TikTok.',
  },
  reels: {
    titleMax: null,
    captionMax: 2200,
    hashtagMax: 30,
    hashtagSoft: null,
    titleHint: 'Reels have no separate title: this becomes the first line of the caption.',
    descHint: 'Caption limit is 2,200 characters, counted with the title line and hashtags.',
    hashtagHint: 'Instagram allows at most 30 hashtags per post.',
  },
  shorts: {
    titleMax: 100,
    captionMax: 5000,
    hashtagMax: null,
    hashtagSoft: 15,
    titleHint: 'Shorts titles are limited to 100 characters.',
    descHint: 'The description holds up to 5,000 characters, counted with the hashtags.',
    hashtagHint: 'YouTube ignores all hashtags when a video has more than 15.',
  },
};

export type CounterTone = 'ok' | 'warn' | 'over';
export function counterTone(len: number, max: number | null): CounterTone {
  if (max === null) return 'ok';
  if (len > max) return 'over';
  return len >= max * 0.9 ? 'warn' : 'ok';
}

/** Normalises user input into a clean hashtag ("Ai tips!" -> "#aitips"); null when nothing usable is left. */
export function normalizeHashtag(raw: string): string | null {
  const body = raw
    .trim()
    .replace(/^#+/, '')
    .replace(/[^\p{L}\p{N}_]/gu, '');
  return body ? `#${body}` : null;
}

export function addHashtags(list: readonly string[], raw: string): string[] {
  const seen = new Set(list.map((h) => h.toLowerCase()));
  const out = [...list];
  for (const piece of raw.split(/[\s,]+/)) {
    const tag = normalizeHashtag(piece);
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
  }
  return out;
}

export const hashtagLine = (tags: readonly string[]) => tags.join(' ');

/** Length of everything the platform counts against its caption limit. */
export function captionLength(platform: Platform, m: PlatformMeta): number {
  const tags = hashtagLine(m.hashtags);
  const parts =
    platform === 'shorts'
      ? [m.description, tags]
      : [m.title, m.description, tags];
  return parts.filter(Boolean).join('\n\n').length;
}

export interface MetaIssue {
  field: 'title' | 'caption' | 'hashtags';
  level: 'error' | 'warning';
  text: string;
}

export function metaIssues(platform: Platform, m: PlatformMeta): MetaIssue[] {
  const spec = PLATFORM_SPECS[platform];
  const out: MetaIssue[] = [];
  if (spec.titleMax !== null && m.title.length > spec.titleMax)
    out.push({
      field: 'title',
      level: 'error',
      text: `Title is ${m.title.length - spec.titleMax} over the ${spec.titleMax} character limit.`,
    });
  const cap = captionLength(platform, m);
  if (cap > spec.captionMax)
    out.push({
      field: 'caption',
      level: 'error',
      text: `Caption is ${cap - spec.captionMax} over the ${spec.captionMax.toLocaleString('en-US')} character limit.`,
    });
  if (spec.hashtagMax !== null && m.hashtags.length > spec.hashtagMax)
    out.push({
      field: 'hashtags',
      level: 'error',
      text: `${m.hashtags.length} hashtags: ${platform === 'reels' ? 'Instagram' : 'the platform'} allows at most ${spec.hashtagMax}.`,
    });
  if (spec.hashtagSoft !== null && m.hashtags.length > spec.hashtagSoft)
    out.push({
      field: 'hashtags',
      level: 'warning',
      text:
        platform === 'shorts'
          ? `More than ${spec.hashtagSoft} hashtags: YouTube ignores all of them.`
          : `More than ${spec.hashtagSoft} hashtags tends to look spammy on ${PLATFORM_SHORT[platform]}.`,
    });
  return out;
}

export const metaEqual = (a: PlatformMeta, b: PlatformMeta) =>
  a.title === b.title &&
  a.description === b.description &&
  a.postingTime.dayOfWeek === b.postingTime.dayOfWeek &&
  a.postingTime.hour === b.postingTime.hour &&
  a.postingTime.reason === b.postingTime.reason &&
  a.hashtags.length === b.hashtags.length &&
  a.hashtags.every((h, i) => h === b.hashtags[i]);

/** Text for the prominent "Copy all": ready to paste into the platform's composer. */
export function formatCopyAll(platform: Platform, m: PlatformMeta): string {
  const tags = hashtagLine(m.hashtags);
  if (platform === 'shorts')
    return [`Title: ${m.title}`, '', 'Description:', m.description, ...(tags ? ['', tags] : [])]
      .join('\n')
      .trimEnd();
  return [m.title, m.description, tags].filter((p) => p.trim().length > 0).join('\n\n');
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const DAY_NAMES = DAYS;

export function formatHour(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  const suffix = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 === 0 ? 12 : h % 12}:00 ${suffix}`;
}

export function formatPostingTime(t: PlatformMeta['postingTime']): string {
  return `${t.dayOfWeek === null ? 'Any day' : (DAYS[t.dayOfWeek] ?? 'Any day')}, ${formatHour(t.hour)}`;
}

/* ----------------------------------------------------------------------------------------- thumbnails */

export const OVERLAY_MAX_WORDS = 5;
export const OVERLAY_MAX_CHARS = 60;
export const countWords = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** Strips surrounding whitespace and collapses runs; returns null for empty so `thumbs:choose` gets `null`. */
export function cleanOverlay(s: string): string | null {
  const t = s.replace(/\s+/g, ' ').trim();
  return t ? t : null;
}

export function overlayError(s: string): string | null {
  const n = countWords(s);
  if (n > OVERLAY_MAX_WORDS) return `Use ${OVERLAY_MAX_WORDS} words or fewer (${n} now).`;
  if (s.trim().length > OVERLAY_MAX_CHARS) return `At most ${OVERLAY_MAX_CHARS} characters.`;
  return null;
}

/** Index of the candidate the vision model ranked first, else the highest total score. */
export function bestCandidateIndex(t: ClipThumbnails): number {
  if (t.candidates.length === 0) return -1;
  let best = 0;
  t.candidates.forEach((c, i) => {
    const b = t.candidates[best]!;
    const rankC = c.llmRank ?? Number.POSITIVE_INFINITY;
    const rankB = b.llmRank ?? Number.POSITIVE_INFINITY;
    if (rankC < rankB || (rankC === rankB && c.scores.total > b.scores.total)) best = i;
  });
  return best;
}

export const percent = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 100);

/* ------------------------------------------------------------------------------------------- reframe */

export const REFRAME_MODES: ReframeMode[] = [
  'auto',
  'single-face',
  'multi-face',
  'screen-face',
  'center',
];

export const LAYOUT_LABELS: Record<NonNullable<ClipView['layout']>, string> = {
  single: 'Single crop',
  split: 'Split screen',
  'screen-face': 'Screen + face',
};

/** Which layout a requested mode should produce, or null when it depends on the footage (auto). */
export function expectedLayout(mode: ReframeMode): ClipView['layout'] {
  if (mode === 'multi-face') return 'split';
  if (mode === 'screen-face') return 'screen-face';
  if (mode === 'single-face' || mode === 'center') return 'single';
  return null;
}

/** Honest explanation when the last render fell back from the requested layout. */
export function layoutFallbackNote(clip: Pick<ClipView, 'reframeMode' | 'layout'>): string | null {
  const want = expectedLayout(clip.reframeMode);
  if (!want || !clip.layout || want === clip.layout) return null;
  return `You asked for “${LAYOUT_LABEL_FOR_MODE[clip.reframeMode]}”, but the last render used a ${LAYOUT_LABELS[clip.layout].toLowerCase()}: the footage did not contain what that layout needs (for example only one face was found).`;
}
const LAYOUT_LABEL_FOR_MODE: Record<ReframeMode, string> = {
  auto: 'Auto',
  'single-face': 'Follow one face',
  'multi-face': 'Split screen',
  'screen-face': 'Screen + face',
  center: 'Centre crop',
};

export const isClipBusy = (c: Pick<ClipView, 'status'>) =>
  c.status === 'queued' || c.status === 'rendering';

/** Captions are outdated when subtitle edits were saved after the clip was rendered. */
export const captionsOutdated = (clip: Pick<ClipView, 'subtitleRev'>, videoRev: number | undefined) =>
  videoRev !== undefined && clip.subtitleRev < videoRev;

/* --------------------------------------------------------------------------------------- steering */

export const STEER_CHIPS = [
  'Funnier moments',
  'More controversial',
  'Only the guest speaking',
  'Numbers & claims',
  'Emotional moments',
  'Tips & advice',
] as const;

export const LENGTH_OPTIONS = [
  { value: 'default', label: 'Same as before' },
  { value: '15-30', label: '15–30 s' },
  { value: '30-60', label: '30–60 s' },
  { value: '60-90', label: '60–90 s' },
] as const;
export type LengthChoice = (typeof LENGTH_OPTIONS)[number]['value'];

export const COUNT_OPTIONS = [
  { value: 'default', label: 'Auto' },
  { value: '3', label: '3' },
  { value: '5', label: '5' },
  { value: '8', label: '8' },
  { value: '12', label: '12' },
] as const;
export type CountChoice = (typeof COUNT_OPTIONS)[number]['value'];

/** Options override for `moments:find`: only what the user explicitly changed is sent. */
export function steerOptions(
  length: LengthChoice,
  count: CountChoice,
): Partial<PipelineOptionsInput> | undefined {
  const o: Partial<PipelineOptionsInput> = {};
  if (length !== 'default') o.clipPreset = length;
  if (count !== 'default') o.clipCount = Number(count);
  return Object.keys(o).length ? o : undefined;
}

export function runStatusLabel(run: Pick<MomentRun, 'status' | 'found'>): string {
  switch (run.status) {
    case 'running':
      return run.found > 0 ? `Searching… ${run.found} found so far` : 'Searching the transcript…';
    case 'done':
      return run.found === 0
        ? 'Done: no new moments matched'
        : `${run.found} new ${run.found === 1 ? 'clip' : 'clips'}`;
    case 'canceled':
      return run.found > 0 ? `Canceled · kept ${run.found}` : 'Canceled';
    case 'failed':
      return 'Failed';
  }
}

export const upsertRun = (list: readonly MomentRun[], run: MomentRun): MomentRun[] => {
  const at = list.findIndex((r) => r.id === run.id);
  if (at < 0) return [run, ...list].sort((a, b) => b.createdAt - a.createdAt);
  const next = list.slice();
  next[at] = run;
  return next;
};

/* ---------------------------------------------------------------------------- cross-component state */

interface ClipUi {
  /** A deep link / action card asked the clip drawer to open this clip (consumed by ClipsBrowser). */
  openRequest: { clipId: string; view: DrawerView | null; at: number } | null;
  requestOpen: (clipId: string, view?: DrawerView | null) => void;
  clearOpenRequest: () => void;
  /** The clip drawer's active tab (kept here so deep links and the chat can choose it). */
  drawerView: DrawerView;
  setDrawerView: (v: DrawerView) => void;
  /** Steering run filter per video: runId, 'auto' (initial automatic run) or null (all). */
  runFilter: Record<string, string | null>;
  setRunFilter: (videoId: string, runId: string | null) => void;
}

export const DRAWER_VIEWS = ['overview', 'hook', 'meta', 'thumbnail', 'reframe'] as const;
export type DrawerView = (typeof DRAWER_VIEWS)[number];
export const isDrawerView = (v: string | null | undefined): v is DrawerView =>
  !!v && (DRAWER_VIEWS as readonly string[]).includes(v);

export const useClipUi = create<ClipUi>((set) => ({
  openRequest: null,
  requestOpen: (clipId, view = null) => set({ openRequest: { clipId, view, at: Date.now() } }),
  clearOpenRequest: () => set({ openRequest: null }),
  drawerView: 'overview',
  setDrawerView: (drawerView) => set({ drawerView }),
  runFilter: {},
  setRunFilter: (videoId, runId) => set((s) => ({ runFilter: { ...s.runFilter, [videoId]: runId } })),
}));

/** Clips that pass the steering-run filter chip (`null` = all, 'auto' = found by the initial automatic run). */
export function matchesRunFilter(clip: Pick<ClipView, 'runId'>, filter: string | null | undefined) {
  if (!filter) return true;
  if (filter === 'auto') return clip.runId === null;
  return clip.runId === filter;
}

/* ------------------------------------------------------------------------------------------ queries */

const fail = (title: string) => (e: IpcCallError) => toast.error(title, { description: e.message });

/** A clip by id: from the caller (the drawer already has it) or the cached all-clips list. */
export function useClipLookup(clipId: string, provided?: ClipView): ClipView | undefined {
  const all = useAllClips();
  if (provided) return provided;
  return all.data?.items.find((c) => c.id === clipId);
}

export function useHooks(clipId: string) {
  return useIpcQuery('hooks:get', { clipId }, { staleTime: 60_000, retry: false });
}
export function useMeta(clipId: string) {
  return useIpcQuery('meta:get', { clipId }, { staleTime: 60_000, retry: false });
}
export function useThumbs(clipId: string) {
  return useIpcQuery('thumbs:get', { clipId }, { staleTime: 60_000, retry: false });
}
export function useThumbCandidateUrl(clipId: string, index: number, enabled: boolean) {
  return useIpcQuery(
    'thumbs:url',
    { clipId, index },
    { enabled, staleTime: 20 * 60_000, retry: 1 },
  );
}
export function useCaptionStyles(enabled = true) {
  return useIpcQuery('captions:styles', undefined, { enabled, staleTime: 5 * 60_000, retry: false });
}

/* --------------------------------------------------------------------------------------- mutations */

export function useGenerateHooks(clipId: string) {
  const qc = useQueryClient();
  return useMutation<ClipHooks, IpcCallError, void>({
    mutationFn: () => invoke('hooks:generate', { clipId }),
    onSuccess: (data) => {
      qc.setQueryData(ipcKey('hooks:get', { clipId }), data);
      patchClipsInCache(qc, [clipId], { hasHooks: true });
      void qc.invalidateQueries({ queryKey: ['cost:summary'] });
    },
  });
}

export function useApplyHook(clipId: string) {
  const qc = useQueryClient();
  return useMutation<
    unknown,
    IpcCallError,
    { platform: Platform; index: number } | null,
    { prev: ClipHooks | null | undefined }
  >({
    mutationFn: (choice) => invoke('hooks:apply', { clipId, choice }),
    onMutate: (choice) => {
      const key = ipcKey('hooks:get', { clipId });
      const prev = qc.getQueryData<ClipHooks | null>(key);
      if (prev) qc.setQueryData<ClipHooks>(key, { ...prev, applied: choice });
      // the clip re-renders with/without the card: show it as queued until main reports progress
      patchClipsInCache(qc, [clipId], { status: 'queued', renderProgress: null, error: null });
      return { prev };
    },
    onError: (e, _c, ctx) => {
      if (ctx?.prev !== undefined) qc.setQueryData(ipcKey('hooks:get', { clipId }), ctx.prev);
      fail('Could not update the title card')(e);
    },
  });
}

export function useGenerateMeta(clipId: string) {
  const qc = useQueryClient();
  return useMutation<ClipMeta, IpcCallError, void>({
    mutationFn: () => invoke('meta:generate', { clipId }),
    onSuccess: (data) => {
      qc.setQueryData(ipcKey('meta:get', { clipId }), data);
      patchClipsInCache(qc, [clipId], { hasMeta: true });
      void qc.invalidateQueries({ queryKey: ['cost:summary'] });
    },
  });
}

export function useSaveMeta(clipId: string) {
  const qc = useQueryClient();
  return useMutation<unknown, IpcCallError, { platform: Platform; meta: PlatformMeta }>({
    mutationFn: ({ platform, meta }) => invoke('meta:save', { clipId, platform, meta }),
    onSuccess: (_d, { platform, meta }) => {
      qc.setQueryData<ClipMeta | null>(ipcKey('meta:get', { clipId }), (old) =>
        old ? { ...old, [platform]: meta } : old,
      );
    },
  });
}

export function useGenerateThumbs(clipId: string) {
  const qc = useQueryClient();
  return useMutation<ClipThumbnails, IpcCallError, void>({
    mutationFn: () => invoke('thumbs:generate', { clipId }),
    onSuccess: (data) => {
      qc.setQueryData(ipcKey('thumbs:get', { clipId }), data);
      qc.removeQueries({ queryKey: ['thumbs:url'] });
      patchClipsInCache(qc, [clipId], { hasThumbOptions: true });
      void qc.invalidateQueries({ queryKey: ['cost:summary'] });
    },
  });
}

export function useChooseThumb(clipId: string) {
  const qc = useQueryClient();
  return useMutation<unknown, IpcCallError, { t: number; overlayText: string | null }>({
    mutationFn: (p) => invoke('thumbs:choose', { clipId, ...p }),
    onSuccess: (_d, p) => {
      qc.setQueryData<ClipThumbnails | null>(ipcKey('thumbs:get', { clipId }), (old) =>
        old ? { ...old, chosenT: p.t, overlayText: p.overlayText } : old,
      );
      // thumb.jpg was rebuilt: drop the cached presigned URL so the card/drawer show the new frame
      void qc.invalidateQueries({ queryKey: ipcKey('clips:mediaUrl', { id: clipId, kind: 'thumb' }) });
      patchClipsInCache(qc, [clipId], { hasThumb: true });
    },
    onError: fail('Could not set the thumbnail'),
  });
}

export function useReframeClips() {
  const qc = useQueryClient();
  return useMutation<unknown, IpcCallError, { ids: string[]; mode: ReframeMode }>({
    mutationFn: (p) => invoke('clips:reframe', p),
    onMutate: ({ ids, mode }) =>
      patchClipsInCache(qc, ids, {
        reframeMode: mode,
        status: 'queued',
        renderProgress: null,
        error: null,
      }),
    onError: fail('Could not re-render with that mode'),
  });
}

export function useRestyleClips() {
  const qc = useQueryClient();
  return useMutation<unknown, IpcCallError, { ids: string[]; styleId: string }>({
    mutationFn: (p) => invoke('clips:restyle', p),
    onMutate: ({ ids, styleId }) =>
      patchClipsInCache(qc, ids, {
        captionStyleId: styleId,
        status: 'queued',
        renderProgress: null,
        error: null,
      }),
    onError: fail('Could not re-render with that style'),
  });
}

export function useExportClipSubtitles() {
  return useMutation<
    { saved: boolean; path: string | null },
    IpcCallError,
    { videoId: string; clipId: string; format: 'srt' | 'vtt' }
  >({
    mutationFn: (p) => invoke('subtitles:export', p),
    onSuccess: (r, p) => {
      if (r.saved)
        toast.success(`Saved ${p.format.toUpperCase()} subtitles`, {
          description: r.path ?? undefined,
        });
    },
    onError: fail('Could not export subtitles'),
  });
}

/* ------------------------------------------------------------------------------------ steered runs */

export function useMomentRuns(videoId: string) {
  const qc = useQueryClient();
  const key = ipcKey('moments:runs', { videoId });
  useIpcEvent('moments:run', (run) => {
    if (run.videoId !== videoId) return;
    qc.setQueryData<{ items: MomentRun[] }>(key, (old) => ({
      items: upsertRun(old?.items ?? [], run),
    }));
  });
  return useIpcQuery('moments:runs', { videoId }, { staleTime: 15_000 });
}

export function useFindMoments(videoId: string) {
  const qc = useQueryClient();
  return useMutation<
    { runId: string },
    IpcCallError,
    { prompt: string; options?: Partial<PipelineOptionsInput> }
  >({
    mutationFn: (p) =>
      invoke('moments:find', {
        videoId,
        prompt: p.prompt,
        options: p.options as InvokeInput<'moments:find'>['options'],
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ipcKey('moments:runs', { videoId }) });
      void qc.invalidateQueries({ queryKey: ['cost:summary'] });
    },
  });
}

export function useCancelRun(videoId: string) {
  const qc = useQueryClient();
  return useMutation<unknown, IpcCallError, { runId: string }>({
    mutationFn: (p) => invoke('moments:cancel', p),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ipcKey('moments:runs', { videoId }) }),
    onError: fail('Could not cancel that run'),
  });
}

export function useCreateHighlight(videoId: string) {
  const qc = useQueryClient();
  return useMutation<{ clipId: string }, IpcCallError, { prompt?: string }>({
    mutationFn: (p) => invoke('highlights:create', { videoId, prompt: p.prompt || undefined }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['clips:list'] });
      void qc.invalidateQueries({ queryKey: ['cost:summary'] });
    },
  });
}

/** Re-exports so consumers need one import. */
export { PLATFORMS };
