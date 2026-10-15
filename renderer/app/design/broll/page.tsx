import * as React from 'react';
import { BrollHost } from '@/components/broll/broll-host';

/** Unlisted reference page for the stock B-roll dialog (see components/broll/broll-host.tsx). */
export default function BrollReference() {
  return (
    <React.Suspense fallback={null}>
      <BrollHost />
    </React.Suspense>
  );
}
