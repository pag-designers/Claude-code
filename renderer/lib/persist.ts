'use client';

import { useCallback, useState } from 'react';

function read<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

/** A string-union preference remembered per viewer (localStorage; every access is guarded, the UI never needs it). */
export function usePersistedChoice<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
) {
  const [value, setValue] = useState<T>(() => read(key, allowed, fallback));
  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        localStorage.setItem(key, v);
      } catch {
        /* storage blocked: the choice simply is not remembered */
      }
    },
    [key],
  );
  return [value, set] as const;
}
