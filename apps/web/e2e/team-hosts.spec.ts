import { expect, test } from '@playwright/test';
import { HOST, signIn } from './stack';

/**
 * "When editing an event, I can't find where to add team members." A personal
 * event answers it where a team event shows its hosts: the event is only
 * yours, and here is how to start one for your team. That link opens a team
 * event whose Hosts block names the team and links to the page where its
 * members are managed. Nothing is saved, so the shared stack is left as found.
 */
test('a personal event points at team events, and a team event says who hosts it', async ({
  page,
}) => {
  await page.goto('/admin/event-types');
  await signIn(page, HOST.email);
  await expect(page).toHaveURL(/\/admin\/event-types$/);

  await page
    .getByRole('listitem')
    .filter({ hasText: 'Intro Call' })
    .getByRole('link', { name: 'Edit' })
    .click();
  await expect(page).toHaveURL(/\/admin\/event-types\/[^/?]+$/);
  const card = page.getByTestId('personal-hosts-card');
  await expect(card).toContainText('This event is only yours.');

  await card.getByRole('link', { name: 'New event for Sales' }).click();
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
  });
  await expect(toTeam).toHaveAttribute('href', `/admin/teams/${teamId}`);
  await toTeam.click();
  await expect(page).toHaveURL(new RegExp(`/admin/teams/${teamId}$`));
  await expect(page.getByRole('heading', { name: /^Members/ })).toBeVisible();
});
