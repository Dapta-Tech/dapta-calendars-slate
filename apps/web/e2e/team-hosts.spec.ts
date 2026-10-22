import { expect, test } from '@playwright/test';
import { E2E, HOST, signIn } from './stack';

/**
 * "When editing an event, I can't find where to add team members." A personal
 * event answers it where a team event shows its hosts: a personal event has
 * one host, and here is how to start one for your team. That link opens a team
 * event whose Hosts block names the team and links to the page where its
 * members are managed. Creating team events is admin-only, so a plain member
 * reads the explanation without the links. Only the priority test saves, and
 * it puts the host back at Medium, so the shared stack is left as found.
 */
const JORDAN = { email: 'jordan@example.com' };

test('a personal event points at team events, and a team event says who hosts it', async ({
  page,
}) => {
  await page.goto('/admin/event-types');
  await signIn(page, HOST.email);
  await expect(page).toHaveURL(/\/admin\/event-types$/);

  await page
    .getByRole('listitem')
    .filter({ hasText: 'Intro Call' })
    .getByRole('link', { name: 'Edit', exact: true })
    .click();
  await expect(page).toHaveURL(/\/admin\/event-types\/[^/?]+$/);
  const card = page.getByTestId('personal-hosts-card');
  await expect(card).toContainText('A personal event has one host.');

  await card.getByRole('link', { name: 'New event for Sales', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/event-types\/new\?teamId=/);
  const teamId = new URL(page.url()).searchParams.get('teamId');
  expect(teamId).toBeTruthy();
  const note = page.getByTestId('team-hosts-note');
  await expect(note).toHaveText(
    'Every member of Sales hosts this event once you save it. Add or remove members on the team page, then save this event.',
  );
  await expect(page.getByTestId('personal-hosts-card')).toHaveCount(0);

  const toTeam = note.getByRole('link', {
    name: 'Add or remove members on the team page, then save this event.',
    exact: true,
  });
  await expect(toTeam).toHaveAttribute('href', `/admin/teams/${teamId}`);
  await toTeam.click();
  await expect(page).toHaveURL(new RegExp(`/admin/teams/${teamId}$`));
  await expect(page.getByRole('heading', { name: /^Members/ })).toBeVisible();
});

test('the Events list offers a team event per team, and its team events say who hosts them', async ({
  page,
}) => {
  await page.goto('/admin/event-types');
  await signIn(page, HOST.email);
  await expect(page).toHaveURL(/\/admin\/event-types$/);

  await expect(
    page.getByRole('link', { name: 'New event for Sales', exact: true }),
  ).toHaveAttribute('href', /^\/admin\/event-types\/new\?teamId=[^&]+$/);

  await page
    .getByRole('listitem')
    .filter({ hasText: 'Team Demo' })
    .getByRole('link', { name: 'Edit', exact: true })
    .click();
  await expect(page).toHaveURL(/\/admin\/event-types\/[^/?]+$/);
  await expect(page.getByTestId('team-hosts-note')).toContainText('Every member of Sales');
  await expect(page.getByTestId('personal-hosts-card')).toHaveCount(0);
});

test('a plain member reads where hosts come from, without links the API would refuse', async ({
  page,
}) => {
  await page.goto('/admin/event-types');
  await signIn(page, JORDAN.email);
  await expect(page).toHaveURL(/\/admin\/event-types$/);

  // The team is listed, but starting a team event is for owners and admins.
  await expect(page.getByRole('heading', { name: 'Sales', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'New event for Sales', exact: true })).toHaveCount(0);

  await page
    .getByRole('listitem')
    .filter({ hasText: 'Quick Chat' })
    .getByRole('link', { name: 'Edit', exact: true })
    .click();
  await expect(page).toHaveURL(/\/admin\/event-types\/[^/?]+$/);
  const card = page.getByTestId('personal-hosts-card');
  await expect(card).toContainText('A personal event has one host.');
  await expect(card.getByRole('link')).toHaveCount(0);
});

/**
 * "Let us set a priority level for each host in the round robin." On the
 * seeded round robin Team Demo, every host starts at Medium (priority 0, the
 * value assignment already used). Jordan is set to Highest, saved, and still
 * Highest after a reload, stored as 2. Jordan is set back to Medium and saved
 * at the end, even after a failure, so round robin assignment on the shared
 * stack behaves as the booking tests expect (the seed's null reads as 0).
 */
test('a round robin host keeps the priority level they are given', async ({ page, request }) => {
  await page.goto('/admin/event-types');
  await signIn(page, HOST.email);
  await expect(page).toHaveURL(/\/admin\/event-types$/);
  await page
    .getByRole('listitem')
    .filter({ hasText: 'Team Demo' })
    .getByRole('link', { name: 'Edit', exact: true })
    .click();
  await expect(page).toHaveURL(/\/admin\/event-types\/[^/?]+$/);
  const editUrl = page.url();
  const eventId = new URL(editUrl).pathname.split('/').pop()!;
  await expect(
    page.getByText('Each booking goes to the free host with the highest priority;'),
  ).toBeVisible();

  const jordan = page.getByRole('button', { name: 'Jordan Lee: Priority' });
  const alex = page.getByRole('button', { name: 'Alex Rivera: Priority' });
  await expect(jordan).toHaveText('Medium');
  await expect(alex).toHaveText('Medium');

  const setJordan = async (level: string) => {
    await jordan.click();
    await page.getByRole('option', { name: level, exact: true }).click();
    await expect(jordan).toHaveText(level);
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Saved successfully.' })).toBeVisible();
  };
  const storedPriorities = async () => {
    const r = await request.get(`${E2E.api}/v1/event-types/${eventId}`, {
      headers: { 'x-slate-email': HOST.email },
    });
    expect(r.ok()).toBe(true);
    const et = (await r.json()) as { hosts?: Array<{ priority: number | null }> };
    return (et.hosts ?? []).map((h) => h.priority).sort((a, b) => (a ?? 0) - (b ?? 0));
  };

  try {
    await setJordan('Highest');
    await page.reload();
    await expect(jordan).toHaveText('Highest');
    await expect(alex).toHaveText('Medium');
    expect(await storedPriorities()).toEqual([0, 2]);
  } finally {
    // Back to Medium even when a check above fails: a Highest Jordan would
    // take every later round robin booking on this shared stack.
    await page.goto(editUrl, { waitUntil: 'networkidle' }); // hydrated before the select is used
    await setJordan('Medium');
  }
  await page.reload();
  await expect(jordan).toHaveText('Medium');
  expect(await storedPriorities()).toEqual([0, 0]);
});

/**
 * "Let us choose between Maximize availability and Equal distribution." On the
 * seeded round robin Team Demo the distribution starts at Maximize
 * availability; Equal distribution is saved, survives a reload with priority
 * and weight set aside, and is put back in a finally so later booking tests
 * see today's behavior.
 */
test('a round robin event keeps the distribution it is given', async ({ page, request }) => {
  await page.goto('/admin/event-types');
  await signIn(page, HOST.email);
  await expect(page).toHaveURL(/\/admin\/event-types$/);
  await page
    .getByRole('listitem')
    .filter({ hasText: 'Team Demo' })
    .getByRole('link', { name: 'Edit', exact: true })
    .click();
  await expect(page).toHaveURL(/\/admin\/event-types\/[^/?]+$/);
  const editUrl = page.url();
  const eventId = new URL(editUrl).pathname.split('/').pop()!;

  const distribution = page.getByRole('combobox', { name: 'Distribution' });
  /** What the API has stored; null is today's behavior. */
  const stored = async () => {
    const r = await request.get(`${E2E.api}/v1/event-types/${eventId}`, {
      headers: { 'x-slate-email': HOST.email },
    });
    return ((await r.json()) as { rrDistribution?: string | null }).rrDistribution ?? null;
  };
  const save = async (value: 'availability' | 'equal') => {
    await distribution.selectOption(value);
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Saved successfully.' })).toBeVisible();
    // Stored before anything reloads the page, so a reload never cuts the save short.
    await expect.poll(stored).toBe(value === 'equal' ? 'equal' : null);
  };
  await expect(distribution).toHaveValue('availability');
  try {
    await save('equal');
    await page.reload();
    await expect(distribution).toHaveValue('equal');
    await expect(page.getByRole('button', { name: 'Jordan Lee: Priority' })).toHaveCount(0);
    await expect(page.getByText("Share this event's bookings evenly")).toBeVisible();
  } finally {
    // A fresh load: let it hydrate before choosing, or hydration puts the
    // select back to what the server rendered and that is what gets saved.
    await page.goto(editUrl, { waitUntil: 'networkidle' });
    await save('availability');
  }
  await page.reload();
  await expect(distribution).toHaveValue('availability');
  await expect(page.getByRole('button', { name: 'Jordan Lee: Priority' })).toBeVisible();
});
