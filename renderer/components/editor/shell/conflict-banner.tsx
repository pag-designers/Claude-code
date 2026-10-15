'use client';

import * as React from 'react';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';

/** Shown when another window saved a newer revision of this project. */
export function ConflictBanner({
  onResolve,
}: {
  onResolve: (choice: 'reload' | 'keep-mine') => Promise<void>;
}) {
  const [busy, setBusy] = React.useState<'reload' | 'keep-mine' | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const run = async (choice: 'reload' | 'keep-mine') => {
    setBusy(choice);
    setError(null);
    try {
      await onResolve(choice);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not resolve the conflict.');
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="shrink-0 border-b bg-background px-3 py-2" data-testid="conflict-banner">
      <Banner
        tone="warning"
        title="This project was changed in another window"
        action={
          <div className="flex items-center gap-2">
            <Button
              size="xs"
              variant="secondary"
              loading={busy === 'reload'}
              disabled={busy !== null}
              onClick={() => run('reload')}
              data-testid="conflict-reload"
            >
              Reload
            </Button>
            <Button
              size="xs"
              variant="primary"
              loading={busy === 'keep-mine'}
              disabled={busy !== null}
              onClick={() => run('keep-mine')}
              data-testid="conflict-keep"
            >
              Keep mine
            </Button>
          </div>
        }
      >
        {error ??
          'Reload to take the other window’s version, or keep yours and overwrite it. Autosave is paused until you choose.'}
      </Banner>
    </div>
  );
}
