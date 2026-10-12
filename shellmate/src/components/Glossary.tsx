import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, type ReactNode } from 'react';
import { useGlossaryPopup, type GlossaryEntry } from '../lib/glossary';
import { sfx } from '../lib/sound';

/** A tappable abbreviation: dotted underline, opens the explanation popup. */
export function Term({ entry, children, code = false }: { entry: GlossaryEntry; children: ReactNode; code?: boolean }) {
  const show = useGlossaryPopup((s) => s.show);
  return (
    <span
      role="button"
      tabIndex={0}
      title={entry.full ?? entry.meaning}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        sfx.tap();
        show(entry);
      }}
      onKeyDown={(e) => {
        if (e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          show(entry);
        }
      }}
      className={`cursor-help underline decoration-dotted decoration-2 underline-offset-4 ${
        code ? 'decoration-current/60' : 'decoration-primary/70 hover:text-primary'
      }`}
    >
      {children}
    </span>
  );
}

/** Small card explaining one term. Rendered once, near the top of the app. */
export function GlossaryPopup() {
  const { open, close } = useGlossaryPopup();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, close]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[70] flex items-start justify-center bg-black/40 px-4 pt-24"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={close}
        >
          <motion.div
            role="dialog"
            aria-label={`What ${open.term} means`}
            className="card w-full max-w-[420px] shadow-2xl"
            initial={{ y: -16, scale: 0.96 }}
            animate={{ y: 0, scale: 1 }}
            exit={{ y: -10, opacity: 0 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-xs font-black uppercase tracking-widest text-muted">What does this mean?</div>
            <div className="mt-2 flex flex-wrap items-baseline gap-x-2">
              <code className="rounded-lg bg-code px-2 py-1 font-mono text-lg font-bold text-primary">{open.term}</code>
              {open.full && <span className="text-lg font-black">= {open.full}</span>}
            </div>
            <p className="mt-3 font-semibold leading-relaxed text-ink/90">{open.meaning}</p>
            <button className="btn3d mt-4 w-full" onClick={close}>
              Got it
            </button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
