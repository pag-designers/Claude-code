'use client';

import type { Asset } from '@shared/editor';
import type { BrandAssetView } from '@shared/brand';

/** Where an imported stock clip goes: a project's media bin, or a Brand Kit's Videos section. */
export type StockTarget = { kind: 'project'; projectId: string } | { kind: 'kit'; kitId: string };

export interface StockBrollDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: StockTarget;
  /** Pre-filled search (e.g. a keyword suggested from the clip's transcript). */
  initialQuery?: string;
  /** Called once per imported clip (project asset for `project` targets, brand asset for `kit` targets). */
  onImported?: (r: { asset: Asset } | { brandAsset: BrandAssetView }) => void;
}

/** INTERIM placeholder owned by the B-roll agent (replaced wholesale); the props above are the contract. */
export function StockBrollDialog(_props: StockBrollDialogProps) {
  return null;
}
