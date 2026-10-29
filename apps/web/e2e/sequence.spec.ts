import { expect, test, type Page } from '@playwright/test';
import { E2E, HOST, visitorEmail, waitForCall } from './stack';

/**
 * The booking sequence (month, times, details, confirmation) the way a
 * visitor moves through it: going back, changing time zone halfway, keyboard
 * only, with reduced motion, inside an embed, and in Spanish.
 */
const PAGE = `/${HOST.accountCode}/${HOST.handle}/${HOST.slug}`;
const TIME = /^\d{1,2}:\d{2}( [AP]M)?$/;

const timesRegion = (page: Page) => page.getByRole('region', { name: /choose a time|elige una hora|elige un horario/i });
const details = (page: Page) => page.getByRole('complementary', { name: /your details|tus datos/i });

async function openFirstDay(page: Page): Promise<void> {
  await page.getByRole('grid').getByRole('button', { disabled: false }).first().click();
  await expect(timesRegion(page).getByRole('button', { name: TIME }).first()).toBeVisible();
}

async function fill(page: Page, email: string): Promise<void> {
  await page.getByRole('textbox', { name: /your name|tu nombre/i }).fill('Ada Visitor');
  await page.getByRole('textbox', { name: /your email|tu correo/i }).fill(email);
  await page.getByRole('textbox', { name: /company|empresa/i }).fill('Example Co');
}

test('back from details returns to the same day, and the hold is given back', async ({ page }) => {
  await page.goto(PAGE);
  await openFirstDay(page);
  const times = timesRegion(page).getByRole('button', { name: TIME });
  const first = (await times.first().textContent())!.trim();
  // The details step shows a range ("10:30 – 11:00 AM"): its start is the pick.
  const start = first.replace(/ [AP]M$/, '');
  await times.first().click();
  await expect(details(page)).toContainText(start);

  await page.getByRole('button', { name: /back to times/i }).click();
  await expect(timesRegion(page).getByRole('button', { name: first })).toBeVisible();
  // The time just let go is offered again to everyone (#135): pick it again.
  await timesRegion(page).getByRole('button', { name: first }).click();
  await expect(details(page)).toContainText(start);
});

test('switching time zone on the details step keeps the instant, shows the new zone', async ({ page }) => {
  const email = visitorEmail('tz');
  await page.goto(PAGE);
  await openFirstDay(page);
  await timesRegion(page).getByRole('button', { name: TIME }).first().click();
  const before = (await details(page).locator('p').first().textContent())!.trim();

  await details(page).getByRole('button', { name: /time ?zone|zona horaria/i }).click();
  await page.keyboard.type('Tokyo');
  await page.getByRole('option', { name: /tokyo/i }).first().click();
  await expect(details(page).getByRole('button', { name: /time ?zone/i })).toContainText(/tokyo/i);
  const after = (await details(page).locator('p').first().textContent())!.trim();
  expect(after).not.toBe(before);

  await fill(page, email);
  await page.getByRole('button', { name: /confirm booking/i }).click();
  const done = page.getByRole('region', { name: /booking confirmed/i });
  await expect(done).toContainText(/tokyo/i);
  // The calendar event is written in the attendee's zone (calendar-effects),
  // and the instant is a 30-minute slot on the grid the page offered.
  const created = await waitForCall('createEvent', (c) => (c.body?.['attendeeEmails'] as string[]).includes(email));
  expect(created.body?.['timeZone']).toBe('Asia/Tokyo');
  const startMs = Date.parse(String(created.body?.['startUtc']));
  expect(Date.parse(String(created.body?.['endUtc'])) - startMs).toBe(30 * 60_000);
  expect(startMs % (30 * 60_000)).toBe(0);
});

test('keyboard only: arrows to a day, Enter, Tab to a time, type, submit', async ({ page }) => {
  const email = visitorEmail('kbd');
  // Hydrated first: a key pressed on server-rendered markup reaches no handler.
  await page.goto(PAGE, { waitUntil: 'networkidle' });
  // Arrows walk the open days of the month on screen, so they need two of
  // them. Near a month's end the shown month can have one only (on Oct 29 it
  // was Oct 30 alone): start in the next month then, as a visitor would.
  const openDays = page.getByRole('grid').getByRole('button', { disabled: false });
  if ((await openDays.count()) < 2) {
    await page.getByRole('button', { name: /next month|mes siguiente/i }).click();
    await expect.poll(() => openDays.count()).toBeGreaterThan(1);
  }
  const firstOpen = openDays.first();
  await firstOpen.focus();
  const start = await firstOpen.getAttribute('data-day');
  const focusedDay = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset['day'] ?? null);
  // Arrows move the cursor without picking (#194): times stay as they were.
  // The grid moves focus to the new cursor on the next animation frame, so
  // each key waits for focus to arrive, as a person does. A key sent before
  // that frame lands on the old day, and the late focus then takes the next
  // key with it (an Enter meant for a time re-picks a day instead).
  await page.keyboard.press('ArrowRight');
  await expect.poll(focusedDay).not.toBe(start);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(focusedDay).toBe(start);
  await page.keyboard.press('Enter');
  const firstTime = timesRegion(page).getByRole('button', { name: TIME }).first();
  await expect(firstTime).toBeVisible();
  await page.waitForLoadState('networkidle');
  // Focus and key in one step: the list can re-render between the two.
  await firstTime.press('Enter');
  await expect(page.getByRole('textbox', { name: /your name/i })).toBeVisible();
  await page.getByRole('textbox', { name: /your name/i }).focus();
  await page.keyboard.type('Ada Visitor');
  await page.keyboard.press('Tab');
  await page.keyboard.type(email);
  await page.keyboard.press('Tab');
  await page.keyboard.type('Example Co');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: /booking confirmed/i })).toBeVisible();
});

test.describe('a visitor in another zone than the host', () => {
  // The host is seeded in America/New_York (packages/db/src/seed.ts); this
  // browser lives in Madrid.
  test.use({ timezoneId: 'Europe/Madrid' });
  test('the times open in the browser zone, with no picker opened, and the booking keeps it', async ({ page }) => {
    const email = visitorEmail('tz-own');
    await page.goto(PAGE);
    // The host's zone stays a fact about the host, beside the event.
    await expect(page.getByText(/new york, the host's time/i)).toBeVisible();
    // On a phone the times (and their zone) show once a day is chosen.
    await openFirstDay(page);
    await expect(page.getByRole('button', { name: /time ?zone/i }).first()).toContainText(/madrid/i);
    await timesRegion(page).getByRole('button', { name: TIME }).first().click();
    await expect(details(page).getByRole('button', { name: /time ?zone/i })).toContainText(/madrid/i);
    await fill(page, email);
    await page.getByRole('button', { name: /confirm booking/i }).click();
    await expect(page.getByRole('region', { name: /booking confirmed/i })).toContainText(/madrid/i);
    const created = await waitForCall('createEvent', (c) => (c.body?.['attendeeEmails'] as string[]).includes(email));
    expect(created.body?.['timeZone']).toBe('Europe/Madrid');
  });
});

test.describe('a browser that hides its zone', () => {
  // Privacy modes report UTC: the page keeps the host's zone, never a blank.
  test.use({ timezoneId: 'UTC' });
  test("the times stay in the host's zone", async ({ page }) => {
    await page.goto(PAGE);
    await openFirstDay(page);
    const zone = page.getByRole('button', { name: /time ?zone/i }).first();
    // Opening the picker needs the page hydrated, so the zone effect has run
    // by the time the label is read (the server HTML already says New York).
    await zone.click();
    await expect(zone).toHaveAttribute('aria-expanded', 'true');
    await expect(zone).toContainText(/new york/i);
  });
});

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });
  test('the sequence runs with transitions cut to nothing', async ({ page }) => {
    await page.goto(PAGE);
    await openFirstDay(page);
    const slot = timesRegion(page).getByRole('button', { name: TIME }).first();
    const duration = await slot.evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(duration.split(',').every((d) => parseFloat(d) <= 0.0001)).toBe(true);
    await slot.click();
    await expect(details(page)).toBeVisible();
  });
});

test('inside an embed: the page frames, books, and wears the embed root', async ({ page, context }) => {
  // Chromium refuses a page framing a loopback address unless the visitor
  // allows local network access. In production both origins are public; here
  // the stack is on loopback, so the test grants it.
  await context.grantPermissions(['local-network-access']);
  const email = visitorEmail('embed');
  // A customer's site on another origin, framing the page the way the embed
  // snippet does, served by the route below from 127.0.0.1 (an origin distinct
  // from localhost; an https one would be refused as mixed content).
  const customer = `http://127.0.0.1:${E2E.webPort}/__customer-site/book`;
  await page.route(customer, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><title>Customer site</title><iframe id="w" src="${E2E.web}${PAGE}?embed=1" style="width:1000px;height:900px;border:0"></iframe>`,
    }),
  );
  await page.goto(customer);
  const frame = page.frameLocator('#w');
  await expect(frame.locator('.dc-embed').first()).toBeAttached();
  await frame.getByRole('grid').getByRole('button', { disabled: false }).first().click();
  await frame.getByRole('button', { name: TIME }).first().click();
  await frame.getByRole('textbox', { name: /your name/i }).fill('Ada Visitor');
  await frame.getByRole('textbox', { name: /your email/i }).fill(email);
  await frame.getByRole('textbox', { name: /company/i }).fill('Example Co');
  await frame.getByRole('button', { name: /confirm booking/i }).click();
  await expect(frame.getByRole('region', { name: /booking confirmed/i })).toBeVisible();
  await waitForCall('createEvent', (c) => (c.body?.['attendeeEmails'] as string[]).includes(email));
});

test('in Spanish: the whole sequence speaks Spanish', async ({ page }) => {
  const email = visitorEmail('es');
  await page.goto(`${PAGE}?lang=es`);
  await expect(page.getByRole('button', { name: /mes siguiente|siguiente mes/i })).toBeVisible();
  await openFirstDay(page);
  await timesRegion(page).getByRole('button', { name: TIME }).first().click();
  await fill(page, email);
  await page.getByRole('button', { name: /confirmar reserva/i }).click();
  await expect(page.getByRole('region', { name: /reserva confirmada/i })).toBeVisible();
  await waitForCall('createEvent', (c) => (c.body?.['attendeeEmails'] as string[]).includes(email));
});
