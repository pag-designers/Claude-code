import { create } from 'zustand';
import type { SessionResult, SessionSpec } from './useGame';

export type Tab = 'home' | 'review' | 'cheatsheet' | 'league' | 'profile';

export type Route =
  | { name: Tab }
  | { name: 'play'; session: SessionSpec; nonce: number }
  | { name: 'complete'; result: SessionResult };

type NavState = {
  route: Route;
  go: (route: Route) => void;
  tab: (name: Tab) => void;
  play: (session: SessionSpec) => void;
};

let nonce = 0;

/** Minimal in-memory router: one current screen. */
export const useNav = create<NavState>()((set) => ({
  route: { name: 'home' },
  go: (route) => set({ route }),
  tab: (name) => set({ route: { name } }),
  play: (session) => set({ route: { name: 'play', session, nonce: ++nonce } }),
}));

export function routeKey(r: Route): string {
  if (r.name === 'play') return `play-${r.nonce}`;
  return r.name;
}
