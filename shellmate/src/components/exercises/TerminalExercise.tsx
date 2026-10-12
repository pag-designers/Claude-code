import Hint from './Hint';
import { useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import type { ExerciseProps, TerminalExercise as TerminalExerciseT } from '../../types';
import { gradeTerminal } from '../../lib/grading';
import { BOUNCE, SHAKE, useReportReady } from './util';

export function TerminalExercise({ exercise, locked, onReady }: ExerciseProps<TerminalExerciseT>) {
  const [value, setValue] = useState('');
  const [focused, setFocused] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const symbol = exercise.promptSymbol ?? '$';
  const title = symbol === '>' ? 'claude' : '~/my-project — zsh';

  useReportReady(onReady, value.trim().length > 0, () => gradeTerminal(value, exercise.accepted), [value]);

  const result = useMemo(
    () => (locked ? gradeTerminal(value, exercise.accepted) : null),
    [locked, value, exercise.accepted],
  );

  return (
    <div className="flex flex-col gap-4">
      <p className="text-lg font-bold text-ink">{exercise.prompt}</p>

      <motion.div
        animate={result ? (result.correct ? BOUNCE : SHAKE) : {}}
        transition={{ duration: 0.4 }}
        onClick={() => inputRef.current?.focus()}
        className={`overflow-hidden rounded-2xl border-2 bg-code shadow-lg ${
          result ? (result.correct ? 'border-success' : 'border-error') : 'border-[#2a2f3a]'
        }`}
      >
        <div className="flex items-center gap-2 border-b border-white/10 bg-white/5 px-3 py-2">
          <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
          <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
          <span className="h-3 w-3 rounded-full bg-[#28c840]" />
          <span className="flex-1 truncate text-center font-mono text-xs text-[#8b93a5]">{title}</span>
          <span className="w-9" />
        </div>
        <div className="min-h-32 px-4 py-4 font-mono text-[15px] leading-relaxed text-[#e9ecf2]">
          {!locked ? (
            <div className="flex items-center gap-2">
              <span className="shrink-0 font-bold text-primary">{symbol}</span>
              <div className="relative flex-1">
                <input
                  ref={inputRef}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  onFocus={() => setFocused(true)}
                  onBlur={() => setFocused(false)}
                  autoFocus
                  autoCapitalize="off"
                  autoCorrect="off"
                  autoComplete="off"
                  spellCheck={false}
                  enterKeyHint="done"
                  aria-label="Terminal command"
                  placeholder={symbol === '>' ? 'type a slash command…' : 'type a command…'}
                  className="w-full bg-transparent font-mono text-[#e9ecf2] caret-primary outline-none placeholder:text-[#8b93a5]/60"
                />
                {!focused && value.length === 0 && (
                  <span className="cursor-blink pointer-events-none absolute left-0 top-1/2 h-5 w-2.5 -translate-y-1/2 bg-primary" />
                )}
              </div>
            </div>
          ) : (
            <>
              <div className="flex gap-2 break-all">
                <span className="shrink-0 font-bold text-primary">{symbol}</span>
                <span>{value}</span>
              </div>
              {result?.correct ? (
                <div className="mt-2 text-success">✔ command accepted</div>
              ) : (
                <div className="mt-2 break-all text-error">
                  ✘ not quite — expected: <span className="text-[#e9ecf2]">{exercise.accepted[0]}</span>
                </div>
              )}
              <div className="mt-2 flex items-center gap-2">
                <span className="font-bold text-primary">{symbol}</span>
                <span className="cursor-blink inline-block h-5 w-2.5 bg-[#e9ecf2]/70" />
              </div>
            </>
          )}
        </div>
      </motion.div>

      {exercise.hint && !locked && <Hint text={exercise.hint} />}
    </div>
  );
}
