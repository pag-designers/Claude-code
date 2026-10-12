import { motion } from 'framer-motion';
import { useState } from 'react';

/** "Show hint" link that reveals a tip on demand. */
export default function Hint({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-h-12">
      {open ? (
        <motion.p
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-xl bg-surface-2 px-3 py-2 text-sm text-muted"
        >
          💡 {text}
        </motion.p>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="min-h-12 text-sm font-bold text-primary underline-offset-4 hover:underline"
        >
          Show hint
        </button>
      )}
    </div>
  );
}
