import { motion } from 'framer-motion';
import type { ReactNode } from 'react';
import Confetti from '../components/Confetti';
import { FlameIcon } from '../components/Icons';
import Kip from '../components/Kip';
import { badges } from '../content';
import { formatDuration } from '../lib/date';
import { PERFECT_BONUS, type SessionResult } from '../store/useGame';
import { useNav } from '../store/useNav';

const HEADLINES: Record<SessionResult['mode'], string> = {
  normal: 'Lesson complete!',
  practice: 'Practice complete!',
  legendary: 'Legendary!',
  review: 'Review complete!',
  mission: 'Mission accomplished!',
};

function StatTile({ label, value, color, delay }: { label: string; value: ReactNode; color: string; delay: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, type: 'spring', stiffness: 260, damping: 20 }}
      className="flex-1 overflow-hidden rounded-2xl border-2"
      style={{ borderColor: color, background: color }}
    >
      <div className="py-1 text-center text-[11px] font-black uppercase tracking-wider text-[#10131a]">{label}</div>
      <div className="rounded-xl bg-surface py-3 text-center text-xl font-black" style={{ color }}>
        {value}
      </div>
    </motion.div>
  );
}

export default function LessonComplete({ result }: { result: SessionResult }) {
  const tab = useNav((s) => s.tab);
  const earned = badges.filter((b) => result.newBadges.includes(b.id));

  return (
    <div className="flex min-h-screen flex-col px-5 pb-8 pt-10">
      <Confetti />
      <div className="flex flex-1 flex-col items-center text-center">
        <motion.div initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 200, damping: 12 }}>
          <Kip mood="celebrate" size={190} />
        </motion.div>
        <h1 className="mt-4 text-3xl font-black text-gold">{HEADLINES[result.mode]}</h1>
        <p className="mt-1 font-bold text-muted">{result.title}</p>

        <div className="mt-6 flex w-full gap-3">
          <StatTile label="Total XP" value={`+${result.xp}`} color="var(--gold)" delay={0.2} />
          <StatTile label="Accuracy" value={`${result.accuracy}%`} color="var(--success)" delay={0.35} />
          <StatTile label="Time" value={formatDuration(result.durationMs)} color="#4aa8ff" delay={0.5} />
        </div>

        <div className="mt-5 flex w-full flex-col gap-2">
          {result.perfect && (
            <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.65 }} className="card rounded-2xl py-3 font-black text-gold">
              💎 Perfect lesson! +{PERFECT_BONUS} bonus XP
            </motion.div>
          )}
          {result.healed && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.7 }} className="card rounded-2xl py-3 font-black text-error">
              ❤️ Hearts refilled!
            </motion.div>
          )}
          {result.goldUnitTitle && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.72 }} className="card rounded-2xl py-3 font-black text-gold">
              👑 {result.goldUnitTitle} is now gold!
            </motion.div>
          )}
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.8 }} className="card flex items-center justify-center gap-2 rounded-2xl py-3 font-black text-primary">
            <FlameIcon size={22} className="flame-flicker" /> {result.streakMessage}
          </motion.div>
          {earned.length > 0 && (
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.95 }} className="card rounded-2xl">
              <div className="mb-2 text-xs font-black uppercase tracking-widest text-muted">New badge{earned.length > 1 ? 's' : ''}!</div>
              <div className="flex flex-wrap justify-center gap-4">
                {earned.map((b) => (
                  <div key={b.id} className="flex w-24 flex-col items-center">
                    <span className="text-4xl">{b.emoji}</span>
                    <span className="mt-1 text-sm font-black">{b.name}</span>
                  </div>
                ))}
              </div>
            </motion.div>
          )}
        </div>
      </div>
      <button className="btn3d btn3d-success mt-8 w-full py-4 text-lg" onClick={() => tab('home')} autoFocus>
        Continue
      </button>
    </div>
  );
}
