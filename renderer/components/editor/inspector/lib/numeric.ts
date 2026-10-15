/* Pure logic of the scrubbable number field. */

export interface StepMods {
  shift?: boolean;
  alt?: boolean;
}

/** Shift = ×10, Alt = ×0.1 (the Figma / After Effects convention). */
export function modStep(step: number, mods: StepMods): number {
  if (mods.shift) return step * 10;
  if (mods.alt) return step * 0.1;
  return step;
}

export const clampNum = (v: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, v));

/** Rounds away binary noise (0.1 + 0.2) to `decimals`, without losing deliberate precision. */
export function roundTo(v: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.round(v * f) / f;
}

/** Parses what a user typed: accepts a comma decimal, a trailing unit, a unicode minus and a leading "+" (relative edit). */
export function parseNumeric(text: string, current: number): number | null {
  const s = text
    .trim()
    .replace(/[−–]/g, '-')
    .replace(/,/g, '.')
    .replace(/\s*(%|px|°|s|x|×|db)\s*$/i, '');
  if (s === '' || s === '-' || s === '.') return null;
  // a leading "+" means "add to the current value" ("+10"); "-5" is the number −5
  if (text.trim().startsWith('+')) {
    const add = Number(s.slice(1));
    return Number.isFinite(add) ? current + add : null;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Result of dragging `dx` px from `start`: one step per pixel. */
export function scrubValue(
  start: number,
  dx: number,
  step: number,
  mods: StepMods,
  min: number,
  max: number,
  decimals: number,
): number {
  return roundTo(clampNum(start + dx * modStep(step, mods), min, max), decimals);
}

export function formatNumeric(v: number, decimals: number): string {
  const r = roundTo(v, decimals);
  const s = r.toFixed(decimals);
  return s.startsWith('-') && Number(s) === 0 ? s.slice(1) : s;
}
