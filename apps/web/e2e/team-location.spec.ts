import { expect, test } from '@playwright/test';
import { E2E, HOST, signIn } from './stack';

/**
 * A team event's location is one setting for every host, and an online
 * meeting's link is created on the ASSIGNED host's own calendar. The editor
 * says so, and names the hosts whose bookings would get no link: here, a member
 * who was invited and has not connected a calendar yet. Alex, connected to the
 * stand-in calendar by the e2e seed, is never named.
 *
 * The team, the invite and the event are this test's own (unique per run and
 * per project), so nothing the rest of the suite books or counts changes.
 */
const asAlex = { 'x-slate-email': HOST.email };

test('a team event on an online meeting names the host with no calendar', async ({
  page,
  request,
}, info) => {
  const tag = `${info.project.name}-${Date.now().toString(36)}`;
  const invitee = `Casey Morgan ${tag}`;

  const team = await request.post(`${E2E.api}/v1/teams`, {
    headers: asAlex,
    data: { name: `Location ${tag}`, slug: `location-${tag}` },
  });
  expect(team.status()).toBe(201);
  const { id: teamId } = (await team.json()) as { id: string };

  const invited = await request.post(`${E2E.api}/v1/members`, {
    headers: asAlex,
    data: { email: `casey-${tag}@example.test`, displayName: invitee },
  });
  expect(invited.status()).toBe(201);
  const { id: caseyId } = (await invited.json()) as { id: string };
  const joined = await request.post(`${E2E.api}/v1/teams/${teamId}/members`, {
    headers: asAlex,
    data: { memberId: caseyId },
  });
  expect(joined.status()).toBe(201);

  // The API says who has a calendar: Alex (the team's creator) does, Casey does not.
  const roster = (await (
    await request.get(`${E2E.api}/v1/teams/${teamId}/members`, { headers: asAlex })
  ).json()) as Array<{
    display_name: string;
    has_destination_calendar: boolean;
  }>;
  expect(
    Object.fromEntries(roster.map((r) => [r.display_name, r.has_destination_calendar])),
  ).toEqual({
    'Alex Rivera': true,
    [invitee]: false,
  });

  const created = await request.post(`${E2E.api}/v1/event-types`, {
    headers: asAlex,
    data: {
      teamId,
      slug: `location-${tag}`,
      title: 'Team Location',
      lengthMinutes: 30,
      location: { kind: 'conferencing' },
      schedulingType: 'round_robin',
      // Off every public list: this event exists only to be edited.
      hidden: true,
    },
  });
  expect(created.status()).toBe(201);
  const { id: eventId } = (await created.json()) as { id: string };

  await page.goto(`/admin/event-types/${eventId}`);
  await signIn(page, HOST.email);
  await expect(page).toHaveURL(new RegExp(`/admin/event-types/${eventId}$`));

  await expect(
    page.getByText(
      'This location applies to every host. Each booking’s meeting link comes from the assigned host’s connected calendar.',
    ),
  ).toBeVisible();
  const warning = page.getByText(/^No meeting link for: /);
  await expect(warning).toHaveText(
    `No meeting link for: ${invitee}. They need to connect a calendar.`,
  );
  await expect(warning).not.toContainText('Alex Rivera');

  // Another kind of location has no link to warn about.
  const kind = page.locator('select', { has: page.locator('option[value="in_person"]') });
  await expect(kind).toHaveValue('conferencing');
  await kind.selectOption('in_person');
  await expect(warning).toBeHidden();
});
