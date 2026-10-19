import { expect, test, type Page } from '@playwright/test';
import { E2E, HOST, clearThrottle, throttle, throttledCount, visitorEmail } from './stack';

/**
 * A busy API (429) as a visitor meets it. The web calls the API from its own
 * server, so the 429s come from the proxy in front of the API
 * (fault-proxy.mjs), exactly where the API's limiter would answer them.
 *
 * It used to be "This page didn't load. Something went wrong reaching the
 * scheduling service": an outage, for a service that only asked for a second.
 * Now the page says it is busy, retries on its own after Retry-After, and keeps
 * a Try again button; a booking refused as busy keeps the form and says to
 * press Confirm again.
 */
const PAGE = `/${HOST.accountCode}/${HOST.handle}/${HOST.slug}`;
const PROFILE = `/v1/profiles/${HOST.accountCode}/${HOST.handle}`;
const OUTAGE = /didn.t load|went wrong|esta página no cargó/i;

test.describe.configure({ mode: 'serial' });
test.afterEach(async () => clearThrottle());

const openDay = (page: Page) => page.getByRole('grid').getByRole('button', { disabled: false }).first();

test('a busy API: the booking page says so, never the outage page, and comes back on its own', async ({ page }) => {
  // Refused twice: the first view and the first automatic retry.
  await throttle({ match: PROFILE, times: 2, retryAfter: 3 });
  const before = await throttledCount();
  await page.goto(PAGE);
  await expect(page.getByRole('heading', { name: 'Busy for a moment' })).toBeVisible();
  await expect(page.getByText(/getting a lot of requests right now/i)).toBeVisible();
  await expect(page.getByText(/Trying again in \d+ s\./)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(page.getByText(OUTAGE)).toHaveCount(0);
  // Retry-After honoured: nothing asked again within the first 2.5 s.
  await page.waitForTimeout(2_500);
  expect(await throttledCount()).toBe(before + 1);
  // Then on its own, twice, and the page arrives.
  await expect(openDay(page)).toBeVisible({ timeout: 20_000 });
  expect(await throttledCount()).toBe(before + 2);
});

test('Try again asks at once, without waiting out a long Retry-After', async ({ page }) => {
  await throttle({ match: PROFILE, times: 1, retryAfter: 30 });
  await page.goto(PAGE);
  await expect(page.getByRole('heading', { name: 'Busy for a moment' })).toBeVisible();
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(openDay(page)).toBeVisible();
});

test('in Spanish too', async ({ page }) => {
  await throttle({ match: PROFILE, times: 1, retryAfter: 30 });
  await page.goto(`${PAGE}?lang=es`);
  await expect(page.getByRole('heading', { name: 'Un momento, por favor' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reintentar' })).toBeVisible();
  await expect(page.getByText(OUTAGE)).toHaveCount(0);
});

test("a busy month read says busy (not that the calendar is broken) and fills in by itself", async ({ page }) => {
  // The visible month's read on the server, then the island's own retries.
  await throttle({ match: '/v1/availability', times: 3, retryAfter: 3 });
  await page.goto(PAGE);
  await expect(page.getByText(/Lots of people are booking right now/)).toBeVisible();
  await expect(page.getByText(OUTAGE)).toHaveCount(0);
  await expect(page.getByText(/can.t read this calendar/i)).toHaveCount(0);
  await expect(openDay(page)).toBeVisible({ timeout: 30_000 });
});

test('a booking refused as busy keeps every field, says to press Confirm again, and then books', async ({
  page,
  request,
}) => {
  await page.goto(PAGE);
  await openDay(page).click();
  const times = page
    .getByRole('region', { name: /choose a time/i })
    .getByRole('button', { name: /^\d{1,2}:\d{2}( [AP]M)?$/ });
  await times.last().click();
  const email = visitorEmail('busy');
  await page.getByRole('textbox', { name: /your name/i }).fill('Ada Visitor');
  await page.getByRole('textbox', { name: /your email/i }).fill(email);
  await page.getByRole('textbox', { name: /company/i }).fill('Example Co');

  // Refused on the first try and on the server's one short retry after it.
  await throttle({ match: '/v1/bookings', method: 'POST', times: 2, retryAfter: 1 });
  await page.getByRole('button', { name: /confirm booking/i }).click();
  await expect(page.getByRole('alert').filter({ hasText: /press Confirm again/i })).toBeVisible();
  await expect(page.getByRole('textbox', { name: /your name/i })).toHaveValue('Ada Visitor');
  await expect(page.getByRole('textbox', { name: /your email/i })).toHaveValue(email);

  await page.getByRole('button', { name: /confirm booking/i }).click();
  const done = page.getByRole('region', { name: /booking confirmed/i });
  await expect(done).toBeVisible();

  // Give the time back, so the files after this one find the day as it was.
  const manage = new URL((await done.getByRole('link', { name: /manage your booking/i }).getAttribute('href'))!);
  const uid = manage.pathname.split('/').pop()!;
  const r = await request.post(`${E2E.api}/v1/bookings/${uid}/cancel`, {
    headers: { 'x-manage-token': manage.searchParams.get('token')! },
    data: {},
  });
  expect(r.status()).toBe(200);
});
