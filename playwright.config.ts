import { defineConfig } from '@playwright/test';

// Electron e2e. On headless Linux run through xvfb:  xvfb-run -a pnpm test:e2e
export default defineConfig({
  testDir: 'test/e2e',
  testMatch: /.*\.spec\.ts/,
  timeout: 90_000,
  workers: 1,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
});
