import { expect, test, type Page } from '@playwright/test';
import { E2E, standInCalls, visitorEmail, waitForCall } from './stack';

/**
 * The pages around one booking: a host with one event lands on it, a host with
 * several shows a profile, an event that needs the host's yes leaves the
 * booking pending until they give it, and a team event assigns one host by
 * round robin and writes only that host's calendar.
 */
const TIME = /^\d{1,2}:\d{2}( [AP]M)?$/;

async function bookFirst(page: Page, email: string, company = true): Promise<void> {
  await page.getByRole('grid').getByRole('button', { disabled: false }).first().click();
  await page.getByRole('button', { name: TIME }).first().click();
  await page.getByRole('textbox', { name: /your name/i }).fill('Ada Visitor');
  await page.getByRole('textbox', { name: /your email/i }).fill(email);
  if (company) await page.getByRole('textbox', { name: /company/i }).fill('Example Co');
}

test('a host with one event opens straight onto it, keeping the query', async ({ page }) => {
  await page.goto('/acme/alex-rivera?utm_source=qa');
  await expect(page).toHaveURL(/\/acme\/alex-rivera\/intro-call\?utm_source=qa$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Intro Call' })).toBeVisible();
});

test('?landing=1 shows the one-event host their profile instead', async ({ page }) => {
  await page.goto('/acme/alex-rivera?landing=1');
  await expect(page).toHaveURL(/\/acme\/alex-rivera\?landing=1$/);
  await expect(page.getByRole('link', { name: /intro call/i })).toBeVisible();
});

test('a host with several events shows a profile listing each', async ({ page }) => {
  await page.goto('/acme/jordan-lee');
  await expect(page).toHaveURL(/\/acme\/jordan-lee$/);
  for (const title of ['Quick Chat', 'Deep Dive', 'By Request'])
    await expect(page.getByRole('link', { name: new RegExp(title, 'i') })).toBeVisible();
  await page.getByRole('link', { name: /quick chat/i }).click();
  await expect(page).toHaveURL(/\/acme\/jordan-lee\/quick-chat/);
  await expect(page.getByRole('heading', { level: 1, name: 'Quick Chat' })).toBeVisible();
});

test('an event that needs the host: pending until confirmed, then written', async ({ page, request }) => {
  const email = visitorEmail('pending');
  await page.goto('/acme/jordan-lee/by-request');
  await bookFirst(page, email, false);
  await page.getByRole('button', { name: /request booking|confirm booking|send request/i }).click();
  const done = page.getByRole('region').filter({ hasText: /request|pending|confirm/i }).first();
  await expect(done).toContainText(/request|pending|awaiting/i);
  // No calendar event while it waits for the host.
  await page.waitForTimeout(6_000);
  expect((await standInCalls('createEvent')).some((c) => (c.body?.['attendeeEmails'] as string[]).includes(email))).toBe(
    false,
  );

  // The host's list carries no attendee, so confirm every pending request on
  // this event; this run's visitor is among them.
  const asJordan = { 'x-slate-email': 'jordan@example.com' };
  const list = await request.get(`${E2E.api}/v1/host/bookings`, { headers: asJordan, params: { status: 'pending' } });
  expect(list.ok()).toBe(true);
  const { items } = (await list.json()) as { items: Array<{ uid: string; status: string; title: string }> };
  const pending = items.filter((b) => b.title === 'By Request');
  expect(pending.length).toBeGreaterThan(0);
  for (const b of pending) {
    const ok = await request.post(`${E2E.api}/v1/host/bookings/${b.uid}/confirm`, { headers: asJordan });
    expect(ok.ok()).toBe(true);
  }
  const created = await waitForCall('createEvent', (c) => (c.body?.['attendeeEmails'] as string[]).includes(email));
  expect((created.body?.['attendeeEmails'] as string[])[0]).toBe('jordan@example.com');
});

test('a round-robin team event assigns one host and writes only their calendar', async ({ page }) => {
  const email = visitorEmail('team');
  await page.goto('/acme/team/sales/team-demo');
  await bookFirst(page, email, false);
  await page.getByRole('button', { name: /confirm booking/i }).click();
  await expect(page.getByRole('region', { name: /booking confirmed/i })).toBeVisible();
  await waitForCall('createEvent', (c) => (c.body?.['attendeeEmails'] as string[]).includes(email));
  // Give a second write (a co-host copy) the time it would take to show up.
  await page.waitForTimeout(6_000);
  const writes = (await standInCalls('createEvent')).filter((c) =>
    (c.body?.['attendeeEmails'] as string[]).includes(email),
  );
  expect(writes).toHaveLength(1);
  const organizer = (writes[0]!.body?.['attendeeEmails'] as string[])[0];
  expect(['alex@example.com', 'jordan@example.com']).toContain(organizer);
  expect(writes[0]!.body?.['connectionRef']).toBe(
    organizer === 'alex@example.com' ? 'e2e-alex-rivera' : 'e2e-jordan-lee',
  );
});
