'use client';

import { SecretInput } from '@/components/ui/secret-input';
import { Banner } from '@/components/ui/banner';
import { invoke } from '@/lib/ipc';
import { useSecretActions, useSecrets } from '@/lib/settings';
import type { SecretKey } from '@shared/secrets';
import type { ValidationService } from '@shared/domain';
import { SettingsCard, openExternal } from './common';
import { SettingsHeading } from './settings-shell';

const KEYS: {
  key: SecretKey;
  service: ValidationService;
  title: string;
  description: string;
  field: string;
  placeholder: string;
  url: string;
  helpLabel: string;
}[] = [
  {
    key: 'anthropic.apiKey',
    service: 'anthropic',
    title: 'Anthropic (Claude)',
    description:
      'Powers moment-finding, hooks, scoring and chat. The only paid service in Clipfern.',
    field: 'API key',
    placeholder: 'sk-ant-…',
    url: 'https://console.anthropic.com/settings/keys',
    helpLabel: 'Get a key',
  },
  {
    key: 'pexels.apiKey',
    service: 'pexels',
    title: 'Pexels',
    description: 'Free stock video for B-roll suggestions.',
    field: 'API key',
    placeholder: 'Pexels API key',
    url: 'https://www.pexels.com/api/',
    helpLabel: 'Get a free key',
  },
  {
    key: 'pixabay.apiKey',
    service: 'pixabay',
    title: 'Pixabay',
    description: 'Free stock video and music.',
    field: 'API key',
    placeholder: 'Pixabay API key',
    url: 'https://pixabay.com/api/docs/',
    helpLabel: 'Get a free key',
  },
  {
    key: 'whop.apiKey',
    service: 'whop',
    title: 'Whop',
    description: 'Content Rewards campaigns, submissions and earnings.',
    field: 'API key',
    placeholder: 'Whop API key',
    url: 'https://whop.com/dashboard/developer/',
    helpLabel: 'Open Whop developer dashboard',
  },
];

export function ApiKeysSettings() {
  const { keys, backend, loading } = useSecrets();
  const { save, clear } = useSecretActions();
  return (
    <>
      <SettingsHeading
        title="API Keys"
        description="Keys are encrypted by your operating system's keychain. The interface can only see the last four characters."
      />
      {backend === 'insecure-fallback' ? (
        <Banner tone="warning" title="No OS keychain available">
          Secrets are only lightly obfuscated on this machine. Use a desktop session with Keychain,
          Credential Manager or libsecret for real protection.
        </Banner>
      ) : null}
      {KEYS.map((k) => (
        <SettingsCard key={k.key} title={k.title} description={k.description}>
          <SecretInput
            id={`secret-${k.key}`}
            label={k.field}
            placeholder={k.placeholder}
            status={keys?.[k.key]}
            loading={loading}
            onSave={(v) => save(k.key, v)}
            onClear={() => clear(k.key)}
            onTest={() => invoke('validate:run', { service: k.service })}
            help={{ label: k.helpLabel, onClick: () => void openExternal(k.url) }}
          />
        </SettingsCard>
      ))}
    </>
  );
}
