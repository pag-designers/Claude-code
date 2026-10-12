import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import type { ExerciseProps, MatchPairsExercise } from '../../types';
import { shuffle } from '../../lib/grading';
import { BOUNCE, SHAKE, useReportReady } from './util';

type Side = 'left' | 'right';
type Sel = { side: Side; idx: number } | null;

export function MatchPairs({ exercise, locked, onReady }: ExerciseProps<MatchPairsExercise>) {
  const n = exercise.pairs.length;
  const [leftOrder] = useState(() => shuffle([...Array(n).keys()], `${exercise.id}-L`));
  const [rightOrder] = useState(() => shuffle([...Array(n).keys()], `${exercise.id}-R`));
  const [matched, setMatched] = useState<number[]>([]);
  const [sel, setSel] = useState<Sel>(null);
  const [mistakes, setMistakes] = useState(0);
  const [wrong, setWrong] = useState<{ left: number; right: number; tick: number } | null>(null);
  const [lastMatch, setLastMatch] = useState<number | null>(null);

  const allMatched = matched.length === n;
  useReportReady(
    onReady,
    allMatched,
    () => ({
      correct: mistakes <= 1,
      feedback:
        mistakes === 0 ? undefined : mistakes === 1 ? 'One slip, but you got them all!' : `You made ${mistakes} mismatches.`,
    }),
    [allMatched, mistakes],
  );

  useEffect(() => {
    if (!wrong) return;
    const t = setTimeout(() => setWrong(null), 600);
    return () => clearTimeout(t);
  }, [wrong]);

  const tap = (side: Side, idx: number) => {
    if (locked || matched.includes(idx)) return;
    if (!sel || sel.side === side) {
      setSel(sel && sel.side === side && sel.idx === idx ? null : { side, idx });
      return;
    }
    const leftIdx = side === 'left' ? idx : sel.idx;
    const rightIdx = side === 'right' ? idx : sel.idx;
    if (leftIdx === rightIdx) {
      setMatched((m) => [...m, leftIdx]);
      setLastMatch(leftIdx);
    } else {
      setMistakes((m) => m + 1);
      setWrong({ left: leftIdx, right: rightIdx, tick: mistakes + 1 });
    }
    setSel(null);
  };

  const renderTile = (side: Side, idx: number) => {
    const text = side === 'left' ? exercise.pairs[idx].left : exercise.pairs[idx].right;
    const isMatched = matched.includes(idx);
    const isSel = sel?.side === side && sel.idx === idx;
    const isWrong = wrong !== null && wrong[side] === idx;
    let cls = 'text-ink';
    if (isMatched) cls = 'tile-correct opacity-80';
    else if (isWrong) cls = 'tile-wrong';
    else if (isSel) cls = 'tile-selected';
    const animate = isWrong ? SHAKE : isMatched && lastMatch === idx ? BOUNCE : {};
    return (
      <motion.button
        key={`${side}-${idx}-${isWrong ? wrong?.tick : 0}`}
        type="button"
        disabled={locked || isMatched}
        onClick={() => tap(side, idx)}
        animate={animate}
        transition={{ duration: 0.4 }}
        className={`tile flex min-h-16 w-full items-center justify-center px-2.5 text-center leading-snug break-words ${
          side === 'left' ? 'font-mono text-[13px] font-semibold' : 'text-sm'
        } ${cls}`}
      >
        {text}
      </motion.button>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-lg font-bold text-ink">{exercise.prompt}</p>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-3">{leftOrder.map((i) => renderTile('left', i))}</div>
        <div className="flex flex-col gap-3">{rightOrder.map((i) => renderTile('right', i))}</div>
      </div>
      {mistakes > 0 && (
        <p className="text-center text-sm text-muted">
          Mismatches: <span className="font-bold text-error">{mistakes}</span>
        </p>
      )}
    </div>
  );
}
