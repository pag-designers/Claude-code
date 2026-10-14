import { describe, it } from 'vitest';
import path from 'node:path';
import { flatClip, haveFfmpeg, makeProject, track, vitem, tmp, savePng, exportProject, files, settingsFor, contactSheet } from './helpers';

describe.skipIf(!haveFfmpeg)('text', () => {
  it('text + shapes', async () => {
    const specs = [{ id: 'r', kind: 'video' as const, path: flatClip('204060', 3, 270, 480), w: 270, h: 480, fps: 30, dur: 3 }];
    const p = makeProject(
      [
        track('video', [vitem('v', 'r', 0, 2)]),
        track('overlay', [
          { type: 'text', id: 't1', startSec: 0, durationSec: 2, text: 'Hello World\nSecond line', style: { size: 40, color: '#FFFFFF', stroke: { color: '#000000', width: 3 }, shadow: { color: '#000000', opacity: 0.6, blur: 4, offsetX: 2, offsetY: 3 }, box: null }, animIn: { type: 'pop', durationSec: 0.4 } },
          { type: 'shape', id: 's1', shape: 'progress-bar', startSec: 0, durationSec: 2, width: 200, height: 12, fill: '#FF0000', transform: { y: { v: 150, kf: [] } } },
          { type: 'shape', id: 's2', shape: 'ellipse', startSec: 0, durationSec: 2, width: 60, height: 40, fill: '#00FF00', stroke: { color: '#FFFFFF', width: 3 }, transform: { y: { v: -150, kf: [] } } },
          { type: 'shape', id: 's3', shape: 'arrow', startSec: 0, durationSec: 2, width: 100, height: 40, fill: '#FFFF00', transform: { y: { v: -200, kf: [] }, rotation: { v: 20, kf: [] } } },
        ]),
      ],
      specs,
      { width: 270, height: 480 },
    );
    const r = await exportProject(p, files(specs), settingsFor(270, 480));
    const d = tmp('shots');
    contactSheet(r.out, path.join(d, 'text.png'), 6, 2, 5, 135);
    console.log('SHEET', path.join(d, 'text.png'));
    console.log(r.notes.join('\n'));
  });
});
