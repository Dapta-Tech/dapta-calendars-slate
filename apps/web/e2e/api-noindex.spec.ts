import { expect, test } from '@playwright/test';
import { E2E, HOST } from './stack';

/**
 * A deployment marked NOINDEX (lib/indexing.ts): the same build as the rest of
 * the suite, started again with the switch on (playwright.config.ts). Every
 * response carries `X-Robots-Tag`, every page `<meta name="robots">`, and
 * `robots.txt` closes the whole site. Only the production build can be started
 * twice, so this runs on CI or under `CI=1` locally.
 */
test.skip(!process.env.CI, 'needs the second, NOINDEX server of the production build (CI, or CI=1 locally)');

const EVENT = `/${HOST.accountCode}/${HOST.handle}/${HOST.slug}`;

test('every response says noindex', async ({ request }) => {
  for (const path of [EVENT, '/acme/jordan-lee', '/login', '/robots.txt', '/acme/nobody']) {
    const res = await request.get(`${E2E.noindexWeb}${path}`, { maxRedirects: 0 });
    expect(res.headers()['x-robots-tag'], path).toBe('noindex, nofollow');
  }
});

test('every page carries the robots meta tag', async ({ request }) => {
  const html = await (await request.get(`${E2E.noindexWeb}${EVENT}`)).text();
  expect(html).toMatch(/<meta name="robots" content="noindex, nofollow"/);
});

test('robots.txt disallows everything', async ({ request }) => {
  const res = await request.get(`${E2E.noindexWeb}/robots.txt`);
  expect(res.status()).toBe(200);
  const body = await res.text();
  expect(body).toMatch(/^User-Agent: \*$/m);
  expect(body).toMatch(/^Disallow: \/$/m);
  expect(body).not.toMatch(/^Allow:/m);
});
