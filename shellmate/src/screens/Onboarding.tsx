import { AnimatePresence, motion } from 'framer-motion';
import { useState } from 'react';
import Kip, { type KipMood } from '../components/Kip';
import ProgressBar from '../components/ProgressBar';
import { units } from '../content';
import { sfx } from '../lib/sound';
import { useGame } from '../store/useGame';
import type { DailyGoal, Experience } from '../types';

type Step = 'welcome' | 'goal' | 'experience' | 'placement' | 'ready';

const GOALS: { value: DailyGoal; label: string; detail: string }[] = [
  { value: 20, label: 'Casual', detail: '20 XP / day · ~5 min' },
  { value: 50, label: 'Regular', detail: '50 XP / day · ~10 min' },
  { value: 100, label: 'Intense', detail: '100 XP / day · ~20 min' },
];

const EXPERIENCE: { value: Experience; label: string; emoji: string; detail: string }[] = [
  { value: 'new', label: 'Never coded', emoji: '🌱', detail: "I'm brand new to terminals and code" },
  { value: 'some', label: 'Some coding', emoji: '🛠️', detail: "I've written scripts or tinkered" },
  { value: 'dev', label: "I'm a dev", emoji: '🚀', detail: 'I code for a living' },
];

const SPEECH: Record<Step, { text: string; mood: KipMood }> = {
  welcome: { text: "Hi, I'm Kip! I live in a terminal. Let's learn Claude Code together, one bite at a time.", mood: 'happy' },
  goal: { text: "What's your daily goal?", mood: 'thinking' },
  experience: { text: 'How much coding have you done?', mood: 'thinking' },
  placement: { text: 'Want to skip the basics? You can test out of Unit 1.', mood: 'encourage' },
  ready: { text: "You're all set. Let's go!", mood: 'celebrate' },
};

export default function Onboarding() {
  const completeOnboarding = useGame((s) => s.completeOnboarding);
  const theme = useGame((s) => s.settings.theme);
  const setTheme = useGame((s) => s.setTheme);
  const [step, setStep] = useState<Step>('welcome');
  const [goal, setGoal] = useState<DailyGoal>(50);
  const [experience, setExperience] = useState<Experience | null>(null);
  const [testOut, setTestOut] = useState(false);

  const steps: Step[] = experience && experience !== 'new' ? ['welcome', 'goal', 'experience', 'placement', 'ready'] : ['welcome', 'goal', 'experience', 'ready'];
  const index = steps.indexOf(step);

  const next = () => {
    sfx.tap();
    if (step === 'ready') {
      sfx.complete();
      completeOnboarding(goal, experience ?? 'new', testOut);
      return;
    }
    setStep(steps[index + 1]);
  };

  const canContinue = step !== 'experience' || experience !== null;
  const speech = SPEECH[step];
  const unit1 = units[0];

  return (
    <div className="flex min-h-screen flex-col px-5 pb-6 pt-5">
      <div className="flex items-center gap-3">
        {index > 0 ? (
          <button className="text-2xl font-black text-muted" onClick={() => setStep(steps[index - 1])} aria-label="Back">
            ←
          </button>
        ) : (
          <span className="w-5" />
        )}
        <ProgressBar value={(index + 1) / steps.length} height={14} />
      </div>

      {step !== 'welcome' && (
        <div className="mt-6 flex items-end gap-3">
          <Kip mood={speech.mood} size={96} className="shrink-0" />
          <motion.div key={step} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} className="card mb-6 rounded-2xl px-4 py-3 font-bold">
            {speech.text}
          </motion.div>
        </div>
      )}

      <AnimatePresence mode="wait">
        <motion.div
          key={step}
          initial={{ opacity: 0, x: 30 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -30 }}
          transition={{ duration: 0.2 }}
          className="mt-4 flex-1"
        >
          {step === 'welcome' && (
            <div className="flex flex-col items-center pt-6 text-center">
              <Kip mood="happy" size={200} />
              <h1 className="mt-6 text-4xl font-black tracking-tight">
                Shell<span className="text-primary">mate</span>
              </h1>
              <p className="mt-3 max-w-xs text-lg font-bold text-muted">{speech.text}</p>
              <div className="mt-8 flex items-center gap-2 rounded-2xl border-2 border-line p-1">
                {(['dark', 'light'] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTheme(t)}
                    className={`rounded-xl px-4 py-2 text-sm font-extrabold ${theme === t ? 'bg-surface-2 text-ink' : 'text-muted'}`}
                  >
                    {t === 'dark' ? '🌙 Dark' : '☀️ Light'}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-xs font-semibold text-muted">Pick a theme — you can change it later in Profile.</p>
            </div>
          )}

          {step === 'goal' && (
            <div className="flex flex-col gap-3">
              {GOALS.map((g) => (
                <button
                  key={g.value}
                  onClick={() => {
                    sfx.tap();
                    setGoal(g.value);
                  }}
                  className={`tile flex items-center justify-between py-4 ${goal === g.value ? 'tile-selected' : ''}`}
                >
                  <span className="text-lg">{g.label}</span>
                  <span className="text-sm text-muted">{g.detail}</span>
                </button>
              ))}
            </div>
          )}

          {step === 'experience' && (
            <div className="flex flex-col gap-3">
              {EXPERIENCE.map((e) => (
                <button
                  key={e.value}
                  onClick={() => {
                    sfx.tap();
                    setExperience(e.value);
                    if (e.value === 'new') setTestOut(false);
                  }}
                  className={`tile flex items-center gap-4 py-4 ${experience === e.value ? 'tile-selected' : ''}`}
                >
                  <span className="text-3xl">{e.emoji}</span>
                  <span>
                    <span className="block text-lg">{e.label}</span>
                    <span className="block text-sm font-semibold text-muted">{e.detail}</span>
                  </span>
                </button>
              ))}
            </div>
          )}

          {step === 'placement' && (
            <div className="flex flex-col gap-3">
              <button onClick={() => setTestOut(false)} className={`tile py-4 ${!testOut ? 'tile-selected' : ''}`}>
                <span className="block text-lg">🐣 Start from scratch</span>
                <span className="block text-sm font-semibold text-muted">Begin with Unit 1 — it goes quickly.</span>
              </button>
              <button
                onClick={() => setTestOut(true)}
                disabled={!unit1}
                className={`tile py-4 disabled:opacity-50 ${testOut ? 'tile-selected' : ''}`}
              >
                <span className="block text-lg">⏩ Test out of Unit 1</span>
                <span className="block text-sm font-semibold text-muted">
                  {unit1 ? `Mark "${unit1.title}" as done and jump ahead.` : 'No units available yet.'}
                </span>
              </button>
            </div>
          )}

          {step === 'ready' && (
            <div className="flex flex-col items-center pt-4 text-center">
              <Kip mood="celebrate" size={180} />
              <p className="mt-6 text-lg font-bold text-muted">
                Daily goal: <span className="text-ink">{goal} XP</span>
                {testOut && unit1 && (
                  <>
                    <br />
                    Starting after <span className="text-ink">Unit 1</span>
                  </>
                )}
              </p>
            </div>
          )}
        </motion.div>
      </AnimatePresence>

      <button className="btn3d btn3d-success mt-6 w-full py-4 text-lg" disabled={!canContinue} onClick={next}>
        {step === 'welcome' ? 'Get started' : step === 'ready' ? "Let's go!" : 'Continue'}
      </button>
    </div>
  );
}
