import { expect, test, type Page } from '@playwright/test';
import {
  E2E,
  HOST,
  analyticsRecorded,
  answerWith,
  clearThrottle,
  signIn,
  waitForAnalytics,
  type RecordedAnalytics,
} from './stack';

/**
 * Error tracking, end to end, against the stand-in ingestion host
 * (scripts/qa/stand-in-analytics.mjs), which serves the REAL vendor library
 * and its error capture extension. The suite runs with analytics on, so error
 * tracking is on too (`PRODUCT_ANALYTICS_ERRORS` unset).
 *
 * One test per surface: a booking page and the dashboard (the browser, both
 * audiences) and a page that fails while the web server renders it; the API's
 * is `api-errors.spec.ts`. Each asserts what reaches the analytics host, that
 * every `$exception` says which product, surface and public host it belongs
 * to, and that nothing personal is in it.
 */
const JORDAN = { accountCode: 'acme', handle: 'jordan-lee', slug: 'quick-chat' };
const EMAIL = 'ana.errors@example.com';
const PHONE = '+57 300 123 4567';
const WEB_HOST = `localhost:${E2E.webPort}`;

test.describe.configure({ mode: 'serial' });

// The vendor library drops events from an automated browser; this one
// presents as a person's (the same override as analytics.spec.ts).
test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false });
    Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => undefined });
  });
});

const isException = (e: RecordedAnalytics, source: 'browser' | 'server', text: string) =>
  e.event === '$exception' && e.source === source && JSON.stringify(e.properties?.['$exception_list'] ?? []).includes(text);

type Entry = { type: string; value: string; mechanism: { handled: boolean }; stacktrace: { frames: Array<Record<string, unknown>> } };
const entries = (e: RecordedAnalytics) => (e.properties?.['$exception_list'] ?? []) as Entry[];

/** What every error event carries, whatever surface sent it: the filters of the error tiles and alerts. */
function expectTagged(e: RecordedAnalytics, surface: string, host: string): void {
  expect(e.properties).toMatchObject({ product: 'calendars', surface, $host: host });
}

/** Nothing personal and no query string, anywhere in the event. */
function expectClean(e: RecordedAnalytics): void {
  const sent = JSON.stringify(e);
  expect(sent).not.toContain(EMAIL);
  expect(sent).not.toContain(encodeURIComponent(EMAIL));
  expect(sent).not.toContain('300 123');
  expect(sent).not.toContain('token=abc');
  expect(sent).not.toContain('E2ECLICK');
  expect(sent).not.toMatch(/\?[\w%.-]+=/);
}

/**
 * Until the library listens for uncaught errors: its extension has loaded AND
 * the page's own `onerror` and `onunhandledrejection` handlers are installed
 * (the extension installs them just after it runs).
 */
async function errorCaptureReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      Boolean((window as unknown as { __PosthogExtensions__?: { errorWrappingFunctions?: unknown } }).__PosthogExtensions__?.errorWrappingFunctions) &&
      typeof window.onerror === 'function' &&
      typeof window.onunhandledrejection === 'function',
    undefined,
    { timeout: 20_000 },
  );
}

/** An uncaught error and an unhandled rejection, raised by the page itself. */
async function failInPage(page: Page, label: string): Promise<void> {
  await page.evaluate(
    ({ email, phone, label }) => {
      setTimeout(() => {
        throw new Error(`${label} for ${email} failed, call ${phone}, see https://x.example.test/p?token=abc`);
      }, 0);
      void Promise.reject(new TypeError(`${label} rejected for ${email}`));
    },
    { email: EMAIL, phone: PHONE, label },
  );
}

test('a booking page error reaches error tracking anonymous and scrubbed', async ({ page }, info) => {
  const since = Date.now();
  const label = `Visitor ${info.project.name}`;
  await page.goto(
    `/${JORDAN.accountCode}/${JORDAN.handle}/${JORDAN.slug}?prefill=${encodeURIComponent(EMAIL)}` +
      `&utm_content=${encodeURIComponent(EMAIL)}&gclid=E2ECLICK`,
  );
  await errorCaptureReady(page);
  await failInPage(page, label);

  const thrown = await waitForAnalytics((e) => isException(e, 'browser', `${label} for`), since);
  const rejected = await waitForAnalytics((e) => isException(e, 'browser', `${label} rejected`), since);
  expect(entries(thrown)[0]).toMatchObject({
    type: 'Error',
    value: `${label} for [email] failed, call [phone], see https://x.example.test/p`,
    mechanism: { handled: false },
  });
  expect(entries(rejected)[0]).toMatchObject({ type: 'TypeError', value: `${label} rejected for [email]` });
  for (const e of [thrown, rejected]) {
    expectTagged(e, 'browser_visitor', WEB_HOST);
    expectClean(e);
    // Anonymous: no person, no profile, no campaign tag or entry URL.
    expect(e.properties?.['$process_person_profile']).toBe(false);
    expect(e.properties?.['account_code']).toBe('acme');
    expect(e.$set).toBeUndefined();
    expect(e.$set_once).toBeUndefined();
    expect(Object.keys(e.properties ?? {}).filter((k) => /utm_|gclid|session_entry_url|session_entry_referrer$|_steps$/.test(k))).toEqual([]);
    for (const frame of entries(e)[0]!.stacktrace.frames) expect(String(frame['filename'] ?? '')).not.toContain('?');
  }
});

test('a dashboard error is filed under the signed-in host, scrubbed', async ({ page }, info) => {
  const since = Date.now();
  const label = `Host ${info.project.name}`;
  await page.goto('/admin');
  await signIn(page, HOST.email);
  await expect(page).toHaveURL(/\/admin/);
  await errorCaptureReady(page);
  await failInPage(page, label);

  const thrown = await waitForAnalytics((e) => isException(e, 'browser', `${label} for`), since);
  expect(thrown.distinct_id).toBe(HOST.email);
  expectTagged(thrown, 'browser_host', WEB_HOST);
  expect(entries(thrown)[0]).toMatchObject({ value: `${label} for [email] failed, call [phone], see https://x.example.test/p` });
  expectClean(thrown);
  const rejected = await waitForAnalytics((e) => isException(e, 'browser', `${label} rejected`), since);
  expectTagged(rejected, 'browser_host', WEB_HOST);
});

test('a page that fails on the web server is reported once, by the server, with its route template', async ({ page }, info) => {
  // Server behaviour, the same in any viewport: once. A second run within a
  // minute would be the same error, which the reporter counts instead of sending.
  test.skip(info.project.name !== 'desktop', 'server-side; runs once');
  const since = Date.now();
  // A status of its own per attempt, so a CI retry raises a different error
  // than the attempt before it, which the reporter would count, not send.
  const status = 500 + info.retry;
  await answerWith({ match: `/v1/profiles/${JORDAN.accountCode}/${JORDAN.handle}`, times: 20, status, body: { error: 'INTERNAL' } });
  const retry = page.getByRole('button', { name: /try again|reintentar/i });
  let requestId: string | undefined;
  try {
    const response = await page.goto(`/${JORDAN.accountCode}/${JORDAN.handle}/${JORDAN.slug}?prefill=${encodeURIComponent(EMAIL)}`);
    requestId = response?.headers()['x-request-id'];
    await expect(retry).toBeVisible();
  } finally {
    await clearThrottle();
  }

  const failure = `API /v1/profiles/${JORDAN.accountCode}/${JORDAN.handle} failed: ${status}`;
  const server = await waitForAnalytics((e) => isException(e, 'server', failure), since);
  expectTagged(server, 'next_server', WEB_HOST);
  expect(server.distinct_id).toBe('calendars-web-server');
  expect(server.properties).toMatchObject({
    route: '/[accountCode]/[handle]/[slug]',
    method: 'GET',
    status: 500,
    account_code: JORDAN.accountCode,
    $process_person_profile: false,
  });
  // The id the response gave the browser is the id the report carries.
  expect(requestId).toMatch(/^req_/);
  expect(server.properties?.['request_id']).toBe(requestId);
  expect(typeof server.properties?.['digest']).toBe('string');
  expect(entries(server)[0]).toMatchObject({ type: 'Error', value: failure, mechanism: { handled: false } });
  // Readable: the failing frame names the source file, not a bundled chunk.
  const top = [...entries(server)[0]!.stacktrace.frames].reverse().find((f) => f['in_app'] === true);
  expect(String(top?.['filename'])).toMatch(/lib\/api\.ts$/);
  expectClean(server);

  // The browser's boundary saw the same failure (it carries a digest) and
  // sent nothing: one failure, one report. Long enough for a report the
  // boundary had sent to arrive: a lazy chunk, the library, a 3 s flush.
  await page.waitForTimeout(8_000);
  const fromBrowser = (await analyticsRecorded(since)).filter((e) => e.event === '$exception' && e.source === 'browser');
  expect(fromBrowser).toEqual([]);

  // R22: the API is back, and Retry asks the server again: the page loads.
  await retry.click();
  await expect(page.getByRole('grid')).toBeVisible();
});
