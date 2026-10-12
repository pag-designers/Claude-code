import { renderInline } from '../RichText';
import Hint from './Hint';
import { useMemo, useState } from 'react';
import { LayoutGroup, motion } from 'framer-motion';
import type { ExerciseProps, FillBlankExercise } from '../../types';
import { gradeFillBlank, shuffle } from '../../lib/grading';
import { BOUNCE, SHAKE, useReportReady } from './util';

export function FillBlank({ exercise, locked, onReady }: ExerciseProps<FillBlankExercise>) {
  const parts = useMemo(() => exercise.code.split('___'), [exercise.code]);
  const blankCount = parts.length - 1;
  // Bank order: shuffled once, deterministic per exercise.
  const [bank] = useState(() => shuffle(exercise.wordBank.map((w, i) => ({ w, i })), exercise.id));
  // slots[k] = index into exercise.wordBank, or null
  const [slots, setSlots] = useState<(number | null)[]>(() => Array(blankCount).fill(null));

  const filledWords = slots.map((s) => (s === null ? null : exercise.wordBank[s]));
  const ready = slots.every((s) => s !== null);
  useReportReady(onReady, ready, () => gradeFillBlank(filledWords, exercise.blanks), [slots]);

  const used = new Set(slots.filter((s): s is number => s !== null));

  const place = (wordIdx: number) => {
    if (locked) return;
    setSlots((prev) => {
      const k = prev.indexOf(null);
      if (k === -1) return prev;
      const next = [...prev];
      next[k] = wordIdx;
      return next;
    });
  };
  const unplace = (slotIdx: number) => {
    if (locked) return;
    setSlots((prev) => {
      const next = [...prev];
      next[slotIdx] = null;
      return next;
    });
  };

  const layoutKey = (wordIdx: number) => `fb-${exercise.id}-${wordIdx}`;

  return (
    <LayoutGroup id={`fb-${exercise.id}`}>
      <div className="flex flex-col gap-5">
        <p className="text-lg font-bold text-ink">{renderInline(exercise.prompt)}</p>
        {exercise.hint && !locked && <Hint text={exercise.hint} />}

        <div className="overflow-hidden rounded-2xl border-2 border-[#2a2f3a] bg-code">
          {exercise.language && (
            <div className="border-b border-white/10 bg-white/5 px-3 py-1.5 font-mono text-xs text-[#8b93a5]">
              {exercise.language}
            </div>
          )}
          <div className="overflow-x-auto px-4 py-4 font-mono text-sm leading-[2.4] whitespace-pre-wrap break-words text-[#e9ecf2]">
            {parts.map((part, k) => (
              <span key={k}>
                {part}
                {k < blankCount && (
                  <Slot
                    wordIdx={slots[k]}
                    word={filledWords[k]}
                    expected={exercise.blanks[k]}
                    locked={locked}
                    layoutId={slots[k] !== null ? layoutKey(slots[k]!) : undefined}
                    onTap={() => unplace(k)}
                  />
                )}
              </span>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap justify-center gap-2.5">
          {bank.map(({ w, i }) => (
            <div key={i} className="relative">
              {/* placeholder keeps the bank layout stable */}
              <span className="chip invisible block min-h-11">{w}</span>
              {!used.has(i) && (
                <motion.button
                  type="button"
                  layoutId={layoutKey(i)}
                  disabled={locked}
                  onClick={() => place(i)}
                  transition={{ layout: { type: 'spring', stiffness: 500, damping: 35 } }}
                  className="chip absolute inset-0 flex min-h-11 items-center justify-center text-ink disabled:opacity-50"
                >
                  {w}
                </motion.button>
              )}
              {used.has(i) && (
                <span className="absolute inset-0 rounded-xl border-2 border-dashed border-line bg-surface-2" />
              )}
            </div>
          ))}
        </div>
      </div>
    </LayoutGroup>
  );
}

function Slot({
  wordIdx,
  word,
  expected,
  locked,
  layoutId,
  onTap,
}: {
  wordIdx: number | null;
  word: string | null;
  expected: string;
  locked: boolean;
  layoutId?: string;
  onTap: () => void;
}) {
  if (wordIdx === null || word === null) {
    return (
      <span
        className={`mx-0.5 inline-block min-w-16 border-b-2 align-middle ${
          locked ? 'border-error' : 'border-primary/70'
        }`}
      >
        &nbsp;
      </span>
    );
  }
  const correct = word.trim() === expected.trim();
  const stateCls = locked
    ? correct
      ? 'border-success bg-success/15 text-success'
      : 'border-error bg-error/15 text-error line-through'
    : 'border-[#4aa8ff] bg-[#4aa8ff]/15 text-[#8cc8ff]';
  return (
    <span className="inline-flex items-center gap-1 align-middle">
      <motion.button
        type="button"
        layoutId={layoutId}
        disabled={locked}
        onClick={onTap}
        animate={locked ? (correct ? BOUNCE : SHAKE) : {}}
        transition={{ layout: { type: 'spring', stiffness: 500, damping: 35 }, duration: 0.4 }}
        className={`mx-0.5 inline-block rounded-lg border-2 border-b-4 px-2 py-0 font-mono text-sm leading-7 font-semibold ${stateCls}`}
      >
        {word}
      </motion.button>
      {locked && !correct && (
        <span className="rounded-lg border-2 border-success bg-success/15 px-2 font-mono text-sm leading-7 font-semibold text-success">
          {expected}
        </span>
      )}
    </span>
  );
}
