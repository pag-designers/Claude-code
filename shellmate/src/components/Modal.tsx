import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, type ReactNode } from 'react';
import { XIcon } from './Icons';

type Props = {
  open: boolean;
  onClose?: () => void;
  children: ReactNode;
  title?: string;
  /** Taller scrollable variant for long content. */
  wide?: boolean;
};

export default function Modal({ open, onClose, children, title, wide = false }: Props) {
  useEffect(() => {
    if (!open || !onClose) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={title}
            className={`card relative w-full max-w-[440px] ${wide ? 'max-h-[85vh] overflow-y-auto' : ''}`}
            initial={{ y: 40, scale: 0.96, opacity: 0 }}
            animate={{ y: 0, scale: 1, opacity: 1 }}
            exit={{ y: 40, scale: 0.96, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 320, damping: 28 }}
            onClick={(e) => e.stopPropagation()}
          >
            {(title || onClose) && (
              <div className="mb-3 flex items-start justify-between gap-3">
                {title ? <h2 className="text-xl font-black">{title}</h2> : <span />}
                {onClose && (
                  <button onClick={onClose} className="-m-1 rounded-xl p-1 text-muted hover:text-ink" aria-label="Close">
                    <XIcon size={22} />
                  </button>
                )}
              </div>
            )}
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
