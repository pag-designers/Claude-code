import { renderInline } from '../RichText';
import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import type { ExerciseProps, SpotBadPromptExercise } from '../../types';
import { BOUNCE, SHAKE, isTypingTarget, useReportReady } from './util';

export function SpotBadPrompt({ exercise, locked, onReady }: ExerciseProps<SpotBadPromptExercise>) {
  const [selected, setSelected] = useState<0 | 1 | null>(null);

  useReportReady(onReady, selected !== null, () => ({ correct: selected === exercise.better }), [selected]);

  useEffect(() => {
    if (locked) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '1') setSelected(0);
      if (e.key === '2') setSelected(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [locked]);

  return (
    <div className="flex flex-col gap-4">
      <div className="card flex gap-3 p-3">
        <span className="text-2xl" aria-hidden>
          🎯
        </span>
        <p className="font-bold text-ink">{renderInline(exercise.prompt)}</p>
      </div>
      <p className="text-sm font-bold text-muted uppercase tracking-wide">Which prompt is better?</p>
      <div className="flex flex-col gap-4">
        {exercise.options.map((text, i) => {
          const isSel = selected === i;
          const isBetter = i === exercise.better;
          let cls = 'text-ink';
          if (locked) cls = isBetter ? 'tile-correct' : isSel ? 'tile-wrong' : 'opacity-70 text-ink';
          else if (isSel) cls = 'tile-selected';
          const animate = locked ? (isBetter ? BOUNCE : isSel ? SHAKE : {}) : {};
          return (
            <motion.button
              key={i}
              type="button"
              disabled={locked}
              onClick={() => setSelected(i as 0 | 1)}
              animate={animate}
              transition={{ duration: 0.4 }}
              className={`tile flex w-full flex-col gap-2 p-4 ${cls}`}
            >
              <span className="flex w-full items-center gap-2">
                <span
                  className={`flex h-7 w-7 items-center justify-center rounded-lg border-2 text-sm font-extrabold ${
                    isSel || (locked && isBetter) ? 'border-current' : 'border-line text-muted'
                  }`}
                >
                  {i + 1}
                </span>
                <span className="text-sm font-extrabold uppercase tracking-wide">Prompt {i === 0 ? 'A' : 'B'}</span>
                {locked && (
                  <span
                    className={`ml-auto rounded-full px-2.5 py-0.5 text-xs font-extrabold uppercase ${
                      isBetter ? 'bg-success text-[#10131a]' : 'bg-surface-2 text-muted'
                    }`}
                  >
                    {isBetter ? 'Better' : 'Weaker'}
                  </span>
                )}
              </span>
              <span className="relative block w-full rounded-2xl rounded-tl-sm bg-surface-2 px-3.5 py-3 text-left font-mono text-[13px] leading-relaxed font-medium whitespace-pre-wrap break-words text-ink">
                {text}
              </span>
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}
