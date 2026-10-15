'use client';

import { Kbd } from '@/components/ui/kbd';
import { Badge } from '@/components/ui/badge';
import { NAV_ITEMS, SETTINGS_ITEM } from '@/lib/nav';
import { SettingsCard } from './common';
import { SettingsHeading } from './settings-shell';

function Row({ label, keys }: { label: string; keys: string[] }) {
  return (
    <li className="flex items-center justify-between gap-4 py-2.5">
      <span className="text-sm">{label}</span>
      <Kbd keys={keys} />
    </li>
  );
}

const EDITOR: [string, string[]][] = [
  ['Play / pause', ['Space']],
  ['Split at playhead', ['S']],
  ['Step one frame', ['←', '→']],
  ['Transport', ['J', 'K', 'L']],
  ['Undo / redo', ['mod', 'Z']],
];

export function ShortcutsSettings() {
  const pages = [...NAV_ITEMS, SETTINGS_ITEM];
  return (
    <>
      <SettingsHeading
        title="Shortcuts"
        description="Keyboard shortcuts that work anywhere in Clipfern."
      />
      <SettingsCard title="Global">
        <ul className="-my-2 divide-y">
          <Row label="Open command palette" keys={['mod', 'K']} />
          <Row label="Collapse or expand sidebar" keys={['mod', 'B']} />
          <Row label="Open settings" keys={['mod', ',']} />
          {pages.map((p, i) => (
            <Row key={p.href} label={`Go to ${p.label}`} keys={['mod', String(i + 1)]} />
          ))}
        </ul>
      </SettingsCard>
      <SettingsCard
        title="Editor"
        description="Modelled on CapCut and Premiere. These become active when the editor ships."
        action={<Badge variant="primary">Checkpoint 3</Badge>}
      >
        <ul className="-my-2 divide-y opacity-70">
          {EDITOR.map(([label, keys]) => (
            <Row key={label} label={label} keys={keys} />
          ))}
        </ul>
      </SettingsCard>
    </>
  );
}
