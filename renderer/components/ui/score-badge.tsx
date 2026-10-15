'use client';

import * as React from 'react';
import {
  animate,
  motion,
  useMotionValue,
  useMotionValueEvent,
  useReducedMotion,
  useTransform,
} from 'framer-motion';
import { Flame } from 'lucide-react';
import { cn } from '@/lib/utils';
import { spring } from '@/lib/motion';
import { ProgressRing, type RingTone } from './progress-ring';

export type ScoreTier = 'low' | 'mid' | 'good' | 'viral';

export function scoreTier(score: number): ScoreTier {
  if (score >= 90) return 'viral';
  if (score >= 75) return 'good';
  if (score >= 50) return 'mid';
  return 'low';
}

export const TIER_LABEL: Record<ScoreTier, string> = {
  low: 'Low',
  mid: 'Decent',
  good: 'Strong',
  viral: 'Viral potential',
};

const TIER_RING: Record<ScoreTier, RingTone> = {
  low: 'muted',
  mid: 'warning',
  good: 'success',
  viral: 'viral',
};
const TIER_TEXT: Record<ScoreTier, string> = {
  low: 'text-score-low',
  mid: 'text-score-mid',
  good: 'text-score-good',
  viral: 'text-foreground',
};

const SPARKS = Array.from({ length: 10 }, (_, i) => {
  const angle = (i / 10) * Math.PI * 2 + 0.3;
  const dist = 26 + (i % 3) * 7;
  return {
    x: Math.cos(angle) * dist,
    y: Math.sin(angle) * dist,
    delay: (i % 4) * 0.03,
    size: 3 + (i % 3),
  };
});
const SPARK_COLORS = ['#f472b6', '#fb923c', '#a898ff', '#fbbf24'];

/** Animated, count-up reveal. 90+ scores get a gradient ring, a pulsing glow and a one-shot spark burst. */
export function ScoreBadge({
  score,
  size = 56,
  animated = true,
  showLabel = false,
  className,
}: {
  score: number;
  size?: number;
  animated?: boolean;
  showLabel?: boolean;
  className?: string;
}) {
  const reduce = useReducedMotion();
  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  const tier = scoreTier(clamped);
  const shouldAnimate = animated && !reduce;
  const mv = useMotionValue(shouldAnimate ? 0 : clamped);
  const text = useTransform(mv, (v) => Math.round(v).toString());
  const [ringValue, setRingValue] = React.useState(shouldAnimate ? 0 : clamped / 100);
  const [burst, setBurst] = React.useState(false);

  // The ring follows the motion value (subscription callback, not a synchronous setState in the effect).
  useMotionValueEvent(mv, 'change', (v) => setRingValue(v / 100));

  React.useEffect(() => {
    if (!shouldAnimate) {
      mv.set(clamped);
      return;
    }
    const controls = animate(mv, clamped, { duration: 0.9, ease: [0.2, 0, 0, 1] });
    const b = tier === 'viral' ? window.setTimeout(() => setBurst(true), 780) : undefined;
    return () => {
      controls.stop();
      if (b) window.clearTimeout(b);
    };
  }, [clamped, shouldAnimate, mv, tier]);

  return (
    <div
      className={cn('inline-flex flex-col items-center gap-1.5', className)}
      role="img"
      aria-label={`Virality score ${clamped} out of 100, ${TIER_LABEL[tier]}`}
    >
      <motion.div
        className={cn('relative rounded-full', tier === 'viral' && 'animate-glow-pulse')}
        initial={shouldAnimate ? { scale: 0.7, opacity: 0 } : false}
        animate={{ scale: 1, opacity: 1 }}
        transition={spring.bouncy}
        style={{ width: size, height: size }}
      >
        <ProgressRing
          value={ringValue}
          size={size}
          stroke={Math.max(3, Math.round(size / 11))}
          tone={TIER_RING[tier]}
        >
          <motion.span
            className={cn('font-display font-bold tabular-nums leading-none', TIER_TEXT[tier])}
            style={{ fontSize: size * 0.34 }}
          >
            {text}
          </motion.span>
        </ProgressRing>
        {tier === 'viral' && burst && !reduce
          ? SPARKS.map((s, i) => (
              <motion.span
                key={i}
                aria-hidden
                className="pointer-events-none absolute left-1/2 top-1/2 rounded-full"
                style={{
                  width: s.size,
                  height: s.size,
                  background: SPARK_COLORS[i % SPARK_COLORS.length],
                }}
                initial={{ x: -s.size / 2, y: -s.size / 2, opacity: 1, scale: 1 }}
                animate={{ x: s.x - s.size / 2, y: s.y - s.size / 2, opacity: 0, scale: 0.2 }}
                transition={{ duration: 0.8, delay: s.delay, ease: [0, 0, 0.2, 1] }}
              />
            ))
          : null}
      </motion.div>
      {showLabel ? (
        <span
          className={cn(
            'inline-flex items-center gap-1 text-2xs font-semibold',
            tier === 'viral'
              ? 'text-viral'
              : TIER_TEXT[tier] === 'text-foreground'
                ? 'text-foreground'
                : TIER_TEXT[tier],
          )}
        >
          {tier === 'viral' ? <Flame className="size-3 text-viral-text" aria-hidden /> : null}
          {TIER_LABEL[tier]}
        </span>
      ) : null}
    </div>
  );
}

/** Compact pill for dense rows and thumbnails. */
export function ScoreChip({ score, className }: { score: number; className?: string }) {
  const s = Math.max(0, Math.min(100, Math.round(score)));
  const tier = scoreTier(s);
  return (
    <span
      title={`Virality score ${s} — ${TIER_LABEL[tier]}`}
      className={cn(
        'inline-flex h-6 min-w-9 items-center justify-center gap-1 rounded-full px-2 font-display text-xs font-bold tabular-nums',
        tier === 'viral' && 'bg-viral text-white shadow-[0_0_14px_var(--viral-glow)]',
        tier === 'good' && 'bg-success-soft text-success',
        tier === 'mid' && 'bg-warning-soft text-warning',
        tier === 'low' && 'bg-muted text-score-low',
        className,
      )}
    >
      {tier === 'viral' ? <Flame className="size-3" aria-hidden /> : null}
      {s}
    </span>
  );
}
