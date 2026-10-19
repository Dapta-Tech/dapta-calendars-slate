import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { readZip } from '../lib/test/read-zip';
import { E2E, HOST, signIn } from './stack';

/**
 * The skill zip, in the real app on both projects: an owner downloads it from
 * the end of the setup guide on MCP, Connect and keys, and it is written for
 * this deployment (its public API address, every route the running API
 * describes and no other); a refused download says why under the button; a
 * plain member is refused at the route itself.
 */

const JORDAN = 'jordan@example.com';
const METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

test.beforeEach(async ({ context }) => {
  await context.addCookies([{ name: 'slate.onboarding.skipped', value: '1', url: E2E.web }]);
});

test('an owner downloads the skill from the setup guide, written for this deployment', async ({ page }) => {
  await page.goto('/admin/developers/keys');
  await signIn(page, HOST.email);
  await expect(page).toHaveURL(/\/admin\/developers\/keys$/);

  const button = page.getByTestId('setup-skill').getByRole('button', { name: 'Download the skill' });
  await expect(button).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), button.click()]);
  expect(download.suggestedFilename()).toBe('dapta-calendars-skill.zip');

  const path = (await download.path())!;
  const files = readZip(readFileSync(path));
  // A second opinion from a real unzip, where the runner has one.
  const unzip = spawnSync('unzip', ['-tq', path], { encoding: 'utf8' });
  if (unzip.error) test.info().annotations.push({ type: 'note', description: 'unzip not installed: -tq check skipped' });
  else expect(unzip.status, unzip.stdout + unzip.stderr).toBe(0);
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

test('a refused download says why under the button, and saves nothing', async ({ page }) => {
  await page.goto('/admin/developers/keys');
  await signIn(page, HOST.email);
  await expect(page).toHaveURL(/\/admin\/developers\/keys$/);
  // The session ends between the page load and the click.
  await page.route('**/api/developers/skill', (route) =>
    route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"UNAUTHENTICATED","message":"x"}' }),
  );
  let downloaded = false;
  page.on('download', () => (downloaded = true));
  await page.getByTestId('setup-skill').getByRole('button', { name: 'Download the skill' }).click();
  await expect(page.getByTestId('setup-skill').getByRole('alert')).toHaveText(
    'Your session has ended. Sign in again, then download the skill.',
  );
  expect(downloaded).toBe(false);
});

test('a plain member is refused the skill at the route, not only by a missing button', async ({ page }) => {
  await page.goto('/admin');
  await signIn(page, JORDAN);
  await expect(page).toHaveURL(/\/admin$/);
  const res = await page.request.get('/api/developers/skill');
  expect(res.status()).toBe(403);
  expect(res.headers()['content-type']).toContain('application/json');
});
