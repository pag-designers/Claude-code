import { DAY_MS, isoWeekId, weekStart } from './date';
import { seededRandom, shuffle } from './random';

export type LeagueBot = { name: string; avatar: string; /** Average XP per day. */ pace: number };
export type League = { weekId: string; bots: LeagueBot[] };

const NAMES = [
  'Segfault Sam',
  'Null Pointer Nia',
  'Tabs-not-Spaces Tom',
  'Merge Conflict Mo',
  'Rubber Duck Rita',
  'Off-By-One Olu',
  'YAML Yvonne',
  'Sudo Sudha',
  'Regex Rex',
  'Flaky Test Finn',
  'Kernel Panic Kai',
  'Linty McLintface',
  'Race Condition Ray',
  'Heisenbug Hana',
];

const AVATARS = ['🐙', '🦊', '🐼', '🦉', '🐸', '🐧', '🦄', '🐢', '🦝', '🐝', '🐳', '🦖', '🐌', '🦔'];

// XP/day. Most are beatable with a regular goal; the last two are tough.
const PACES = [6, 12, 18, 25, 33, 42, 55, 85, 130];

export function createLeague(weekId: string = isoWeekId()): League {
  const rand = seededRandom(`league:${weekId}`);
  const names = shuffle(NAMES, rand).slice(0, PACES.length);
  const avatars = shuffle(AVATARS, rand);
  const paces = shuffle(PACES, rand);
  return {
    weekId,
    bots: names.map((name, i) => ({ name, avatar: avatars[i], pace: paces[i] })),
  };
}

/** Bot XP grows deterministically through the week: seeded per-day amounts, linear within the day. */
export function botXp(bot: LeagueBot, weekId: string, now: Date = new Date()): number {
  const elapsedDays = Math.min(7, Math.max(0, (now.getTime() - weekStart(now).getTime()) / DAY_MS));
  const rand = seededRandom(`${weekId}:${bot.name}`);
  let xp = 0;
  for (let day = 0; day < 7 && day < elapsedDays; day++) {
    const r = rand();
    const skip = rand() < 0.12;
    const daily = skip ? 0 : Math.round(bot.pace * (0.5 + r));
    const frac = Math.min(1, elapsedDays - day);
    xp += Math.round(daily * frac);
  }
  return xp;
}

export function daysLeftInWeek(now: Date = new Date()): number {
  const end = weekStart(now).getTime() + 7 * DAY_MS;
  return Math.max(0, Math.ceil((end - now.getTime()) / DAY_MS));
}
