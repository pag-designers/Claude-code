// Renders build/icon.svg -> build/icon.png (1024) using the preinstalled Chromium via Playwright.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const svg = fs.readFileSync(path.join(here, 'icon.svg'), 'utf8');
const exe = process.env.PLAYWRIGHT_BROWSERS_PATH
  ? fs
      .readdirSync(process.env.PLAYWRIGHT_BROWSERS_PATH)
      .filter((d) => d.startsWith('chromium-'))
      .map((d) => path.join(process.env.PLAYWRIGHT_BROWSERS_PATH, d, 'chrome-linux', 'chrome'))[0]
  : undefined;
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
await page.setContent(
  `<html><body style="margin:0;background:transparent">${svg.replace('<svg ', '<svg width="1024" height="1024" ')}</body></html>`,
);
await page.screenshot({ path: path.join(here, 'icon.png'), omitBackground: true });
await browser.close();
console.log('wrote build/icon.png');
