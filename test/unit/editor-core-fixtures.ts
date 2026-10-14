import {
  assetSchema,
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
  type TrackKind,
} from '@shared/editor';
import { itemEnd } from '@shared/editor-eval';
import { createEditorStore, type FullEditorStore } from '../../renderer/lib/editor/core/store';
import type { StoreApi } from 'zustand';

type O = Record<string, unknown>;

export const V = (id: string, startSec: number, durationSec: number, o: O = {}) =>
  videoItemSchema.parse({ type: 'video', id, startSec, durationSec, assetId: 'av', ...o });
export const A = (id: string, startSec: number, durationSec: number, o: O = {}) =>
  audioItemSchema.parse({ type: 'audio', id, startSec, durationSec, assetId: 'aa', ...o });
export const I = (id: string, startSec: number, durationSec: number, o: O = {}) =>
  imageItemSchema.parse({ type: 'image', id, startSec, durationSec, assetId: 'ai', ...o });
export const T = (id: string, startSec: number, durationSec: number, o: O = {}) =>
  textItemSchema.parse({ type: 'text', id, startSec, durationSec, text: 'hi', ...o });
export const S = (id: string, startSec: number, durationSec: number, o: O = {}) =>
  shapeItemSchema.parse({ type: 'shape', id, startSec, durationSec, shape: 'rect', ...o });
export const C = (
  id: string,
  startSec: number,
  durationSec: number,
  words: [string, number, number][] = [['one', 0, 0.5]],
  o: O = {},
) =>
  subtitleItemSchema.parse({
    type: 'subtitle',
    id,
    startSec,
    durationSec,
    words: words.map(([w, s, e]) => ({ w, s, e })),
    ...o,
  });

export const asset = (
  id: string,
  kind: Asset['kind'],
  durationSec: number | null,
  o: O = {},
): Asset =>
  assetSchema.parse({
    id,
    kind,
    name: id,
    source: { kind: 'upload', key: `k/${id}`, fileName: `${id}.bin` },
    durationSec,
    hasAudio: kind === 'video' || kind === 'audio',
    ...o,
  });

export const DEFAULT_ASSETS: Asset[] = [
  asset('av', 'video', 60),
  asset('aa', 'audio', 120),
  asset('ai', 'image', null),
];

export const track = (id: string, kind: TrackKind, items: Item[] = [], o: O = {}): Track =>
  trackSchema.parse({ id, kind, name: id, items, speech: kind === 'video', ...o });

/** Project with the given tracks (default one video track `v1`) and the default assets. */
export function proj(tracks: Track[], o: { assets?: Asset[]; fps?: number } = {}): Project {
  return projectSchema.parse({
    canvas: { fps: o.fps ?? 30 },
    tracks,
    assets: o.assets ?? DEFAULT_ASSETS,
  });
}

export const items = (p: Project, trackId: string): Item[] =>
  (p.tracks.find((t) => t.id === trackId) as Track).items;
export const item = (p: Project, id: string): Item => {
  for (const t of p.tracks) {
    const f = t.items.find((i) => i.id === id);
    if (f) return f;
  }
  throw new Error(`no item ${id}`);
};
export const find = (p: Project, id: string): Item | undefined => {
  for (const t of p.tracks) {
    const f = t.items.find((i) => i.id === id);
    if (f) return f;
  }
  return undefined;
};
export const span = (it: Item): [number, number] => [
  Math.round(it.startSec * 1e6) / 1e6,
  Math.round(itemEnd(it) * 1e6) / 1e6,
];
export const spans = (p: Project, trackId: string): [number, number][] =>
  items(p, trackId).map(span);

/** A clock tests can advance by hand. */
export function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => void (t += ms),
    set: (v: number) => void (t = v),
  };
}

export function makeStore(
  project: Project,
  o: { clock?: ReturnType<typeof fakeClock>; id?: string; rev?: number } = {},
): StoreApi<FullEditorStore> {
  const store = createEditorStore({ now: o.clock?.now });
  store.getState().load({
    id: o.id ?? 'proj1',
    name: 'Test',
    rev: o.rev ?? 1,
    project,
    updatedAt: 1,
  });
  return store;
}
