import { expect, test } from '@playwright/test';
import { E2E, HOST, rail, signIn } from './stack';

/**
 * The rail's MCP group and Docs item, in the real app on both projects (the
 * 1440 desktop rail and the 360 drawer): the old Settings address still lands
 * on the keys, the group's pages are one click from anywhere, a plain member
 * never gets a door that opens on "no access", and Docs leaves the app in a new
 * tab in the reader's language.
 */

const JORDAN = 'jordan@example.com';

test.beforeEach(async ({ context }) => {
  await context.addCookies([{ name: 'slate.onboarding.skipped', value: '1', url: E2E.web }]);
});

test('the old Settings address and the bare group address answer with a redirect to the keys', async ({ request }) => {
  for (const from of ['/admin/settings/developer', '/admin/developers']) {
    const res = await request.get(from, { maxRedirects: 0 });
    expect(res.status(), from).toBe(307);
    expect(res.headers().location, from).toBe('/admin/developers/keys');
  }
});

test('an owner follows an old link through the login to the keys, then walks the group', async ({ page, isMobile }) => {
  await page.goto('/admin/settings/developer');
  await signIn(page, HOST.email);
  await expect(page).toHaveURL(/\/admin\/developers\/keys$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Connect and keys' })).toBeVisible();
  await expect(page.getByTestId('setup-guide')).toBeVisible();
  // The tab it used to be is gone from Settings.
  await page.goto('/admin/settings/general');
  await expect(page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: 'MCP & API' })).toHaveCount(0);

  await page.goto('/admin/developers/keys');
  let nav = await rail(page, isMobile);
  const group = nav.getByTestId('nav-developers');
  await expect(group).toHaveAttribute('aria-expanded', 'true');
  await expect(nav.getByRole('link', { name: 'Connect and keys' })).toHaveAttribute('aria-current', 'page');

  await nav.getByRole('link', { name: 'Webhooks' }).click();
  await expect(page).toHaveURL(/\/admin\/developers\/webhooks$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Webhooks' })).toBeVisible();

  nav = await rail(page, isMobile);
  await nav.getByRole('link', { name: 'API docs' }).click();
  await expect(page).toHaveURL(/\/admin\/developers\/docs$/);
  await expect(page.getByRole('heading', { level: 1, name: 'API docs' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'What an agent can do' })).toBeVisible();
  // Picking a page closes the drawer (it slides off screen, so it is still
  // "visible" to a locator; the toggle says whether it is open).
  if (isMobile) await expect(page.getByRole('button', { name: 'Open navigation' })).toHaveAttribute('aria-expanded', 'false');
});

test('on the collapsed rail MCP is a menu: open it, arrow down, pick a page', async ({ page, context, isMobile }) => {
  test.skip(isMobile, 'the collapsed rail is a desktop preference');
  await context.addCookies([{ name: 'slate.nav.collapsed', value: '1', url: E2E.web }]);
  await page.goto('/admin');
  await signIn(page, HOST.email);
  await expect(page).toHaveURL(/\/admin$/);

  const trigger = page.locator('aside').first().getByRole('button', { name: 'MCP' });
  await expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
  await trigger.click();
  const menu = page.getByRole('menu', { name: 'MCP' });
  await expect(menu.getByRole('menuitem')).toHaveText(['Connect and keys', 'Webhooks', 'API docs']);
  await expect(menu.getByRole('menuitem', { name: 'Connect and keys' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Webhooks' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();

  // Tab leaves the menu, closes it, and moves on from the MCP item: to Docs.
  await trigger.click();
  await expect(menu.getByRole('menuitem', { name: 'Connect and keys' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(menu).toBeHidden();
  await expect(page.locator('aside').first().getByTestId('nav-docs')).toBeFocused();

  await trigger.click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/admin\/developers\/docs$/);
});

test('Docs opens the deployment’s docs in a new tab, in the reader’s language', async ({ page, isMobile }) => {
  await page.goto('/admin');
  await signIn(page, HOST.email);
  await expect(page).toHaveURL(/\/admin$/);
  const nav = await rail(page, isMobile);
  const docs = nav.getByTestId('nav-docs');
  await expect(docs).toHaveAttribute('target', '_blank');
  await expect(docs).toHaveAttribute('rel', 'noopener noreferrer');
  const href = new URL((await docs.getAttribute('href'))!);
  expect(`${href.origin}${href.pathname}`).toBe(E2E.docsUrl);
  expect(href.searchParams.get('utm_medium')).toBe('sidebar');

  // In Spanish, the Spanish docs.
  await page.context().addCookies([{ name: 'slate_locale', value: 'es', url: E2E.web }]);
  await page.goto('/admin');
  const es = (await rail(page, isMobile)).getByTestId('nav-docs');
  await expect(es).toContainText('Documentación');
  const esHref = new URL((await es.getAttribute('href'))!);
  expect(`${esHref.origin}${esHref.pathname}`).toBe(E2E.docsUrlEs);
});

test('a plain member gets Docs but no MCP item, and the address alone says no access', async ({ page, isMobile }) => {
  await page.goto('/admin');
  await signIn(page, JORDAN);
  await expect(page).toHaveURL(/\/admin$/);
  const nav = await rail(page, isMobile);
  await expect(nav.getByTestId('nav-docs')).toBeVisible();
  await expect(nav.getByTestId('nav-developers')).toHaveCount(0);
  if (isMobile) await page.keyboard.press('Escape');
  // Nor the Home shortcut to the keys.
  await expect(page.locator('main a[href="/admin/developers/keys"]')).toHaveCount(0);

  for (const path of ['/admin/developers/keys', '/admin/developers/webhooks', '/admin/developers/docs']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: 'You don’t have access' }), path).toBeVisible();
  }
});

test('the foot of the rail is the person: one menu with the public page and Sign out', async ({ page, isMobile }) => {
  await page.goto('/admin');
  await signIn(page, HOST.email);
  await expect(page).toHaveURL(/\/admin$/);
  const nav = await rail(page, isMobile);
  const me = nav.getByTestId('profile-menu-trigger');
  await expect(me).toContainText(HOST.email);
  await me.click();
  const menu = page.getByRole('menu', { name: 'Account menu' });
  await expect(menu.getByRole('menuitem', { name: /View public page/ })).toHaveAttribute(
    'href',
    `/${HOST.accountCode}/${HOST.handle}`,
  );
  await expect(menu.getByRole('menuitem', { name: /View public page/ })).toBeFocused();
  // Escape closes the menu and nothing else (on mobile, the drawer stays open).
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(me).toBeFocused();
  if (isMobile) await expect(page.getByRole('button', { name: 'Open navigation' })).toHaveAttribute('aria-expanded', 'true');

  await me.click();
  await menu.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
});
