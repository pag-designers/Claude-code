/**
 * Tiny Electron main script for brand-media-electron.spec.ts: exposes the real SVG rasteriser on globalThis so the
 * spec can drive it through `electronApp.evaluate`. No windows of its own, so it must not quit when the last
 * (hidden) rasteriser window is destroyed.
 */
import { app, BrowserWindow } from 'electron';
import { createElectronSvgRasterizer } from '../../../electron/main/services/brand-media/svg-electron';

app.on('window-all-closed', () => {
  /* stay alive: the spec closes the app */
});

const g = globalThis as unknown as Record<string, unknown>;
g.__rasterize = createElectronSvgRasterizer();
g.__windowCount = (): number => BrowserWindow.getAllWindows().length;
