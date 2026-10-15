/**
 * Drag-and-drop payload formats shared between the editor's left dock (MediaBin: sources) and the timeline
 * (drop targets). Both are JSON in `DataTransfer` under a custom MIME type, so a drop from anywhere else
 * (files, text) is ignored by `parse*`.
 *
 *   application/x-clipfern-asset       {"assetId": "<project asset id>"}
 *   application/x-clipfern-transition  {"type": "<TransitionType>"}
 */
import { transitionTypeSchema, type TransitionType } from '@shared/editor';

export const ASSET_MIME = 'application/x-clipfern-asset';
export const TRANSITION_MIME = 'application/x-clipfern-transition';

export const assetDragPayload = (assetId: string): string => JSON.stringify({ assetId });
export const transitionDragPayload = (type: TransitionType): string => JSON.stringify({ type });

export function parseAssetDrag(raw: string | null | undefined): { assetId: string } | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (v && typeof v === 'object' && 'assetId' in v) {
      const id = (v as { assetId: unknown }).assetId;
      if (typeof id === 'string' && id.length > 0) return { assetId: id };
    }
  } catch {
    /* not ours */
  }
  return null;
}

export function parseTransitionDrag(
  raw: string | null | undefined,
): { type: TransitionType } | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (v && typeof v === 'object' && 'type' in v) {
      const t = transitionTypeSchema.safeParse((v as { type: unknown }).type);
      if (t.success) return { type: t.data };
    }
  } catch {
    /* not ours */
  }
  return null;
}

/** Minimal slice of `DataTransfer` the sources need (keeps the helpers testable without a DOM). */
export interface DragSink {
  setData(format: string, data: string): void;
  effectAllowed: string;
}

export function startAssetDrag(dt: DragSink, assetId: string, label?: string): void {
  dt.setData(ASSET_MIME, assetDragPayload(assetId));
  if (label) dt.setData('text/plain', label);
  dt.effectAllowed = 'copy';
}

export function startTransitionDrag(dt: DragSink, type: TransitionType): void {
  dt.setData(TRANSITION_MIME, transitionDragPayload(type));
  dt.effectAllowed = 'copy';
}
