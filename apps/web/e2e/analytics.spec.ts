import { expect, test, type Page } from '@playwright/test';
import { E2E, analyticsRecorded, visitorEmail, waitForAnalytics, type RecordedAnalytics } from './stack';

/**
 * Product analytics, end to end, against the stand-in ingestion host
 * (scripts/qa/stand-in-analytics.mjs). The suite runs with analytics ON
 * (ANALYTICS_ENV in stack.ts), so this file asserts what it sends and, as
 * importantly, what it never sends: a visitor's name or email, a query
 * string, an identity, a recording.
 *
 * Books on Jordan's quick chat, at the far end of the month, so the other
 * files' "first free time" is never this one.
 */
const JORDAN = { accountCode: 'acme', handle: 'jordan-lee', slug: 'quick-chat', email: 'jordan@example.com' };

/** Console errors and uncaught exceptions, for the "no console errors" bar. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}

const browserFrom = (all: RecordedAnalytics[], instance: string) =>
  all.filter((e) => e.source === 'browser' && e.instance === instance);

test.describe.configure({ mode: 'serial' });

test('a visitor is counted anonymously, and nothing personal leaves the page', async ({ page }) => {
  // Only what this test caused: the suite's other files book for Jordan too.
  const since = Date.now();
  const errors = watchErrors(page);
  const email = visitorEmail('analytics');
  const name = 'Ana Analytics';
  // A query on the URL, the way a link builder might prefill one: it must
  // never reach the analytics host.
  await page.goto(`/${JORDAN.accountCode}/${JORDAN.handle}/${JORDAN.slug}?prefill=${encodeURIComponent(email)}`);

  await page.getByRole('grid').getByRole('button', { disabled: false }).last().click();
  const times = page
    .getByRole('region', { name: /choose a time|elige una hora/i })
    .getByRole('button', { name: /^\d{1,2}:\d{2}( [AP]M)?$/ });
  await expect(times.first()).toBeVisible();
  await times.last().click();
  await page.getByRole('textbox', { name: /your name/i }).fill(name);
  await page.getByRole('textbox', { name: /your email/i }).fill(email);
  await page.getByRole('button', { name: /confirm booking/i }).click();
  await expect(page.getByRole('region', { name: /booking confirmed/i })).toBeVisible();

  await waitForAnalytics((e) => e.event === 'calendars_booking_confirmed', since);
  const visitor = browserFrom(await analyticsRecorded(since), 'calendars_visitor');

  // The settings the page asked for: no profile, nothing stored, nothing recorded.
  const init = visitor.find((e) => e.type === 'init');
  expect(init?.config).toMatchObject({
    person_profiles: 'never',
    persistence: 'memory',
    autocapture: false,
    capture_pageview: false,
    disable_session_recording: true,
    capture_heatmaps: false,
  });

  const names = visitor.filter((e) => e.type === 'capture').map((e) => e.event);
  for (const event of [
    'calendars_booking_page_viewed',
    'calendars_day_picked',
    'calendars_slot_picked',
    'calendars_booking_submitted',
    'calendars_booking_confirmed',
  ]) {
    expect(names).toContain(event);
  }
  const confirmed = visitor.find((e) => e.event === 'calendars_booking_confirmed');
  expect(confirmed?.properties).toMatchObject({ product: 'calendars', account_code: 'acme', status: 'accepted' });

  // Never identified, never grouped, never aliased.
  expect(visitor.filter((e) => e.type === 'identify' || e.type === 'alias' || e.type === 'group')).toEqual([]);
  // Nothing the visitor typed, and no query string, anywhere in what was sent.
  const sent = JSON.stringify(visitor);
  expect(sent).not.toContain(email);
  expect(sent).not.toContain(encodeURIComponent(email));
  expect(sent).not.toContain(name);
  for (const e of visitor.filter((x) => x.type === 'capture')) {
    expect(String(e.properties?.['$current_url'])).not.toContain('?');
  }

  // The API's half: the booking, about the HOST who received it.
  // By when the booking HAPPENED: the outbox can deliver an earlier file's
  // booking for Jordan after this test has started.
  const created = await waitForAnalytics(
    (e) =>
      e.source === 'server' &&
      e.event === 'calendars_booking_created' &&
      e.distinct_id === JORDAN.email &&
      Date.parse(e.timestamp ?? '') >= since,
    since,
  );
  expect(created.properties).toMatchObject({
    channel: 'booking_page',
    status: 'accepted',
    is_team: false,
    invitee_is_member: false,
    invitee_is_internal: false,
    // Jordan stands in for the operator's own staff (ANALYTICS_ENV).
    is_internal: true,
    account_code: 'acme',
    $groups: { calendars_account: 'acme' },
  });
  expect(JSON.stringify(created)).not.toContain(email);
  expect(JSON.stringify(created)).not.toContain(name);

  expect(errors).toEqual([]);
});

test('a click on the badge is counted with its medium', async ({ page, context }) => {
  const since = Date.now();
  const errors = watchErrors(page);
  // The badge opens the signup destination in a new tab; answer it locally.
  await context.route(`${new URL(E2E.signupUrl).origin}/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>signup</title>' }),
  );
  await page.goto(`/${JORDAN.accountCode}/${JORDAN.handle}/${JORDAN.slug}`);
  const popup = context.waitForEvent('page');
  await page.getByRole('link', { name: /made with/i }).click();
  await (await popup).close();

  const click = await waitForAnalytics((e) => e.event === 'calendars_cta_clicked', since);
  expect(click.instance).toBe('calendars_visitor');
  expect(click.properties).toMatchObject({ utm_medium: 'badge', page: 'event', account_code: 'acme' });
  expect(errors).toEqual([]);
});

test('a new host is identified by email, joins their account, and their signup is recorded', async ({ page }) => {
  const since = Date.now();
  const errors = watchErrors(page);
  const email = `analytics-host-${Date.now().toString(36)}@example.test`;
  const landingId = `0198a1b2-e2e0-7e89-a1b2-${Date.now().toString(16).padStart(12, '0').slice(-12)}`;

  // Arrives from a landing that handed over its anonymous id.
  await page.goto(`/login?ph_id=${landingId}`);
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Continue' }).click();
  // A brand-new account owes the first-run wizard.
  await expect(page).toHaveURL(/\/onboarding/);

  const identify = await waitForAnalytics((e) => e.type === 'identify' && e.distinctId === email, since);
  expect(identify.instance).toBe('calendars_host');
  expect(identify.set).toMatchObject({ email, role: 'owner', is_internal: false });
  // The landing visit is joined to the person, after identify.
  await waitForAnalytics((e) => e.type === 'alias' && e.instance === 'calendars_host' && e.alias === landingId, since);
  const recorded = await analyticsRecorded(since);

  const host = browserFrom(recorded, 'calendars_host');
  expect(host.find((e) => e.type === 'init')?.config).toMatchObject({
    autocapture: false,
    disable_session_recording: true,
    person_profiles: 'identified_only',
  });

  // The server's half: the signup, with the account it created.
  const signup = await waitForAnalytics(
    (e) => e.source === 'server' && e.event === 'calendars_signup_completed' && e.distinct_id === email,
    since,
  );
  expect(signup.properties).toMatchObject({
    role: 'owner',
    is_first_member: true,
    from_invite: false,
    is_internal: false,
    $set: { email, is_internal: false },
  });
  const accountKey = String(signup.properties?.['account_code']);
  const group = host.find((e) => e.type === 'group');
  expect(group).toMatchObject({ groupType: 'calendars_account', groupKey: accountKey });

  // "Skip for now" on the template step is a browser-only fact.
  await page.getByRole('button', { name: /skip for now/i }).click();
  await waitForAnalytics((e) => e.event === 'calendars_template_skipped' && e.instance === 'calendars_host', since);

  expect(errors).toEqual([]);
});
