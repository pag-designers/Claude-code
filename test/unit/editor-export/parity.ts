/** Export a project and compare decoded pixels against the CPU reference at chosen frames / points. */
import type { Project } from '../../../shared/editor';
import { allFrames, exportProject, files, settingsFor, type AssetSpec, type Frame } from './helpers';
import { refPixel, type RefSource } from './reference';

export interface ParityResult {
  out: string;
  maxErr: number;
  worst: string;
  frames: Frame[];
  rows: string[];
}

export async function parity(
  project: Project,
  specs: AssetSpec[],
  sources: Record<string, RefSource>,
  opts: {
    w?: number;
    h?: number;
    fps?: number;
    frames: number[];
    points?: [number, number][];
    /** Evaluate the reference at this extra time offset (range exports). */
    r0?: number;
    range?: { startSec: number; endSec: number };
    name?: string;
    skip?: (k: number, x: number, y: number) => boolean;
    edgeSkip?: boolean;
    edge?: number;
  },
): Promise<ParityResult> {
  const w = opts.w ?? project.canvas.width;
  const h = opts.h ?? project.canvas.height;
  const fps = opts.fps ?? 30;
  const settings = settingsFor(w, h, { fps });
  const r = await exportProject(project, files(specs), settings, { range: opts.range, name: opts.name });
  const frames = allFrames(r.out);
  const pts: [number, number][] =
    opts.points ??
    [
      [w * 0.1, h * 0.1], [w * 0.5, h * 0.1], [w * 0.9, h * 0.1],
      [w * 0.1, h * 0.5], [w * 0.5, h * 0.5], [w * 0.9, h * 0.5],
      [w * 0.1, h * 0.9], [w * 0.5, h * 0.9], [w * 0.9, h * 0.9],
      [w * 0.3, h * 0.3], [w * 0.7, h * 0.7], [w * 0.3, h * 0.7], [w * 0.7, h * 0.3],
    ].map(([x, y]) => [Math.floor(x as number), Math.floor(y as number)]);
  let maxErr = 0;
  let worst = '';
  const rows: string[] = [];
  for (const k of opts.frames) {
    const fr = frames[k];
    if (!fr) throw new Error(`export has no frame ${k} (has ${frames.length})`);
    const T = (opts.r0 ?? 0) + k / fps;
    for (const [x, y] of pts) {
      if (opts.skip?.(k, x, y)) continue;
      const got = fr.px(x, y);
      const exp = refPixel(project, sources, T, x, y, { outW: w, outH: h });
      if (opts.edgeSkip !== false) {
        // compare only flat regions: skip points within `edge` px of a colour boundary of the reference
        const e = opts.edge ?? 3;
        const near4 = [[e, 0], [-e, 0], [0, e], [0, -e], [e, e], [-e, -e], [e, -e], [-e, e]].map(([dx, dy]) =>
          refPixel(project, sources, T, x + (dx as number), y + (dy as number), { outW: w, outH: h }),
        );
        if (near4.some((n) => Math.max(...n.map((v, c) => Math.abs(v - (exp[c] as number)))) > 12)) continue;
      }
      const err = Math.max(...got.map((g, c) => Math.abs(g - (exp[c] as number))));
      rows.push(`f${k} (${x},${y}) got ${got} exp ${exp.map((v) => Math.round(v))} err ${err.toFixed(1)}`);
      if (err > maxErr) {
        maxErr = err;
        worst = rows[rows.length - 1] as string;
      }
    }
  }
  return { out: r.out, maxErr, worst, frames, rows };
}

import { ff, tmp } from './helpers';
import path from 'node:path';
import fs from 'node:fs';
/** Writes the reference render at time T as PNG and returns the path (visual inspection). */
export function refPng(project: Project, sources: Record<string, RefSource>, T: number, w: number, h: number, name: string): string {
  const buf = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = refPixel(project, sources, T, x, y, { outW: w, outH: h });
      buf[(y * w + x) * 3] = Math.round(c[0]);
      buf[(y * w + x) * 3 + 1] = Math.round(c[1]);
      buf[(y * w + x) * 3 + 2] = Math.round(c[2]);
    }
  const dir = tmp('ref');
  const raw = path.join(dir, `${name}.rgb`);
  fs.writeFileSync(raw, buf);
  const out = path.join(dir, `${name}.png`);
  ff(['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${w}x${h}`, '-i', raw, '-frames:v', '1', out]);
  return out;
}
