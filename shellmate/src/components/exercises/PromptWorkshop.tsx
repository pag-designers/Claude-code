import { renderInline } from '../RichText';
import { useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { ExerciseProps, PromptWorkshopExercise } from '../../types';
import { countWords, gradePrompt } from '../../lib/grading';
import { useReportReady } from './util';

const MIN_WORDS = 8;
const LEGEND = ['Context', 'Goal', 'Constraints', 'Done-when', 'Files'];

export function PromptWorkshop({ exercise, locked, onReady }: ExerciseProps<PromptWorkshopExercise>) {
  const [text, setText] = useState('');
  const [showSample, setShowSample] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const words = countWords(text);

  useReportReady(onReady, words >= MIN_WORDS, () => gradePrompt(text, exercise), [text]);

  const result = useMemo(() => (locked ? gradePrompt(text, exercise) : null), [locked, text, exercise]);

  const insertFile = (path: string) => {
    if (locked) return;
    const ta = taRef.current;
    const token = `@${path}`;
    const start = ta?.selectionStart ?? text.length;
    const end = ta?.selectionEnd ?? text.length;
    const before = text.slice(0, start);
    const after = text.slice(end);
    const pre = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
    const post = after.length === 0 || !/^\s/.test(after) ? ' ' : '';
    const next = before + pre + token + post + after;
    setText(next);
    const caret = (before + pre + token + post).length;
    requestAnimationFrame(() => {
      if (!taRef.current) return;
      taRef.current.focus();
      taRef.current.setSelectionRange(caret, caret);
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="card flex gap-3 p-3">
        <span className="text-2xl" aria-hidden>
          🛠️
        </span>
        <p className="font-bold leading-snug text-ink">{renderInline(exercise.scenario)}</p>
      </div>

      {!locked && exercise.files && exercise.files.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-bold uppercase tracking-wide text-muted">Files:</span>
          {exercise.files.map((f) => (
            <button
              key={f}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insertFile(f)}
              className="chip min-h-10 text-primary active:translate-y-0.5"
            >
              @{f}
            </button>
          ))}
        </div>
      )}

      {!locked ? (
        <div className="flex flex-col gap-1.5">
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={6}
            autoFocus
            spellCheck
            aria-label="Your prompt"
            placeholder="Write the prompt you'd give Claude…"
            className="min-h-36 w-full resize-y rounded-2xl border-2 border-line bg-surface p-3.5 text-[15px] leading-relaxed text-ink outline-none placeholder:text-muted/70 focus:border-primary"
          />
          <div className="flex items-center justify-between gap-2 text-xs text-muted">
            <span className="flex flex-wrap gap-x-1.5">
              {LEGEND.map((l, i) => (
                <span key={l}>
                  {l}
                  {i < LEGEND.length - 1 && <span className="pl-1.5 opacity-50">·</span>}
                </span>
              ))}
            </span>
            <span className={`shrink-0 font-mono ${words >= MIN_WORDS ? 'text-success' : ''}`}>
              {words}w · {text.length}c
            </span>
          </div>
        </div>
      ) : (
        <div className="rounded-2xl border-2 border-line bg-surface-2 p-3.5 text-[15px] leading-relaxed whitespace-pre-wrap break-words text-ink">
          {text}
        </div>
      )}

      {result && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-center gap-2" aria-label={`${result.stars} of 3 stars`}>
            {[1, 2, 3].map((s) => {
              const on = s <= result.stars;
              return (
                <motion.span
                  key={s}
                  initial={{ scale: 0, rotate: -30, opacity: 0 }}
                  animate={{ scale: on ? [0, 1.35, 1] : 1, rotate: 0, opacity: 1 }}
                  transition={{ delay: 0.15 + s * 0.18, duration: 0.45 }}
                  className={`text-4xl ${on ? 'drop-shadow-[0_0_8px_rgba(255,200,61,0.6)]' : 'opacity-25 grayscale'}`}
                >
                  ⭐
                </motion.span>
              );
            })}
          </div>
          <ul className="card flex flex-col gap-2.5 p-3">
            {result.checks.map((c, i) => (
              <motion.li
                key={c.key}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.6 + i * 0.07 }}
                className="flex gap-2.5"
              >
                <span
                  className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-sm font-extrabold text-[#10131a] ${
                    c.passed ? 'bg-success' : 'bg-error'
                  }`}
                >
                  {c.passed ? '✓' : '✗'}
                </span>
                <span className="text-sm leading-snug">
                  <span className="font-extrabold text-ink">{c.label}</span>
                  <span className="text-muted"> — {c.tip}</span>
                </span>
              </motion.li>
            ))}
          </ul>
          <div className="card p-0">
            <button
              type="button"
              onClick={() => setShowSample((v) => !v)}
              aria-expanded={showSample}
              className="flex min-h-12 w-full items-center justify-between px-4 font-extrabold text-ink"
            >
              Sample prompt
              <motion.span animate={{ rotate: showSample ? 180 : 0 }} className="text-muted">
                ▾
              </motion.span>
            </button>
            <AnimatePresence initial={false}>
              {showSample && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="overflow-hidden"
                >
                  <p className="mx-3 mb-3 rounded-xl bg-code p-3 font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-words text-[#e9ecf2]">
                    {exercise.sample}
                  </p>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      )}
    </div>
  );
}
