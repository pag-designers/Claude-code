'use client';

import { motion } from 'framer-motion';
import { duration, ease } from '@/lib/motion';

/** Re-mounts on every navigation: a short fade/lift. MotionConfig(reducedMotion="user") drops the transform. */
export default function Template({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      className="min-h-full"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: duration.slow, ease: ease.out }}
    >
      {children}
    </motion.div>
  );
}
