/** Colour maths (applyColor), LUTs and blend modes — export vs the shared-evaluator reference. */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { A, TR, std } from './fixtures';
import {
  exportProject,
  files,
  frameAt,
  haveFfmpeg,
  makeProject,
  settingsFor,
  tmp,
  track,
  vitem,
} from './helpers';
import { parity } from './parity';
import { applyColor, resolveColor } from '../../../shared/editor-eval';
import { colorFilters } from '../../../electron/main/services/editor-export/video';

vi.setConfig({ testTimeout: 60_000 });
const { specs, sources } = std();

describe.skipIf(!haveFfmpeg)('colour adjustments', () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ['exposure +0.5', { exposure: A(0.5) }, 'o'],
    ['exposure -0.5', { exposure: A(-0.5) }, 'o'],
    ['exposure +1 (clips)', { exposure: A(1) }, 'o'],
    ['contrast +0.5', { contrast: A(0.5) }, 'o'],
    ['contrast -0.5', { contrast: A(-0.5) }, 'o'],
    ['saturation -0.6', { saturation: A(-0.6) }, 'o'],
    ['saturation -1 (grey)', { saturation: A(-1) }, 'o'],
    ['saturation +0.8', { saturation: A(0.8) }, 'o'],
    ['temperature +0.8 (warm)', { temperature: A(0.8) }, 'm'],
    ['temperature -0.8 (cool)', { temperature: A(-0.8) }, 'm'],
    [
      'all four values',
      { exposure: A(0.2), contrast: A(0.3), saturation: A(0.4), temperature: A(-0.3) },
      'o',
    ],
    ['filter noir', { filter: 'noir' }, 'o'],
    ['filter vivid on quadrants', { filter: 'vivid' }, 'q'],
    [
      'filter + values add (clamped)',
      { filter: 'warm', temperature: A(0.9), saturation: A(0.5) },
      'o',
    ],
    [
      'animated exposure -0.5 → 0.5',
      {
        exposure: A(0, [
          { t: 0, v: -0.5 },
          { t: 1, v: 0.5 },
        ]),
      },
      'o',
    ],
    [
      'animated saturation 0 → -1',
      {
        saturation: A(0, [
          { t: 0, v: 0 },
          { t: 1, v: -1 },
        ]),
      },
      'o',
    ],
  ];
  for (const [name, color, src] of cases) {
    it(name, async () => {
      const p = makeProject([track('video', [vitem('i', src, 0, 1, { color })])], specs);
      const r = await parity(p, specs, sources, {
        frames: [0, 15, 29],
        name: `c-${name}`.replace(/\W+/g, '_'),
      });
      expect(r.rows.length).toBeGreaterThan(10);
      expect(r.maxErr, r.worst).toBeLessThan(10);
    });
  }

  it('neutral colour adds no colour filters at all', () => {
    expect(
      colorFilters(
        resolveColor(
          {
            exposure: A(0),
            contrast: A(0),
            saturation: A(0),
            temperature: A(0),
            filter: null,
            lutAssetId: null,
            lutAmount: 1,
          } as never,
          0,
        ),
      ),
    ).toEqual([]);
  });

  it('the filter chain reproduces applyColor() for a grid of colours (CPU model of the LUT/matrix)', () => {
    const e = resolveColor(
      {
        exposure: A(0.3),
        contrast: A(0.2),
        saturation: A(-0.4),
        temperature: A(0.5),
        filter: null,
        lutAssetId: null,
        lutAmount: 1,
      } as never,
      0,
    );
    const out = applyColor([0.8, 0.4, 0.2], e);
    expect(out[0]).toBeGreaterThan(out[2]);
    expect(colorFilters(e).join(',')).toMatch(/lutrgb.*colorchannelmixer.*lutrgb/);
  });
});

describe.skipIf(!haveFfmpeg)('LUT (.cube, applied after colour, mixed by lutAmount)', () => {
  const dir = tmp('lut');
  const invert = path.join(dir, 'invert.cube');
  fs.writeFileSync(
    invert,
    [
      'TITLE "invert"',
      'LUT_3D_SIZE 2',
      ...[0, 1].flatMap((b) =>
        [0, 1].flatMap((g) => [0, 1].map((r) => `${1 - r} ${1 - g} ${1 - b}`)),
      ),
    ].join('\n'),
  );
  const lutSpec = { id: 'lut1', kind: 'lut' as const, path: invert };
  const all = [...specs, lutSpec];

  it('a full-strength inverting LUT turns red into cyan', async () => {
    const p = makeProject(
      [track('video', [vitem('i', 'r', 0, 1, { color: { lutAssetId: 'lut1', lutAmount: 1 } })])],
      all,
    );
    const r = await exportProject(p, files(all), settingsFor(160, 284));
    const c = frameAt(r.out, 3).px(80, 140);
    expect(c[0]).toBeLessThan(20);
    expect(c[1]).toBeGreaterThan(235);
    expect(c[2]).toBeGreaterThan(235);
  });

  it('lutAmount 0.5 mixes the original and the LUT result', async () => {
    const p = makeProject(
      [track('video', [vitem('i', 'r', 0, 1, { color: { lutAssetId: 'lut1', lutAmount: 0.5 } })])],
      all,
    );
    const r = await exportProject(p, files(all), settingsFor(160, 284));
    const c = frameAt(r.out, 3).px(80, 140);
    expect(c[0]).toBeGreaterThan(110);
    expect(c[0]).toBeLessThan(145);
    expect(c[1]).toBeGreaterThan(110);
    expect(c[1]).toBeLessThan(145);
  });

  it('lutAmount 0.25 is 75 % original + 25 % LUT (operand order matters)', async () => {
    const p = makeProject(
      [track('video', [vitem('i', 'r', 0, 1, { color: { lutAssetId: 'lut1', lutAmount: 0.25 } })])],
      all,
    );
    const r = await exportProject(p, files(all), settingsFor(160, 284));
    const c = frameAt(r.out, 3).px(80, 140);
    expect(c[0]).toBeGreaterThan(180);
    expect(c[0]).toBeLessThan(204);
    expect(c[1]).toBeGreaterThan(50);
    expect(c[1]).toBeLessThan(78);
  });

  it('the LUT is applied AFTER the colour adjustments', async () => {
    const p = makeProject(
      [
        track('video', [
          vitem('i', 'm', 0, 1, { color: { exposure: A(-1), lutAssetId: 'lut1', lutAmount: 1 } }),
        ]),
      ],
      all,
    );
    const r = await exportProject(p, files(all), settingsFor(160, 284));
    const c = frameAt(r.out, 3).px(80, 140); // grey 128 → exposure -1.5 stops → ~45 → inverted ~210
    expect(c[0]).toBeGreaterThan(185);
    expect(c[0]).toBeLessThan(235);
  });

  it('a missing LUT asset file is a readable error', async () => {
    const bad = [...specs, { id: 'lutX', kind: 'lut' as const, path: '/nonexistent/x.cube' }];
    const p = makeProject(
      [track('video', [vitem('i', 'r', 0, 1, { color: { lutAssetId: 'lutX' } })])],
      bad,
    );
    await expect(exportProject(p, files(bad), settingsFor(160, 284))).rejects.toThrow(/missing/i);
  });
});

describe.skipIf(!haveFfmpeg)('blend modes (W3C formulas on an opaque backdrop)', () => {
  for (const blend of [
    'normal',
    'multiply',
    'screen',
    'overlay',
    'add',
    'darken',
    'lighten',
  ] as const) {
    it(`${blend}: quadrant backdrop, flat orange layer at 80 % scale`, async () => {
      const p = makeProject(
        [
          track('video', [vitem('bg', 'q', 0, 1)]),
          track('overlay', [vitem('top', 'o', 0, 1, { blend, transform: TR({ scale: A(0.8) }) })]),
        ],
        specs,
      );
      const r = await parity(p, specs, sources, {
        frames: [0, 10],
        name: `blend-${blend}`,
        edge: 5,
      });
      expect(r.rows.length).toBeGreaterThan(3);
      expect(r.maxErr, r.worst).toBeLessThan(12);
    });
  }

  it('overlay mode is keyed on the BACKDROP (swapping operands would fail this)', async () => {
    // backdrop 128 grey (0.5), layer red: cb = 0.5 → 2·cb·cs = cs → red stays red except where cb<.5 vs >.5 differ
    const p = makeProject(
      [
        track('video', [vitem('bg', 'b', 0, 1)]),
        track('overlay', [vitem('top', 'm', 0, 1, { blend: 'overlay' })]),
      ],
      specs,
    );
    const r = await exportProject(p, files(specs), settingsFor(160, 284));
    const c = frameAt(r.out, 3).px(80, 140);
    // backdrop blue (0,0,1), layer grey 0.5: R,G: cb=0 → 0 ; B: cb=1 → 1 - 2(0)(.5)=1
    expect(c[0]).toBeLessThan(15);
    expect(c[1]).toBeLessThan(15);
    expect(c[2]).toBeGreaterThan(235);
  });

  it('a blended layer with opacity 0.5 lerps between backdrop and the blended result', async () => {
    const p = makeProject(
      [
        track('video', [vitem('bg', 'b', 0, 1)]),
        track('overlay', [
          vitem('top', 'g', 0, 1, { blend: 'add', transform: TR({ opacity: A(0.5) }) }),
        ]),
      ],
      specs,
    );
    const r = await exportProject(p, files(specs), settingsFor(160, 284));
    const c = frameAt(r.out, 3).px(80, 140); // add(blue, green) = cyan; 50 % → (0,128,255)
    expect(c[1]).toBeGreaterThan(110);
    expect(c[1]).toBeLessThan(145);
    expect(c[2]).toBeGreaterThan(235);
  });

  it('only the layer area is blended (outside it the backdrop is untouched)', async () => {
    const p = makeProject(
      [
        track('video', [vitem('bg', 'b', 0, 1)]),
        track('overlay', [
          vitem('top', 'r', 0, 1, { blend: 'screen', transform: TR({ scale: A(0.3) }) }),
        ]),
      ],
      specs,
    );
    const r = await exportProject(p, files(specs), settingsFor(160, 284));
    expect(frameAt(r.out, 3).px(10, 10)[2]).toBeGreaterThan(240);
    expect(frameAt(r.out, 3).px(10, 10)[0]).toBeLessThan(15);
    expect(frameAt(r.out, 3).px(80, 142)[0]).toBeGreaterThan(240); // screen(blue, red) = magenta
    expect(frameAt(r.out, 3).px(80, 142)[2]).toBeGreaterThan(240);
  });
});
