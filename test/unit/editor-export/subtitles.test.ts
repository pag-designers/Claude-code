/** Subtitle track: burnt-in captions (one block per cue), per-line style, per-word colours, SRT / VTT. */
import { describe, expect, it, vi } from 'vitest';
import { BUILTIN_STYLE_IDS, captionStyleSchema } from '../../../shared/cp2';
import { exportProject, files, bboxWhere, flatClip, frameAt, haveFfmpeg, isMagenta, isRed, isWhite, isYellow, makeProject, settingsFor, track, getStyle } from './helpers';
import { buildSubtitleCues } from '../../../electron/main/services/editor-export/overlays';

vi.setConfig({ testTimeout: 60_000 });

const specs = [{ id: 'bg', kind: 'video' as const, path: flatClip('204060', 3, 270, 480), w: 270, h: 480, fps: 30, dur: 3 }];
const w = (s: number, e: number, t: string, color: string | null = null) => ({ w: t, s, e, color });
const cue = (id: string, start: number, dur: number, words: ReturnType<typeof w>[], over: Record<string, unknown> = {}) => ({
  type: 'subtitle', id, startSec: start, durationSec: dur, words, styleId: 'clean-pop', ...over,
});
const bgTrack = track('video', [{ type: 'video', id: 'v', assetId: 'bg', startSec: 0, durationSec: 3 }]);

async function render(cues: Record<string, unknown>[], settings: Parameters<typeof settingsFor>[2] = {}, range?: { startSec: number; endSec: number }) {
  const p = makeProject([bgTrack, track('subtitle', cues)], specs, { width: 270, height: 480 });
  const r = await exportProject(p, files(specs), settingsFor(270, 480, settings), { name: 'subs', range });
  return { r, p };
}

describe.skipIf(!haveFfmpeg)('subtitle track burn-in', () => {
  it('the cue is on screen for its whole duration, not only while words are spoken', async () => {
    const { r } = await render([cue('c', 0.5, 1.5, [w(0.5, 0.9, 'Hello'), w(0.9, 1.3, 'there')])]);
    const text = (k: number) => bboxWhere(frameAt(r.out, k), (a, b, c) => a > 200 && b > 200 && c > 200).n;
    expect(text(14)).toBe(0); // 0.467 s: before the cue
    expect(text(16)).toBeGreaterThan(50); // 0.533 s: cue visible, no word active yet (first word at 1.0)
    expect(text(40)).toBeGreaterThan(50); // 1.33 s: both words spoken, cue still up
    expect(text(59)).toBeGreaterThan(50); // 1.97 s
    expect(text(61)).toBe(0); // after the item ends (2.0 s)
  });

  it('the active word is the last word that has started (none before the first word)', async () => {
    const { r } = await render([cue('c', 0, 2, [w(0.4, 0.7, 'one'), w(0.7, 1.0, 'two'), w(1.0, 1.3, 'three')])]);
    const yellow = (k: number) => bboxWhere(frameAt(r.out, k), isYellow).n;
    expect(yellow(5)).toBe(0); // 0.17 s: nothing active
    expect(yellow(14)).toBeGreaterThan(20); // 0.47: "one"
    const xOf = (k: number) => bboxWhere(frameAt(r.out, k), isYellow).cx;
    expect(xOf(14)).toBeLessThan(xOf(24)); // moves right
    expect(xOf(24)).toBeLessThan(xOf(36));
    expect(yellow(55)).toBeGreaterThan(20); // after the last word the last word stays active
    expect(xOf(55)).toBeCloseTo(xOf(36), -1);
  });

  it('burnCaptions = false renders no caption pixels (the cues still export as SRT)', async () => {
    const on = await render([cue('c', 0, 2, [w(0.1, 0.5, 'Hello')])], { burnCaptions: true });
    const off = await render([cue('c', 0, 2, [w(0.1, 0.5, 'Hello')])], { burnCaptions: false });
    expect(bboxWhere(frameAt(on.r.out, 20), isYellow).n).toBeGreaterThan(20);
    expect(bboxWhere(frameAt(off.r.out, 20), (a, b, c) => a > 150 && b > 150).n).toBe(0);
    expect(off.r.srt).toContain('Hello');
  });

  it('per-line style: two cues with different presets render with their own colours / position', async () => {
    const { r } = await render([
      cue('a', 0, 1.4, [w(0.1, 0.6, 'Alpha')], { styleId: 'clean-pop' }),
      cue('b', 1.5, 1.4, [w(0.1, 0.6, 'Beta')], { styleId: 'minimal-lower-third' }),
    ]);
    const a = frameAt(r.out, 20);
    const b = frameAt(r.out, 60);
    expect(bboxWhere(a, isYellow).n).toBeGreaterThan(20); // clean-pop highlight #FFD60A
    expect(bboxWhere(b, isYellow).n).toBe(0);
    const notBg = (x: number, y: number, z: number) => Math.abs(x - 0x20) + Math.abs(y - 0x40) + Math.abs(z - 0x60) > 120;
    const ab = bboxWhere(a, notBg);
    const bb = bboxWhere(b, notBg);
    expect(Math.abs(ab.cx - 135)).toBeLessThan(15); // clean-pop is centred
    expect(bb.cx).toBeLessThan(135); // minimal-lower-third is left aligned
    expect(bb.cy).toBeGreaterThan(ab.cy - 5); // sits lower (73 % vs 69 %)
  });

  it('styleOverride wins over styleId', async () => {
    const st = captionStyleSchema.parse({ ...getStyle('clean-pop'), id: 'custom', fill: '#FF0000', highlight: { mode: 'none', color: '#FF0000', boxColor: '#FF0000', scale: 1 } });
    const { r } = await render([cue('c', 0, 2, [w(0, 0.5, 'Hello')], { styleId: 'clean-pop', styleOverride: st })]);
    expect(bboxWhere(frameAt(r.out, 20), isRed).n).toBeGreaterThan(100);
    expect(bboxWhere(frameAt(r.out, 20), isYellow).n).toBe(0);
  });

  it('per-word colour replaces the keyword colour as the idle colour', async () => {
    const withColor = await render([cue('c', 0, 2, [w(0, 0.4, 'plain'), w(0.4, 0.8, 'pink', '#FF00FF'), w(0.8, 1.2, 'end')])]);
    const without = await render([cue('c', 0, 2, [w(0, 0.4, 'plain'), w(0.4, 0.8, 'pink'), w(0.8, 1.2, 'end')])]);
    expect(bboxWhere(frameAt(withColor.r.out, 8), isMagenta).n).toBeGreaterThan(30); // 0.27 s: "pink" idle
    expect(bboxWhere(frameAt(without.r.out, 8), isMagenta).n).toBe(0);
    // when it is the active word the highlight colour takes over
    expect(bboxWhere(frameAt(withColor.r.out, 15), isMagenta).n).toBeLessThan(bboxWhere(frameAt(withColor.r.out, 8), isMagenta).n);
  });

  it('a cue with punctuation stays ONE block (the caption chunker is not run over an editor cue)', async () => {
    const { r } = await render([cue('c', 0, 2, [w(0, 0.3, 'One.'), w(0.6, 0.9, 'Two.'), w(1.2, 1.5, 'Three.')], { styleId: 'tiktok-classic' })]);
    const f = frameAt(r.out, 15); // 0.5 s: everything on screen at once
    const b = bboxWhere(f, (x, y, z) => x > 200 && y > 200 && z > 200);
    const bAll = bboxWhere(frameAt(r.out, 50), (x, y, z) => x > 200 && y > 200 && z > 200);
    expect(b.n).toBeGreaterThan(100);
    expect(Math.abs(b.w - bAll.w)).toBeLessThan(6);
  });

  it('the entrance (fade) runs at the cue start, not at the first word', async () => {
    const { r } = await render([cue('c', 0.2, 2, [w(0.8, 1.2, 'Late')], { styleId: 'minimal-lower-third' })]);
    const lum = (k: number) => bboxWhere(frameAt(r.out, k), (x, y, z) => x > 90 && y > 90 && z > 120).n;
    expect(lum(7)).toBeLessThan(lum(12)); // fading in right after 0.2 s
    expect(lum(12)).toBeGreaterThan(5);
    expect(Math.abs(lum(20) - lum(30))).toBeLessThan(lum(30) * 0.5 + 10); // no second entrance at the first word (1.0 s)
  });

  for (const id of BUILTIN_STYLE_IDS) {
    it(`preset ${id} renders visible text`, async () => {
      const { r } = await render([cue('c', 0, 1.2, [w(0.1, 0.5, 'Preset'), w(0.5, 0.9, 'check')], { styleId: id })]);
      const f = frameAt(r.out, 22);
      const diff = bboxWhere(f, (x, y, z) => Math.abs(x - 0x20) + Math.abs(y - 0x40) + Math.abs(z - 0x60) > 120);
      expect(diff.n, id).toBeGreaterThan(80);
    });
  }

  it('a range export shifts cues to the range start', async () => {
    const { r } = await render([cue('c', 1.0, 1.0, [w(0, 0.4, 'Shifted')])], {}, { startSec: 1.2, endSec: 1.8 });
    expect(bboxWhere(frameAt(r.out, 2), (x, y, z) => x > 200 && y > 180 && z < 120).n).toBeGreaterThan(20);
    expect(r.srt).toContain('00:00:00,000 --> 00:00:00,600');
  });
});

describe('SRT / VTT from the subtitle track', () => {
  const project = (items: unknown[]) => ({ tracks: [{ kind: 'subtitle', items }] }) as never;
  const sub = (id: string, s: number, d: number, words: string[]) => ({ type: 'subtitle', id, startSec: s, durationSec: d, words: words.map((t, i) => ({ w: t, s: i * 0.2, e: i * 0.2 + 0.2, color: null })) });

  it('one cue per subtitle item, SRT timestamps with commas', () => {
    const c = buildSubtitleCues(project([sub('a', 1, 2, ['Hello', 'world']), sub('b', 4, 1, ['Bye'])]), 0, 10);
    expect(c.srt).toBe('1\n00:00:01,000 --> 00:00:03,000\nHello world\n\n2\n00:00:04,000 --> 00:00:05,000\nBye\n');
    expect(c.vtt).toMatch(/^WEBVTT\n\n00:00:01\.000 --> 00:00:03\.000\nHello world\n/);
  });

  it('cues are shifted by the range start and clipped to it', () => {
    const c = buildSubtitleCues(project([sub('a', 1, 2, ['Hello']), sub('b', 4, 1, ['Out'])]), 2, 3.5);
    expect(c.srt).toBe('1\n00:00:00,000 --> 00:00:01,000\nHello\n');
  });

  it('VTT escapes &, < and -->', () => {
    const c = buildSubtitleCues(project([sub('a', 0, 1, ['a&b', '<i>', '-->'])]), 0, 5);
    expect(c.vtt).toContain('a&amp;b &lt;i> --&gt;');
  });

  it('no subtitle items → null', () => {
    expect(buildSubtitleCues(project([]), 0, 5)).toEqual({ srt: null, vtt: null });
  });

  it('cues are sorted by time even across tracks / unsorted items', () => {
    const c = buildSubtitleCues(project([sub('b', 4, 1, ['Second']), sub('a', 1, 1, ['First'])]), 0, 10);
    expect(c.srt?.indexOf('First')).toBeLessThan(c.srt?.indexOf('Second') as number);
  });

  it('empty-word items are skipped', () => {
    const c = buildSubtitleCues(project([sub('a', 0, 1, ['  ', ''])]), 0, 5);
    expect(c.srt).toBeNull();
  });
});
