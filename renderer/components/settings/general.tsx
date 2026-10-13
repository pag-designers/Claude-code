'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { toast } from 'sonner';
import type { Theme } from '@shared/settings';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { Kbd } from '@/components/ui/kbd';
import { useSettings } from '@/lib/settings';
import { useSidebar, useTheme } from '@/lib/shell';
import { SettingRow, SettingsCard } from './common';
import { SettingsHeading } from './settings-shell';

export function GeneralSettings() {
  const { pref, setTheme } = useTheme();
  const { collapsed, setCollapsed } = useSidebar();
  const { ready } = useSettings();
  return (
    <>
      <SettingsHeading
        title="General"
        description="How Clipfern looks and behaves on this computer."
      />
      <SettingsCard
        title="Appearance"
        description="Applied instantly and remembered, with no flash when the app starts."
      >
        <SettingRow
          label="Theme"
          description="System follows your operating system, including when it switches at sunset."
        >
          <Segmented
            label="Theme"
            value={pref}
            onValueChange={(t: Theme) => {
              setTheme(t);
              toast.success(`Theme: ${t === 'system' ? 'match system' : t}`);
            }}
            options={[
              { value: 'system', label: 'System', icon: <Monitor /> },
              { value: 'light', label: 'Light', icon: <Sun /> },
              { value: 'dark', label: 'Dark', icon: <Moon /> },
            ]}
          />
        </SettingRow>
        <SettingRow
          label="Collapse sidebar"
          htmlFor="sidebar-collapsed"
          description={
            <span className="inline-flex items-center gap-1.5">
              Icon-only navigation for more room. Toggle anywhere with <Kbd keys={['mod', 'B']} />
            </span>
          }
        >
          <Switch
            id="sidebar-collapsed"
            checked={collapsed}
            disabled={!ready}
            onCheckedChange={(c) => {
              setCollapsed(c);
              toast.success(c ? 'Sidebar collapsed' : 'Sidebar expanded');
            }}
          />
        </SettingRow>
        <SettingRow
          label="Motion"
          description="Animations are reduced automatically when your operating system asks for reduced motion."
        >
          <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
            Follows system
          </span>
        </SettingRow>
      </SettingsCard>
    </>
  );
}
