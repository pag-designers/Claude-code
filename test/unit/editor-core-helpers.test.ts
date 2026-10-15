import { describe, expect, it } from 'vitest';
import {
  ASPECT_SIZES,
  TRACK_ACCEPTS,
  itemSchema,
  projectSchema,
  trackSchema,
  type ItemType,
  type ShapeKind,
  type TrackKind,
} from '@shared/editor';
import {
  TRANSPORT_RATES,
  emptyProject,
  firstCompatibleTrack,
  frameDuration,
  makeAudioItem,
  makeImageItem,
  makeShapeItem,
  makeSubtitleItem,
  makeTextItem,
  makeTrack,
  makeVideoItem,
  newId,
  pxToTime,
  snapToFrame,
  timeToPx,
  trackAccepts,
} from '../../renderer/lib/editor/core';
import { asset, proj, track } from './editor-core-fixtures';

describe('newId', () => {
  it('prefixes and is unique across many calls', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 20000; i++) ids.add(newId('it'));
    expect(ids.size).toBe(20000);
    expect(newId('tr').startsWith('tr_')).toBe(true);
    expect(newId('mk')).toMatch(/^mk_[a-z0-9]+$/);
  });
});

describe('emptyProject', () => {
  it('has Video (speech), Subtitles, Text, Music', () => {
    const p = emptyProject();
    expect(p.tracks.map((t) => [t.kind, t.name, t.speech])).toEqual([
      ['video', 'Video', true],
      ['subtitle', 'Subtitles', false],
      ['text', 'Text', false],
      ['audio', 'Music', false],
    ]);
    expect(projectSchema.safeParse(p).success).toBe(true);
    expect(new Set(p.tracks.map((t) => t.id)).size).toBe(4);
  });

  it('sizes the canvas for every aspect', () => {
    for (const a of ['9:16', '1:1', '16:9', '4:5'] as const) {
      const p = emptyProject(a);
      expect([p.canvas.width, p.canvas.height]).toEqual([
        ASPECT_SIZES[a].width,
        ASPECT_SIZES[a].height,
      ]);
      expect(p.canvas.aspect).toBe(a);
    }
    expect(emptyProject('custom').canvas.aspect).toBe('custom');
    expect(emptyProject().canvas.fps).toBe(30);
  });
});

describe('factories produce items that pass itemSchema', () => {
  const vid = asset('v', 'video', 12.5);
  const aud = asset('a', 'audio', 200);
  const img = asset('i', 'image', null);

  const all = [
    ['video', makeVideoItem(vid, 3)],
    ['video w/ opts', makeVideoItem(vid, 1, { durationSec: 4, inSec: 2, name: 'x', id: 'fixed' })],
    ['audio', makeAudioItem(aud, 0)],
    ['audio w/ in', makeAudioItem(aud, 5, { inSec: 30, durationSec: 10 })],
    ['image', makeImageItem(img, 2)],
    ['text', makeTextItem('Hello 👋\nworld', 1)],
    ['text style', makeTextItem('x', 0, { style: { size: 100, color: '#ff0000' } })],
    [
      'subtitle',
      makeSubtitleItem(
        [
          { w: 'a', s: 0, e: 0.5 },
          { w: 'b', s: 0.6, e: 1 },
        ],
        4,
      ),
    ],
    ...(['rect', 'ellipse', 'line', 'arrow', 'progress-bar'] as ShapeKind[]).map(
      (k) => [`shape ${k}`, makeShapeItem(k, 0)] as const,
    ),
  ] as const;

  for (const [name, it] of all) {
    it_(name, it);
  }
  function it_(name: string, item: unknown) {
    it(`${name} parses`, () => {
      expect(itemSchema.safeParse(item).success).toBe(true);
    });
  }

  it('durations: asset duration, 5 s for images, 3 s for text/shapes, word span for cues', () => {
    expect(makeVideoItem(vid, 0).durationSec).toBe(12.5);
    expect(makeVideoItem(vid, 0, { inSec: 2 }).durationSec).toBe(10.5);
    expect(makeAudioItem(aud, 0).durationSec).toBe(200);
    expect(makeImageItem(img, 0).durationSec).toBe(5);
    expect(makeTextItem('t', 0).durationSec).toBe(3);
    expect(makeShapeItem('rect', 0).durationSec).toBe(3);
    expect(makeSubtitleItem([{ w: 'a', s: 0, e: 2.5 }], 0).durationSec).toBe(2.5);
    expect(makeVideoItem(asset('u', 'video', null), 0).durationSec).toBe(5);
  });

  it('video items mirror hasAudio into audioEnabled; names default to the asset name', () => {
    expect(makeVideoItem(asset('s', 'video', 5, { hasAudio: false }), 0).audioEnabled).toBe(false);
    expect(makeVideoItem(vid, 0).audioEnabled).toBe(true);
    expect(makeVideoItem(vid, 0).name).toBe('v');
    expect(makeVideoItem(vid, 0).assetId).toBe('v');
  });

  it('clamps negative starts and tiny durations', () => {
    expect(makeTextItem('x', -5).startSec).toBe(0);
    expect(makeTextItem('x', 0, { durationSec: 0 }).durationSec).toBe(0.04);
    expect(makeSubtitleItem([], 0).durationSec).toBeGreaterThanOrEqual(0.04);
  });

  it('every call yields a fresh id', () => {
    expect(makeTextItem('x', 0).id).not.toBe(makeTextItem('x', 0).id);
  });

  it('subtitle words are sanitised (end ≥ start, colour null)', () => {
    const c = makeSubtitleItem([{ w: 'x', s: 1, e: 0.5 }], 0);
    expect(c.words[0]).toEqual({ w: 'x', s: 1, e: 1, color: null });
  });
});

describe('time ↔ pixels, frames', () => {
  it('timeToPx / pxToTime are inverses', () => {
    for (const [t, z, s] of [
      [0, 100, 0],
      [12.5, 37, 3],
      [100, 600, 99],
      [0.25, 1, 0],
    ] as const) {
      expect(pxToTime(timeToPx(t, z, s), z, s)).toBeCloseTo(t, 10);
    }
    expect(timeToPx(5, 100, 2)).toBe(300);
    expect(pxToTime(300, 100, 2)).toBe(5);
  });

  it('frameDuration / snapToFrame', () => {
    expect(frameDuration(30)).toBeCloseTo(1 / 30);
    expect(frameDuration(25)).toBe(0.04);
    expect(snapToFrame(1.0123, 30)).toBeCloseTo(30 / 30);
    expect(snapToFrame(0.017, 30)).toBeCloseTo(1 / 30);
    expect(snapToFrame(0.016, 60)).toBeCloseTo(1 / 60);
    expect(snapToFrame(5, 24)).toBe(5);
  });

  it('TRANSPORT_RATES', () => {
    expect([...TRANSPORT_RATES]).toEqual([1, 2, 4, 8]);
  });
});

describe('track compatibility', () => {
  it('trackAccepts mirrors TRACK_ACCEPTS', () => {
    const kinds = Object.keys(TRACK_ACCEPTS) as TrackKind[];
    const types: ItemType[] = ['video', 'image', 'audio', 'text', 'subtitle', 'shape'];
    for (const k of kinds)
      for (const t of types)
        expect(trackAccepts({ kind: k }, t)).toBe(TRACK_ACCEPTS[k].includes(t));
  });

  it('firstCompatibleTrack prefers the natural kind and skips locked tracks', () => {
    const p = proj([
      track('ov', 'overlay', []),
      track('v1', 'video', [], { locked: true }),
      track('v2', 'video', []),
      track('t', 'text', []),
      track('m', 'audio', []),
      track('s', 'subtitle', []),
    ]);
    expect(firstCompatibleTrack(p, 'video')?.id).toBe('v2');
    expect(firstCompatibleTrack(p, 'text')?.id).toBe('t');
    expect(firstCompatibleTrack(p, 'audio')?.id).toBe('m');
    expect(firstCompatibleTrack(p, 'subtitle')?.id).toBe('s');
    expect(firstCompatibleTrack(p, 'image')?.id).toBe('ov');
    expect(firstCompatibleTrack(p, 'shape')?.id).toBe('ov');
  });

  it('returns null when nothing fits', () => {
    expect(firstCompatibleTrack(proj([track('v1', 'video', [])]), 'subtitle')).toBeNull();
    expect(firstCompatibleTrack(proj([track('m', 'audio', [])]), 'video')).toBeNull();
  });

  it('makeTrack parses and video tracks default to speech', () => {
    expect(trackSchema.safeParse(makeTrack('video')).success).toBe(true);
    expect(makeTrack('video').speech).toBe(true);
    expect(makeTrack('audio').speech).toBe(false);
    expect(makeTrack('text', 'Titles').name).toBe('Titles');
  });
});
