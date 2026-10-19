import { defineConfig, devices } from '@playwright/test';
import { ANALYTICS_ENV, E2E } from './e2e/stack';

/**
 * The browser suite: the real web app and the real API on a fresh database,
 * with the stand-in calendar backend (scripts/qa/stand-in-calendar.mjs) as the
 * host's connected calendar. Run from apps/web:
 *
 *   pnpm build:packages            # once, from the repo root
 *   pnpm --filter @slate/web e2e   # SQLite
 *   E2E_DATABASE_URL=postgres://slate:slate@localhost:5432/slate_e2e pnpm --filter @slate/web e2e
 *
 * Ports are E2E_WEB_PORT / E2E_API_PORT / E2E_CALENDAR_PORT (3411 / 4411 / 4519)
 * so the suite runs beside a `pnpm dev` on 3000 / 4000. A second API on
 * E2E_LIMITED_API_PORT (4412) has a small rate limit for the limiter tests, so
 * the rest of the suite never trips it.
 */
export default defineConfig({
  testDir: './e2e',
  outputDir: './e2e/.results',
  // One stack, shared state (one slot, one booking): the files run in order.
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: './e2e/.report' }]] : 'list',
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: E2E.web,
    locale: 'en-US',
    timezoneId: 'America/New_York',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
      testIgnore: /api-.*\.spec\.ts/,
    },
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'], viewport: { width: 360, height: 780 } },
      testIgnore: /api-.*\.spec\.ts/,
    },
    // Server behaviour, once, after both browser runs: the request-log check
    // reads the log of every booking those runs made.
    { name: 'api', testMatch: /api-.*\.spec\.ts/, dependencies: ['desktop', 'mobile'] },
  ],
  webServer: [
    {
      command: `node ../../scripts/qa/stand-in-calendar.mjs ${E2E.calendarPort}`,
      url: `${E2E.calendar}/__qa/calls`,
      reuseExistingServer: false,
    },
    {
      command: `node ../../scripts/qa/stand-in-analytics.mjs ${E2E.analyticsPort}`,
      url: `${E2E.analytics}/__qa/events`,
      reuseExistingServer: false,
    },
    {
      command: 'node e2e/start-api.mjs main',
      url: `${E2E.api}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'node e2e/start-api.mjs limited',
      url: `${E2E.limitedApi}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      // On CI the image is built WITHOUT the analytics variables and started
      // with them, the way one image serves every environment: a value that
      // only works when inlined at build time fails the analytics spec here.
      command: process.env.CI
        ? `env ${Object.keys(ANALYTICS_ENV)
            .map((k) => `-u ${k}`)
            .join(' ')} pnpm exec next build && pnpm exec next start -p ${E2E.webPort}`
        : `pnpm exec next dev -p ${E2E.webPort}`,
      url: `${E2E.web}/acme/alex-rivera/intro-call`,
      reuseExistingServer: false,
      timeout: 300_000,
      env: {
        NEXT_PUBLIC_API_URL: E2E.api,
        API_URL: E2E.api,
        NEXT_PUBLIC_SIGNUP_URL: E2E.signupUrl,
        ...ANALYTICS_ENV,
      },
    },
  ],
});
