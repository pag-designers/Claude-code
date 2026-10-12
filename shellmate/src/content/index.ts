import type { Badge, Unit } from '../types';
import badgesJson from './badges.json';

// Every JSON file in ./units is picked up automatically — drop in a new file to add a unit.
const modules = import.meta.glob<{ default: Unit }>('./units/*.json', { eager: true });

export const units: Unit[] = Object.values(modules)
  .map((m) => m.default)
  .sort((a, b) => a.order - b.order);

export const badges: Badge[] = badgesJson as Badge[];

export const lessonIndex = new Map(
  units.flatMap((u) => u.lessons.map((l, i) => [l.id, { unit: u, lesson: l, index: i }] as const)),
);
