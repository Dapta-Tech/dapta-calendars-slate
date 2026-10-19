import { expect, test, type Page } from '@playwright/test';
import { E2E, HOST, answerWith, clearThrottle, throttle } from './stack';

/**
 * MCP, Connect and keys shows how to connect an agent only when the API says it
 * serves MCP. The web is started with MCP_PUBLIC_URL set (playwright.config.ts),
 * so the address alone would always be there; what decides is the API's own
 * `mcpEnabled` on the Connected apps read.
 *
 * - The suite's API runs with MCP on (the default), so the page shows the real
 *   address, and that address really answers.
 * - MCP off is the reply an API with MCP_ENABLED=false gives (pinned in the
 *   API's oauth.integration.spec.ts), served by the proxy in front of the API.
 * - A read that fails (429 here) fails closed to the same state.
 */
const PAGE = '/admin/developers/keys';
const MCP_URL = `${E2E.api}/mcp`;
const GRANTS = '/v1/oauth/grants';
const UNAVAILABLE = 'Agent connections are not turned on for this installation.';

async function openAsOwner(page: Page): Promise<void> {
  await page.goto(`/login?next=${encodeURIComponent(PAGE)}`);
  await page.getByLabel('Email').fill(HOST.email);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(new RegExp(`${PAGE}$`));
  // Exact: with MCP on it is step 2's title, under "Connect your agent in 3 steps".
  await expect(page.getByRole('heading', { name: 'Connect your agent', exact: true })).toBeVisible();
}

/** The keys do not depend on MCP and render the same in every state. */
async function expectOtherSections(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'API keys' })).toBeVisible();
}

async function expectUnavailable(page: Page): Promise<void> {
  await expect(page.getByText(UNAVAILABLE)).toBeVisible();
  await expect(page.getByRole('tablist', { name: 'Connect your agent' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Add to Cursor' })).toHaveCount(0);
  // The tool list describes the endpoint that is off.
  await expect(page.getByRole('heading', { name: 'What an agent can do' })).toHaveCount(0);
  // No address anywhere on the page, not even in a copy block or a link.
  expect(await page.content()).not.toContain(MCP_URL);
  await expectOtherSections(page);
}

test.afterEach(async () => {
  await clearThrottle();
});

test('MCP on: the steps show the configured address, and that address answers', async ({ page, request }) => {
  const reported = await request.get(`${E2E.api}${GRANTS}`, { headers: { 'x-slate-email': HOST.email } });
  expect(reported.ok()).toBe(true);
  expect(((await reported.json()) as { mcpEnabled?: boolean }).mcpEnabled).toBe(true);

  await openAsOwner(page);
  await expect(page.getByRole('tablist', { name: 'Connect your agent' })).toBeVisible();
  await expect(page.getByText(MCP_URL, { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Add to Cursor' })).toHaveAttribute('href', /^cursor:\/\//);
  await expect(page.getByText(UNAVAILABLE)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'What an agent can do' })).toBeVisible();
  await expectOtherSections(page);

  // The page only names an address that is really serving MCP.
  const mcp = await request.post(MCP_URL, {
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  });
  expect(mcp.status()).toBe(200);
});

test('MCP off: an honest sentence, no steps, no tool list and no address', async ({ page }) => {
  await answerWith({
    match: GRANTS,
    method: 'GET',
    times: 10,
    status: 200,
    body: { enabled: false, mcpEnabled: false, accessTokenTtlSeconds: null, grants: [] },
  });
  await openAsOwner(page);
  await expectUnavailable(page);
});

test('the API cannot be asked: fails closed to the same state', async ({ page }) => {
  await throttle({ match: GRANTS, method: 'GET', times: 10, retryAfter: 1 });
  await openAsOwner(page);
  await expectUnavailable(page);
});
