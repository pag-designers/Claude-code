import { motion } from 'framer-motion';
import { useState } from 'react';

const COLORS = ['#ff7a45', '#ffc83d', '#3ddc84', '#4aa8ff', '#ff5c6c', '#b18cff'];

function makeParticles(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: i,
    x: (Math.random() - 0.5) * 520,
    y: -(Math.random() * 380 + 120),
    fall: Math.random() * 300 + 520,
    rotate: Math.random() * 720 - 360,
    color: COLORS[i % COLORS.length],
    w: Math.random() * 6 + 6,
    h: Math.random() * 8 + 8,
    round: Math.random() > 0.6,
    delay: Math.random() * 0.25,
    duration: Math.random() * 1.2 + 1.8,
  }));
}

/** Lightweight confetti burst made of framer-motion particles. */
export default function Confetti({ count = 70 }: { count?: number }) {
  const [parts] = useState(() => makeParticles(count));
  return (
    <div className="pointer-events-none fixed inset-0 z-50 overflow-hidden" aria-hidden>
      <div className="absolute left-1/2 top-[38%]">
        {parts.map((p) => (
          <motion.span
            key={p.id}
            className="absolute block"
            style={{ width: p.w, height: p.round ? p.w : p.h, background: p.color, borderRadius: p.round ? 999 : 2 }}
            initial={{ x: 0, y: 0, opacity: 1, rotate: 0, scale: 0.6 }}
            animate={{ x: [0, p.x, p.x * 1.1], y: [0, p.y, p.y + p.fall], rotate: p.rotate, opacity: [1, 1, 0], scale: 1 }}
            transition={{ duration: p.duration, delay: p.delay, times: [0, 0.3, 1], ease: 'easeOut' }}
          />
        ))}
      </div>
    </div>
  );
}
