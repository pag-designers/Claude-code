/** Placement, fit, crop, mirror, opacity, fades, blur — export pixels vs the CPU reference built on shared/editor-eval. */
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { A, TR, std } from './fixtures';
import {
  contactSheet,
  exportProject,
  ff,
  files,
  haveFfmpeg,
  frameAt,
  makeProject,
  pngImage,
  settingsFor,
  tmp,
  track,
  vitem,
} from './helpers';
import { parity } from './parity';
import { flat } from './reference';

vi.setConfig({ testTimeout: 60_000 });

const { specs, sources } = std();
/** Keeps the project 1 s long without drawing anything visible. */
const PAD = track('overlay', [
  vitem('pad', 'b', 0, 1, { transform: TR({ x: A(5000), scale: A(0.01) }) }),
]);

type Opts = Parameters<typeof parity>[3];
async function check(
  name: string,
  tracks: ReturnType<typeof track>[],
  frames: number[],
  over: Partial<Opts> = {},
  extraSpecs: typeof specs = [],
  extraSources: typeof sources = {},
) {
  const p = makeProject(tracks, [...specs, ...extraSpecs]);
  const r = await parity(
    p,
    [...specs, ...extraSpecs],
    { ...sources, ...extraSources },
    { frames, name, edge: 4, ...over },
  );
  expect(r.rows.length, `${name}: no comparable points`).toBeGreaterThan(over.points ? 0 : 4);
  return r;
}
const TOL = 10;

describe.skipIf(!haveFfmpeg)('fit (naturalLayout)', () => {
  for (const fit of ['cover', 'contain', 'native'] as const) {
    it(`landscape source, ${fit}`, async () => {
      const r = await check(
        `fit-${fit}`,
        [track('video', [vitem('i', 'w', 0, 1, { fit })])],
        [0, 12],
      );
      expect(r.maxErr, r.worst).toBeLessThan(TOL);
    });
  }

  it('portrait source in a landscape canvas, cover and contain', async () => {
    for (const fit of ['cover', 'contain'] as const) {
      const p = makeProject([track('video', [vitem('i', 'q', 0, 1, { fit })])], specs, {
        width: 284,
        height: 160,
      });
      const r = await parity(p, specs, sources, {
        w: 284,
        h: 160,
        frames: [3],
        name: `land-${fit}`,
        edge: 4,
      });
      expect(r.maxErr, r.worst).toBeLessThan(TOL);
    }
  });

  it('contain leaves the canvas background visible (letterbox)', async () => {
    const p = makeProject([track('video', [vitem('i', 'w', 0, 1, { fit: 'contain' })])], specs, {
      background: '#204080',
    });
    const r = await parity(p, specs, sources, {
      frames: [2],
      name: 'letterbox',
      points: [
        [80, 20],
        [80, 270],
        [80, 142],
      ],
    });
    expect(r.frames[2]!.px(80, 20)[2]).toBeGreaterThan(110);
    expect(r.maxErr, r.worst).toBeLessThan(TOL);
  });

  it('native fit: 1 source px = 1 canvas px, centred, may overflow', async () => {
    const r = await check(
      'native',
      [track('video', [vitem('i', 'w', 0, 1, { fit: 'native' })])],
      [1],
      {
        points: [
          [30, 100],
          [130, 200],
          [30, 200],
          [130, 100],
        ],
      },
    );
    expect(r.maxErr, r.worst).toBeLessThan(TOL);
  });
});

describe.skipIf(!haveFfmpeg)('crop (resolveCrop, keyframes = reframe paths)', () => {
  it('static crop of the centre half', async () => {
    const r = await check(
      'crop-static',
      [
        track('video', [
          vitem('i', 'q', 0, 1, { crop: { x: A(0.25), y: A(0.25), w: A(0.5), h: A(0.5) } }),
        ]),
      ],
      [0, 10],
    );
    expect(r.maxErr, r.worst).toBeLessThan(TOL);
  });

  it('sub-pixel crop origin: integer window + exact second crop at OUTPUT resolution (x 72.34 → window 72, offset 3 px at 10x)', async () => {
    const p = makeProject(
      [
        track('video', [
          vitem('i', 'q', 0, 1, { crop: { x: A(0.4521), y: A(0.2), w: A(0.1), h: A(0.1) } }),
        ]),
      ],
      specs,
    );
    const r = await exportProject(p, files(specs), settingsFor(160, 284), { run: false });
    expect(r.graph).toContain('crop=w=17:h=30:x=72:y=56:exact=1');
    expect(r.graph).toContain('scale=w=170:h=300');
    expect(r.graph).toContain('crop=w=160:h=284:x=3:y=8:exact=1');
  });

  it('static crop of a wide source (sub-pixel centre crop)', async () => {
    const r = await check(
      'crop-wide',
      [
        track('video', [
          vitem('i', 'w', 0, 1, { crop: { x: A(0.2), y: A(0), w: A(0.5), h: A(1) } }),
        ]),
      ],
      [0, 10],
    );
    expect(r.maxErr, r.worst).toBeLessThan(TOL);
  });

  it('x keyframes (pan) follow the evaluator frame by frame', async () => {
    const r = await check(
      'crop-pan',
      [
        track('video', [
          vitem('i', 'w', 0, 1, {
            crop: {
              x: A(0, [
                { t: 0, v: 0 },
                { t: 1, v: 0.5 },
              ]),
              y: A(0),
              w: A(0.5),
              h: A(1),
            },
          }),
        ]),
      ],
      [0, 5, 15, 25, 29],
    );
    expect(r.maxErr, r.worst).toBeLessThan(TOL);
  });

  it('eased pan (ease-in-out)', async () => {
    const r = await check(
      'crop-pan-ease',
      [
        track('video', [
          vitem('i', 'w', 0, 1, {
            crop: {
              x: A(0, [
                { t: 0, v: 0, ease: 'ease-in-out' },
                { t: 1, v: 0.5 },
              ]),
              y: A(0),
              w: A(0.5),
              h: A(1),
            },
          }),
        ]),
      ],
      [4, 10, 20],
    );
    expect(r.maxErr, r.worst).toBeLessThan(TOL);
  });

  it('zoom crop (w/h keyframes) with cover', async () => {
    const z = (a: number, b: number) =>
      A(a, [
        { t: 0, v: a },
        { t: 1, v: b },
      ]);
    const r = await check(
      'crop-zoom',
      [
        track('video', [
          vitem('i', 'w', 0, 1, {
            crop: { x: z(0, 0.25), y: z(0, 0), w: z(1, 0.5), h: z(1, 0.5) },
          }),
        ]),
      ],
      [0, 15, 29],
    );
    expect(r.maxErr, r.worst).toBeLessThan(TOL);
  });

  it('crop with contain fits the cropped region', async () => {
    const r = await check(
      'crop-contain',
      [
        track('video', [
          vitem('i', 'w', 0, 1, { fit: 'contain', crop: { x: A(0), y: A(0), w: A(0.5), h: A(1) } }),
        ]),
      ],
      [0, 9],
    );
    expect(r.maxErr, r.worst).toBeLessThan(TOL);
  });
});

describe.skipIf(!haveFfmpeg)('mirror and transform (resolveTransform)', () => {
  it('mirror flips horizontally', async () => {
    const r = await check(
      'mirror',
      [track('video', [vitem('i', 'q', 0, 1, { mirror: true })])],
      [0],
    );
    expect(r.frames[0]!.px(40, 70)).toSatisfy((c: number[]) => c[1]! > 200 && c[0]! < 60); // top-left shows GREEN
    expect(r.maxErr, r.worst).toBeLessThan(TOL);
  });

  it('x/y offset moves the natural rect from the canvas centre', async () => {
    const r = await check(
      'xy',
      [track('video', [vitem('i', 'q', 0, 1, { transform: TR({ x: A(30), y: A(-50) }) })])],
      [0],
    );
    expect(r.maxErr, r.worst).toBeLessThan(TOL);
  });

  for (const s of [0.5, 0.75, 1.4]) {
    it(`static scale ${s} (about the centre)`, async () => {
      const r = await check(
        `scale-${s}`,
        [track('video', [vitem('i', 'q', 0, 1, { transform: TR({ scale: A(s) }) })])],
        [0],
      );
      expect(r.maxErr, r.worst).toBeLessThan(TOL);
    });
  }

  it('animated scale 0.5 → 1.5', async () => {
    const r = await check(
      'scale-anim',
      [
        track('video', [
          vitem('i', 'q', 0, 1, {
            transform: TR({
              scale: A(1, [
                { t: 0, v: 0.5 },
                { t: 1, v: 1.5 },
              ]),
            }),
          }),
        ]),
      ],
      [0, 8, 15, 22, 29],
    );
    expect(r.maxErr, r.worst).toBeLessThan(TOL);
  });

  for (const deg of [30, 90, 180, -45]) {
    it(`static rotation ${deg}° (clockwise)`, async () => {
      const r = await check(
        `rot-${deg}`,
        [
          track('video', [
            vitem('i', 'q', 0, 1, { transform: TR({ scale: A(0.6), rotation: A(deg) }) }),
          ]),
        ],
        [0],
      );
      expect(r.maxErr, r.worst).toBeLessThan(TOL);
    });
  }

  it('rotation corner pixels: a 45° flat square has its vertices on the axes and empty corners', async () => {
    // 100 px wide natural rect would not fit; use scale on a flat clip: rect = canvas (160x284) * 0.5 = 80x142
    const p = makeProject(
      [
        track('video', [
          vitem('i', 'r', 0, 1, { transform: TR({ scale: A(0.5), rotation: A(45) }) }),
        ]),
      ],
      specs,
    );
    const r = await parity(p, specs, sources, {
      frames: [0],
      name: 'rot-corner',
      points: [
        [80, 142],
        [80, 142 - 90],
        [80, 142 + 90],
        [80 + 60, 142],
        [5, 5],
        [155, 5],
        [5, 280],
        [155, 280],
      ],
      edgeSkip: false,
    });
    const f = r.frames[0]!;
    expect(f.px(80, 142)[0]).toBeGreaterThan(240);
    expect(f.px(80, 52)).toEqual([0, 0, 0]); // above the rotated rect's top vertex (142-~78)
    expect(f.px(5, 5)).toEqual([0, 0, 0]);
    expect(f.px(155, 280)).toEqual([0, 0, 0]);
    expect(r.maxErr, r.worst).toBeLessThan(TOL);
  });

  it('animated rotation 0 → 90° (time-varying rotate expression)', async () => {
    const r = await check(
      'rot-anim',
      [
        track('video', [
          vitem('i', 'q', 0, 1, {
            transform: TR({
              scale: A(0.5),
              rotation: A(0, [
                { t: 0, v: 0 },
                { t: 1, v: 90 },
              ]),
            }),
          }),
        ]),
      ],
      [0, 10, 20, 29],
    );
    expect(r.maxErr, r.worst).toBeLessThan(TOL);
  });

  it('all transforms together (offset + scale + rotation, keyframed)', async () => {
    const tr = TR({
      x: A(0, [
        { t: 0, v: -20 },
        { t: 1, v: 20 },
      ]),
      y: A(10),
      scale: A(0.6, [
        { t: 0, v: 0.5, ease: 'ease-out' },
        { t: 1, v: 0.8 },
      ]),
      rotation: A(0, [
        { t: 0, v: -20 },
        { t: 1, v: 40 },
      ]),
    });
    const r = await check(
      'combo',
      [track('video', [vitem('i', 'q', 0, 1, { transform: tr })])],
      [0, 14, 29],
    );
    expect(r.maxErr, r.worst).toBeLessThan(TOL);
  });

  it('scale 0 (or invisible) items are skipped without breaking the export', async () => {
    const p = makeProject(
      [track('video', [vitem('i', 'q', 0, 1, { transform: TR({ scale: A(0) }) })])],
      specs,
    );
    const r = await exportProject(p, files(specs), settingsFor(160, 284));
    expect(r.notes.join(' ')).toMatch(/invisible/);
    expect(frameAt(r.out, 3).px(80, 140)).toEqual([0, 0, 0]);
  });
});

describe.skipIf(!haveFfmpeg)('opacity, fades, stacking, background', () => {
  it('constant opacity over another layer', async () => {
    const r = await check(
      'opa-const',
      [
        track('video', [vitem('i', 'b', 0, 1)]),
        track('overlay', [vitem('o', 'r', 0, 1, { transform: TR({ opacity: A(0.4) }) })]),
      ],
      [0, 10],
    );
    expect(r.frames[0]!.px(80, 140)[0]).toBeGreaterThan(80);
    expect(r.frames[0]!.px(80, 140)[0]).toBeLessThan(125);
    expect(r.maxErr, r.worst).toBeLessThan(TOL);
  });

  it('opacity keyframes 1 → 0.2 (general alpha path)', async () => {
    const r = await check(
      'opa-kf',
      [
        track('video', [vitem('i', 'b', 0, 1)]),
        track('overlay', [
          vitem('o', 'r', 0, 1, {
            transform: TR({
              opacity: A(1, [
                { t: 0, v: 1 },
                { t: 1, v: 0.2 },
              ]),
            }),
          }),
        ]),
      ],
      [0, 7, 15, 22, 29],
    );
    expect(r.maxErr, r.worst).toBeLessThan(TOL + 4);
  });

  it('fadeIn / fadeOut ramp the alpha (fadeFactor)', async () => {
    const r = await check(
      'fades',
      [
        track('video', [vitem('i', 'b', 0, 1)]),
        track('overlay', [vitem('o', 'r', 0, 1, { fadeInSec: 0.4, fadeOutSec: 0.4 })]),
      ],
      [0, 4, 8, 15, 22, 26, 29],
    );
    expect(r.frames[4]!.px(80, 140)[0]).toBeGreaterThan(60);
    expect(r.frames[4]!.px(80, 140)[0]).toBeLessThan(200);
    expect(r.maxErr, r.worst).toBeLessThan(TOL + 4);
  });

  it('fade on a bottom layer fades to the canvas background', async () => {
    const p = makeProject([track('video', [vitem('i', 'r', 0, 1, { fadeInSec: 0.5 })])], specs, {
      background: '#0000FF',
    });
    const r = await parity(p, specs, sources, {
      frames: [0, 8, 15, 20],
      name: 'fade-bg',
      edgeSkip: false,
      points: [
        [80, 140],
        [20, 20],
      ],
    });
    expect(r.frames[0]!.px(80, 140)[2]).toBeGreaterThan(240);
    expect(r.maxErr, r.worst).toBeLessThan(TOL + 4);
  });

  it('tracks stack bottom → top (later track on top)', async () => {
    const r = await check(
      'z-order',
      [
        track('video', [vitem('a', 'r', 0, 1)]),
        track('overlay', [vitem('b', 'g', 0, 1, { transform: TR({ scale: A(0.5) }) })]),
        track('overlay', [vitem('c', 'b', 0, 1, { transform: TR({ scale: A(0.2) }) })]),
      ],
      [0],
      {
        points: [
          [80, 142],
          [80, 100],
          [20, 20],
        ],
      },
    );
    expect(r.frames[0]!.px(80, 142)[2]).toBeGreaterThan(240);
    expect(r.frames[0]!.px(80, 100)[1]).toBeGreaterThan(240);
    expect(r.frames[0]!.px(20, 20)[0]).toBeGreaterThan(240);
    expect(r.maxErr, r.worst).toBeLessThan(TOL);
  });

  it('a hidden track is not drawn', async () => {
    const p = makeProject(
      [
        track('video', [vitem('a', 'r', 0, 1)]),
        track('overlay', [vitem('b', 'g', 0, 1)], { hidden: true }),
      ],
      specs,
    );
    const r = await exportProject(p, files(specs), settingsFor(160, 284));
    expect(frameAt(r.out, 3).px(80, 140)[0]).toBeGreaterThan(240);
  });

  it('canvas background colour shows where nothing is drawn', async () => {
    const p = makeProject([track('video', [vitem('a', 'r', 0.5, 0.5)])], specs, {
      background: '#336699',
    });
    const r = await exportProject(p, files(specs), settingsFor(160, 284));
    const c = frameAt(r.out, 3).px(80, 140);
    expect(Math.abs(c[0] - 0x33) + Math.abs(c[1] - 0x66) + Math.abs(c[2] - 0x99)).toBeLessThan(14);
    expect(frameAt(r.out, 20).px(80, 140)[0]).toBeGreaterThan(240);
  });

  it('items start and end on the right frame (no early / late frames)', async () => {
    const p = makeProject([track('video', [vitem('a', 'r', 0.5, 0.5)]), PAD], specs);
    const r = await exportProject(p, files(specs), settingsFor(160, 284));
    expect(frameAt(r.out, 14).px(80, 140)[0]).toBeLessThan(30);
    expect(frameAt(r.out, 15).px(80, 140)[0]).toBeGreaterThan(240);
    expect(frameAt(r.out, 29).px(80, 140)[0]).toBeGreaterThan(240);
  });

  it('an item starting between frames appears on the first frame at or after its start', async () => {
    const p = makeProject([track('video', [vitem('a', 'r', 0.41, 0.5)]), PAD], specs);
    const r = await exportProject(p, files(specs), settingsFor(160, 284));
    expect(frameAt(r.out, 12).px(80, 140)[0]).toBeLessThan(30); // t = 0.4 < 0.41
    expect(frameAt(r.out, 13).px(80, 140)[0]).toBeGreaterThan(240); // t = 0.4333
  });
});

describe.skipIf(!haveFfmpeg)('blur, background blur', () => {
  it('constant blur keeps flat areas and softens the edge of a split picture', async () => {
    const p = makeProject([track('video', [vitem('i', 'q', 0, 1, { blur: A(8) })])], specs);
    const r = await exportProject(p, files(specs), settingsFor(160, 284));
    const f = frameAt(r.out, 3);
    // the red | green boundary at x = 80 is a ramp now
    const mid = f.px(80, 40);
    expect(mid[0]).toBeGreaterThan(60);
    expect(mid[0]).toBeLessThan(200);
    expect(mid[1]).toBeGreaterThan(60);
    expect(f.px(20, 40)[0]).toBeGreaterThan(230);
    const sharp = await exportProject(
      makeProject([track('video', [vitem('i', 'q', 0, 1)])], specs),
      files(specs),
      settingsFor(160, 284),
      { name: 'sharp' },
    );
    expect(frameAt(sharp.out, 3).px(76, 40)[0]).toBeGreaterThan(240);
    expect(f.px(76, 40)[0]).toBeLessThan(frameAt(sharp.out, 3).px(76, 40)[0] - 5);
  });

  it('animated blur grows over time (gated gblur pieces)', async () => {
    const p = makeProject(
      [
        track('video', [
          vitem('i', 'q', 0, 1, {
            blur: A(0, [
              { t: 0, v: 0 },
              { t: 1, v: 10 },
            ]),
          }),
        ]),
      ],
      specs,
    );
    const r = await exportProject(p, files(specs), settingsFor(160, 284));
    const spread = (k: number) => {
      const f = frameAt(r.out, k);
      return f.px(70, 40)[0] - f.px(90, 40)[0]; // red→green transition width proxy
    };
    expect(spread(0)).toBeGreaterThan(spread(15) - 1);
    expect(spread(15)).toBeGreaterThanOrEqual(0);
    expect(frameAt(r.out, 0).px(76, 40)[0]).toBeGreaterThan(240);
    expect(frameAt(r.out, 28).px(76, 40)[0]).toBeLessThan(frameAt(r.out, 10).px(76, 40)[0] + 1);
  });

  it("'contain' + backgroundBlur fills the letterbox with a blurred cover copy", async () => {
    const p = makeProject(
      [track('video', [vitem('i', 'w', 0, 1, { fit: 'contain', backgroundBlur: true })])],
      specs,
    );
    const r = await exportProject(p, files(specs), settingsFor(160, 284));
    const f = frameAt(r.out, 3);
    // bars: colours come from the blurred copy, not black
    const top = f.px(20, 30);
    expect(top[0] + top[1] + top[2]).toBeGreaterThan(150);
    // the centre strip is the sharp picture
    expect(f.px(40, 120)).toSatisfy((c: number[]) => c[0]! > 200 || c[2]! > 200 || c[1]! > 200);
    const sheet = path.join(tmp('shots'), 'bgblur.png');
    contactSheet(r.out, sheet, 3, 1, 10, 120);
    expect(sheet).toBeTruthy();
  });

  it('without backgroundBlur the letterbox stays black', async () => {
    const p = makeProject([track('video', [vitem('i', 'w', 0, 1, { fit: 'contain' })])], specs);
    const r = await exportProject(p, files(specs), settingsFor(160, 284));
    expect(frameAt(r.out, 3).px(20, 30)).toEqual([0, 0, 0]);
  });
});

describe.skipIf(!haveFfmpeg)('image items', () => {
  const png = pngImage('FF8030', 100, 60);
  const alpha = (() => {
    const out = path.join(tmp('media'), 'half-alpha.png');
    // left half opaque green, right half transparent
    ff([
      '-f',
      'lavfi',
      '-i',
      'color=c=0x00FF00:s=100x60,format=rgba,geq=r=r(X\\,Y):g=g(X\\,Y):b=b(X\\,Y):a=if(lt(X\\,50)\\,255\\,0)',
      '-frames:v',
      '1',
      out,
    ]);
    return out;
  })();
  const imgSpecs = [
    { id: 'p', kind: 'image' as const, path: png, w: 100, h: 60 },
    { id: 'pa', kind: 'image' as const, path: alpha, w: 100, h: 60 },
  ];
  const imgSources = {
    p: { sampler: flat('#FF8030'), w: 100, h: 60 },
    pa: { sampler: flat('#00FF00'), w: 100, h: 60 },
  };

  it('an image fills the canvas (cover) and lasts exactly its duration', async () => {
    const p = makeProject(
      [
        track('video', [
          { type: 'image', id: 'im', assetId: 'p', startSec: 0.2, durationSec: 0.5 },
        ]),
        PAD,
      ],
      [...specs, ...imgSpecs],
    );
    const r = await parity(
      p,
      [...specs, ...imgSpecs],
      { ...sources, ...imgSources },
      {
        frames: [6, 10, 20],
        name: 'img-cover',
        points: [
          [80, 142],
          [10, 10],
        ],
        edgeSkip: false,
      },
    );
    expect(r.frames[5]!.px(80, 142)).toEqual([0, 0, 0]);
    expect(r.frames[6]!.px(80, 142)[0]).toBeGreaterThan(240);
    expect(r.frames[21]!.px(80, 142)).toEqual([0, 0, 0]);
    expect(r.maxErr, r.worst).toBeLessThan(TOL);
  });

  it('image with contain + transform + keyframed opacity', async () => {
    const p = makeProject(
      [
        track('video', [
          {
            type: 'image',
            id: 'im',
            assetId: 'p',
            startSec: 0,
            durationSec: 1,
            fit: 'contain',
            transform: TR({
              scale: A(0.8),
              rotation: A(10),
              opacity: A(1, [
                { t: 0, v: 0.3 },
                { t: 1, v: 1 },
              ]),
            }),
          },
        ]),
      ],
      [...specs, ...imgSpecs],
    );
    const r = await parity(
      p,
      [...specs, ...imgSpecs],
      { ...sources, ...imgSources },
      { frames: [0, 15, 29], name: 'img-contain' },
    );
    expect(r.maxErr, r.worst).toBeLessThan(TOL + 4);
  });

  it('PNG alpha is preserved through the layer (half transparent image)', async () => {
    const p = makeProject(
      [
        track('video', [vitem('bg', 'b', 0, 1)]),
        track('overlay', [
          { type: 'image', id: 'im', assetId: 'pa', startSec: 0, durationSec: 1, fit: 'native' },
        ]),
      ],
      [...specs, ...imgSpecs],
    );
    const r = await exportProject(p, files([...specs, ...imgSpecs]), settingsFor(160, 284));
    const f = frameAt(r.out, 3);
    expect(f.px(60, 142)[1]).toBeGreaterThan(230); // opaque green half (x 30..80)
    expect(f.px(100, 142)[2]).toBeGreaterThan(230); // transparent half shows the blue clip
    expect(f.px(100, 142)[1]).toBeLessThan(30);
  });
});
