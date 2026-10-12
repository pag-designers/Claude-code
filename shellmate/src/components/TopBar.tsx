import { useState } from 'react';
import { displayStreak, MAX_HEARTS, msToNextHeart, todayXp, useGame } from '../store/useGame';
import { formatDuration } from '../lib/date';
import { FlameIcon, GemIcon, HeartIcon } from './Icons';
import Modal from './Modal';
import ProgressRing from './ProgressRing';

type Stat = 'streak' | 'hearts' | 'xp' | 'goal' | null;

export default function TopBar() {
  const s = useGame();
  const [info, setInfo] = useState<Stat>(null);
  const streak = displayStreak(s);
  const today = todayXp(s);
  const goalPct = today / s.dailyGoal;
  const nextHeart = msToNextHeart(s);

  const item = 'flex items-center gap-1.5 rounded-xl px-2 py-1.5 font-black hover:bg-surface-2';

  return (
    <header className="sticky top-0 z-30 border-b-2 border-line bg-bg/95 backdrop-blur">
      <div className="flex items-center justify-between px-4 py-2.5">
        <button className={item} onClick={() => setInfo('streak')} aria-label={`${streak} day streak`}>
          <FlameIcon size={26} className={streak > 0 ? 'flame-flicker' : 'opacity-40 grayscale'} />
          <span className={streak > 0 ? 'text-primary' : 'text-muted'}>{streak}</span>
        </button>
        <button className={item} onClick={() => setInfo('xp')} aria-label={`${s.xpTotal} total XP`}>
          <GemIcon size={24} />
          <span className="text-gold">{s.xpTotal}</span>
        </button>
        <button className={item} onClick={() => setInfo('hearts')} aria-label={`${s.hearts} hearts`}>
          <HeartIcon size={26} className={s.hearts === 0 ? 'opacity-40 grayscale' : ''} />
          <span className="text-error">{s.hearts}</span>
        </button>
        <button className={item} onClick={() => setInfo('goal')} aria-label="Daily goal progress">
          <ProgressRing value={goalPct} size={34} color={goalPct >= 1 ? 'var(--success)' : 'var(--gold)'}>
            {goalPct >= 1 ? '✓' : `${Math.round(goalPct * 100)}`}
          </ProgressRing>
        </button>
      </div>

      <Modal open={info !== null} onClose={() => setInfo(null)} title={titles[info ?? 'xp']}>
        <p className="text-muted">
          {info === 'streak' &&
            (streak > 0
              ? `You're on a ${streak} day streak. Finish a lesson every day to keep it going. One missed day per week is covered by a streak freeze ❄️.`
              : 'Finish a lesson today to start a streak!')}
          {info === 'hearts' &&
            (s.hearts >= MAX_HEARTS
              ? 'Your hearts are full. Each mistake in a lesson costs one heart.'
              : `You have ${s.hearts}/${MAX_HEARTS} hearts. Next heart in ${formatDuration(nextHeart ?? 0)}. Practice a finished lesson to refill them all.`)}
          {info === 'xp' && `You've earned ${s.xpTotal} XP in total. 10 XP per correct answer, +5 for a perfect lesson.`}
          {info === 'goal' && `Today: ${today} / ${s.dailyGoal} XP.${today >= s.dailyGoal ? ' Goal reached — nice!' : ''}`}
        </p>
      </Modal>
    </header>
  );
}

const titles: Record<Exclude<Stat, null>, string> = {
  streak: 'Streak',
  hearts: 'Hearts',
  xp: 'Total XP',
  goal: 'Daily goal',
};
