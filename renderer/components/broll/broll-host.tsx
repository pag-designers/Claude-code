'use client';

import * as React from 'react';
import { useSearchParams } from 'next/navigation';
import { Film } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StockBrollDialog, type StockBrollDialogProps } from './stock-dialog';

/**
 * Unlisted reference host for the stock B-roll dialog (`/design/broll/`), used by the stubbed-bridge e2e tests.
 * Query: `target=project|kit` (default project), `q` (initialQuery), `suggest` (suggestFrom), `open=0` to start closed.
 * The readout prints every `onImported` payload as JSON, in call order.
 */
export function BrollHost() {
  const params = useSearchParams();
  const kind = params.get('target') === 'kit' ? 'kit' : 'project';
  const [open, setOpen] = React.useState(params.get('open') !== '0');
  const [imported, setImported] = React.useState<unknown[]>([]);
  const target: StockBrollDialogProps['target'] =
    kind === 'kit' ? { kind: 'kit', kitId: 'kit-1' } : { kind: 'project', projectId: 'proj-1' };
  return (
    <div className="flex flex-col gap-4 p-8" data-testid="broll-host" data-open={open}>
      <div className="flex items-center gap-3">
        <Button variant="primary" onClick={() => setOpen(true)} data-testid="host-open-broll">
          <Film aria-hidden /> Stock B-roll
        </Button>
        <span className="text-sm text-muted-foreground" data-testid="host-target">
          {kind}
        </span>
      </div>
      <pre className="text-xs text-muted-foreground" data-testid="host-imported">
        {JSON.stringify(imported)}
      </pre>
      <StockBrollDialog
        open={open}
        onOpenChange={setOpen}
        target={target}
        initialQuery={params.get('q') ?? undefined}
        suggestFrom={params.get('suggest') ?? undefined}
        onImported={(r) => setImported((prev) => [...prev, r])}
      />
    </div>
  );
}
