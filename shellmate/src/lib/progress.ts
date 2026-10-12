import { units } from '../content';
import type { Lesson, Unit } from '../types';

export type LessonRecord = { bestAccuracy: number; times: number; legendary?: boolean };

/** The slice of game state needed to compute unlocks. */
export type ProgressState = {
  completedLessons: Record<string, LessonRecord>;
  testedOut: boolean;
};

export type FlatLesson = { lesson: Lesson; unit: Unit; indexInUnit: number; flatIndex: number };

export const flatLessons: FlatLesson[] = units.flatMap((unit) =>
  unit.lessons.map((lesson, indexInUnit) => ({ lesson, unit, indexInUnit, flatIndex: 0 })),
).map((f, i) => ({ ...f, flatIndex: i }));

const flatById = new Map(flatLessons.map((f) => [f.lesson.id, f]));

export function isLessonDone(s: ProgressState, lessonId: string): boolean {
  if (s.completedLessons[lessonId]) return true;
  if (s.testedOut) {
    const f = flatById.get(lessonId);
    return !!f && f.unit === units[0];
  }
  return false;
}

/** Lessons unlock linearly across all units. */
export function isLessonUnlocked(s: ProgressState, lessonId: string): boolean {
  const f = flatById.get(lessonId);
  if (!f) return false;
  if (f.flatIndex === 0) return true;
  return isLessonDone(s, flatLessons[f.flatIndex - 1].lesson.id);
}

export function isUnitLessonsDone(s: ProgressState, unit: Unit): boolean {
  return unit.lessons.length > 0 && unit.lessons.every((l) => isLessonDone(s, l.id));
}

/** Mission node unlocks after the unit's last lesson. */
export const isMissionUnlocked = isUnitLessonsDone;

/** First unlocked, not-yet-done lesson (null when everything is done). */
export function currentLesson(s: ProgressState): FlatLesson | null {
  return flatLessons.find((f) => !isLessonDone(s, f.lesson.id)) ?? null;
}

export function isUnitStarted(s: ProgressState, unit: Unit): boolean {
  return unit.lessons.length > 0 && isLessonDone(s, unit.lessons[0].id);
}

export function unitById(id: string): Unit | undefined {
  return units.find((u) => u.id === id);
}

export function lastCompletedLesson(s: ProgressState): FlatLesson | null {
  for (let i = flatLessons.length - 1; i >= 0; i--) {
    if (isLessonDone(s, flatLessons[i].lesson.id)) return flatLessons[i];
  }
  return null;
}

/** Darker shade for 3D bottom borders. */
export function darker(color: string, pct = 70): string {
  return `color-mix(in srgb, ${color} ${pct}%, black)`;
}

/** Pick readable text color for a hex background. */
export function textOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return '#ffffff';
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.4 ? '#10131a' : '#ffffff';
}
