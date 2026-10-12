import { AnimatePresence, motion, useAnimationControls } from 'framer-motion';
import { useCallback, useEffect, useRef, useState } from 'react';
import BottomSheet from '../components/BottomSheet';
import { ExerciseRenderer, exerciseTitle } from '../components/exercises/ExerciseRenderer';
import { BookIcon, CheckIcon, CrownIcon, HeartIcon, InfinityIcon, XIcon } from '../components/Icons';
import Kip, { type KipMood } from '../components/Kip';
import Modal from '../components/Modal';
import ProgressBar from '../components/ProgressBar';
import RichText, { CodeBlock, renderInline } from '../components/RichText';
import { lessonIndex } from '../content';
import { lastCompletedLesson, unitById } from '../lib/progress';
import { sfx } from '../lib/sound';
import { dueReviewIds, useGame, type SessionSpec, hasUnlimitedHearts } from '../store/useGame';
import { useNav } from '../store/useNav';
import type { Exercise, GradeResult, TheoryCard } from '../types';

type QueueItem = { exercise: Exercise; lessonId: string; retry: boolean };
type Phase = 'theory' | 'answer' | 'feedback' | 'failed' | 'outOfHearts';

type Session = { title: string; theory: TheoryCard[]; queue: QueueItem[]; color?: string };

const MAX_REVIEW = 10;
const PRAISE = ['Nice!', 'Correct!', 'Great job!', 'You got it!', 'Excellent!'];

function buildSession(spec: SessionSpec): Session | null {
  if (spec.mode === 'review') {
    const deck = useGame.getState().reviewDeck;
    const queue = dueReviewIds(useGame.getState())
      .flatMap((id): QueueItem[] => {
        const lessonId = deck[id]?.lessonId;
        const exercise = lessonIndex.get(lessonId ?? '')?.lesson.exercises.find((e) => e.id === id);
        return exercise ? [{ exercise, lessonId, retry: false }] : [];
      })
      .slice(0, MAX_REVIEW);
    return queue.length ? { title: 'Review', theory: [], queue } : null;
  }
  if (spec.mode === 'mission') {
    const unit = unitById(spec.unitId);
    if (!unit) return null;
    return {
      title: `Mission: ${unit.mission.title}`,
      theory: [],
      queue: [{ exercise: unit.mission, lessonId: `mission:${unit.id}`, retry: false }],
      color: unit.color,
    };
  }
  const entry = lessonIndex.get(spec.lessonId);
  if (!entry) return null;
  return {
    title: entry.lesson.title,
    // Practice/legendary runs skip the theory for speed.
    theory: spec.mode === 'normal' ? entry.lesson.theory : [],
    queue: entry.lesson.exercises.map((exercise) => ({ exercise, lessonId: entry.lesson.id, retry: false })),
    color: entry.unit.color,
  };
}

export default function LessonPlayer({ session: spec }: { session: SessionSpec }) {
  const go = useNav((s) => s.go);
  const tab = useNav((s) => s.tab);
  const play = useNav((s) => s.play);
  const hearts = useGame((s) => s.hearts);
  const unlimited = useGame(hasUnlimitedHearts);
  const { loseHeart, addToReview, answerReview, finishSession, tickHearts } = useGame.getState();

  const [session] = useState(() => buildSession(spec));
  const [queue, setQueue] = useState<QueueItem[]>(() => session?.queue ?? []);
  const originalCount = session?.queue.length ?? 0;

  const [phase, setPhase] = useState<Phase>(() => (session && session.theory.length > 0 ? 'theory' : 'answer'));
  const [theoryIdx, setTheoryIdx] = useState(0);
  const [pos, setPos] = useState(0);
  const [ready, setReady] = useState(false);
  const [result, setResult] = useState<GradeResult | null>(null);
  const [praise, setPraise] = useState(PRAISE[0]);
  const [kipMood, setKipMood] = useState<KipMood>('thinking');
  const [quitOpen, setQuitOpen] = useState(false);
  const [tipsOpen, setTipsOpen] = useState(false);
  const [correctIds, setCorrectIds] = useState<Set<string>>(() => new Set());

  const gradeRef = useRef<(() => GradeResult) | null>(null);
  const attempted = useRef(new Set<string>());
  const requeued = useRef(new Set<string>());
  const stats = useRef({ firstTryCorrect: 0, mistakes: 0 });
  const failNext = useRef(false);
  const startedAt = useRef(0);
  const controls = useAnimationControls();

  const item = queue[pos];
  // Theory cards for whichever lesson the current exercise came from (works in review too).
  const tips: TheoryCard[] = (item && lessonIndex.get(item.lessonId)?.lesson.theory) || session?.theory || [];
  const isLessonMode = spec.mode === 'normal' || spec.mode === 'practice' || spec.mode === 'legendary';

  // Starting a normal lesson with no hearts left goes straight to the "Out of hearts" modal.
  useEffect(() => {
    startedAt.current = Date.now();
  }, []);

  useEffect(() => {
    if (spec.mode !== 'normal') return;
    tickHearts();
    if (useGame.getState().hearts <= 0) setPhase('outOfHearts');
  }, [spec.mode, tickHearts]);

  const onReady = useCallback((isReady: boolean, grade?: () => GradeResult) => {
    setReady(isReady);
    gradeRef.current = grade ?? null;
  }, []);

  const quit = useCallback(() => tab('home'), [tab]);

  const nextTheory = useCallback(() => {
    if (!session) return;
    sfx.tap();
    if (theoryIdx + 1 < session.theory.length) setTheoryIdx(theoryIdx + 1);
    else setPhase('answer');
  }, [session, theoryIdx]);

  const check = useCallback(() => {
    if (!item || !ready || !gradeRef.current) return;
    const grade = gradeRef.current();
    const id = item.exercise.id;
    const first = !attempted.current.has(id);
    attempted.current.add(id);
    setResult(grade);
    setPhase('feedback');

    if (grade.correct) {
      sfx.correct();
      setPraise(PRAISE[Math.floor(Math.random() * PRAISE.length)]);
      setKipMood('happy');
      void controls.start({ scale: [1, 1.03, 1], transition: { duration: 0.35 } });
      if (first) stats.current.firstTryCorrect++;
      setCorrectIds((s) => new Set(s).add(id));
      if (spec.mode === 'review' && first) answerReview(id, true);
    } else {
      sfx.wrong();
      setKipMood('encourage');
      void controls.start({ x: [0, -12, 12, -8, 8, -4, 0], transition: { duration: 0.45 } });
      stats.current.mistakes++;
      if (spec.mode === 'legendary') {
        failNext.current = true;
      } else if (!item.retry && !requeued.current.has(id)) {
        requeued.current.add(id);
        setQueue((q) => [...q, { ...item, retry: true }]);
      }
      if (isLessonMode) addToReview(id, item.lessonId);
      if (spec.mode === 'review' && first) answerReview(id, false);
      if (spec.mode === 'normal') loseHeart();
    }
  }, [item, ready, controls, spec.mode, isLessonMode, answerReview, addToReview, loseHeart]);

  const finish = useCallback(() => {
    if (!session) return;
    const res = finishSession({
      spec,
      title: session.title,
      firstTryCorrect: stats.current.firstTryCorrect,
      total: originalCount,
      mistakes: stats.current.mistakes,
      durationMs: Date.now() - startedAt.current,
    });
    sfx.complete();
    go({ name: 'complete', result: res });
  }, [session, spec, originalCount, finishSession, go]);

  const cont = useCallback(() => {
    sfx.tap();
    if (failNext.current) {
      setPhase('failed');
      setKipMood('sad');
      return;
    }
    if (spec.mode === 'normal' && useGame.getState().hearts <= 0) {
      setPhase('outOfHearts');
      return;
    }
    if (pos + 1 < queue.length) {
      setPos(pos + 1);
      setPhase('answer');
      setReady(false);
      setResult(null);
      gradeRef.current = null;
      setKipMood('thinking');
    } else {
      finish();
    }
  }, [spec.mode, pos, queue.length, finish]);

  // Keyboard: Enter = Check / Continue (Ctrl/Cmd+Enter inside a textarea).
  const keyState = useRef({ phase, ready, quitOpen: quitOpen || tipsOpen, check, cont, nextTheory });
  useEffect(() => {
    keyState.current = { phase, ready, quitOpen: quitOpen || tipsOpen, check, cont, nextTheory };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.isComposing || e.repeat) return;
      const target = e.target as HTMLElement | null;
      if (target?.tagName === 'TEXTAREA' && !(e.ctrlKey || e.metaKey)) return;
      const k = keyState.current;
      if (k.quitOpen) return;
      if (k.phase === 'theory') k.nextTheory();
      else if (k.phase === 'answer' && k.ready) k.check();
      else if (k.phase === 'feedback') k.cont();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  if (!session) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
        <Kip mood="thinking" size={140} />
        <h2 className="mt-4 text-2xl font-black">{spec.mode === 'review' ? 'Nothing to review' : 'Lesson not found'}</h2>
        <p className="mt-2 font-semibold text-muted">
          {spec.mode === 'review' ? 'No items are due right now. Come back later!' : 'This lesson seems to have wandered off.'}
        </p>
        <button className="btn3d mt-6" onClick={() => tab(spec.mode === 'review' ? 'review' : 'home')}>
          Back
        </button>
      </div>
    );
  }

  const progress = phase === 'theory' ? 0 : correctIds.size / Math.max(1, originalCount);
  const color = spec.mode === 'legendary' ? 'var(--gold)' : 'var(--success)';
  const healTarget = phase === 'outOfHearts' ? lastCompletedLesson(useGame.getState()) : null;

  return (
    <div className="flex min-h-screen flex-col">
      {/* Header */}
      <div className="sticky top-0 z-20 flex items-center gap-3 bg-bg px-4 pb-3 pt-4">
        <button className="rounded-xl p-1 text-muted hover:text-ink" onClick={() => setQuitOpen(true)} aria-label="Quit lesson">
          <XIcon size={26} />
        </button>
        <ProgressBar value={progress} color={color} />
        {tips.length > 0 && phase !== 'theory' && (
          <button
            className="flex items-center gap-1 rounded-xl px-1.5 py-1 text-xs font-black uppercase tracking-wide text-muted hover:text-ink"
            onClick={() => setTipsOpen(true)}
            aria-label="Show this lesson's tips"
          >
            <BookIcon size={22} />
            Tips
          </button>
        )}
        <div className="flex min-w-12 items-center justify-end gap-1 font-black">
          {spec.mode === 'normal' && !unlimited ? (
            <>
              <HeartIcon size={24} className={hearts === 0 ? 'grayscale' : ''} />
              <span className="text-error">{hearts}</span>
            </>
          ) : spec.mode === 'legendary' ? (
            <CrownIcon size={26} />
          ) : (
            <InfinityIcon size={26} className="text-error" />
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 px-5 pb-40 pt-2">
        {phase === 'theory' && (
          <AnimatePresence mode="wait">
            <motion.div
              key={theoryIdx}
              initial={{ opacity: 0, x: 40 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -40 }}
              drag="x"
              dragConstraints={{ left: 0, right: 0 }}
              dragElastic={0.4}
              onDragEnd={(_, info) => info.offset.x < -80 && nextTheory()}
            >
              <div className="mb-3 flex items-center gap-3">
                <Kip mood="happy" size={64} />
                <div className="text-xs font-black uppercase tracking-widest text-primary">
                  Quick tip {theoryIdx + 1}/{session.theory.length}
                </div>
              </div>
              <div className="card">
                <h2 className="mb-3 text-2xl font-black">{session.theory[theoryIdx].title}</h2>
                <RichText text={session.theory[theoryIdx].body} className="text-[1.05rem] font-semibold" />
                {session.theory[theoryIdx].code && (
                  <div className="mt-4">
                    <CodeBlock code={session.theory[theoryIdx].code!} />
                  </div>
                )}
              </div>
              <p className="mt-3 text-center text-xs font-bold text-muted">Swipe or tap “Got it” to continue</p>
            </motion.div>
          </AnimatePresence>
        )}

        {(phase === 'answer' || phase === 'feedback') && item && (
          <motion.div key={pos} initial={{ opacity: 0, x: 30 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.2 }}>
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                {item.retry && (
                  <div className="mb-1 text-xs font-black uppercase tracking-widest text-error">Previous mistake</div>
                )}
                {spec.mode === 'legendary' && !item.retry && (
                  <div className="mb-1 text-xs font-black uppercase tracking-widest text-gold">Legendary · no mistakes</div>
                )}
                <h1 className="text-2xl font-black leading-tight">{exerciseTitle(item.exercise.type)}</h1>
              </div>
              <Kip mood={kipMood} size={64} className="shrink-0" />
            </div>
            <motion.div animate={controls}>
              <ExerciseRenderer key={pos} exercise={item.exercise} locked={phase === 'feedback'} onReady={onReady} />
            </motion.div>
          </motion.div>
        )}

        {phase === 'failed' && (
          <div className="flex flex-col items-center pt-10 text-center">
            <Kip mood="sad" size={170} />
            <h2 className="mt-5 text-2xl font-black">Legendary attempt failed</h2>
            <p className="mt-2 max-w-xs font-semibold text-muted">Legendary runs allow zero mistakes. Shake it off and try again!</p>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="fixed inset-x-0 bottom-0 z-10">
        <div className="mx-auto max-w-[480px] border-t-2 border-line bg-bg px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4">
          {phase === 'theory' && (
            <button className="btn3d w-full py-4 text-lg" onClick={nextTheory}>
              {theoryIdx + 1 < session.theory.length ? 'Got it' : "Got it — let's practice"}
            </button>
          )}
          {(phase === 'answer' || phase === 'feedback') && (
            <button className="btn3d btn3d-success w-full py-4 text-lg" disabled={!ready || phase === 'feedback'} onClick={check}>
              {spec.mode === 'mission' ? 'Mission complete' : 'Check'}
            </button>
          )}
          {phase === 'failed' && (
            <div className="flex gap-3">
              <button className="btn3d btn3d-ghost flex-1 py-4" onClick={quit}>
                Quit
              </button>
              <button className="btn3d btn3d-gold flex-1 py-4" onClick={() => play(spec)}>
                Try again
              </button>
            </div>
          )}
        </div>
      </div>

      <BottomSheet open={phase === 'feedback' && !!result} tone={result?.correct ? 'success' : 'error'}>
        {result && (
          <div className={result.correct ? 'text-success' : 'text-error'}>
            <div className="flex items-center gap-3">
              <span className={`grid h-10 w-10 place-items-center rounded-full ${result.correct ? 'bg-success' : 'bg-error'} text-[#10131a]`}>
                {result.correct ? <CheckIcon size={24} /> : <XIcon size={22} />}
              </span>
              <h2 className="text-2xl font-black">{result.correct ? praise : 'Not quite'}</h2>
              {result.stars !== undefined && (
                <span className="ml-auto text-xl tracking-tight text-gold" aria-label={`${result.stars} of 3 stars`}>
                  {'★'.repeat(result.stars)}
                  <span className="opacity-30">{'★'.repeat(Math.max(0, 3 - result.stars))}</span>
                </span>
              )}
            </div>
            {result.feedback && <p className="mt-3 font-bold text-ink">{renderInline(result.feedback)}</p>}
            {item && <p className="mt-2 text-sm font-semibold text-ink/80">{renderInline(item.exercise.explanation)}</p>}
            {!result.correct && tips.length > 0 && (
              <button className="mt-2 text-sm font-black underline underline-offset-2" onClick={() => setTipsOpen(true)}>
                📖 Re-read the tips for this lesson
              </button>
            )}
            <button className={`btn3d ${result.correct ? 'btn3d-success' : 'btn3d-error'} mt-4 w-full py-4 text-lg`} onClick={cont}>
              Continue
            </button>
          </div>
        )}
      </BottomSheet>

      <Modal open={tipsOpen} onClose={() => setTipsOpen(false)} title="Lesson tips" wide>
        <div className="flex flex-col gap-4">
          {tips.map((card, i) => (
            <div key={i} className="card">
              <h3 className="mb-2 text-lg font-black">{card.title}</h3>
              <RichText text={card.body} className="font-semibold" />
              {card.code && (
                <div className="mt-3">
                  <CodeBlock code={card.code} />
                </div>
              )}
            </div>
          ))}
          <button className="btn3d w-full" onClick={() => setTipsOpen(false)}>
            Back to the exercise
          </button>
        </div>
      </Modal>

      <Modal open={quitOpen} onClose={() => setQuitOpen(false)}>
        <div className="flex flex-col items-center text-center">
          <Kip mood="sad" size={110} />
          <h2 className="mt-3 text-xl font-black">Wait, don't go!</h2>
          <p className="mt-1 font-semibold text-muted">You'll lose your progress in this session.</p>
          <button className="btn3d mt-5 w-full" onClick={() => setQuitOpen(false)}>
            Keep learning
          </button>
          <button className="mt-3 w-full py-2 font-black uppercase tracking-wide text-error" onClick={quit}>
            End session
          </button>
        </div>
      </Modal>

      <Modal open={phase === 'outOfHearts'}>
        <div className="flex flex-col items-center text-center">
          <Kip mood="sad" size={110} />
          <h2 className="mt-3 text-xl font-black">Out of hearts</h2>
          <p className="mt-1 font-semibold text-muted">
            {healTarget
              ? 'Practice a lesson you already finished to refill your hearts — mistakes there are free.'
              : 'Hearts refill one every 30 minutes. Take a short break!'}
          </p>
          {healTarget && (
            <button className="btn3d btn3d-success mt-5 w-full" onClick={() => play({ mode: 'practice', lessonId: healTarget.lesson.id })}>
              <HeartIcon size={20} /> Practice to heal
            </button>
          )}
          <button className="btn3d btn3d-ghost mt-3 w-full" onClick={quit}>
            Quit
          </button>
        </div>
      </Modal>
    </div>
  );
}
