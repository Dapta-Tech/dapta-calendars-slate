import { expect, test, type Page } from '@playwright/test';
import { E2E, HOST, answerWith, clearThrottle, signIn, throttle } from './stack';

/**
 * Connect your agent and Tools, in the real app on both projects (the 1440
 * desktop and a 360 phone). The guide shows only when the API says it serves
 * MCP and takes a sign-in. The web is started with MCP_PUBLIC_URL set
 * (playwright.config.ts), so the address alone would always be there; what
 * decides is the API's own Connected apps read.
 *
 * - The suite's API runs with MCP on and OAuth off, so on its own it answers
 *   "no sign-in" and the page says the connector is not available.
 * - A sign-in is the reply an API with OAUTH_AUTHORIZATION_SERVER set gives
 *   (pinned in the API's oauth specs), served by the proxy in front of it; the
 *   address the guide prints is the suite's real MCP endpoint, which answers.
 * - A read that fails (429 here) fails closed to "not available".
 */
const PAGE = '/admin/developers/connect';
const TOOLS = '/admin/developers/tools';
const KEYS = '/admin/developers/keys';
const MCP_URL = `${E2E.api}/mcp`;
const GRANTS = '/v1/oauth/grants';
/** The suite's build has no product name of its own: a fork's default. */
const HEADING = 'Connect Claude, ChatGPT, Codex or Cursor to Calendars';
const UNAVAILABLE = 'The connector is not available on this installation';
const SIGN_IN = { enabled: false, external: true, mcpEnabled: true, accessTokenTtlSeconds: null, grants: [] };
const APPS = ['Claude', 'ChatGPT', 'Claude Code', 'Codex', 'Cursor', 'OpenClaw', 'Hermes'];

test.beforeEach(async ({ context }) => {
  await context.addCookies([{ name: 'slate.onboarding.skipped', value: '1', url: E2E.web }]);
});

test.afterEach(async () => {
  await clearThrottle();
});

async function openAsOwner(page: Page, path = PAGE): Promise<void> {
  await page.goto(`/login?next=${encodeURIComponent(path)}`);
  await signIn(page, HOST.email);
  await expect(page).toHaveURL(new RegExp(`${path}$`));
}

const signInOn = () => answerWith({ match: GRANTS, method: 'GET', times: 20, status: 200, body: SIGN_IN });

/**
 * Nothing in `main` runs past the window's right edge, the way a phone would
 * show it. The page clips horizontal overflow (`overflow-x: clip` on html), so
 * a too-wide element would be cut off rather than scroll: every element is
 * measured, except inside a box that scrolls or clips on purpose (the tab
 * strip, a code block).
 */
async function expectNoSideOverflow(page: Page): Promise<void> {
  const report = await page.evaluate(() => {
    const width = window.innerWidth;
    const clipped = (el: Element) => {
      for (let p = el.parentElement; p && p.tagName !== 'MAIN'; p = p.parentElement) {
        if (getComputedStyle(p).overflowX !== 'visible') return true;
      }
      return false;
    };
    const over = [...document.querySelectorAll('main *')]
      .filter((el) => !clipped(el))
      .filter((el) => el.getBoundingClientRect().right > width + 0.5)
      .map((el) => `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className).slice(0, 60)}`);
    return { width, over: over.slice(0, 5) };
  });
  expect(report.width).toBe(page.viewportSize()!.width);
  expect(report.over).toEqual([]);
}

test('with a sign-in: a tab per app, the address that answers, and no key anywhere', async ({ page, request, isMobile }) => {
  await signInOn();
  await openAsOwner(page);
  await expect(page.getByRole('heading', { level: 1, name: HEADING })).toBeVisible();
  await expect(page.getByTestId('mcp-connect-recommended')).toBeVisible();

  const tabs = page.getByRole('tablist', { name: 'Your AI app' });
  await expect(tabs.getByRole('tab')).toHaveText(APPS);
  await expect(page.getByTestId('mcp-url')).toContainText(MCP_URL);
  await expect(page.getByTestId('mcp-walkthrough')).toBeVisible();
  // No listing for this deployment: Claude's tab is the custom connector.
  await expect(page.getByTestId('mcp-claude-directory')).toHaveCount(0);
  await expect(page.getByTestId('mcp-open-claude')).toHaveAttribute('href', 'https://claude.ai/customize/connectors');
  expect(await page.content()).not.toMatch(/DAPTA_CALENDARS_API_KEY|Bearer |dcl_[A-Za-z0-9]/);

  // Cursor: one click on a computer, the "open it on your computer" note on a phone.
  await tabs.getByRole('tab', { name: 'Cursor' }).click();
  if (isMobile) {
    await expect(page.getByTestId('mcp-phone-note')).toHaveText('Open this page on your computer to connect Cursor.');
    await expect(page.getByTestId('mcp-cursor-deeplink')).toHaveCount(0);
  } else {
    const href = (await page.getByTestId('mcp-cursor-deeplink').getAttribute('href'))!;
    const config = new URL(href.replace('cursor://', 'http://')).searchParams.get('config')!;
    expect(JSON.parse(Buffer.from(config, 'base64').toString('utf8'))).toEqual({ url: MCP_URL });
  }

  // The page only names an address that is really serving MCP.
  const mcp = await request.post(MCP_URL, {
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  });
  expect(mcp.status()).toBe(200);
});

test('the arrows move between the apps, the walkthrough answers clicks, and the pick is remembered', async ({ page }) => {
  await signInOn();
  await openAsOwner(page);
  const tabs = page.getByRole('tablist', { name: 'Your AI app' });
  await tabs.getByRole('tab', { name: 'Claude', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(tabs.getByRole('tab', { name: 'ChatGPT' })).toBeFocused();
  await expect(tabs.getByRole('tab', { name: 'ChatGPT' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('End');
  await expect(tabs.getByRole('tab', { name: 'Hermes' })).toHaveAttribute('aria-selected', 'true');

  await tabs.getByRole('tab', { name: 'Codex' }).click();
  const walk = page.getByTestId('mcp-walkthrough');
  await expect(walk).toHaveAttribute('data-kind', 'terminal');
  // A click on a step number jumps there; a click on the frame holds it still.
  await page.getByTestId('mcp-steps-codex').getByTestId('mcp-step').nth(2).locator('button').first().click();
  await expect(walk).toHaveAttribute('data-step', '2');
  await walk.getByRole('img').click();
  await expect(page.getByTestId('mcp-walkthrough-toggle')).toHaveAttribute('aria-pressed', 'true');

  await page.reload();
  await expect(tabs.getByRole('tab', { name: 'Codex' })).toHaveAttribute('aria-selected', 'true');
});

test('the suite API takes no sign-in: the note instead of the guide, no address, and Tools still one click away', async ({ page }) => {
  await openAsOwner(page);
  await expect(page.getByTestId('mcp-connect-unavailable')).toContainText(UNAVAILABLE);
  await expect(page.getByRole('tablist', { name: 'Your AI app' })).toHaveCount(0);
  expect(await page.content()).not.toContain(MCP_URL);
  await page.getByTestId('mcp-tools-link').click();
  await expect(page).toHaveURL(new RegExp(`${TOOLS}$`));
});

test('MCP off, or an API that cannot be asked: the same note', async ({ page }) => {
  await answerWith({ match: GRANTS, method: 'GET', times: 10, status: 200, body: { ...SIGN_IN, mcpEnabled: false } });
  await openAsOwner(page);
  await expect(page.getByTestId('mcp-connect-unavailable')).toBeVisible();
  expect(await page.content()).not.toContain(MCP_URL);
  await clearThrottle();

  await throttle({ match: GRANTS, method: 'GET', times: 10, retryAfter: 1 });
  await page.reload();
  await expect(page.getByTestId('mcp-connect-unavailable')).toBeVisible();
  expect(await page.content()).not.toContain(MCP_URL);
});

test('Tools: every tool in its group, in plain words, and the way back to connect', async ({ page }) => {
  await openAsOwner(page, TOOLS);
  await expect(page.getByRole('heading', { level: 1, name: 'Tools' })).toBeVisible();
  await expect(page.getByTestId('tools-item')).toHaveCount(17);
  for (const group of ['availability', 'booking', 'holds', 'bookings', 'requests', 'account']) {
    await expect(page.getByTestId(`tools-group-${group}`)).toBeVisible();
  }
  expect(await page.locator('main').innerText()).not.toMatch(/find_available_slots|book_meeting|_id\b/);
  await page.getByTestId('tools-connect-link').click();
  await expect(page).toHaveURL(new RegExp(`${PAGE}$`));
});

test('API keys keeps the keys and the skill, and no connect guide', async ({ page }) => {
  await signInOn();
  await openAsOwner(page, KEYS);
  await expect(page.getByRole('heading', { level: 1, name: 'API keys' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create key' })).toBeVisible();
  await expect(page.getByTestId('setup-skill')).toBeVisible();
  await expect(page.getByRole('tablist')).toHaveCount(0);
  expect(await page.content()).not.toContain(MCP_URL);
});

test('an owner\'s home leads to the guide from the banner and the card', async ({ page }) => {
  await openAsOwner(page, '/admin');
  await expect(page.getByTestId('home-agent-banner')).toBeVisible();
  await expect(page.getByTestId('home-agent-card')).toBeVisible();
  await page.getByTestId('home-agent-banner-cta').click();
  await expect(page).toHaveURL(new RegExp(`${PAGE}$`));
});

test('at phone width nothing runs off the side: connect, Tools and the home', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'the 360 project');
  await signInOn();
  await openAsOwner(page);
  await expect(page.getByTestId('mcp-connect')).toBeVisible();
  await expectNoSideOverflow(page);
  for (const path of [TOOLS, '/admin']) {
    await page.goto(path);
    await expect(page.locator('main h1').first()).toBeVisible();
    await expectNoSideOverflow(page);
  }
});
