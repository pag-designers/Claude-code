'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

export type RingTone = 'primary' | 'success' | 'warning' | 'danger' | 'info' | 'muted' | 'viral';

const STROKE: Record<Exclude<RingTone, 'viral'>, string> = {
  primary: 'var(--primary-text)',
  success: 'var(--success)',
  warning: 'var(--warning)',
  danger: 'var(--danger)',
  info: 'var(--info)',
  muted: 'var(--score-low)',
};

interface ProgressRingProps {
  /** 0..1 */
  value: number;
  size?: number;
  stroke?: number;
  tone?: RingTone;
  /** Dashed, empty ring used for "not configured". */
  dashed?: boolean;
  className?: string;
  children?: React.ReactNode;
  'aria-label'?: string;
}

export function ProgressRing({
  value,
  size = 40,
  stroke = 4,
  tone = 'primary',
  dashed,
  className,
  children,
  'aria-label': ariaLabel,
}: ProgressRingProps) {
  const id = React.useId();
  const v = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div
      role="progressbar"
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v * 100)}
      className={cn('relative inline-flex shrink-0 items-center justify-center', className)}
      style={{ width: size, height: size }}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="-rotate-90"
        aria-hidden
      >
        {tone === 'viral' ? (
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="var(--viral-text)" />
              <stop offset="55%" stopColor="#f472b6" />
              <stop offset="100%" stopColor="#fb923c" />
            </linearGradient>
          </defs>
        ) : null}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--border-strong)"
          strokeWidth={stroke}
          strokeDasharray={dashed ? `${stroke} ${stroke * 1.6}` : undefined}
          strokeLinecap={dashed ? 'round' : undefined}
          opacity={dashed ? 0.8 : 0.55}
        />
        {dashed ? null : (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={tone === 'viral' ? `url(#${id})` : STROKE[tone]}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={c * (1 - v)}
            style={{
              transition:
                'stroke-dashoffset var(--duration-slow) var(--ease-standard), stroke var(--duration-base)',
            }}
          />
        )}
      </svg>
      {children ? (
        <div className="absolute inset-0 flex items-center justify-center">{children}</div>
      ) : null}
    </div>
  );
}
