import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { TrophyIcon } from '../components/Icons';
import { botXp, daysLeftInWeek } from '../lib/league';
import { useGame, weeklyXp } from '../store/useGame';

const PROMOTION = 3;

export default function League() {
  const league = useGame((s) => s.league);
  const xpByDay = useGame((s) => s.xpByDay);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const rows = [
    { name: 'You', avatar: '🦀', xp: weeklyXp({ xpByDay }), me: true },
    ...league.bots.map((b) => ({ name: b.name, avatar: b.avatar, xp: botXp(b, league.weekId, now), me: false })),
  ].sort((a, b) => b.xp - a.xp || (a.me ? -1 : b.me ? 1 : 0));

  const days = daysLeftInWeek(now);
  const myRank = rows.findIndex((r) => r.me) + 1;

  return (
    <div className="px-4 pt-5">
      <div className="flex flex-col items-center text-center">
        <TrophyIcon size={64} />
        <h1 className="mt-2 text-2xl font-black">Terminal League</h1>
        <p className="font-semibold text-muted">
          Top {PROMOTION} advance · {days} day{days === 1 ? '' : 's'} left
        </p>
        <p className="mt-1 text-sm font-bold">
          You're <span className="text-primary">#{myRank}</span> this week
        </p>
      </div>

      <ol className="mt-5 flex flex-col gap-1.5">
        {rows.map((r, i) => {
          const promo = i < PROMOTION;
          const demo = i >= rows.length - 2;
          return (
            <motion.li
              key={r.name}
              layout
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.03 }}
              className={`flex items-center gap-3 rounded-2xl border-2 px-3 py-2.5 ${
                r.me ? 'border-[#4aa8ff] bg-[#4aa8ff]/12' : 'border-transparent'
              }`}
            >
              <span className={`w-6 text-center font-black ${promo ? 'text-success' : demo ? 'text-error' : 'text-muted'}`}>
                {i < 3 ? ['🥇', '🥈', '🥉'][i] : i + 1}
              </span>
              <span className="grid h-10 w-10 place-items-center rounded-full bg-surface-2 text-2xl">{r.avatar}</span>
              <span className={`flex-1 font-extrabold ${r.me ? 'text-[#4aa8ff]' : ''}`}>{r.name}</span>
              <span className="font-black text-muted">{r.xp} XP</span>
            </motion.li>
          );
        }).flatMap((el, i) =>
          i === PROMOTION
            ? [
                <li key="promo-line" className="my-1 flex items-center gap-2 text-[11px] font-black uppercase tracking-widest text-success">
                  <span className="h-0.5 flex-1 bg-success/50" /> ▲ Promotion zone ▲ <span className="h-0.5 flex-1 bg-success/50" />
                </li>,
                el,
              ]
            : [el],
        )}
      </ol>
      <p className="mt-4 text-center text-xs font-semibold text-muted">Earn XP by finishing lessons. Leagues reset every Monday.</p>
    </div>
  );
}
