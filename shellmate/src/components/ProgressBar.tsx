import { motion } from 'framer-motion';

type Props = { value: number; color?: string; className?: string; height?: number };

/** Rounded progress bar; value in [0, 1]. */
export default function ProgressBar({ value, color = 'var(--success)', className = '', height = 16 }: Props) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div
      className={`relative w-full overflow-hidden rounded-full bg-surface-2 ${className}`}
      style={{ height }}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
    >
      <motion.div
        className="absolute inset-y-0 left-0 rounded-full"
        style={{ background: color }}
        initial={false}
        animate={{ width: `${pct}%` }}
        transition={{ type: 'spring', stiffness: 120, damping: 20 }}
      >
        <div className="absolute left-2 right-2 top-[3px] h-[30%] rounded-full bg-white/30" />
      </motion.div>
    </div>
  );
}
