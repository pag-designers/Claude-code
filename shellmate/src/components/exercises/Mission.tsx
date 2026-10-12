import { useState } from 'react';
import { motion } from 'framer-motion';
import type { ExerciseProps, MissionExercise } from '../../types';
import { useReportReady } from './util';

export function Mission({ exercise, locked, onReady }: ExerciseProps<MissionExercise>) {
  const [done, setDone] = useState<boolean[]>(() => exercise.checklist.map(() => false));
  const allDone = done.every(Boolean);

  useReportReady(onReady, allDone, () => ({ correct: true }), [allDone]);

  const toggle = (i: number) => {
    if (locked) return;
    setDone((d) => d.map((v, j) => (j === i ? !v : v)));
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-gold px-3 py-1 text-xs font-extrabold text-[#10131a] uppercase">
          +{exercise.bonusXp} XP
        </span>
        {exercise.badge && (
          <span className="rounded-full border-2 border-gold/60 bg-gold/10 px-3 py-0.5 text-xs font-extrabold text-gold uppercase">
            🏅 Badge: {exercise.badge}
          </span>
        )}
      </div>
      <h2 className="text-2xl font-extrabold text-ink">{exercise.title}</h2>
      <p className="leading-relaxed text-ink/90">{exercise.intro}</p>
      <div className="flex items-center gap-2 rounded-xl bg-surface-2 px-3 py-2 text-sm text-muted">
        <span aria-hidden>💻</span>
        <span>Do this in your real terminal with Claude Code, then tick each step.</span>
      </div>
      <ul className="flex flex-col gap-2.5">
        {exercise.checklist.map((item, i) => {
          const on = done[i];
          return (
            <li key={i}>
              <button
                type="button"
                role="checkbox"
                aria-checked={on}
                disabled={locked}
                onClick={() => toggle(i)}
                className={`tile flex min-h-14 w-full items-center gap-3 ${on ? 'tile-correct' : 'text-ink'}`}
              >
                <motion.span
                  animate={on ? { scale: [1, 1.2, 1] } : { scale: 1 }}
                  transition={{ duration: 0.3 }}
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border-2 ${
                    on ? 'border-success bg-success' : 'border-line bg-surface-2'
                  }`}
                >
                  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="#10131a" strokeWidth={3.5}>
                    <motion.path
                      d="M5 12.5l4.5 4.5L19 7.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      initial={false}
                      animate={{ pathLength: on ? 1 : 0, opacity: on ? 1 : 0 }}
                      transition={{ duration: 0.25 }}
                    />
                  </svg>
                </motion.span>
                <span className="flex-1 text-[15px] leading-snug">{item}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="text-center text-sm text-muted">
        {done.filter(Boolean).length}/{exercise.checklist.length} done
      </p>
    </div>
  );
}
