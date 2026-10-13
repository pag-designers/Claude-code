import type { AudioSignals } from '@shared/pipeline';

/**
 * Concatenates per-window AudioSignals (each re-based to its own start) into one global series.
 * Windows start at multiples of the hop, so arrays are padded/trimmed to their exact expected length
 * before being appended; silences that touch a window boundary are joined.
 */
export function mergeSignals(
  parts: { start: number; signals: AudioSignals }[],
  totalDurationSec: number,
): AudioSignals {
  const first = parts[0]?.signals;
  const hop = first?.hopSec ?? 0.5;
  const loudness: number[] = [];
  const speechRate: number[] = [];
  const silences: AudioSignals['silences'] = [];
  const laughter: AudioSignals['laughter'] = [];
  const speakerChanges: number[] = [];
  for (const { start, signals } of parts) {
    const n = Math.max(0, Math.round((start + signals.durationSec) / hop) - Math.round(start / hop));
    const base = Math.round(start / hop);
    // Align to the global grid: drop/pad so index i maps to time i*hop.
    while (loudness.length < base) loudness.push(loudness.at(-1) ?? -70);
    while (speechRate.length < base) speechRate.push(0);
    loudness.length = base;
    speechRate.length = base;
    for (let i = 0; i < n; i++) {
      loudness.push(signals.loudness[i] ?? signals.loudness.at(-1) ?? -70);
      speechRate.push(signals.speechRate[i] ?? 0);
    }
    for (const s of signals.silences) {
      const g = { s: s.s + start, e: s.e + start };
      const prev = silences.at(-1);
      if (prev && g.s - prev.e < 0.05) prev.e = Math.max(prev.e, g.e);
      else silences.push(g);
    }
    for (const l of signals.laughter) laughter.push({ ...l, s: l.s + start, e: l.e + start });
    for (const c of signals.speakerChanges) speakerChanges.push(c + start);
  }
  return {
    hopSec: hop,
    durationSec: totalDurationSec,
    loudness,
    speechRate,
    silences,
    laughter,
    speakerChanges,
    sceneCuts: [],
  };
}
