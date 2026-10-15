'use client';

import { useNow } from '../clock';

/** Current time in epoch ms rounded to the minute; null until mounted (static export safe). */
export function useNowMs(): number | null {
  return useNow()?.getTime() ?? null;
}
