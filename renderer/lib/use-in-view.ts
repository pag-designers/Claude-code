'use client';

import { useEffect, useRef, useState } from 'react';

/** True once the element has been near the viewport (sticky: stays true, so images do not unload on scroll). */
export function useInView<T extends Element>(rootMargin = '300px') {
  const ref = useRef<T | null>(null);
  // no IntersectionObserver (very old runtime): treat everything as visible
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen, rootMargin]);
  return [ref, seen] as const;
}
