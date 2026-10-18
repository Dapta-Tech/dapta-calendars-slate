import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { E2E, visitorEmail } from './stack';

/**
 * The host's request email, followed from a signed-out browser: its "Confirm
 * or decline" button opens the booking's own page, the dashboard sends the host
 * through the login, and the login lands back on that booking with its actions.
 * The API's local provider runs strict here (start-api.mjs), so a browser with
 * no session is really signed out.
 *
 * The link is written the way the API writes it into the mail:
 * `PUBLIC_APP_URL` + `adminBookingPath(uid)` (pinned in host-request-email.spec.ts
 * and shared.spec.ts).
 */
const JORDAN = { accountCode: 'acme', handle: 'jordan-lee', slug: 'by-request', email: 'jordan@example.com' };
const emailLink = (uid: string) => `/admin/bookings/${uid}`;

/** A fresh request on Jordan's confirm-by-hand event, booked the way a visitor books it. */
async function requestBooking(request: APIRequestContext, tag: string): Promise<string> {
  const from = new Date(Date.now() + 86_400_000);
  const to = new Date(from.getTime() + 30 * 86_400_000);
  const r = await request.get(`${E2E.api}/v1/availability`, {
    params: { ...JORDAN, from: from.toISOString(), to: to.toISOString() },
  });
  expect(r.ok()).toBe(true);
  const { slots } = (await r.json()) as { slots: Array<{ startUtc: string }> };
  // From the far end, so the profile suite's "first free time" is never this one.
  for (const slot of slots.slice(-5).reverse()) {
    const booked = await request.post(`${E2E.api}/v1/bookings`, {
      data: {
        ...JORDAN,
        startUtc: slot.startUtc,
        attendee: { name: 'Deep Link Visitor', email: visitorEmail(tag), timeZone: 'America/New_York' },
      },
    });
    if (booked.status() !== 201) continue;
    const body = (await booked.json()) as { uid: string; status: string };
    expect(body.status).toBe('pending');
    return body.uid;
  }
  throw new Error('no free time left to request');
}

async function signIn(page: Page, email: string): Promise<void> {
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Continue' }).click();
}

test('signed out: the email link goes through the login and lands on that booking, ready to act', async ({
  page,
  request,
}) => {
  const uid = await requestBooking(request, 'deeplink');

  await page.goto(emailLink(uid));
  // The login knows where it is going back to.
  await expect(page).toHaveURL(new RegExp(`/login\\?next=${encodeURIComponent(emailLink(uid))}$`));
  await signIn(page, JORDAN.email);

  await expect(page).toHaveURL(new RegExp(`${emailLink(uid)}$`));
  await expect(page.getByText('By Request')).toBeVisible();
  const confirm = page.getByRole('button', { name: 'Confirm', exact: true });
  const decline = page.getByRole('button', { name: 'Decline', exact: true });
  await expect(confirm).toBeVisible();
  await expect(decline).toBeVisible();
  await expect(page.getByText('pending', { exact: true })).toBeVisible();

  // The action works from here, and the page says what it did. Declining
  // releases the time, so the rest of the suite still finds it free.
  await decline.click();
  await expect(page.getByText('rejected', { exact: true })).toBeVisible();
  await expect(confirm).toBeHidden();
});

test('a link from an older email (the uid in the fragment) still opens its booking', async ({ page, request }) => {
  const uid = await requestBooking(request, 'legacy');

  await page.goto('/login');
  await signIn(page, JORDAN.email);
  await expect(page).toHaveURL(/\/admin/);

  await page.goto(`/admin/bookings#booking-${uid}`);
  await expect(page).toHaveURL(new RegExp(`${emailLink(uid)}$`));
  await expect(page.getByRole('button', { name: 'Decline', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Decline', exact: true }).click();
  await expect(page.getByText('rejected', { exact: true })).toBeVisible();
});

test("another workspace's booking is not found, and nothing of it shows", async ({ page, request, context }) => {
  const uid = await requestBooking(request, 'foreign');

  // A brand-new workspace of its own, made by one call first: the dev login
  // makes a workspace on a person's first request, and the dashboard's first
  // render asks several things at once, which on Postgres can race that.
  // Its onboarding is not what this checks.
  const stranger = visitorEmail('stranger');
  expect((await request.get(`${E2E.api}/v1/me`, { headers: { 'x-slate-email': stranger } })).ok()).toBe(true);
  await context.addCookies([{ name: 'slate.onboarding.skipped', value: '1', url: E2E.web }]);
  await page.goto(emailLink(uid));
  await signIn(page, stranger);

  await expect(page).toHaveURL(new RegExp(`${emailLink(uid)}$`));
  // Inside the dashboard, with the way back to the list.
  await expect(page.getByText('Booking not found')).toBeVisible();
  await expect(page.getByText('By Request')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Decline', exact: true })).toHaveCount(0);

  // Jordan's own request is untouched by the visit.
  const still = await request.get(`${E2E.api}/v1/host/bookings/${uid}`, {
    headers: { 'x-slate-email': JORDAN.email },
  });
  expect(((await still.json()) as { status: string }).status).toBe('pending');
  await request.post(`${E2E.api}/v1/host/bookings/${uid}/decline`, { headers: { 'x-slate-email': JORDAN.email } });
});
