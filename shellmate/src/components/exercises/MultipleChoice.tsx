import { renderInline } from '../RichText';
import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import type { ExerciseProps, MultipleChoiceExercise } from '../../types';
import { isTypingTarget, useReportReady } from './util';

export function MultipleChoice({ exercise, locked, onReady }: ExerciseProps<MultipleChoiceExercise>) {
  const [selected, setSelected] = useState<number | null>(null);

  useReportReady(onReady, selected !== null, () => ({ correct: selected === exercise.answer }), [selected]);

  useEffect(() => {
    if (locked) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= exercise.options.length) {
        setSelected(n - 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [locked, exercise.options.length]);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-lg font-bold text-ink">{renderInline(exercise.prompt)}</p>
      <div className="flex flex-col gap-3">
        {exercise.options.map((opt, i) => {
          const isSel = selected === i;
          const isAnswer = i === exercise.answer;
          let cls = '';
          if (locked) {
            if (isAnswer) cls = 'tile-correct';
            else if (isSel) cls = 'tile-wrong';
            else cls = 'opacity-60';
          } else if (isSel) cls = 'tile-selected';
          const animate = locked
            ? isAnswer
              ? { scale: [1, 1.04, 1] }
              : isSel
                ? { x: [0, -8, 8, -6, 6, 0] }
                : {}
            : {};
          return (
            <motion.button
              key={i}
              type="button"
              disabled={locked}
              onClick={() => setSelected(i)}
              animate={animate}
              transition={{ duration: 0.35 }}
              className={`tile flex min-h-14 w-full items-center gap-3 text-ink ${cls}`}
            >
              <span
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border-2 text-sm font-extrabold ${
                  isSel || (locked && isAnswer) ? 'border-current' : 'border-line text-muted'
                }`}
              >
                {i + 1}
              </span>
              <span className="flex-1 break-words">{renderInline(opt, { glossary: false })}</span>
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}
