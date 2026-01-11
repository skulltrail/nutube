import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for Chrome Extension E2E testing.
 *
 * Note: Chrome extensions require a persistent context and cannot use
 * headless mode. Tests launch Chrome with the extension loaded.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false, // Extensions need serial execution
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1, // Single worker for extension testing
  reporter: process.env.CI ? 'github' : 'html',
  timeout: 60000, // Extension loading can take time

  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'on-first-retry',
  },

  projects: [
    {
      name: 'chromium-extension',
      use: {
        // Chrome extension testing requires specific setup
        // See e2e/extension.spec.ts for context configuration
      },
    },
  ],
});
