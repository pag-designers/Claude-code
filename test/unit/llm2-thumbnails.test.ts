import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { imageSize, sniffMediaType } from '@main/services/llm/images';
import { mapRanking } from '@main/services/llm/thumbnails';
import { StubAnthropic } from './llm-stub-server';
import {
  expectNoForbiddenParams,
  jsonReply,
  makeCost,
  makeV2,
  wireBlocks,
  wireSystem,
} from './llm2-harness';

const stub = new StubAnthropic();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipfern-thumbs-'));
beforeAll(async () => {
  await stub.start();
});
afterAll(async () => {
  await stub.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => stub.reset());

/** A minimal JPEG-looking file: SOI, APP0, SOF0 with the size, EOI. Enough for header parsing. */
function fakeJpeg(w: number, h: number, seed = 0): Buffer {
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
  ]);
  const sof = Buffer.alloc(19);
  sof.set([0xff, 0xc0, 0x00, 0x11, 0x08]);
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  sof.set([3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1], 9);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([seed, 0xff, 0xd9])]);
}
function frame(i: number, w = 540, h = 960): { index: number; file: string } {
  const file = path.join(dir, `f${i}-${w}x${h}.jpg`);
  fs.writeFileSync(file, fakeJpeg(w, h, i));
  return { index: 10 + i, file }; // caller's indices are NOT 0..n-1
}

const clip = {
  title: 'He called every customer',
  hook: 'The first million was the easy part',
  startSec: 57.2,
  endSec: 107.6,
  text: 'We lost forty percent of our customers. I called every single one of them myself.',
  whyItWorks: null,
  score: 80,
};

describe('rankThumbnails()', () => {
  it('sends frames as base64 image blocks AFTER the cached instructions + clip context and BEFORE the task', async () => {
    stub.replies = [
      jsonReply({
        ranking: [
          { frame: 2, note: 'sharp, eyes open, mid-gesture' },
          { frame: 3, note: 'slightly soft' },
          { frame: 1, note: 'mid-blink' },
        ],
        overlayText: 'He called every customer',
      }),
    ];
    const cost = makeCost();
    const { service } = makeV2(stub, { cost });
    const frames = [frame(0), frame(1), frame(2)];
    const r = await service.rankThumbnails({ clip, frames });

    const b = stub.requests[0]!.body;
    expectNoForbiddenParams(b);
    expect(b).not.toHaveProperty('tools');
    expect(b.model).toBe('claude-sonnet-5-5');
    expect(b.output_config?.effort).toBe('low');
    expect(wireSystem(b)[0]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(wireSystem(b)[0]!.text).toContain('How to judge a frame');

    const blocks = wireBlocks(b);
    expect(blocks.map((x) => x.type)).toEqual([
      'text',
      'text',
      'image',
      'text',
      'image',
      'text',
      'image',
      'text',
    ]);
    expect(blocks[0]!.cache_control).toEqual({ type: 'ephemeral' }); // instructions-side context first
    expect(blocks[0]!.text).toContain('<clip_text>');
    expect(blocks.slice(1).every((x) => x.cache_control === undefined)).toBe(true);
    expect(blocks[1]!.text).toBe('Frame 1');
    expect(blocks[3]!.text).toBe('Frame 2');
    expect(blocks.at(-1)!.text).toContain('Rank the 3 frames');
    for (const [k, fr] of frames.entries()) {
      const img = blocks[2 + k * 2]!;
      expect(img.source?.type).toBe('base64');
      expect(img.source?.media_type).toBe('image/jpeg');
      expect(Buffer.from(img.source!.data!, 'base64').equals(fs.readFileSync(fr.file))).toBe(true);
    }
    // ranking is mapped back to the CALLER's indices (10, 11, 12), 1-based ranks
    expect(r.ranking).toEqual([
      { index: 11, rank: 1, note: 'sharp, eyes open, mid-gesture' },
      { index: 12, rank: 2, note: 'slightly soft' },
      { index: 10, rank: 3, note: 'mid-blink' },
    ]);
    expect(r.overlayText).toBe('He called every customer');
    expect(cost.rows[0]!.purpose).toBe('thumbnails');
  });

  it('frames that are already small are sent unchanged and never downscaled; big ones go through the downscaler', async () => {
    stub.replies = [
      jsonReply({
        ranking: [
          { frame: 1, note: 'a' },
          { frame: 2, note: 'b' },
        ],
        overlayText: '',
      }),
    ];
    const calls: number[] = [];
    const small = frame(0, 720, 1280); // width <= 720 -> as-is
    const big = frame(1, 1080, 1920);
    const shrunk = fakeJpeg(432, 768, 99);
    const { service } = makeV2(stub, {
      downscaleImage: (data, max) => {
        calls.push(max);
        expect(imageSize(data)).toEqual({ width: 1080, height: 1920 });
        return Promise.resolve({ data: shrunk, mediaType: 'image/jpeg' });
      },
    });
    await service.rankThumbnails({ clip, frames: [small, big] });
    expect(calls).toEqual([768]); // only the big frame
    const blocks = wireBlocks(stub.requests[0]!.body);
    expect(
      Buffer.from(blocks[2]!.source!.data!, 'base64').equals(fs.readFileSync(small.file)),
    ).toBe(true);
    expect(Buffer.from(blocks[4]!.source!.data!, 'base64').equals(shrunk)).toBe(true);
  });

  it('without any downscaler (plain Node) big frames are still sent, with one log line', async () => {
    stub.replies = [jsonReply({ ranking: [{ frame: 1, note: 'a' }], overlayText: '' })];
    const { service } = makeV2(stub);
    const big = frame(0, 1080, 1920);
    await service.rankThumbnails({ clip, frames: [big] });
    const blocks = wireBlocks(stub.requests[0]!.body);
    expect(Buffer.from(blocks[2]!.source!.data!, 'base64').equals(fs.readFileSync(big.file))).toBe(
      true,
    );
  });

  it('uses at most 6 frames', async () => {
    stub.replies = [
      jsonReply({
        ranking: Array.from({ length: 6 }, (_, i) => ({ frame: i + 1, note: 'n' })),
        overlayText: '',
      }),
    ];
    const { service, logs } = makeV2(stub);
    const r = await service.rankThumbnails({
      clip,
      frames: Array.from({ length: 8 }, (_, i) => frame(i)),
    });
    expect(wireBlocks(stub.requests[0]!.body).filter((x) => x.type === 'image')).toHaveLength(6);
    expect(r.ranking).toHaveLength(6);
    expect(logs.some((l) => l.includes('ranking the first 6'))).toBe(true);
  });

  it('an unknown / repeated frame number is reported once; frames the model forgot are appended last', async () => {
    stub.replies = [
      jsonReply({
        ranking: [
          { frame: 7, note: 'ghost' },
          { frame: 2, note: 'b' },
          { frame: 2, note: 'again' },
        ],
        overlayText: '',
      }),
      jsonReply({
        ranking: [
          { frame: 2, note: 'b' },
          { frame: 1, note: 'a' },
        ],
        overlayText: '',
      }),
    ];
    const { service } = makeV2(stub);
    const r = await service.rankThumbnails({ clip, frames: [frame(0), frame(1), frame(2)] });
    expect(stub.requests).toHaveLength(2);
    const repair = wireBlocks(stub.requests[1]!.body).at(-1)!.text!;
    expect(repair).toContain('unknown frame number 7');
    expect(repair).toContain('frame 2 is ranked twice');
    expect(r.ranking.map((x) => x.index)).toEqual([11, 10, 12]); // forgotten frame 3 goes last
    expect(r.ranking[2]!.note).toBe('Not assessed by the model.');
  });

  it('overlay text over 5 words becomes empty (a broken phrase is worse than none)', async () => {
    const doc = { ranking: [{ frame: 1, note: 'a' }], overlayText: 'one two three four five six' };
    stub.replies = [jsonReply(doc), jsonReply(doc)];
    const { service } = makeV2(stub);
    const r = await service.rankThumbnails({ clip, frames: [frame(0)] });
    expect(r.overlayText).toBe('');
    expect(stub.requests).toHaveLength(2);
  });

  it('over the monthly target the fast model ranks; hard errors are typed', async () => {
    stub.replies = [jsonReply({ ranking: [{ frame: 1, note: 'a' }], overlayText: '' })];
    const { service } = makeV2(stub, { cost: makeCost({ spentUsd: 31 }) });
    await service.rankThumbnails({ clip, frames: [frame(0)] });
    expect(stub.requests[0]!.body.model).toBe('claude-haiku-5-5');
    await expect(service.rankThumbnails({ clip, frames: [] })).rejects.toMatchObject({
      code: 'bad-request',
    });
    await expect(
      service.rankThumbnails({ clip, frames: [{ index: 0, file: path.join(dir, 'missing.jpg') }] }),
    ).rejects.toMatchObject({ code: 'bad-request' });
    const txt = path.join(dir, 'not-an-image.jpg');
    fs.writeFileSync(txt, 'hello');
    await expect(
      service.rankThumbnails({ clip, frames: [{ index: 0, file: txt }] }),
    ).rejects.toMatchObject({
      code: 'bad-request',
    });
  });
});

describe('image helpers', () => {
  it('reads JPEG and PNG sizes from the header and sniffs the type', () => {
    expect(imageSize(fakeJpeg(432, 768))).toEqual({ width: 432, height: 768 });
    const png = Buffer.alloc(33);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    png.writeUInt32BE(640, 16);
    png.writeUInt32BE(360, 20);
    expect(imageSize(png)).toEqual({ width: 640, height: 360 });
    expect(sniffMediaType(png)).toBe('image/png');
    expect(sniffMediaType(Buffer.from('nope'))).toBeNull();
  });
  it('mapRanking leaves a complete ranking untouched', () => {
    const r = mapRanking(
      {
        ranking: [
          { frame: 2, note: ' x ' },
          { frame: 1, note: 'y' },
        ],
        overlayText: '"Hi there"',
      },
      2,
    );
    expect(r.order).toEqual([2, 1]);
    expect(r.overlay).toBe('Hi there');
    expect(r.problems).toEqual([]);
  });
});
