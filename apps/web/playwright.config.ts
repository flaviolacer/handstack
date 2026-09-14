import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.e2e.ts',
  fullyParallel: true,
  forbidOnly: true,
  retries: 1,
  reporter: 'line',
  outputDir: 'test-results',
  snapshotPathTemplate: '{testDir}/snapshots/{testFilePath}/{projectName}/{arg}{ext}',
  use: {
    baseURL: 'http://127.0.0.1:3000',
    colorScheme: 'dark',
    locale: 'en-US',
    timezoneId: 'America/Sao_Paulo',
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm --workspace @handstack/web run start',
    url: 'http://127.0.0.1:3000/chat',
    reuseExistingServer: false,
    timeout: 60_000,
  },
  projects: [
    {
      name: 'chromium-360',
      use: { ...devices['Desktop Chrome'], viewport: { width: 360, height: 800 } },
    },
    {
      name: 'firefox-360',
      use: { ...devices['Desktop Firefox'], viewport: { width: 360, height: 800 } },
    },
    {
      name: 'webkit-360',
      use: { ...devices['Desktop Safari'], viewport: { width: 360, height: 800 } },
    },
  ],
});
