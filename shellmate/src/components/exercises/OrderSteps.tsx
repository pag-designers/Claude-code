import { useState } from 'react';
import type { ReactNode } from 'react';
import { Reorder, motion } from 'framer-motion';
import type { ExerciseProps, OrderStepsExercise } from '../../types';
import { gradeOrder, shuffle } from '../../lib/grading';
import { BOUNCE, SHAKE, useReportReady } from './util';

export function OrderSteps({ exercise, locked, onReady }: ExerciseProps<OrderStepsExercise>) {
  // Order holds indices into exercise.steps (robust to duplicate step text).
  const [order, setOrder] = useState<number[]>(() => shuffle(exercise.steps.map((_, i) => i), exercise.id));

  useReportReady(
    onReady,
    true,
    () =>
      gradeOrder(
        order.map((i) => exercise.steps[i]),
        exercise.steps,
      ),
    [order],
  );

  const move = (pos: number, dir: -1 | 1) => {
    const to = pos + dir;
    if (locked || to < 0 || to >= order.length) return;
    setOrder((prev) => {
      const next = [...prev];
      [next[pos], next[to]] = [next[to], next[pos]];
      return next;
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-lg font-bold text-ink">{exercise.prompt}</p>
      {!locked && <p className="-mt-2 text-sm text-muted">Drag the steps, or use the arrows.</p>}
      <Reorder.Group axis="y" values={order} onReorder={locked ? () => {} : setOrder} className="flex flex-col gap-2.5">
        {order.map((stepIdx, pos) => {
          const right = exercise.steps[stepIdx] === exercise.steps[pos];
          const stateCls = locked ? (right ? 'tile-correct' : 'tile-wrong') : 'text-ink';
          return (
            <Reorder.Item
              key={stepIdx}
              value={stepIdx}
              drag={locked ? false : 'y'}
              animate={locked ? (right ? BOUNCE : SHAKE) : {}}
              transition={{ duration: 0.4, delay: locked ? pos * 0.05 : 0 }}
              whileDrag={{ scale: 1.03, boxShadow: '0 10px 30px rgba(0,0,0,0.35)', zIndex: 10 }}
              className={`tile relative flex min-h-14 items-center gap-3 py-2 ${locked ? '' : 'cursor-grab touch-none active:cursor-grabbing'} ${stateCls}`}
            >
              <span
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-extrabold ${
                  locked ? 'border-2 border-current' : 'bg-surface-2 text-muted'
                }`}
              >
                {pos + 1}
              </span>
              <span className="flex-1 break-words text-[15px] leading-snug">{exercise.steps[stepIdx]}</span>
              {!locked && (
                <span className="flex shrink-0 flex-col gap-1" onPointerDown={(e) => e.stopPropagation()}>
                  <ArrowButton label="Move up" disabled={pos === 0} onClick={() => move(pos, -1)}>
                    ▲
                  </ArrowButton>
                  <ArrowButton label="Move down" disabled={pos === order.length - 1} onClick={() => move(pos, 1)}>
                    ▼
                  </ArrowButton>
                </span>
              )}
              {locked && !right && (
                <motion.span
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="shrink-0 rounded-lg bg-surface-2 px-2 py-0.5 text-xs font-bold text-muted"
                >
                  #{exercise.steps.indexOf(exercise.steps[stepIdx]) + 1}
                </motion.span>
              )}
            </Reorder.Item>
          );
        })}
      </Reorder.Group>
    </div>
  );
}

function ArrowButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="flex h-7 w-10 items-center justify-center rounded-md bg-surface-2 text-[10px] text-muted hover:text-ink disabled:opacity-30"
    >
      {children}
    </button>
  );
}
