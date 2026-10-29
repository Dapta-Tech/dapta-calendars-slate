import { expect, test, type Page } from '@playwright/test';
import {
  E2E,
  analyticsRecorded,
  analyticsRequests,
  signIn,
  visitorEmail,
  waitForAnalytics,
  type RecordedAnalytics,
} from './stack';

/**
 * Product analytics, end to end, against the stand-in ingestion host
 * (scripts/qa/stand-in-analytics.mjs), which serves the REAL vendor library
 * and decodes its real batches. The suite runs with analytics ON
 * (ANALYTICS_ENV in stack.ts), so this file asserts what leaves the browser
 * and the API and, as importantly, what never does: a visitor's name or email,
 * a query string, a campaign tag, an identity, a recording.
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

const fromBrowser = (all: RecordedAnalytics[], surface: 'booking_page' | 'dashboard') =>
  all.filter((e) => e.source === 'browser' && e.properties?.['surface'] === surface);

/** What the vendor library keeps on the device, by its own key prefix. */
async function vendorStorage(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [
      ...Object.keys(window.localStorage),
      ...Object.keys(window.sessionStorage),
      ...document.cookie.split(';').map((c) => c.trim().split('=')[0] ?? ''),
    ].filter((k) => k.startsWith('ph_') || k.includes('posthog')),
  );
}

test.describe.configure({ mode: 'serial' });

// The vendor library drops every event from an automated browser: it reads
// `navigator.webdriver` and a `HeadlessChrome` brand as a bot, which is what
// production wants. Here the browser presents as a person's.
test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false });
    Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => undefined });
  });
});

test('a visitor is counted anonymously, and nothing personal leaves the page', async ({ page }) => {
  // Only what this test caused: the suite's other files book for Jordan too.
  const since = Date.now();
  const errors = watchErrors(page);
  const email = visitorEmail('analytics');
  const name = 'Ana Analytics';
  // A query on the URL the way a link builder might fill one, with a campaign
  // tag and a click id: none of it may reach the analytics host.
  await page.goto(
    `/${JORDAN.accountCode}/${JORDAN.handle}/${JORDAN.slug}?prefill=${encodeURIComponent(email)}` +
      `&utm_content=${encodeURIComponent(email)}&gclid=E2ECLICK`,
  );

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
  const visitor = fromBrowser(await analyticsRecorded(since), 'booking_page');

  const names = visitor.map((e) => e.event);
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

  // Anonymous: no identify, no alias, no group, no person, no profile.
  expect(visitor.filter((e) => e.event.startsWith('$'))).toEqual([]);
  for (const e of visitor) {
    expect(e.properties?.['$process_person_profile']).toBe(false);
    expect(e.$set).toBeUndefined();
    expect(e.$set_once).toBeUndefined();
    expect(
      Object.keys(e.properties ?? {}).filter((k) => /utm_|gclid|session_entry_url|session_entry_referrer$/.test(k)),
    ).toEqual([]);
  }
  // Nothing the visitor typed, no query string and no click id, anywhere.
  const sent = JSON.stringify(visitor);
  expect(sent).not.toContain(email);
  expect(sent).not.toContain(encodeURIComponent(email));
  expect(sent).not.toContain(name);
  expect(sent).not.toContain('E2ECLICK');
  expect(sent).not.toContain('?');
  // Nothing on the device, and nothing asked for beyond the library and events.
  expect(await vendorStorage(page)).toEqual([]);
  // With error tracking on (the suite's default), the library also fetches
  // its error capture extension from the same host; nothing else.
  const paths = [...new Set(await analyticsRequests(since))];
  expect(paths.filter((p) => !/^\/static\/[\w.-]+\/exception-autocapture\.js$/.test(p)).sort()).toEqual([
    '/capture/',
    '/e/',
    // The pinned release (`POSTHOG_JS_VERSION` in lib/analytics/posthog.ts).
    '/static/1.441.0/array.js',
  ]);

  // The API's half: the booking, about the HOST who received it, by when it
  // HAPPENED (the outbox can deliver an earlier file's booking for Jordan
  // after this test has started).
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
  expect(click.properties).toMatchObject({
    utm_medium: 'badge',
    page: 'event',
    account_code: 'acme',
    surface: 'booking_page',
  });
  expect(errors).toEqual([]);
});

test('a new host is identified by email, joins their account, and their signup is recorded', async ({ page }) => {
  const since = Date.now();
  const errors = watchErrors(page);
  const email = `analytics-host-${Date.now().toString(36)}@example.test`;
  const landingId = `0198a1b2-e2e0-7e89-a1b2-${Date.now().toString(16).padStart(12, '0').slice(-12)}`;

  // Arrives from a landing that handed over its anonymous id.
  await page.goto(`/login?ph_id=${landingId}`);
  await signIn(page, email);
  // A brand-new account owes the first-run wizard.
  await expect(page).toHaveURL(/\/onboarding/);

  const identify = await waitForAnalytics((e) => e.event === '$identify' && e.distinct_id === email, since);
  expect(identify.$set).toMatchObject({ email, role: 'owner', is_internal: false });
  // The landing visit is joined to the PERSON (the host's email), whatever
  // order the library replays its queue in.
  await waitForAnalytics(
    (e) => e.event === '$create_alias' && e.properties?.['alias'] === landingId && e.distinct_id === email,
    since,
  );

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
  await waitForAnalytics(
    (e) =>
      e.source === 'browser' &&
      e.event === '$groupidentify' &&
      e.properties?.['$group_type'] === 'calendars_account' &&
      e.properties?.['$group_key'] === accountKey,
    since,
  );

  // "Skip for now" on the template step is a browser-only fact.
  await page.getByRole('button', { name: /skip for now/i }).click();
  const skipped = await waitForAnalytics(
    (e) => e.event === 'calendars_template_skipped' && e.distinct_id === email,
    since,
  );
  expect(skipped.properties).toMatchObject({ surface: 'dashboard', account_code: accountKey, is_internal: false });
  // No query string, the landing id's included, rides on a host event.
  expect(JSON.stringify(fromBrowser(await analyticsRecorded(since), 'dashboard'))).not.toContain('ph_id=');

  expect(errors).toEqual([]);
});
