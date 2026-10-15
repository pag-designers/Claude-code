import path from 'node:path';
import type { Menu as ElectronMenu, MenuItemConstructorOptions, NativeImage, Tray } from 'electron';
import type { SchedulerStatus } from '@shared/publish';

/** The slice of Electron the controller needs (injected so it is unit-testable without Electron). */
export interface TrayElectron {
  Tray: new (image: NativeImage) => Tray;
  Menu: { buildFromTemplate(t: MenuItemConstructorOptions[]): ElectronMenu };
  nativeImage: { createFromPath(p: string): NativeImage };
}

export interface TrayDeps {
  electron: TrayElectron;
  /** Folder with tray.png / tray@2x.png / trayTemplate*.png. */
  iconDir: string;
  platform: NodeJS.Platform;
  /** Linux desktops without a status-notifier host swallow the icon; then closing the window must still quit. */
  env?: Record<string, string | undefined>;
  showWindow(): void;
  setPaused(paused: boolean): void;
  quit(): void;
  log(m: string): void;
}

/** Human line for the menu / tooltip: "3 posts scheduled · next 18:30". Pure. */
export function statusLine(s: SchedulerStatus | null, locale?: string): string {
  if (!s) return 'Starting…';
  if (s.paused) return 'Scheduler paused';
  if (s.publishing) return `Publishing ${s.publishing} post${s.publishing === 1 ? '' : 's'}…`;
  if (!s.upcoming) return 'No posts scheduled';
  const next = s.nextAt
    ? ` · next ${new Date(s.nextAt).toLocaleString(locale, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`
    : '';
  return `${s.upcoming} post${s.upcoming === 1 ? '' : 's'} scheduled${next}`;
}

/** Tray / menu-bar presence so the scheduler keeps running after the window is closed (BRIEF §9). */
export class TrayController {
  private tray: Tray | null = null;
  private last: SchedulerStatus | null = null;

  constructor(private readonly d: TrayDeps) {}

  /** Whether the OS is likely to show a tray icon at all. */
  get supported(): boolean {
    if (this.d.platform !== 'linux') return true;
    const env = this.d.env ?? process.env;
    return !!(env.XDG_CURRENT_DESKTOP || env.CLIPFERN_FORCE_TRAY === '1');
  }

  get active(): boolean {
    return this.tray !== null;
  }

  ensure(): boolean {
    if (this.tray) return true;
    if (!this.supported) return false;
    try {
      const { Tray, nativeImage } = this.d.electron;
      const mac = this.d.platform === 'darwin';
      const icon = nativeImage.createFromPath(
        path.join(this.d.iconDir, mac ? 'trayTemplate.png' : 'tray.png'),
      );
      if (mac) (icon as unknown as { setTemplateImage(v: boolean): void }).setTemplateImage(true);
      this.tray = new Tray(icon);
      this.tray.on('click', () => this.d.showWindow());
      this.refresh();
      return true;
    } catch (e) {
      this.d.log(`tray unavailable: ${e instanceof Error ? e.message : String(e)}`);
      this.tray = null;
      return false;
    }
  }

  update(status: SchedulerStatus): void {
    this.last = status;
    this.refresh();
  }

  private refresh(): void {
    if (!this.tray) return;
    const line = statusLine(this.last);
    this.tray.setToolTip(`Clipfern — ${line}`);
    this.tray.setContextMenu(
      this.d.electron.Menu.buildFromTemplate([
        { label: 'Open Clipfern', click: () => this.d.showWindow() },
        { type: 'separator' },
        { label: line, enabled: false },
        {
          label: this.last?.paused ? 'Resume scheduler' : 'Pause scheduler',
          click: () => this.d.setPaused(!this.last?.paused),
        },
        { type: 'separator' },
        { label: 'Quit Clipfern', click: () => this.d.quit() },
      ]),
    );
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }
}
