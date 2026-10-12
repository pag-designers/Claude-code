import { AnimatePresence, motion } from 'framer-motion';
import type { ReactNode } from 'react';

type Props = { open: boolean; tone: 'success' | 'error' | 'neutral'; children: ReactNode };

const TONE: Record<Props['tone'], string> = {
  success: 'color-mix(in srgb, var(--success) 18%, var(--surface))',
  error: 'color-mix(in srgb, var(--error) 18%, var(--surface))',
  neutral: 'var(--surface)',
};

/** Feedback sheet that slides up from the bottom of the app column. */
export default function BottomSheet({ open, tone, children }: Props) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-x-0 bottom-0 z-40"
          initial={{ y: '100%' }}
          animate={{ y: 0 }}
          exit={{ y: '100%' }}
          transition={{ type: 'spring', stiffness: 380, damping: 34 }}
        >
          <div
            className="mx-auto max-w-[480px] rounded-t-3xl border-t-2 border-line px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-5"
            style={{ background: TONE[tone] }}
          >
            {children}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
