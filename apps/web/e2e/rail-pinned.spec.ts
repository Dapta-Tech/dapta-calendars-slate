import { expect, test, type Locator, type Page } from '@playwright/test';
import { E2E, HOST, rail, signIn } from './stack';

/**
 * The rail is pinned to the window, on both projects (the 1440 desktop rail and
 * the 360 drawer): however far a long page scrolls, the footer (the theme
 * switch and the person, with Sign out behind it) stays on screen, and when the
 * nav is taller than the window only the nav scrolls, so the wordmark and the
 * footer stay put. Tools is the page: it is long on both projects, and the
 * nav carries every item an owner gets.
 */

const PAGE = '/admin/developers/tools';

test.beforeEach(async ({ context }) => {
  await context.addCookies([{ name: 'slate.onboarding.skipped', value: '1', url: E2E.web }]);
});

/**
 * Wholly inside the window, on both axes: the closed drawer is full height
 * too, only slid off to the left, so the vertical check alone would pass it.
 */
async function expectOnScreen(page: Page, target: Locator) {
  const box = await target.boundingBox();
  const { width, height } = page.viewportSize()!;
  expect(box, 'rendered').not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(height);
}

/** Signed in on the long page, with its content rendered (not the loading skeleton). */
async function openLongPage(page: Page) {
  await page.goto(PAGE);
  await signIn(page, HOST.email);
  await expect(page).toHaveURL(/\/admin\/developers\/tools$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Tools' })).toBeVisible();
}

/**
 * Wholly inside a scroll box's visible part. The window is not enough: a row
 * the nav has scrolled out of sight can still sit within the window's bounds.
 */
async function expectWithin(container: Locator, target: Locator) {
  const [outer, inner] = [await container.boundingBox(), await target.boundingBox()];
  expect(outer, 'container rendered').not.toBeNull();
  expect(inner, 'target rendered').not.toBeNull();
  expect(inner!.y).toBeGreaterThanOrEqual(outer!.y);
  expect(inner!.y + inner!.height).toBeLessThanOrEqual(outer!.y + outer!.height);
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
  await openLongPage(page);

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
      await expect(page.getByTestId('nav-open')).toHaveAttribute('aria-expanded', 'false');
    }
  }

  // And it still works from the end of the page.
  await nav!.getByTestId('profile-menu-trigger').click();
  await expect(page.getByRole('menu', { name: 'Account menu' })).toBeVisible();
});

test('the collapsed rail stays pinned, and its API and webhooks menu opens beside it', async ({ page, context, isMobile }) => {
  test.skip(isMobile, 'The collapsed rail is the desktop rail.');
  await context.addCookies([{ name: 'slate.nav.collapsed', value: '1', url: E2E.web }]);
  await openLongPage(page);

  const nav = page.getByTestId('rail');
  for (const at of STOPS) {
    await scrollPage(page, at);
    expect((await nav.boundingBox())!.y, `rail top at ${at}`).toBe(0);
    await expectOnScreen(page, nav.getByTestId('profile-menu-trigger'));
  }
  await scrollPage(page, 0.5);
  const group = nav.getByTestId('nav-api');
  await group.click();
  const flyout = page.getByRole('menu', { name: 'API and webhooks' });
  await expect(flyout).toBeVisible();
  await expectOnScreen(page, flyout);
  const [trigger, panel] = [(await group.boundingBox())!, (await flyout.boundingBox())!];
  expect(panel.x).toBeGreaterThanOrEqual(trigger.x + trigger.width);
});

test('in a short window only the nav scrolls, and the wordmark and footer stay', async ({ page, isMobile }) => {
  await page.setViewportSize({ width: isMobile ? 360 : 1440, height: 420 });
  await openLongPage(page);

  const box = await rail(page, isMobile);
  const list = box.locator('nav');
  expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  // The page you are on opens in view, not scrolled out of sight under the fold.
  await expectWithin(list, list.locator('[aria-current="page"]'));
  await list.evaluate((el) => el.scrollTo(0, el.scrollHeight));

  // The rail itself did not move; the last item came up within the list.
  expect(await box.evaluate((el) => el.scrollTop)).toBe(0);
  // The brand row: the wordmark, or a fork's chip and name.
  await expectOnScreen(page, box.getByTestId('rail-brand'));
  await expectOnScreen(page, box.getByTestId('profile-menu-trigger'));
  await expectWithin(list, list.locator(':scope > ul > li').last());
});
