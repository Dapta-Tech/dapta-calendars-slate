import { expect, test, type APIRequestContext } from '@playwright/test';
import { E2E, HOST } from './stack';

/**
 * What the public surface says to a search engine or a link unfurler, read as
 * one: the status a link answers, the language its document declares, its
 * title, and `robots.txt`. Read as raw HTTP on purpose, because a crawler sees
 * the response, not the page a browser finishes building from it.
 */
const EVENT = `/${HOST.accountCode}/${HOST.handle}/${HOST.slug}`;

async function page(request: APIRequestContext, path: string, headers: Record<string, string> = {}) {
  const res = await request.get(`${E2E.web}${path}`, { headers, maxRedirects: 0 });
  return { status: res.status(), headers: res.headers(), html: await res.text() };
}

const langOf = (html: string) => /<html[^>]*\slang="([^"]+)"/.exec(html)?.[1];
const titleOf = (html: string) => /<title>([^<]*)<\/title>/.exec(html)?.[1];

test.describe('status codes', () => {
  for (const path of [EVENT, '/acme/jordan-lee', '/acme/team/sales']) {
    test(`a real page answers 200: ${path}`, async ({ request }) => {
      expect((await page(request, path)).status).toBe(200);
    });
  }

  test('a host with one event is sent to it by a real redirect, query kept', async ({ request }) => {
    const res = await page(request, `/${HOST.accountCode}/${HOST.handle}?utm_source=qa`);
    expect(res.status).toBe(307);
    expect(res.headers.location).toBe(`${EVENT}?utm_source=qa`);
  });

  for (const path of [
    '/acme/nobody',
    '/acme/nobody/intro-call',
    `/${HOST.accountCode}/${HOST.handle}/no-such-event`,
    '/zzzzzz/nobody',
    '/acme/team/no-such-team',
    '/acme/team/sales/no-such-event',
    // A guessed invite token reads exactly like any other dead link.
    '/booking/not-a-real-token',
  ]) {
    test(`a link that leads nowhere answers a real 404, noindex: ${path}`, async ({ request }) => {
      const res = await page(request, path);
      expect(res.status).toBe(404);
      expect(res.html).toMatch(/<meta name="robots" content="noindex"/);
      // The site's own title, never a guess at a host or event that is not there.
      expect(titleOf(res.html)).toBe('Calendars: calendars for AI agents');
    });
  }

  // The 404 body itself is drawn by the browser (Next renders a 404 decided
  // during render that way), so what it says is checked in language.spec.ts.
  test("the 404 head speaks the visitor's language", async ({ request }) => {
    const res = await page(request, '/acme/nobody?lang=es');
    expect(res.status).toBe(404);
    expect(titleOf(res.html)).toBe('Calendars: calendarios para agentes de IA');
  });
});

test.describe('<html lang>', () => {
  test('is the language the booking page renders in', async ({ request }) => {
    expect(langOf((await page(request, EVENT, { 'accept-language': 'en-US' })).html)).toBe('en');
    // A Spanish browser alone does not switch the language: English is the default.
    expect(langOf((await page(request, EVENT, { 'accept-language': 'es-CO,es;q=0.9' })).html)).toBe('en');
    expect(langOf((await page(request, `${EVENT}?lang=es`, { 'accept-language': 'en-US' })).html)).toBe('es');
    expect(langOf((await page(request, '/acme/team/sales?lang=es')).html)).toBe('es');
  });
});

test.describe('titles', () => {
  test('an event page names its host once, in the page language', async ({ request }) => {
    expect(titleOf((await page(request, EVENT, { 'accept-language': 'en-US' })).html)).toBe(
      'Intro Call with Alex Rivera',
    );
    expect(titleOf((await page(request, `${EVENT}?lang=es`)).html)).toBe(
      'Intro Call con Alex Rivera',
    );
  });

  test('a team event page goes through the same rule, no em dash', async ({ request }) => {
    expect(titleOf((await page(request, '/acme/team/sales/team-demo', { 'accept-language': 'en-US' })).html)).toBe(
      'Team Demo with Sales',
    );
  });

  test('the sign-in page title is plain product copy, no em dash', async ({ request }) => {
    const title = titleOf((await page(request, '/login')).html) ?? '';
    expect(title).toMatch(/^Sign in · /);
    expect(title).not.toMatch(/[\u2014\u2013]/);
  });
});

test.describe('robots', () => {
  test('robots.txt keeps the product out and the booking pages open', async ({ request }) => {
    const res = await request.get(`${E2E.web}/robots.txt`);
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/^User-Agent: \*$/m);
    expect(body).toMatch(/^Allow: \/$/m);
    for (const rule of ['/admin$', '/admin/', '/login$', '/login?', '/onboarding$', '/api/']) {
      expect(body).toContain(`Disallow: ${rule}\n`);
    }
    expect(body).not.toMatch(/^Disallow: \/$/m);
  });

  test('an indexable deployment sends no X-Robots-Tag', async ({ request }) => {
    for (const path of [EVENT, '/robots.txt']) {
      expect((await page(request, path)).headers['x-robots-tag'], path).toBeUndefined();
    }
  });
});
