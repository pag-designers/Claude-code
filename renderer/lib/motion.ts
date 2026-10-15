/**
 * Motion tokens for framer-motion. CSS counterparts live in globals.css (--duration-*, --ease-*).
 * Durations: fast 120ms · base 200ms · slow 320ms. Springs for anything draggable or "physical".
 */
import type { Transition } from 'framer-motion';

export const duration = { fast: 0.12, base: 0.2, slow: 0.32 } as const;
export const ease = {
  standard: [0.2, 0, 0, 1],
  out: [0, 0, 0.2, 1],
  in: [0.4, 0, 1, 1],
} as const;

export const spring = {
  /** Snappy UI feedback: tabs, indicators, toggles. */
  snappy: { type: 'spring', stiffness: 520, damping: 38, mass: 0.8 },
  /** Gentle settle for panels and page content. */
  gentle: { type: 'spring', stiffness: 260, damping: 30, mass: 1 },
  /** Playful overshoot for celebratory reveals (score badge). */
  bouncy: { type: 'spring', stiffness: 420, damping: 16, mass: 0.9 },
  /** Dragging (dnd-kit overlays, timeline): stiff and low-mass so it tracks the pointer. */
  drag: { type: 'spring', stiffness: 700, damping: 45, mass: 0.6 },
} satisfies Record<string, Transition>;

export const fadeUp = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: duration.slow, ease: ease.out },
} as const;

export const stagger = (i: number, step = 0.04) => ({ delay: Math.min(i * step, 0.4) });
