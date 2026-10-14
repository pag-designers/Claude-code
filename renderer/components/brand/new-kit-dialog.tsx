'use client';

import * as React from 'react';
import type { BrandKitSummary } from '@shared/brand';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { FieldRow, SelectField } from './controls';

/** "New brand kit": a name, and optionally a copy of an existing kit's settings and colors. */
export function NewKitDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kits: BrandKitSummary[];
  busy: boolean;
  error: string | null;
  onCreate: (name: string, copyFrom?: string) => void;
}) {
  const { open, onOpenChange, busy } = props;
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-w-md" data-testid="new-kit-dialog">
        <NewKitForm {...props} />
      </DialogContent>
    </Dialog>
  );
}

/** Mounted only while the dialog is open, so every opening starts from a clean form. */
function NewKitForm({
  onOpenChange,
  kits,
  busy,
  error,
  onCreate,
}: {
  onOpenChange: (open: boolean) => void;
  kits: BrandKitSummary[];
  busy: boolean;
  error: string | null;
  onCreate: (name: string, copyFrom?: string) => void;
}) {
  const [name, setName] = React.useState(kits.length === 0 ? 'My brand' : '');
  const [copy, setCopy] = React.useState('blank');
  const trimmed = name.trim();
  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        if (trimmed) onCreate(trimmed, copy === 'blank' ? undefined : copy);
      }}
    >
      <DialogHeader>
        <DialogTitle className="font-display text-lg font-semibold">New brand kit</DialogTitle>
        <DialogDescription className="text-sm text-muted-foreground">
          One kit per creator or campaign. You can rename it any time.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-4">
        <FieldRow label="Name" htmlFor="new-kit-name">
          <Input
            id="new-kit-name"
            autoFocus
            value={name}
            maxLength={60}
            placeholder="e.g. Acme Podcast"
            onChange={(e) => setName(e.target.value)}
          />
        </FieldRow>
        {kits.length > 0 ? (
          <FieldRow
            label="Start from"
            htmlFor="new-kit-from"
            hint="A copy includes colors, styles and defaults. Files stay with the original kit."
          >
            <SelectField
              id="new-kit-from"
              label="Start from"
              value={copy}
              onChange={setCopy}
              options={[
                { value: 'blank', label: 'A blank kit' },
                ...kits.map((k) => ({ value: k.id, label: `Copy of ${k.name}` })),
              ]}
            />
          </FieldRow>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!trimmed} loading={busy}>
          Create kit
        </Button>
      </DialogFooter>
    </form>
  );
}
