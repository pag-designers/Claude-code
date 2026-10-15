/**
 * YouTube Data API quota resets at midnight US Pacific Time (PST/PDT, DST aware). Pure, uses Intl only.
 */
const TZ = 'America/Los_Angeles';

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

interface Wall {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

function wallAt(ms: number): Wall {
  const out: Record<string, number> = {};
  for (const p of fmt.formatToParts(new Date(ms))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return {
    y: out.year ?? 1970,
    m: out.month ?? 1,
    d: out.day ?? 1,
    h: out.hour ?? 0,
    mi: out.minute ?? 0,
    s: out.second ?? 0,
  };
}

/** Pacific UTC offset (ms, negative) at the instant `ms`. */
function offsetAt(ms: number): number {
  const w = wallAt(ms);
  const asUtc = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The next instant (epoch ms, strictly after `nowMs`) at which it is 00:00:00 in Pacific Time. */
export function nextPacificMidnight(nowMs: number): number {
  const w = wallAt(nowMs);
  // Midnight of the next calendar day on the Pacific wall clock, expressed as if it were UTC.
  const wallMidnight = Date.UTC(w.y, w.m - 1, w.d + 1, 0, 0, 0);
  // Subtract the Pacific offset in force AT that instant; iterate because the offset may differ from "now"'s.
  let guess = wallMidnight - offsetAt(nowMs);
  for (let i = 0; i < 3; i++) {
    const next = wallMidnight - offsetAt(guess);
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

/** Whole seconds (rounded up, at least 1) until the quota resets. */
export function secondsUntilQuotaReset(nowMs: number): number {
  return Math.max(1, Math.ceil((nextPacificMidnight(nowMs) - nowMs) / 1000));
}
