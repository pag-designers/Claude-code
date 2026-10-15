'use client';

import Link from 'next/link';
import { ExternalLink, KeyRound } from 'lucide-react';
import type { BrollProvider } from '@shared/brand';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { PROVIDER_INFO, SETTINGS_API_KEYS_HREF } from '@/lib/broll/model';

/** Guidance (not an error) shown when the selected provider has no API key yet. */
export function MissingKey({
  provider,
  otherReady,
  onOpenLink,
  onNavigate,
  onSwitch,
}: {
  provider: BrollProvider;
  /** The other provider, when it does have a key. */
  otherReady: BrollProvider | null;
  onOpenLink: (url: string) => void;
  onNavigate: () => void;
  onSwitch: (p: BrollProvider) => void;
}) {
  const info = PROVIDER_INFO[provider];
  return (
    <div data-testid="broll-missing-key" className="flex h-full items-center justify-center">
      <EmptyState
        icon={KeyRound}
        size="sm"
        title={`Add your ${info.name} API key`}
        description={`Clipfern searches ${info.name}'s free stock library with your own key. It is stored only on this computer, in your system keychain.`}
        steps={[
          `Create a free key at ${info.keyUrl.replace('https://', '').replace(/\/$/, '')}`,
          'Paste it in Settings → API Keys and press Test',
          'Come back here. No restart needed.',
        ]}
        actions={
          <>
            <Button variant="primary" asChild>
              <Link
                href={SETTINGS_API_KEYS_HREF}
                onClick={onNavigate}
                data-testid="broll-open-settings"
              >
                <KeyRound aria-hidden />
                Open Settings &rarr; API Keys
              </Link>
            </Button>
            <Button variant="outline" onClick={() => onOpenLink(info.keyUrl)}>
              <ExternalLink aria-hidden />
              Get a free {info.name} key
            </Button>
            {otherReady ? (
              <Button
                variant="ghost"
                onClick={() => onSwitch(otherReady)}
                data-testid="broll-switch-provider"
              >
                Search {PROVIDER_INFO[otherReady].name} instead
              </Button>
            ) : null}
          </>
        }
      />
    </div>
  );
}
