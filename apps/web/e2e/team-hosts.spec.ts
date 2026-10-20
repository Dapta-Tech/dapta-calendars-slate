import { expect, test } from '@playwright/test';
import { HOST, signIn } from './stack';

/**
 * "When editing an event, I can't find where to add team members." A personal
 * event answers it where a team event shows its hosts: a personal event has
 * one host, and here is how to start one for your team. That link opens a team
 * event whose Hosts block names the team and links to the page where its
 * members are managed. Creating team events is admin-only, so a plain member
 * reads the explanation without the links. Nothing is saved, so the shared
 * stack is left as found.
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
    'Every member of Sales hosts this event. Add or remove members on the team page.',
  );
  await expect(page.getByTestId('personal-hosts-card')).toHaveCount(0);

  const toTeam = note.getByRole('link', {
    name: 'Add or remove members on the team page.',
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
