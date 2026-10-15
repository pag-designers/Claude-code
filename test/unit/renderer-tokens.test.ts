import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards the design system's AA contrast promise by parsing the real tokens in renderer/app/globals.css.
 * Text pairs must reach 4.5:1, focus ring / UI boundary 3:1.
 */
const css = fs.readFileSync(path.resolve(__dirname, '../../renderer/app/globals.css'), 'utf8');

function block(selector: RegExp): Record<string, string> {
  const m = css.match(new RegExp(`${selector.source}\\s*\\{([\\s\\S]*?)\\n\\}`));
  if (!m) throw new Error(`block not found: ${selector}`);
  const out: Record<string, string> = {};
  for (const d of m[1]!.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) out[d[1]!] = d[2]!.trim();
  return out;
}

const dark = block(/:root,\s*:root\[data-theme='dark'\]/);
const light = { ...dark, ...block(/:root\[data-theme='light'\]/) };

const rgb = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
};
const lin = (c: number) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (hex: string) => {
  const [r, g, b] = rgb(hex).map(lin) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const toHex = (c: number[]) =>
  `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/** Resolve a token to hex; `color-mix(in srgb, #x N%, transparent)` is composited over `over`. */
function resolve(theme: Record<string, string>, name: string, over?: string): string {
  const v = theme[name];
  if (!v) throw new Error(`missing token --${name}`);
  if (/^#[0-9a-f]{6}$/i.test(v)) return v;
  const mix = v.match(/color-mix\(in srgb,\s*(#[0-9a-f]{6})\s+(\d+)%,\s*transparent\)/i);
  if (mix && over) {
    const t = Number(mix[2]) / 100;
    const a = rgb(mix[1]!);
    const b = rgb(over);
    return toHex(a.map((c, i) => c * t + b[i]! * (1 - t)));
  }
  throw new Error(`cannot resolve --${name}: ${v}`);
}

describe.each([
  ['dark', dark],
  ['light', light],
] as const)('%s theme contrast (WCAG AA)', (_name, t) => {
  const hex = (n: string, over?: string) => resolve(t, n, over);

  it.each([
    ['foreground', 'background'],
    ['foreground', 'card'],
    ['muted-foreground', 'background'],
    ['muted-foreground', 'card'],
    ['muted-foreground', 'muted'],
    ['subtle', 'background'],
    ['subtle', 'card'],
    ['subtle', 'muted'],
    ['primary-text', 'background'],
    ['primary-text', 'card'],
    ['success', 'card'],
    ['warning', 'card'],
    ['danger', 'card'],
    ['info', 'card'],
    ['score-low', 'card'],
    ['score-mid', 'card'],
    ['score-good', 'card'],
    ['viral-text', 'card'],
  ])('text token --%s on --%s is >= 4.5:1', (fg, bg) => {
    expect(ratio(hex(fg), hex(bg))).toBeGreaterThanOrEqual(4.5);
  });

  it('primary button label is readable', () => {
    expect(ratio(hex('primary-foreground'), hex('primary'))).toBeGreaterThanOrEqual(4.5);
  });

  it('focus ring is visible against surfaces (>= 3:1)', () => {
    expect(ratio(hex('ring'), hex('background'))).toBeGreaterThanOrEqual(3);
    expect(ratio(hex('ring'), hex('card'))).toBeGreaterThanOrEqual(3);
  });

  it.each(['success', 'warning', 'danger', 'info'])(
    '%s text on its soft badge background is >= 4.5:1',
    (k) => {
      const soft = hex(`${k}-soft`, hex('card'));
      expect(ratio(hex(k), soft)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it('primary-text on primary-soft is >= 4.5:1', () => {
    expect(ratio(hex('primary-text'), hex('primary-soft', hex('card')))).toBeGreaterThanOrEqual(
      4.5,
    );
  });

  it('input borders are distinguishable from the field (>= 1.3:1, decorative)', () => {
    expect(ratio(hex('input'), hex('field'))).toBeGreaterThanOrEqual(1.3);
  });
});

describe('viral gradient', () => {
  it('white text on every gradient stop is >= 4.5:1', () => {
    for (const k of ['viral-a', 'viral-b', 'viral-c']) {
      expect(ratio('#ffffff', resolve(dark, k))).toBeGreaterThanOrEqual(4.5);
    }
  });
});
