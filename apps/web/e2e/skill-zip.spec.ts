import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { readZip } from '../lib/test/read-zip';
import { E2E, HOST } from './stack';

/**
 * The skill zip, in the real app on both projects: an owner downloads it from
 * the end of the setup guide on MCP, Connect and keys, and it is written for
 * this deployment (its public API address, every route the running API
 * describes and no other); a plain member is refused at the route itself.
 */

const JORDAN = 'jordan@example.com';
const METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

async function signIn(page: Page, email: string): Promise<void> {
  await expect(page).toHaveURL(/\/login/);
  await page.locator('input[type="email"]').fill(email);
  await page.locator('button[type="submit"]').click();
}

test.beforeEach(async ({ context }) => {
  await context.addCookies([{ name: 'slate.onboarding.skipped', value: '1', url: E2E.web }]);
});

test('an owner downloads the skill from the setup guide, written for this deployment', async ({ page }) => {
  await page.goto('/admin/developers/keys');
  await signIn(page, HOST.email);
  await expect(page).toHaveURL(/\/admin\/developers\/keys$/);

  const button = page.getByTestId('setup-skill').getByRole('link', { name: 'Download the skill' });
  await expect(button).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), button.click()]);
  expect(download.suggestedFilename()).toBe('dapta-calendars-skill.zip');

  const files = readZip(readFileSync((await download.path())!));
  expect(files.get('dapta-calendars/SKILL.md')).toContain(`API base URL: \`${E2E.api}\``);

  // The endpoint reference is the running API's own description, route for route.
  const served = (await (await page.request.get(`${E2E.api}/openapi.json`)).json()) as { paths: Record<string, object> };
  const operations = Object.entries(served.paths).flatMap(([path, item]) =>
    Object.keys(item)
      .filter((m) => METHODS.has(m))
      .map((m) => `${m.toUpperCase()} ${path}`),
  );
  const listed = [...files.get('dapta-calendars/reference/endpoints.md')!.matchAll(/^### `(.+)`$/gm)].map((m) => m[1]);
  expect(listed.sort()).toEqual(operations.sort());
});

test('a plain member is refused the skill at the route, not only by a missing button', async ({ page }) => {
  await page.goto('/admin');
  await signIn(page, JORDAN);
  await expect(page).toHaveURL(/\/admin$/);
  const res = await page.request.get('/api/developers/skill');
  expect(res.status()).toBe(403);
  expect(res.headers()['content-type']).toContain('application/json');
});
