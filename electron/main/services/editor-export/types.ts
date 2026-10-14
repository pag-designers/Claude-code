import type { BlendMode } from '@shared/editor';
import type { Graph } from './graph';
import type { Grid } from './timeline';

export interface FileInfo {
  assetId: string;
  kind: 'video' | 'audio' | 'image' | 'lut';
  path: string;
  width: number | null;
  height: number | null;
  fps: number | null;
  durationSec: number | null;
  hasAudio: boolean;
  /** Untagged HD video: convert YUV→RGB with BT.709 (swscale would assume BT.601). */
  forceBt709?: boolean;
}

/** Everything the visual / text builders need. All geometry in OUTPUT pixels of the inner canvas. */
export interface Ctx {
  g: Graph;
  grid: Grid;
  fps: number;
  /** Project canvas units → output px. */
  K: number;
  /** Project canvas size (units). */
  cw: number;
  ch: number;
  /** Inner canvas size in output px. */
  W: number;
  H: number;
  notes: string[];
  file(assetId: string): FileInfo;
}

/** A finished RGBA layer stream (absolute slot timestamps) and how to put it on the stack. */
export interface PlacedLayer {
  label: string;
  ja: number;
  jb: number;
  /** Overlay x / y expressions (output px, may use t, w, h, W, H). */
  x: string;
  y: string;
  blend: BlendMode;
}
