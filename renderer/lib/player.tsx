'use client';

/**
 * Shared proxy-player state for the video detail page. The <video> element lives in <ProxyPlayer>; everything else
 * (transcript, chapters, notes, clip drawer) talks to it through `seek()` and reads the playhead through
 * `usePlayerSelector`, which only re-renders a consumer when ITS derived value changes (e.g. the active sentence),
 * not on every timeupdate.
 */
import * as React from 'react';

interface PlayerSnapshot {
  time: number;
  duration: number;
  playing: boolean;
  /** A <video> with a loaded source is mounted. */
  available: boolean;
}

interface PlayerStore {
  get: () => PlayerSnapshot;
  set: (patch: Partial<PlayerSnapshot>) => void;
  subscribe: (l: () => void) => () => void;
}

function createStore(): PlayerStore {
  let snap: PlayerSnapshot = { time: 0, duration: 0, playing: false, available: false };
  const ls = new Set<() => void>();
  return {
    get: () => snap,
    set: (patch) => {
      const next = { ...snap, ...patch };
      if (
        next.time === snap.time &&
        next.duration === snap.duration &&
        next.playing === snap.playing &&
        next.available === snap.available
      )
        return;
      snap = next;
      ls.forEach((l) => l());
    },
    subscribe: (l) => {
      ls.add(l);
      return () => ls.delete(l);
    },
  };
}

interface PlayerApi {
  store: PlayerStore;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** Seeks (queued until metadata is ready). Returns false when no playable source exists. */
  seek: (t: number, opts?: { play?: boolean }) => boolean;
  setPending: (t: number | null, play?: boolean) => void;
  getPending: () => { t: number; play: boolean } | null;
}

const Ctx = React.createContext<PlayerApi | null>(null);

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const [store] = React.useState(createStore);
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const pending = React.useRef<{ t: number; play: boolean } | null>(null);

  const api = React.useMemo<PlayerApi>(
    () => ({
      store,
      videoRef,
      seek: (t, opts) => {
        const v = videoRef.current;
        if (!v) return false;
        const play = opts?.play ?? true;
        if (v.readyState >= 1) {
          v.currentTime = Math.max(0, Math.min(t, Number.isFinite(v.duration) ? v.duration : t));
          store.set({ time: v.currentTime });
          if (play) void v.play().catch(() => undefined);
        } else {
          pending.current = { t, play };
          v.load();
        }
        return true;
      },
      setPending: (t, play = true) => {
        pending.current = t === null ? null : { t, play };
      },
      getPending: () => pending.current,
    }),
    [store],
  );
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function usePlayer(): PlayerApi {
  const c = React.useContext(Ctx);
  if (!c) throw new Error('usePlayer must be used inside <PlayerProvider>');
  return c;
}

/** `selector` must return a primitive (or a stable reference): it runs on every store change. */
export function usePlayerSelector<T>(selector: (s: PlayerSnapshot) => T): T {
  const { store } = usePlayer();
  return React.useSyncExternalStore(
    store.subscribe,
    () => selector(store.get()),
    () => selector(store.get()),
  );
}
