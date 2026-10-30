import { expect, test } from '@playwright/test';
import { E2E, HOST, rail, signIn } from './stack';

/**
 * The rail's agent items ("Connect your agent", "Tools"), its "API and
 * webhooks" group and its Docs item, in the real app on both projects (the
 * 1440 desktop rail and the 360 drawer): the old addresses land on the connect
 * guide, every page is one click from anywhere, a plain member never gets a
 * door that opens on "no access", Docs leaves the app in a new tab in the
 * reader's language, and API docs opens the API's own reference the same way.
 */

const JORDAN = 'jordan@example.com';

test.beforeEach(async ({ context }) => {
  await context.addCookies([{ name: 'slate.onboarding.skipped', value: '1', url: E2E.web }]);
});

test('the old Settings address and the bare /admin/developers answer with a redirect to the connect guide', async ({ request }) => {
  for (const from of ['/admin/settings/developer', '/admin/developers']) {
    const res = await request.get(from, { maxRedirects: 0 });
    expect(res.status(), from).toBe(307);
    expect(res.headers().location, from).toBe('/admin/developers/connect');
  }
});

test('an owner follows an old link through the login to the guide, then walks Tools and the API pages', async ({ page, isMobile }) => {
  await page.goto('/admin/settings/developer');
  await signIn(page, HOST.email);
  await expect(page).toHaveURL(/\/admin\/developers\/connect$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Connect Claude, ChatGPT, Codex or Cursor');
  // The tab it used to be is gone from Settings.
  await page.goto('/admin/settings/general');
  await expect(page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: 'MCP & API' })).toHaveCount(0);

  await page.goto('/admin/developers/connect');
  let nav = await rail(page, isMobile);
  const connect = nav.getByTestId('nav-connect');
  await expect(connect).toHaveAttribute('aria-current', 'page');
  await expect(connect).toHaveAttribute('data-prominent', 'true');
  // The group shares the address prefix but is not where you are.
  await expect(nav.getByTestId('nav-api')).toHaveAttribute('aria-expanded', 'false');

  await nav.getByTestId('nav-tools').click();
  await expect(page).toHaveURL(/\/admin\/developers\/tools$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Tools' })).toBeVisible();

  nav = await rail(page, isMobile);
  await nav.getByTestId('nav-api').click();
  await nav.getByRole('link', { name: 'API keys' }).click();
  await expect(page).toHaveURL(/\/admin\/developers\/keys$/);
  await expect(page.getByRole('heading', { level: 1, name: 'API keys' })).toBeVisible();

  nav = await rail(page, isMobile);
  await expect(nav.getByTestId('nav-api')).toHaveAttribute('aria-expanded', 'true');
  await expect(nav.getByRole('link', { name: 'API keys' })).toHaveAttribute('aria-current', 'page');
  await nav.getByRole('link', { name: 'Webhooks' }).click();
  await expect(page).toHaveURL(/\/admin\/developers\/webhooks$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Webhooks' })).toBeVisible();
  // Picking a page closes the drawer (it slides off screen, so it is still
  // "visible" to a locator; the toggle says whether it is open).
  if (isMobile) await expect(page.getByTestId('nav-open')).toHaveAttribute('aria-expanded', 'false');

  // API docs is the API's own reference, in a new tab like Docs: no page in
  // the dashboard between, and the reference never drawn on the dashboard.
  nav = await rail(page, isMobile);
  const apiDocs = nav.getByTestId('nav-api-docs');
  await expect(apiDocs).toHaveAttribute('href', `${E2E.api}/docs`);
  await expect(apiDocs).toHaveAttribute('target', '_blank');
  await expect(apiDocs).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(apiDocs).not.toHaveAttribute('aria-current', /.*/);
  await expect(apiDocs).toContainText('(opens in a new tab)');

  // A link made before to the old page lands on the reference itself.
  await page.goto('/admin/developers/docs');
  await expect(page).toHaveURL(`${E2E.api}/docs`);
});

test('on the collapsed rail API and webhooks is a menu: open it, arrow down, pick a page', async ({ page, context, isMobile }) => {
  test.skip(isMobile, 'the collapsed rail is a desktop preference');
  await context.addCookies([{ name: 'slate.nav.collapsed', value: '1', url: E2E.web }]);
  await page.goto('/admin');
  await signIn(page, HOST.email);
  await expect(page).toHaveURL(/\/admin$/);

  const aside = page.locator('aside').first();
  await expect(aside.getByRole('link', { name: 'Connect your agent' })).toBeVisible();
  const trigger = aside.getByRole('button', { name: 'API and webhooks' });
  await expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
  await trigger.click();
  const menu = page.getByRole('menu', { name: 'API and webhooks' });
  await expect(menu.getByRole('menuitem')).toHaveText(['API keys', 'Webhooks', /^API docs/]);
  await expect(menu.getByRole('menuitem', { name: 'API keys' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Webhooks' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();

  // Tab leaves the menu, closes it, and moves on from the group: to Docs.
  await trigger.click();
  await expect(menu.getByRole('menuitem', { name: 'API keys' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(menu).toBeHidden();
  await expect(aside.getByTestId('nav-docs')).toBeFocused();

  // The last item leaves the app: the API's reference, in a new tab.
  await trigger.click();
  await page.keyboard.press('End');
  const last = menu.getByRole('menuitem', { name: /API docs/ });
  await expect(last).toBeFocused();
  await expect(last).toHaveAttribute('href', `${E2E.api}/docs`);
  await expect(last).toHaveAttribute('target', '_blank');
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

test('a plain member gets Docs but no agent or API item, no home promo, and the addresses alone say no access', async ({ page, isMobile }) => {
  await page.goto('/admin');
  await signIn(page, JORDAN);
  await expect(page).toHaveURL(/\/admin$/);
  const nav = await rail(page, isMobile);
  await expect(nav.getByTestId('nav-docs')).toBeVisible();
  for (const id of ['nav-connect', 'nav-tools', 'nav-api']) await expect(nav.getByTestId(id)).toHaveCount(0);
  if (isMobile) await page.keyboard.press('Escape');
  // Nor the home's banner and card, or any link into those pages.
  await expect(page.getByTestId('home-agent-banner')).toHaveCount(0);
  await expect(page.getByTestId('home-agent-card')).toHaveCount(0);
  await expect(page.locator('main a[href^="/admin/developers"]')).toHaveCount(0);

  for (const path of [
    '/admin/developers/connect',
    '/admin/developers/tools',
    '/admin/developers/keys',
    '/admin/developers/webhooks',
    '/admin/developers/docs',
  ]) {
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
  if (isMobile) await expect(page.getByTestId('nav-open')).toHaveAttribute('aria-expanded', 'true');

  await me.click();
  await menu.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
});
