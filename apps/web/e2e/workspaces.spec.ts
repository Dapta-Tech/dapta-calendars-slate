import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { E2E, HOST, rail, signIn } from './stack';

/**
 * One person, two workspaces, in the browser: someone who already has their
 * own account is invited by an admin of another, the invitation goes out
 * (logged here: the stack sends no mail), and on their next visit the rail
 * offers the workspace marked "Invited". Opening it is accepting it: the admin
 * then sees them active.
 */

test.beforeEach(async ({ context }) => {
  await context.addCookies([{ name: 'slate.onboarding.skipped', value: '1', url: E2E.web }]);
});

async function signInAt(page: Page, path: string, email: string) {
  await page.goto('/api/auth/logout');
  await page.goto(path);
  await signIn(page, email);
}

/** The API's log, colours stripped. */
const apiLog = () => readFileSync(resolve(E2E.logDir, 'main.log'), 'utf8').replace(/\x1b\[[0-9;]*m/g, '');

test('an invited person opens the workspace from the rail, and that accepts the invitation', async ({ page }, info) => {
  const mobile = info.project.name === 'mobile';
  const invitee = `invitee-${info.project.name}-${Date.now().toString(36)}@example.test`;

  // The invitee's own account comes first, as for anyone already using the product.
  await signInAt(page, '/admin', invitee);
  await expect(page).toHaveURL(/\/admin/);

  // An admin of another workspace invites that address.
  await signInAt(page, '/admin/settings/members', HOST.email);
  await page.getByRole('button', { name: 'Invite member' }).click();
  const dialog = page.getByRole('dialog', { name: 'Invite a member' });
  await dialog.getByRole('textbox').fill(invitee);
  await dialog.getByRole('button', { name: 'Send invite' }).click();
  // This stack has no mail transport, so the toast says so instead of "sent".
  await expect(page.getByText(/This server sends no email/)).toBeVisible();
  const row = page.getByRole('listitem').filter({ hasText: invitee });
  await expect(row.getByText('Invited', { exact: true })).toBeVisible();
  await expect(row.getByRole('button', { name: /Resend invite/ })).toBeVisible();
  // The invitation went through the outbox to the invited address.
  await expect.poll(() => apiLog().includes(`to=${invitee}`), { timeout: 20_000 }).toBe(true);

  // The invitee's next visit: their own account, and the invitation beside it.
  await signInAt(page, '/admin', invitee);
  await expect(page).toHaveURL(/\/admin/);
  const nav = await rail(page, mobile);
  const trigger = nav.getByTestId('workspace-switcher-trigger');
  await expect(trigger).toBeVisible();
  await trigger.click();
  const menu = page.getByTestId('workspace-switcher-menu');
  const invited = menu.getByRole('menuitem').filter({ hasText: 'Invited' });
  await expect(invited).toHaveCount(1);
  const workspaceName = (await invited.locator('span').first().textContent())?.trim() ?? '';
  expect(workspaceName).not.toBe('');
  await invited.click();

  // In the inviting workspace now, and the invitation is spent.
  await expect(page).toHaveURL(/\/admin$/);
  const after = await rail(page, mobile);
  await expect(after.getByTestId('workspace-switcher-trigger')).toHaveAttribute('title', workspaceName);
  await after.getByTestId('workspace-switcher-trigger').click();
  await expect(page.getByTestId('workspace-switcher-menu').getByText('Invited', { exact: true })).toHaveCount(0);

  // The admin sees them active, with nothing left to resend.
  await signInAt(page, '/admin/settings/members', HOST.email);
  const joined = page.getByRole('listitem').filter({ hasText: invitee });
  await expect(joined.getByText('Active', { exact: true })).toBeVisible();
  await expect(joined.getByRole('button', { name: /Resend invite/ })).toHaveCount(0);
});

test('an invitation link opened by someone it is not for says so', async ({ page }) => {
  await signInAt(page, '/admin', `stranger-${Date.now().toString(36)}@example.test`);
  await expect(page).toHaveURL(/\/admin/);
  await page.goto(`/invite/${HOST.accountCode}`);
  await expect(page).toHaveURL(/\/invite\/not-for-you/);
  await expect(page.getByRole('heading', { name: 'This invitation isn’t for this account' })).toBeVisible();
});
