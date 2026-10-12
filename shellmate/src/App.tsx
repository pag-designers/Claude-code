import { AnimatePresence, motion } from 'framer-motion';
import { useEffect } from 'react';
import BottomNav from './components/BottomNav';
import ToastHost from './components/Toast';
import TopBar from './components/TopBar';
import { installAudioUnlock } from './lib/sound';
import CheatSheet from './screens/CheatSheet';
import Home from './screens/Home';
import League from './screens/League';
import LessonComplete from './screens/LessonComplete';
import LessonPlayer from './screens/LessonPlayer';
import Onboarding from './screens/Onboarding';
import Profile from './screens/Profile';
import Review from './screens/Review';
import { useGame } from './store/useGame';
import { routeKey, useNav, type Route } from './store/useNav';

function useAppEffects() {
  const theme = useGame((s) => s.settings.theme);
  const tickHearts = useGame((s) => s.tickHearts);
  const ensureLeague = useGame((s) => s.ensureLeague);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('light', theme === 'light');
    root.classList.toggle('dark', theme === 'dark');
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f7f5f2' : '#0f1115');
  }, [theme]);

  useEffect(() => {
    const tick = () => {
      tickHearts();
      ensureLeague();
    };
    tick();
    const id = window.setInterval(tick, 60_000);
    const onVisible = () => document.visibilityState === 'visible' && tick();
    window.addEventListener('focus', tick);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('focus', tick);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [tickHearts, ensureLeague]);

  useEffect(() => installAudioUnlock(), []);
}

function Screen({ route }: { route: Route }) {
  switch (route.name) {
    case 'home':
      return <Home />;
    case 'review':
      return <Review />;
    case 'cheatsheet':
      return <CheatSheet />;
    case 'league':
      return <League />;
    case 'profile':
      return <Profile />;
    case 'play':
      return <LessonPlayer session={route.session} />;
    case 'complete':
      return <LessonComplete result={route.result} />;
  }
}

export default function App() {
  useAppEffects();
  const onboarded = useGame((s) => s.onboarded);
  const route = useNav((s) => s.route);
  const isTab = route.name !== 'play' && route.name !== 'complete';

  useEffect(() => {
    if (route.name !== 'home') window.scrollTo({ top: 0 });
  }, [route]);

  return (
    <div className="mx-auto min-h-full max-w-[480px]">
      {!onboarded ? (
        <Onboarding />
      ) : (
        <>
          {isTab && <TopBar />}
          <AnimatePresence mode="wait" initial={false}>
            <motion.main
              key={routeKey(route)}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.18 }}
              className={isTab ? 'pb-28' : ''}
            >
              <Screen route={route} />
            </motion.main>
          </AnimatePresence>
          {isTab && <BottomNav />}
        </>
      )}
      <ToastHost />
    </div>
  );
}
