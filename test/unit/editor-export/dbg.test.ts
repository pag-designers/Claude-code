import { it } from 'vitest';
import { exportProject, files, frameLevels, indexClip, makeProject, settingsFor, track, vitem } from './helpers';
it('dbg', async () => {
  const idx = indexClip(100, 30, 64, 64);
  const specs = [{ id: 'x', kind: 'video' as const, path: idx, w: 64, h: 64, fps: 30, dur: 3.3 }];
  const p = makeProject([track('video', [vitem('i', 'x', 0, 1, { inSec: 1, speed: 0.5, reverse: true })])], specs, { width: 64, height: 64 });
  const r = await exportProject(p, files(specs), settingsFor(64, 64), { name: 'dbg' });
  console.log(r.graph.split('\n')[1]);
  console.log(r.args.slice(0, 14).join(' '));
  console.log(frameLevels(r.out).join(','));
});
