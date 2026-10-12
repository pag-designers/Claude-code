import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { units } from '../content';
import type { DailyGoal, Experience } from '../types';
import { addDays, diffDays, isoWeekId, todayStr, weekDates } from '../lib/date';
import { createLeague, type League } from '../lib/league';
import { isLessonDone, unitById, type LessonRecord, testOutUnits } from '../lib/progress';
import { setMuteSource } from '../lib/sound';
import { toast } from './useToast';

export const MAX_HEARTS = 5;
export const HEART_REGEN_MS = 30 * 60 * 1000;
export const XP_PER_CORRECT = 10;
export const PERFECT_BONUS = 5;
/** Days until next review, indexed by (box - 1). */
export const LEITNER_INTERVALS = [0, 1, 3, 7, 14] as const;

export type LessonMode = 'normal' | 'practice' | 'legendary';
export type SessionSpec =
  | { mode: LessonMode; lessonId: string }
  | { mode: 'review' }
  | { mode: 'mission'; unitId: string };
export type SessionMode = SessionSpec['mode'];

export type ReviewItem = { box: 1 | 2 | 3 | 4 | 5; due: string; lessonId: string };

export type Streak = { count: number; lastDay: string | null; freezesUsedWeek: string | null };

/** `unlimitedHearts` is undefined for saves made before the setting existed; treat that as on. */
export type Settings = { muted: boolean; theme: 'dark' | 'light'; unlimitedHearts?: boolean };

export type SessionResult = {
  mode: SessionMode;
  title: string;
  xp: number;
  accuracy: number;
  durationMs: number;
  perfect: boolean;
  streakCount: number;
  streakMessage: string;
  newBadges: string[];
  healed: boolean;
  goldUnitTitle?: string;
};

export type FinishInput = {
  spec: SessionSpec;
  title: string;
  /** Exercises answered correctly on the first try. */
  firstTryCorrect: number;
  /** Number of distinct exercises in the session. */
  total: number;
  mistakes: number;
  durationMs: number;
};

type GameData = {
  onboarded: boolean;
  dailyGoal: DailyGoal;
  experience: Experience;
  xpTotal: number;
  xpByDay: Record<string, number>;
  completedLessons: Record<string, LessonRecord>;
  completedMissions: Record<string, true>;
  goldUnits: Record<string, true>;
  hearts: number;
  heartsUpdatedAt: number;
  streak: Streak;
  activeDays: string[];
  badges: string[];
  reviewDeck: Record<string, ReviewItem>;
  league: League;
  settings: Settings;
  testedOut: boolean;
};

type GameActions = {
  completeOnboarding: (goal: DailyGoal, experience: Experience, testOut: boolean) => void;
  setDailyGoal: (goal: DailyGoal) => void;
  setTheme: (theme: Settings['theme']) => void;
  toggleMute: () => void;
  toggleUnlimitedHearts: () => void;
  /** Lazily regenerate hearts (1 per 30 min). */
  tickHearts: () => void;
  loseHeart: () => void;
  /** Wrong answer: put the exercise in Leitner box 1, due today. */
  addToReview: (exerciseId: string, lessonId: string) => void;
  /** Answer inside a review session: correct moves up a box, wrong resets to box 1. */
  answerReview: (exerciseId: string, correct: boolean) => void;
  /** Make sure the league belongs to the current ISO week. */
  ensureLeague: () => void;
  /** Apply XP, completion, streak, badges for a finished session; returns a summary. */
  finishSession: (input: FinishInput) => SessionResult;
  resetProgress: () => void;
};

export type GameState = GameData & GameActions;

function initialData(): GameData {
  return {
    onboarded: false,
    dailyGoal: 50,
    experience: 'new',
    xpTotal: 0,
    xpByDay: {},
    completedLessons: {},
    completedMissions: {},
    goldUnits: {},
    hearts: MAX_HEARTS,
    heartsUpdatedAt: Date.now(),
    streak: { count: 0, lastDay: null, freezesUsedWeek: null },
    activeDays: [],
    badges: [],
    reviewDeck: {},
    league: createLeague(),
    settings: { muted: false, theme: 'dark', unlimitedHearts: true },
    testedOut: false,
  };
}

function regen(hearts: number, updatedAt: number, now: number): { hearts: number; heartsUpdatedAt: number } {
  if (hearts >= MAX_HEARTS) return { hearts: MAX_HEARTS, heartsUpdatedAt: now };
  const gained = Math.floor((now - updatedAt) / HEART_REGEN_MS);
  if (gained <= 0) return { hearts, heartsUpdatedAt: updatedAt };
  const next = Math.min(MAX_HEARTS, hearts + gained);
  return { hearts: next, heartsUpdatedAt: next >= MAX_HEARTS ? now : updatedAt + gained * HEART_REGEN_MS };
}

export const useGame = create<GameState>()(
  persist(
    (set, get) => ({
      ...initialData(),

      completeOnboarding: (dailyGoal, experience, testOut) => {
        const completedLessons = { ...get().completedLessons };
        if (testOut) {
          for (const l of testOutUnits.flatMap((u) => u.lessons)) {
            completedLessons[l.id] ??= { bestAccuracy: 100, times: 1 };
          }
        }
        set({ onboarded: true, dailyGoal, experience, testedOut: testOut, completedLessons });
      },

      setDailyGoal: (dailyGoal) => set({ dailyGoal }),
      setTheme: (theme) => set((s) => ({ settings: { ...s.settings, theme } })),
      toggleMute: () => set((s) => ({ settings: { ...s.settings, muted: !s.settings.muted } })),
      toggleUnlimitedHearts: () =>
        set((s) => ({
          settings: { ...s.settings, unlimitedHearts: !hasUnlimitedHearts(s) },
          hearts: MAX_HEARTS,
          heartsUpdatedAt: Date.now(),
        })),

      tickHearts: () => {
        const s = get();
        if (hasUnlimitedHearts(s)) {
          if (s.hearts !== MAX_HEARTS) set({ hearts: MAX_HEARTS, heartsUpdatedAt: Date.now() });
          return;
        }
        const next = regen(s.hearts, s.heartsUpdatedAt, Date.now());
        if (next.hearts !== s.hearts || next.heartsUpdatedAt !== s.heartsUpdatedAt) set(next);
      },

      loseHeart: () => {
        const now = Date.now();
        const s = get();
        if (hasUnlimitedHearts(s)) return;
        const cur = regen(s.hearts, s.heartsUpdatedAt, now);
        const wasFull = cur.hearts >= MAX_HEARTS;
        set({
          hearts: Math.max(0, cur.hearts - 1),
          heartsUpdatedAt: wasFull ? now : cur.heartsUpdatedAt,
        });
      },

      addToReview: (exerciseId, lessonId) =>
        set((s) => ({
          reviewDeck: { ...s.reviewDeck, [exerciseId]: { box: 1, due: todayStr(), lessonId } },
        })),

      answerReview: (exerciseId, correct) =>
        set((s) => {
          const item = s.reviewDeck[exerciseId];
          if (!item) return {};
          const deck = { ...s.reviewDeck };
          if (!correct) {
            deck[exerciseId] = { ...item, box: 1, due: todayStr() };
          } else if (item.box >= 5) {
            delete deck[exerciseId];
          } else {
            const box = (item.box + 1) as ReviewItem['box'];
            deck[exerciseId] = { ...item, box, due: addDays(todayStr(), LEITNER_INTERVALS[box - 1]) };
          }
          return { reviewDeck: deck };
        }),

      ensureLeague: () => {
        const weekId = isoWeekId();
        if (get().league.weekId !== weekId) set({ league: createLeague(weekId) });
      },

      finishSession: (input) => {
        const s = get();
        const today = todayStr();
        const now = Date.now();
        const { spec } = input;
        const isLesson = spec.mode === 'normal' || spec.mode === 'practice' || spec.mode === 'legendary';
        const perfect = isLesson && input.mistakes === 0;
        const accuracy = input.total > 0 ? Math.round((input.firstTryCorrect / input.total) * 100) : 100;

        const badges = new Set(s.badges);
        let xp = input.firstTryCorrect * XP_PER_CORRECT;
        if (perfect) {
          xp += PERFECT_BONUS;
          badges.add('perfect-lesson');
        }

        const patch: Partial<GameData> = {};
        let healed = false;
        let goldUnitTitle: string | undefined;

        if (isLesson) {
          const lessonId = spec.lessonId;
          const prev = s.completedLessons[lessonId];
          const completedLessons = {
            ...s.completedLessons,
            [lessonId]: {
              bestAccuracy: Math.max(prev?.bestAccuracy ?? 0, accuracy),
              times: (prev?.times ?? 0) + 1,
              legendary: prev?.legendary || spec.mode === 'legendary' || undefined,
            },
          };
          patch.completedLessons = completedLessons;

          if (spec.mode === 'practice') {
            patch.hearts = MAX_HEARTS;
            patch.heartsUpdatedAt = now;
            healed = s.hearts < MAX_HEARTS;
            badges.add('healer');
          }

          if (spec.mode === 'legendary') {
            const unit = units.find((u) => u.lessons.some((l) => l.id === lessonId));
            if (unit && !s.goldUnits[unit.id] && unit.lessons.every((l) => completedLessons[l.id]?.legendary)) {
              patch.goldUnits = { ...s.goldUnits, [unit.id]: true };
              badges.add('legendary');
              goldUnitTitle = unit.title;
            }
          }
        }

        if (spec.mode === 'mission') {
          const unit = unitById(spec.unitId);
          if (unit) {
            xp = unit.mission.bonusXp;
            patch.completedMissions = { ...s.completedMissions, [unit.id]: true };
            if (unit.mission.badge) badges.add(unit.mission.badge);
          }
        }

        // Streak: the first finished session of the day counts.
        let streak = s.streak;
        let streakMessage: string;
        if (streak.lastDay === today) {
          streakMessage = `Streak safe for today — ${streak.count} day${streak.count === 1 ? '' : 's'} 🔥`;
        } else {
          const gap = streak.lastDay ? diffDays(streak.lastDay, today) : Infinity;
          const week = isoWeekId();
          if (gap === 1) {
            streak = { ...streak, count: streak.count + 1, lastDay: today };
            streakMessage = `${streak.count} day streak! Keep it burning 🔥`;
          } else if (gap === 2 && streak.freezesUsedWeek !== week && streak.count > 0) {
            streak = { count: streak.count + 1, lastDay: today, freezesUsedWeek: week };
            streakMessage = `Streak freeze used ❄️ — ${streak.count} day streak saved!`;
            toast('Streak freeze used ❄️');
          } else {
            streak = { ...streak, count: 1, lastDay: today };
            streakMessage = 'Streak started! Day 1 🔥';
          }
          patch.activeDays = [...s.activeDays, today];
        }
        patch.streak = streak;
        if (streak.count >= 7) badges.add('streak-7');

        patch.xpTotal = s.xpTotal + xp;
        patch.xpByDay = { ...s.xpByDay, [today]: (s.xpByDay[today] ?? 0) + xp };
        patch.badges = [...badges];

        set(patch);

        return {
          mode: spec.mode,
          title: input.title,
          xp,
          accuracy,
          durationMs: input.durationMs,
          perfect,
          streakCount: streak.count,
          streakMessage,
          newBadges: [...badges].filter((b) => !s.badges.includes(b)),
          healed,
          goldUnitTitle,
        };
      },

      resetProgress: () => {
        const settings = get().settings;
        set({ ...initialData(), settings });
      },
    }),
    {
      name: 'shellmate-v1',
      version: 1,
      // Persist data only (actions are recreated by the store).
      partialize: (s) =>
        Object.fromEntries(Object.entries(s).filter(([, v]) => typeof v !== 'function')) as GameData,
    },
  ),
);

setMuteSource(() => useGame.getState().settings.muted);

// ---------- Selectors / derived values ----------

export function hasUnlimitedHearts(s: Pick<GameData, 'settings'>): boolean {
  return s.settings.unlimitedHearts !== false;
}

/** Streak shown in the UI: 0 if it has lapsed (allowing a not-yet-used freeze). */
export function displayStreak(s: Pick<GameData, 'streak'>): number {
  const { lastDay, count, freezesUsedWeek } = s.streak;
  if (!lastDay) return 0;
  const gap = diffDays(lastDay, todayStr());
  if (gap <= 1) return count;
  if (gap === 2 && freezesUsedWeek !== isoWeekId()) return count;
  return 0;
}

export function todayXp(s: Pick<GameData, 'xpByDay'>): number {
  return s.xpByDay[todayStr()] ?? 0;
}

export function weeklyXp(s: Pick<GameData, 'xpByDay'>): number {
  return weekDates().reduce((sum, d) => sum + (s.xpByDay[d] ?? 0), 0);
}

export function dueReviewIds(s: Pick<GameData, 'reviewDeck'>): string[] {
  const today = todayStr();
  return Object.entries(s.reviewDeck)
    .filter(([, item]) => item.due <= today)
    .map(([id]) => id);
}

export function lessonsDoneCount(s: Pick<GameData, 'completedLessons' | 'testedOut'>): number {
  return units.reduce((n, u) => n + u.lessons.filter((l) => isLessonDone(s, l.id)).length, 0);
}

export function msToNextHeart(s: Pick<GameData, 'hearts' | 'heartsUpdatedAt'>): number | null {
  if (s.hearts >= MAX_HEARTS) return null;
  return Math.max(0, s.heartsUpdatedAt + HEART_REGEN_MS - Date.now());
}
