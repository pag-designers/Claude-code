/**
 * Starting points for Brand Kit text styles ("Add text styles": title / hook / CTA / lower-third presets with
 * animations). Pure data; every preset parses with `brandTextStyleSchema` (unit tested). Sizes are canvas px at
 * 1080 wide, like editor text items.
 */
import {
  brandTextStyleSchema,
  type BrandTextStyle,
  type TEXT_STYLE_KINDS,
} from '@shared/brand';

export type TextStyleKind = (typeof TEXT_STYLE_KINDS)[number];

export const TEXT_KIND_LABEL: Record<TextStyleKind, string> = {
  title: 'Title',
  hook: 'Hook',
  cta: 'Call to action',
  'lower-third': 'Lower third',
};

export const TEXT_KIND_SAMPLE: Record<TextStyleKind, string> = {
  title: 'Three habits that changed my channel',
  hook: 'Nobody tells you this about editing',
  cta: 'Follow for part 2',
  'lower-third': 'Alex Rivera\nFounder, Acme',
};

export interface TextPreset {
  key: string;
  label: string;
  kind: TextStyleKind;
  blurb: string;
  make: () => Omit<BrandTextStyle, 'id'>;
}

const parse = (v: unknown): Omit<BrandTextStyle, 'id'> => {
  const { id: _id, ...rest } = brandTextStyleSchema.parse({ id: 'x', ...(v as object) });
  return rest;
};

export const TEXT_PRESETS: readonly TextPreset[] = [
  {
    key: 'title-bold',
    label: 'Bold Title',
    kind: 'title',
    blurb: 'Heavy white title with a soft shadow.',
    make: () =>
      parse({
        name: 'Bold Title',
        kind: 'title',
        style: {
          fontFamily: 'Montserrat',
          weight: 800,
          size: 92,
          color: '#FFFFFF',
          shadow: { color: '#000000', opacity: 0.55, blur: 18, offsetX: 0, offsetY: 6 },
        },
        animIn: { type: 'pop', durationSec: 0.35 },
        animOut: { type: 'fade', durationSec: 0.25 },
        yPct: 28,
      }),
  },
  {
    key: 'title-impact',
    label: 'Impact Outline',
    kind: 'title',
    blurb: 'Condensed yellow caps with a black outline.',
    make: () =>
      parse({
        name: 'Impact Outline',
        kind: 'title',
        style: {
          fontFamily: 'Anton',
          weight: 400,
          size: 128,
          color: '#FFE94D',
          letterSpacing: 2,
          stroke: { color: '#000000', width: 8 },
        },
        animIn: { type: 'bounce', durationSec: 0.5 },
        animOut: { type: 'none', durationSec: 0.2 },
        yPct: 26,
      }),
  },
  {
    key: 'title-clean',
    label: 'Clean Serif',
    kind: 'title',
    blurb: 'Elegant serif on a soft dark box.',
    make: () =>
      parse({
        name: 'Clean Serif',
        kind: 'title',
        style: {
          fontFamily: 'DM Serif Display',
          weight: 400,
          size: 84,
          color: '#FFFFFF',
          box: { color: '#000000', opacity: 0.45, padding: 28, radius: 20 },
        },
        animIn: { type: 'fade', durationSec: 0.5 },
        animOut: { type: 'fade', durationSec: 0.4 },
        yPct: 30,
      }),
  },
  {
    key: 'hook-card',
    label: 'Hook Card',
    kind: 'hook',
    blurb: 'Dark text on a white card, the classic opener.',
    make: () =>
      parse({
        name: 'Hook Card',
        kind: 'hook',
        style: {
          fontFamily: 'Montserrat',
          weight: 800,
          size: 76,
          color: '#101114',
          box: { color: '#FFFFFF', opacity: 1, padding: 30, radius: 28 },
        },
        animIn: { type: 'pop', durationSec: 0.35 },
        animOut: { type: 'fade', durationSec: 0.25 },
        yPct: 18,
      }),
  },
  {
    key: 'hook-neon',
    label: 'Hook Spotlight',
    kind: 'hook',
    blurb: 'Bebas caps with a bright outline, types in.',
    make: () =>
      parse({
        name: 'Hook Spotlight',
        kind: 'hook',
        style: {
          fontFamily: 'Bebas Neue',
          weight: 400,
          size: 128,
          color: '#FFFFFF',
          letterSpacing: 3,
          stroke: { color: '#6A4BF2', width: 10 },
          shadow: { color: '#6A4BF2', opacity: 0.7, blur: 30, offsetX: 0, offsetY: 0 },
        },
        animIn: { type: 'typewriter', durationSec: 0.8 },
        animOut: { type: 'fade', durationSec: 0.3 },
        yPct: 20,
      }),
  },
  {
    key: 'cta-pill',
    label: 'Follow Pill',
    kind: 'cta',
    blurb: 'A rounded violet pill that slides up.',
    make: () =>
      parse({
        name: 'Follow Pill',
        kind: 'cta',
        style: {
          fontFamily: 'Poppins',
          weight: 700,
          size: 56,
          color: '#FFFFFF',
          box: { color: '#6A4BF2', opacity: 1, padding: 26, radius: 60 },
        },
        animIn: { type: 'slide', durationSec: 0.4 },
        animOut: { type: 'fade', durationSec: 0.25 },
        yPct: 74,
      }),
  },
  {
    key: 'cta-subscribe',
    label: 'Subscribe Bar',
    kind: 'cta',
    blurb: 'Bold white label on a red bar.',
    make: () =>
      parse({
        name: 'Subscribe Bar',
        kind: 'cta',
        style: {
          fontFamily: 'Montserrat',
          weight: 800,
          size: 54,
          color: '#FFFFFF',
          box: { color: '#E11D48', opacity: 1, padding: 22, radius: 14 },
        },
        animIn: { type: 'scale', durationSec: 0.35 },
        animOut: { type: 'scale', durationSec: 0.25 },
        yPct: 76,
      }),
  },
  {
    key: 'lt-plate',
    label: 'Name Plate',
    kind: 'lower-third',
    blurb: 'Left-aligned name on a dark glass box.',
    make: () =>
      parse({
        name: 'Name Plate',
        kind: 'lower-third',
        style: {
          fontFamily: 'Poppins',
          weight: 600,
          size: 44,
          color: '#FFFFFF',
          align: 'left',
          lineHeight: 1.25,
          box: { color: '#0C0C13', opacity: 0.72, padding: 24, radius: 16 },
        },
        animIn: { type: 'slide', durationSec: 0.45 },
        animOut: { type: 'slide', durationSec: 0.35 },
        yPct: 68,
      }),
  },
  {
    key: 'lt-mono',
    label: 'Mono Tag',
    kind: 'lower-third',
    blurb: 'Compact monospaced tag, no box.',
    make: () =>
      parse({
        name: 'Mono Tag',
        kind: 'lower-third',
        style: {
          fontFamily: 'IBM Plex Mono',
          weight: 600,
          size: 38,
          color: '#FFFFFF',
          align: 'left',
          shadow: { color: '#000000', opacity: 0.7, blur: 8, offsetX: 0, offsetY: 3 },
        },
        animIn: { type: 'typewriter', durationSec: 0.6 },
        animOut: { type: 'fade', durationSec: 0.3 },
        yPct: 70,
      }),
  },
];

export function presetsOfKind(kind: TextStyleKind): TextPreset[] {
  return TEXT_PRESETS.filter((p) => p.kind === kind);
}
