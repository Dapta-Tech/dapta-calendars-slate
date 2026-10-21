import { expect, test, type Page } from '@playwright/test';
import { E2E, HOST, signIn } from './stack';

/**
 * The path a team takes the week it moves in: an admin invites teammates, sees
 * them in Members, and builds a team event before they have joined.
 *
 * - In Spanish the invited row used to lose the name and email at desktop
 *   width (the controls took the whole line), and the state read "Invitado"
 *   in Members but "Pendiente" in the workspace switcher.
 * - A host with no working hours (an invited member until their first sign-in)
 *   is offered at no time and never assigned; the team event's Hosts block now
 *   says so by name.
 */
const asAlex = { 'x-slate-email': HOST.email };

async function inSpanish(page: Page) {
  await page.context().addCookies([{ name: 'slate_locale', value: 'es', url: new URL(page.url()).origin }]);
  await page.reload({ waitUntil: 'networkidle' });
}

test('an invited member reads in full in Members, in Spanish, with one word for the state', async ({
  page,
  request,
}, info) => {
  const tag = `${info.project.name}-${Date.now().toString(36)}`;
  const email = `casey.morgan.long.address-${tag}@example-company.test`;
  const invited = await request.post(`${E2E.api}/v1/members`, { headers: asAlex, data: { email, role: 'member' } });
  expect(invited.status()).toBe(201);

  await page.goto('/admin/settings/members');
  await signIn(page, HOST.email);
  await page.waitForURL(/\/admin\/settings\/members/);
  await inSpanish(page);

  // Every row lays its name and email out with a real width instead of
  // squeezing them to nothing beside the controls: the invitee's, and an
  // active member's, whose short Spanish labels kept the controls on one line.
  for (const who of [email, 'jordan@example.com']) {
    const text = page.getByRole('listitem').filter({ hasText: who }).getByText(who, { exact: true });
    await expect(text).toBeVisible();
    expect((await text.boundingBox())!.width).toBeGreaterThan(100);
  }
  const row = page.getByRole('listitem').filter({ hasText: email });
  await expect(row.getByText('Invitación pendiente', { exact: true })).toBeVisible();
});

test("a team event's hosts say who gets no bookings until they have working hours", async ({
  page,
  request,
}, info) => {
  const tag = `${info.project.name}-${Date.now().toString(36)}`;
  const team = await request.post(`${E2E.api}/v1/teams`, {
    headers: asAlex,
    data: { name: `Ready ${tag}`, slug: `ready-${tag}` },
  });
  expect(team.status()).toBe(201);
  const { id: teamId } = (await team.json()) as { id: string };
  const invitee = `Taylor Brooks ${tag}`;
  const invited = await request.post(`${E2E.api}/v1/members`, {
    headers: asAlex,
    data: { email: `taylor-${tag}@example.test`, displayName: invitee },
  });
  expect(invited.status()).toBe(201);
  const { id: taylorId } = (await invited.json()) as { id: string };
  expect(
    (await request.post(`${E2E.api}/v1/teams/${teamId}/members`, { headers: asAlex, data: { memberId: taylorId } }))
      .status(),
  ).toBe(201);

  await page.goto(`/admin/event-types/new?teamId=${teamId}`);
  await signIn(page, HOST.email);
  await page.waitForURL(/\/admin\/event-types\/new/);
  const noHours = page.getByTestId('host-readiness').locator('p').first();
  await expect(noHours).toContainText(`there are no working hours for: ${invitee}.`);
  // The creator has hours; only the invitee is named there.
  await expect(noHours).not.toContainText('Alex Rivera');
});
