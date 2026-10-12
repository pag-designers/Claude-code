import type { ReactNode } from 'react';
import { sfx } from '../lib/sound';
import { dueReviewIds, useGame } from '../store/useGame';
import { useNav, type Tab } from '../store/useNav';
import { CardsIcon, PathIcon, TerminalIcon, TrophyIcon, UserIcon } from './Icons';

const TABS: { id: Tab; label: string; icon: ReactNode }[] = [
  { id: 'home', label: 'Learn', icon: <PathIcon size={28} /> },
  { id: 'review', label: 'Review', icon: <CardsIcon size={28} /> },
  { id: 'cheatsheet', label: 'Cheats', icon: <TerminalIcon size={28} /> },
  { id: 'league', label: 'League', icon: <TrophyIcon size={28} /> },
  { id: 'profile', label: 'Profile', icon: <UserIcon size={28} /> },
];

export default function BottomNav() {
  const route = useNav((s) => s.route);
  const tab = useNav((s) => s.tab);
  const due = useGame((s) => dueReviewIds(s).length);
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30">
      <div className="mx-auto flex max-w-[480px] justify-around border-t-2 border-line bg-bg/95 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2 backdrop-blur">
        {TABS.map((t) => {
          const active = route.name === t.id;
          return (
            <button
              key={t.id}
              onClick={() => {
                sfx.tap();
                tab(t.id);
              }}
              className={`relative flex min-w-[60px] flex-col items-center gap-0.5 rounded-2xl border-2 px-2 py-1.5 text-[11px] font-extrabold uppercase tracking-wide transition-colors ${
                active ? 'border-[#4aa8ff] bg-[#4aa8ff]/15 text-[#4aa8ff]' : 'border-transparent text-muted hover:bg-surface-2'
              }`}
              aria-current={active ? 'page' : undefined}
            >
              {t.icon}
              {t.label}
              {t.id === 'review' && due > 0 && (
                <span className="absolute right-1 top-0 grid h-5 min-w-5 place-items-center rounded-full bg-error px-1 text-[10px] text-white">
                  {due}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
