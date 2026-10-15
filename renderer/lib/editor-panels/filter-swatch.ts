/**
 * Preview swatches for the Effects tab. Each look is previewed by pushing a fixed set of sample colours through the
 * SAME colour maths the compositor and the exporter use (`resolveColor` + `applyColor` in shared/editor-eval.ts),
 * so a tile shows what the filter really does to skin, sky, grass and greys.
 */
import { colorSchema } from '@shared/editor';
import { applyColor, resolveColor } from '@shared/editor-eval';

type RGB = readonly [number, number, number];

const SAMPLES: readonly RGB[] = [
  [0.86, 0.66, 0.56], // skin
  [0.36, 0.6, 0.9], // sky
  [0.3, 0.65, 0.32], // grass
  [0.86, 0.2, 0.2], // red
  [0.95, 0.8, 0.25], // yellow
  [0.5, 0.5, 0.5], // mid grey
  [0.16, 0.16, 0.32], // shadow blue
  [0.95, 0.95, 0.9], // paper
];
const RAMP: readonly RGB[] = [0, 0.25, 0.5, 0.75, 1].map((v) => [v, v, v] as const);

const css = ([r, g, b]: RGB): string =>
  `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`;

/** The sample colours after applying the filter (`null` = the original). */
export function filterColors(filter: string | null): { samples: string[]; ramp: string[] } {
  const eff = resolveColor(colorSchema.parse({ filter }), 0);
  const map = (c: RGB) => css(applyColor(c, eff));
  return { samples: SAMPLES.map(map), ramp: RAMP.map(map) };
}

/** CSS `background` value: colour stripes over a grey ramp. */
export function filterSwatchBackground(filter: string | null): string {
  const { samples, ramp } = filterColors(filter);
  const n = samples.length;
  const stripes = samples
    .map((c, i) => `${c} ${(i / n) * 100}% ${((i + 1) / n) * 100}%`)
    .join(', ');
  return `linear-gradient(90deg, ${stripes}) top / 100% 62% no-repeat, linear-gradient(90deg, ${ramp.join(', ')}) bottom / 100% 38% no-repeat`;
}
