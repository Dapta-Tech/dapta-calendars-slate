import { expect, test, type Page } from '@playwright/test';
import { E2E, HOST, parseIcs, standInBusy, standInCalls, visitorEmail, waitForCall } from './stack';

/**
 * The whole life of one booking, as a visitor and the host's calendar see it:
 * pick a day and a time, give details, confirm, take the calendar file, open
 * the manage link, move it, cancel it. The stand-in calendar backend records
 * every write the API makes, so the event it creates and the move it receives
 * are asserted on directly.
 */
const PAGE = `/${HOST.accountCode}/${HOST.handle}/${HOST.slug}`;

/**
 * The first day the month offers, then its first or its last time. Returns the
 * time's label.
 *
 * Never "the third time", or any count past one. How many times that day
 * still has is not something a test can count on: it is today or the next
 * weekday depending on the hour the suite runs (the host asks two hours'
 * notice), and every earlier test in both canvases books or holds times on
 * it. The reschedule once took the third, and at 13:03 UTC the mobile run
 * found only two left. The first and the last exist whenever the day has any.
 */
async function pickTime(page: Page, which: 'first' | 'last' = 'first'): Promise<string> {
  const day = page.getByRole('grid').getByRole('button', { disabled: false }).first();
  await day.click();
  const times = page
    .getByRole('region', { name: /choose a time|elige una hora/i })
    .getByRole('button', { name: /^\d{1,2}:\d{2}( [AP]M)?$/ });
  await expect(times.first()).toBeVisible();
  const chosen = which === 'first' ? times.first() : times.last();
  // One spelling of the space before AM/PM, whichever the page renders.
  const label = (await chosen.textContent())!.trim().replace(/\s/g, ' ');
  await chosen.click();
  return label;
}

/**
 * The zone the manage page reads times in: the booking's, which is the zone
 * the booking page opened in, the visitor's own (`timezoneId` in
 * playwright.config.ts). The seeded host lives in the same one.
 */
const ZONE = 'America/New_York';

/** An instant as the manage page labels it: 12-hour, in `ZONE`. */
const timeLabel = (iso: string) =>
  new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: ZONE })
    .format(new Date(iso))
    .replace(/\s/g, ' ');

async function fillDetails(page: Page, email: string): Promise<void> {
  await page.getByRole('textbox', { name: /your name/i }).fill('Ada Visitor');
  await page.getByRole('textbox', { name: /your email/i }).fill(email);
  await page.getByRole('textbox', { name: /company/i }).fill('Example Co');
}

test.describe.configure({ mode: 'serial' });

test.describe('one booking, end to end', () => {
  let manageUrl = '';
  let uid = '';
  let startUtc = '';
  /** The calendar event the booking wrote, once the move has named it. */
  let eventId = '';
  const email = visitorEmail('life');

  test('every time the page offers is free on the host calendar', async ({ request }) => {
    const from = new Date(Date.now() + 60_000);
    const to = new Date(from.getTime() + 60 * 86_400_000);
    const r = await request.get(`${E2E.api}/v1/availability`, {
      params: { ...HOST, from: from.toISOString(), to: to.toISOString() },
    });
    expect(r.status()).toBe(200);
    const body = (await r.json()) as { slots: Array<{ startUtc: string }>; eventType: { lengthMinutes: number } };
    expect(body.slots.length).toBeGreaterThan(0);
    const len = body.eventType.lengthMinutes * 60_000;
    const clashes = body.slots.filter((s) => standInBusy(Date.parse(s.startUtc), Date.parse(s.startUtc) + len));
    expect(clashes).toEqual([]);
  });

  test('book: day, time, details, confirmation', async ({ page }) => {
    await page.goto(PAGE);
    await pickTime(page);
    await fillDetails(page, email);
    await page.getByRole('button', { name: /confirm booking/i }).click();
    const done = page.getByRole('region', { name: /booking confirmed/i });
    await expect(done).toBeVisible();
    await expect(done).toContainText(email);

    const href = (await done.getByRole('link', { name: /add to calendar/i }).getAttribute('href'))!;
    expect(href.startsWith('data:text/calendar')).toBe(true);
    const ics = parseIcs(decodeURIComponent(href.slice(href.indexOf(',') + 1)));
    manageUrl = (await done.getByRole('link', { name: /manage your booking/i }).getAttribute('href'))!;
    uid = new URL(manageUrl).pathname.split('/').pop()!;
    expect(ics['UID']).toBe(uid);
    expect(ics['DTSTART']).toMatch(/^\d{8}T\d{6}Z$/);
    expect(ics['DTEND']).toMatch(/^\d{8}T\d{6}Z$/);
    const toIso = (v: string) => `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 11)}:${v.slice(11, 13)}:${v.slice(13, 15)}Z`;
    expect(Date.parse(toIso(ics['DTEND']!)) - Date.parse(toIso(ics['DTSTART']!))).toBe(30 * 60_000);
    startUtc = new Date(Date.parse(toIso(ics['DTSTART']!))).toISOString();
  });

  test('the calendar gets one event: the organizer listed first and once, one room', async () => {
    const created = await waitForCall('createEvent', (c) => c.body?.['startUtc'] === startUtc);
    const all = (await standInCalls('createEvent')).filter((c) => c.body?.['startUtc'] === startUtc);
    expect(all).toHaveLength(1);
    const attendees = created.body!['attendeeEmails'] as string[];
    expect(attendees[0]).toBe(HOST.email);
    expect(attendees.filter((a) => a.toLowerCase() === HOST.email)).toHaveLength(1);
    expect(attendees).toContain(email);
    expect(created.body!['requestConferenceLink']).toBe(true);
  });

  test('a second booking on the same time is refused', async ({ request }) => {
    const r = await request.post(`${E2E.api}/v1/bookings`, {
      data: {
        ...HOST,
        startUtc,
        attendee: { name: 'Second Visitor', email: visitorEmail('second'), timeZone: 'America/New_York' },
        answers: { company: 'Other Co' },
      },
    });
    expect([400, 409]).toContain(r.status());
    const body = (await r.json()) as { error: string };
    expect(['SLOT_TAKEN', 'INVALID_SLOT']).toContain(body.error);
  });

  test('the manage link opens the booking and names the host', async ({ page }) => {
    await page.goto(manageUrl);
    const card = page.getByRole('region', { name: /manage your booking/i });
    await expect(card).toContainText(/intro call/i);
    await expect(card).toContainText('Alex Rivera');
    await expect(card).not.toContainText('With Ada Visitor');
    // The room the calendar minted shows up here once the write-out has run.
    await expect(card.getByRole('link', { name: /join the meeting/i })).toHaveAttribute(
      'href',
      /^https:\/\/meet\.example\.test\/evt_/,
    );
  });

  test('reschedule moves the same calendar event', async ({ page }) => {
    const since = Date.now();
    await page.goto(manageUrl);
    const creates = (await standInCalls('createEvent')).length;
    // Any time the manage page offers is a real move: the booking's own time is
    // taken, so it is never among them. The LAST of the first open day: the
    // first sits closest to the two-hour notice line, and a run that crosses
    // it between loading the page and moving would be refused for the notice.
    const label = await pickTime(page, 'last');
    await page.getByRole('button', { name: /reschedule|confirm|move/i }).last().click();
    await expect(page.getByRole('main')).toContainText(/rescheduled|moved|new time|updated/i);
    // A move rotates the manage link (older emails stop opening it); the page
    // has already moved to the new one.
    const before = manageUrl;
    await expect.poll(() => page.url()).not.toBe(before);
    manageUrl = page.url();
    // THIS booking's move (its visitor, after this test began), never the other
    // canvas's: both canvases' writes land on the one stand-in.
    const update = await waitForCall(
      'updateEvent',
      (c) => c.at >= since && ((c.body?.['attendeeEmails'] as string[] | undefined) ?? []).includes(email),
    );
    expect(update.path).toMatch(/^\/v1\/events\/evt_/);
    eventId = update.path.split('/').pop()!;
    // Moved to the time the visitor picked, off the one it was booked at.
    const movedTo = String(update.body?.['startUtc']);
    expect(movedTo).not.toBe(startUtc);
    expect(timeLabel(movedTo)).toBe(label);
    const created = await waitForCall('createEvent', (c) => c.body?.['startUtc'] === startUtc);
    void created;
    // A move, not a cancel plus a new invite: no second event was created.
    expect((await standInCalls('createEvent')).length).toBe(creates);
  });

  test('cancel removes the calendar event', async ({ page }) => {
    await page.goto(manageUrl);
    await page.getByRole('textbox', { name: /cancel this booking/i }).fill('Plans changed');
    await page.getByRole('button', { name: /^cancel booking$/i }).click();
    await expect(page.getByRole('main')).toContainText(/cancelled|canceled/i);
    // The event the move kept, not any delete the other canvas already made.
    await waitForCall('deleteEvent', (c) => c.path.endsWith(`/events/${eventId}`));
  });

  // F5: the confirmation screen builds its calendar file from the create
  // response, and the room is minted afterwards by the outbox, so the screen
  // asks for the link until it exists and the file picks it up.
  test('the calendar file of an online meeting carries the join link', async ({ page, request }) => {
    await page.goto(PAGE);
    await pickTime(page);
    await fillDetails(page, visitorEmail('ics-link'));
    await page.getByRole('button', { name: /confirm booking/i }).click();
    const done = page.getByRole('region', { name: /booking confirmed/i });
    await expect(done).toBeVisible();
    const file = done.getByRole('link', { name: /add to calendar/i });
    const ics = async () => {
      const href = (await file.getAttribute('href')) ?? '';
      return parseIcs(decodeURIComponent(href.slice(href.indexOf(',') + 1)));
    };
    await expect.poll(async () => (await ics())['URL'] ?? '', { timeout: 30_000 }).toMatch(
      /^https:\/\/meet\.example\.test\/evt_/,
    );
    const event = await ics();
    // The link is what a calendar opens, so it is the LOCATION too.
    expect(event['LOCATION']).toBe(event['URL']);
    // Give the time back, so the next canvas finds the day as this one did.
    const manage = new URL((await done.getByRole('link', { name: /manage your booking/i }).getAttribute('href'))!);
    const cancelled = await request.post(
      `${E2E.api}/v1/bookings/${manage.pathname.split('/').pop()}/cancel?token=${manage.searchParams.get('token')}`,
      { data: { reason: 'e2e cleanup' } },
    );
    expect(cancelled.ok()).toBe(true);
  });
});
