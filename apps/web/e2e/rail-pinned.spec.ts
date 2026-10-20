import { expect, test, type Locator, type Page } from '@playwright/test';
import { E2E, HOST, signIn } from './stack';

/**
 * The rail is pinned to the window, on both projects (the 1440 desktop rail and
 * the 360 drawer): however far a long page scrolls, the footer (the theme
 * switch and the person, with Sign out behind it) stays on screen, and when the
 * nav is taller than the window only the nav scrolls, so the wordmark and the
 * footer stay put. Connect and keys is the page: it is long, and on it the MCP
 * group is open, which makes the nav its tallest.
 */

const PAGE = '/admin/developers/keys';

test.beforeEach(async ({ context }) => {
  await context.addCookies([{ name: 'slate.onboarding.skipped', value: '1', url: E2E.web }]);
});

/** The rail a person actually sees: the desktop aside, or the drawer, opened. */
async function rail(page: Page, mobile: boolean) {
  if (!mobile) return page.locator('aside').first();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  return page.getByRole('dialog', { name: 'Primary' });
}

/** Wholly inside the window: nothing cut off at the top or the bottom. */
async function expectOnScreen(page: Page, target: Locator) {
  const box = await target.boundingBox();
  const height = page.viewportSize()!.height;
  expect(box, 'rendered').not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(height);
}

/**
 * Scroll the page to a fraction of its scrollable height. The top and the
 * middle are what catch a rail stretched with the page: at the very end of the
 * page a stretched rail ends at the window's bottom edge too, so its footer
 * happens to be on screen there.
 */
const STOPS = [0, 0.5, 1] as const;
async function scrollPage(page: Page, at: number) {
  const y = await page.evaluate((at) => {
    const el = document.scrollingElement!;
    window.scrollTo(0, (el.scrollHeight - window.innerHeight) * at);
    return window.scrollY;
  }, at);
  // A real scroll: the page is taller than the window.
  if (at > 0) expect(y).toBeGreaterThan(0);
}

test('the footer stays on screen at the top, the middle and the end of a long page', async ({ page, isMobile }) => {
  await page.goto(PAGE);
  await signIn(page, HOST.email);
  await expect(page).toHaveURL(/\/admin\/developers\/keys$/);

  let nav: Locator | null = null;
  for (const at of STOPS) {
    await scrollPage(page, at);
    nav = await rail(page, isMobile);
    // The rail spans the window from its top edge, wherever the page is.
    const box = (await nav.boundingBox())!;
    expect(box.y, `rail top at ${at}`).toBe(0);
    expect(box.height, `rail height at ${at}`).toBe(page.viewportSize()!.height);
    const me = nav.getByTestId('profile-menu-trigger');
    await expect(me).toContainText(HOST.email);
    await expectOnScreen(page, me);
    await expectOnScreen(page, nav.getByRole('button', { name: /^Switch to (light|dark) theme$/ }));
    if (isMobile && at < 1) {
      await page.keyboard.press('Escape');
      await expect(page.getByRole('button', { name: 'Open navigation' })).toHaveAttribute('aria-expanded', 'false');
    }
  }

  // And it still works from the end of the page.
  await nav!.getByTestId('profile-menu-trigger').click();
  await expect(page.getByRole('menu', { name: 'Account menu' })).toBeVisible();
});

test('the collapsed rail stays pinned, and its MCP menu opens beside it', async ({ page, context, isMobile }) => {
  test.skip(isMobile, 'The collapsed rail is the desktop rail.');
  await context.addCookies([{ name: 'slate.nav.collapsed', value: '1', url: E2E.web }]);
  await page.goto(PAGE);
  await signIn(page, HOST.email);
  await expect(page).toHaveURL(/\/admin\/developers\/keys$/);

  const nav = page.locator('aside').first();
  for (const at of STOPS) {
    await scrollPage(page, at);
    expect((await nav.boundingBox())!.y, `rail top at ${at}`).toBe(0);
    await expectOnScreen(page, nav.getByTestId('profile-menu-trigger'));
  }
  await scrollPage(page, 0.5);
  const mcp = nav.getByTestId('nav-developers');
  await mcp.click();
  const flyout = page.getByRole('menu', { name: 'MCP' });
  await expect(flyout).toBeVisible();
  await expectOnScreen(page, flyout);
  const [trigger, panel] = [(await mcp.boundingBox())!, (await flyout.boundingBox())!];
  expect(panel.x).toBeGreaterThanOrEqual(trigger.x + trigger.width);
});

test('in a short window only the nav scrolls, and the wordmark and footer stay', async ({ page, isMobile }) => {
  await page.setViewportSize({ width: isMobile ? 360 : 1440, height: 420 });
  await page.goto(PAGE);
  await signIn(page, HOST.email);
  await expect(page).toHaveURL(/\/admin\/developers\/keys$/);

  const box = await rail(page, isMobile);
  const list = box.locator('nav');
  expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await list.evaluate((el) => el.scrollTo(0, el.scrollHeight));

  // The rail itself did not move; the last item came up within the list.
  expect(await box.evaluate((el) => el.scrollTop)).toBe(0);
  // The brand row (the wordmark, or a fork's chip and name) is the rail's first.
  await expectOnScreen(page, box.locator(':scope > *').first());
  await expectOnScreen(page, box.getByTestId('profile-menu-trigger'));
  await expectOnScreen(page, list.locator('li').last());
});
