import { useState } from 'react';
import { FlameIcon, GemIcon } from '../components/Icons';
import Kip from '../components/Kip';
import Modal from '../components/Modal';
import { badges } from '../content';
import { addDays, todayStr, toDateStr, weekStart } from '../lib/date';
import { sfx } from '../lib/sound';
import { displayStreak, lessonsDoneCount, useGame, hasUnlimitedHearts } from '../store/useGame';
import { useNav } from '../store/useNav';
import type { DailyGoal } from '../types';

const WEEKS = 16;
const GOALS: DailyGoal[] = [20, 50, 100];
const GOAL_LABEL: Record<DailyGoal, string> = { 20: 'Casual', 50: 'Regular', 100: 'Intense' };

function level(xp: number): number {
  if (xp <= 0) return 0;
  if (xp < 20) return 1;
  if (xp < 50) return 2;
  if (xp < 100) return 3;
  return 4;
}

const LEVEL_BG = [
  'var(--surface-2)',
  'color-mix(in srgb, var(--success) 30%, var(--surface-2))',
  'color-mix(in srgb, var(--success) 55%, var(--surface-2))',
  'color-mix(in srgb, var(--success) 80%, var(--surface-2))',
  'var(--success)',
];

function Heatmap({ xpByDay }: { xpByDay: Record<string, number> }) {
  const today = todayStr();
  const start = addDays(toDateStr(weekStart()), -(WEEKS - 1) * 7);
  const cols = Array.from({ length: WEEKS }, (_, c) => Array.from({ length: 7 }, (_, r) => addDays(start, c * 7 + r)));
  return (
    <div>
      <div className="flex gap-[3px]">
        <div className="mr-1 flex flex-col justify-between py-[1px] text-[9px] font-bold text-muted">
          <span>M</span>
          <span>T</span>
          <span>S</span>
        </div>
        {cols.map((days, c) => (
          <div key={c} className="flex flex-1 flex-col gap-[3px]">
            {days.map((d) => {
              const xp = xpByDay[d] ?? 0;
              const future = d > today;
              return (
                <div
                  key={d}
                  title={future ? undefined : `${d}: ${xp} XP`}
                  className={`aspect-square w-full rounded-[3px] ${d === today ? 'ring-2 ring-primary' : ''}`}
                  style={{ background: future ? 'transparent' : LEVEL_BG[level(xp)] }}
                />
              );
            })}
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-end gap-1 text-[10px] font-bold text-muted">
        Less
        {LEVEL_BG.map((bg, i) => (
          <span key={i} className="h-2.5 w-2.5 rounded-[3px]" style={{ background: bg }} />
        ))}
        More
      </div>
    </div>
  );
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: () => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onChange}
      className={`relative h-8 w-14 rounded-full transition-colors ${on ? 'bg-success' : 'bg-surface-2'}`}
    >
      <span className={`absolute top-1 h-6 w-6 rounded-full bg-white shadow transition-all ${on ? 'left-7' : 'left-1'}`} />
    </button>
  );
}

export default function Profile() {
  const s = useGame();
  const tab = useNav((n) => n.tab);
  const [confirmReset, setConfirmReset] = useState(false);
  const streak = displayStreak(s);
  const done = lessonsDoneCount(s);
  const earned = new Set(s.badges);

  return (
    <div className="px-4 pt-5">
      <div className="flex items-center gap-4">
        <Kip mood="happy" size={110} />
        <div>
          <h1 className="text-2xl font-black">Your shell</h1>
          <p className="font-semibold text-muted">
            {s.experience === 'dev' ? 'Seasoned dev' : s.experience === 'some' ? 'Tinkerer' : 'Fresh hatchling'} · {s.activeDays.length} active day
            {s.activeDays.length === 1 ? '' : 's'}
          </p>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-3 gap-3">
        <div className="card flex flex-col items-center rounded-2xl p-3">
          <FlameIcon size={28} className={streak ? 'flame-flicker' : 'grayscale'} />
          <span className="mt-1 text-xl font-black">{streak}</span>
          <span className="text-xs font-bold text-muted">Day streak</span>
        </div>
        <div className="card flex flex-col items-center rounded-2xl p-3">
          <GemIcon size={28} />
          <span className="mt-1 text-xl font-black">{s.xpTotal}</span>
          <span className="text-xs font-bold text-muted">Total XP</span>
        </div>
        <div className="card flex flex-col items-center rounded-2xl p-3">
          <span className="text-2xl leading-7">📚</span>
          <span className="mt-1 text-xl font-black">{done}</span>
          <span className="text-xs font-bold text-muted">Lessons</span>
        </div>
      </div>

      <h2 className="mb-2 mt-6 text-lg font-black">Activity</h2>
      <div className="card">
        <Heatmap xpByDay={s.xpByDay} />
      </div>

      <h2 className="mb-2 mt-6 text-lg font-black">
        Badges <span className="text-muted">{earned.size}/{badges.length}</span>
      </h2>
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
        {badges.map((b) => {
          const has = earned.has(b.id);
          return (
            <div key={b.id} className={`card flex flex-col items-center rounded-2xl p-3 text-center ${has ? '' : 'opacity-50'}`} title={b.description}>
              <span className={`text-4xl ${has ? '' : 'grayscale'}`}>{b.emoji}</span>
              <span className="mt-1 text-xs font-black leading-tight">{b.name}</span>
              <span className="mt-0.5 text-[10px] font-semibold leading-tight text-muted">{b.description}</span>
            </div>
          );
        })}
      </div>

      <h2 className="mb-2 mt-6 text-lg font-black">Settings</h2>
      <div className="card flex flex-col gap-4">
        <div>
          <div className="mb-2 font-extrabold">Daily goal</div>
          <div className="grid grid-cols-3 gap-2">
            {GOALS.map((g) => (
              <button
                key={g}
                onClick={() => {
                  sfx.tap();
                  s.setDailyGoal(g);
                }}
                className={`tile px-2 py-2 text-center text-sm ${s.dailyGoal === g ? 'tile-selected' : ''}`}
              >
                {GOAL_LABEL[g]}
                <span className="block text-xs text-muted">{g} XP</span>
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-between">
          <span className="font-extrabold">☀️ Light mode</span>
          <Toggle label="Light mode" on={s.settings.theme === 'light'} onChange={() => s.setTheme(s.settings.theme === 'light' ? 'dark' : 'light')} />
        </div>
        <div className="flex items-center justify-between">
          <span className="font-extrabold">🔊 Sound effects</span>
          <Toggle label="Sound effects" on={!s.settings.muted} onChange={s.toggleMute} />
        </div>
        <div className="flex items-center justify-between">
          <span className="font-extrabold">❤️ Unlimited hearts</span>
          <Toggle label="Unlimited hearts" on={hasUnlimitedHearts(s)} onChange={s.toggleUnlimitedHearts} />
        </div>
        <button className="btn3d btn3d-error w-full" onClick={() => setConfirmReset(true)}>
          Reset progress
        </button>
      </div>

      <Modal open={confirmReset} onClose={() => setConfirmReset(false)}>
        <div className="flex flex-col items-center text-center">
          <Kip mood="sad" size={110} />
          <h2 className="mt-3 text-xl font-black">Reset all progress?</h2>
          <p className="mt-1 font-semibold text-muted">XP, streak, badges, review deck and lessons will be wiped. This can't be undone.</p>
          <button className="btn3d btn3d-ghost mt-5 w-full" onClick={() => setConfirmReset(false)}>
            Keep my progress
          </button>
          <button
            className="mt-3 w-full py-2 font-black uppercase tracking-wide text-error"
            onClick={() => {
              s.resetProgress();
              setConfirmReset(false);
              tab('home');
            }}
          >
            Reset everything
          </button>
        </div>
      </Modal>
    </div>
  );
}
