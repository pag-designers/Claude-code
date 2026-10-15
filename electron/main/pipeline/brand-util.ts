/** Pure helpers for branded renders. */

const pad = (n: number, w: number): string => String(n).padStart(w, '0');

function shiftStamp(h: string, m: string, s: string, ms: string, delta: number, sep: string): string {
  const total = Math.max(0, Math.round(((+h * 60 + +m) * 60 + +s) * 1000 + +ms + delta * 1000));
  const hh = Math.floor(total / 3_600_000);
  const mm = Math.floor((total % 3_600_000) / 60_000);
  const ss = Math.floor((total % 60_000) / 1000);
  return `${pad(hh, 2)}:${pad(mm, 2)}:${pad(ss, 2)}${sep}${pad(total % 1000, 3)}`;
}

/**
 * Shifts every cue time of an SRT (`,` millisecond separator) or WebVTT (`.`) document by `deltaSec`.
 * Used when an intro is joined in front of a clip, so the sidecar subtitle files stay in sync with the video.
 */
export function shiftSubtitleText(text: string, deltaSec: number): string {
  if (!deltaSec) return text;
  return text.replace(
    /(\d{1,2}):(\d{2}):(\d{2})([.,])(\d{3})/g,
    (_m, h: string, m: string, s: string, sep: string, ms: string) =>
      shiftStamp(h, m, s, ms, deltaSec, sep),
  );
}
