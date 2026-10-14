/** Markers, assets and canvas (pure). */
import {
  ASPECT_SIZES,
  assetSchema,
  canvasSchema,
  projectMarkerSchema,
  type Asset,
  type Project,
  type ProjectMarker,
} from '@shared/editor';
import { newId } from '../helpers';

export function addMarkerOp(
  p: Project,
  atSec: number,
  label?: string,
  halfFrame = 0.01,
): { project: Project; id: string } {
  const at = Math.max(0, atSec);
  const dup = p.markers.find((m) => Math.abs(m.atSec - at) < halfFrame);
  if (dup) return { project: p, id: dup.id };
  const marker = projectMarkerSchema.parse({
    id: newId('mk'),
    atSec: at,
    label: label ?? `Marker ${p.markers.length + 1}`,
  });
  const markers = [...p.markers, marker].sort((a, b) => a.atSec - b.atSec);
  return { project: { ...p, markers }, id: marker.id };
}

export function updateMarkerOp(
  p: Project,
  id: string,
  patch: Partial<Pick<ProjectMarker, 'atSec' | 'label' | 'color'>>,
): Project {
  const cur = p.markers.find((m) => m.id === id);
  if (!cur) return p;
  const next = projectMarkerSchema.safeParse({
    ...cur,
    ...patch,
    atSec: patch.atSec === undefined ? cur.atSec : Math.max(0, patch.atSec),
  });
  if (!next.success) return p;
  if (next.data.atSec === cur.atSec && next.data.label === cur.label && next.data.color === cur.color) return p;
  const markers = p.markers.map((m) => (m.id === id ? next.data : m)).sort((a, b) => a.atSec - b.atSec);
  return { ...p, markers };
}

export function removeMarkerOp(p: Project, id: string): Project {
  return p.markers.some((m) => m.id === id) ? { ...p, markers: p.markers.filter((m) => m.id !== id) } : p;
}

/** Add assets; an asset whose id already exists replaces the old entry. */
export function addAssetsOp(p: Project, assets: readonly Asset[]): Project {
  const valid = assets.filter((a) => assetSchema.safeParse(a).success);
  if (!valid.length) return p;
  const ids = new Set(valid.map((a) => a.id));
  return { ...p, assets: [...p.assets.filter((a) => !ids.has(a.id)), ...valid] };
}

export function updateAssetOp(p: Project, assetId: string, patch: Partial<Asset>): Project {
  const cur = p.assets.find((a) => a.id === assetId);
  if (!cur) return p;
  const next = assetSchema.safeParse({ ...cur, ...patch, id: cur.id });
  if (!next.success) return p;
  return { ...p, assets: p.assets.map((a) => (a.id === assetId ? next.data : a)) };
}

/** Canvas edit. Choosing a preset aspect also sets its pixel size unless width / height are given. */
export function setCanvasOp(p: Project, patch: Partial<Project['canvas']>): Project {
  const merged: Record<string, unknown> = { ...p.canvas, ...patch };
  if (patch.aspect && patch.aspect !== 'custom' && patch.width === undefined && patch.height === undefined) {
    const size = ASPECT_SIZES[patch.aspect];
    merged.width = size.width;
    merged.height = size.height;
  }
  const next = canvasSchema.safeParse(merged);
  if (!next.success) return p;
  const c = p.canvas;
  const d = next.data;
  if (c.aspect === d.aspect && c.width === d.width && c.height === d.height && c.fps === d.fps && c.background === d.background)
    return p;
  return { ...p, canvas: d };
}
