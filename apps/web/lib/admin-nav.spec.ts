import { describe, expect, it } from 'vitest';
import { getMessages, isNavItemActive } from '@slate/shared';
import {
  adminNav,
  DEVELOPER_PAGES,
  DEVELOPERS_DOCS_HREF,
  DEVELOPERS_HREF,
  DEVELOPERS_KEYS_HREF,
  DEVELOPERS_WEBHOOKS_HREF,
} from './admin-nav';

/**
 * Who gets which rail item, in what order, and where each one goes. The shell
 * only draws this list, so the rules live (and are proven) here.
 */
const DOCS = 'https://docs.example.test/?utm_source=calendars&utm_medium=sidebar';
const keys = (items: ReturnType<typeof adminNav>) => items.map((i) => i.key);

describe('adminNav', () => {
  it('gives an owner or admin the product pages, then MCP, then Docs, last', () => {
    expect(keys(adminNav({ isAdmin: true, docsHref: DOCS }))).toEqual([
      'home',
      'bookings',
      'availability',
      'eventTypes',
      'teams',
      'calendars',
      'settings',
      'developers',
      'docs',
    ]);
  });

  it('never gives a plain member the MCP item, which would only lead to "no access"', () => {
    const items = adminNav({ isAdmin: false, docsHref: DOCS });
    expect(keys(items)).not.toContain('developers');
    // Docs is for everyone: reading the manual needs no role.
    expect(keys(items).at(-1)).toBe('docs');
  });

  it('has no Docs item when the deployment configures no docs (a fork, by default)', () => {
    expect(keys(adminNav({ isAdmin: true, docsHref: null }))).not.toContain('docs');
    expect(keys(adminNav({ isAdmin: false, docsHref: null }))).not.toContain('docs');
  });

  it('makes Docs an external item pointing at exactly the URL it was given', () => {
    const docs = adminNav({ isAdmin: false, docsHref: DOCS }).find((i) => i.key === 'docs');
    expect(docs).toMatchObject({ href: DOCS, external: true, icon: 'book' });
  });

  it('makes MCP a group of three pages under /admin/developers, with the rotating logos', () => {
    const mcp = adminNav({ isAdmin: true, docsHref: null }).find((i) => i.key === 'developers');
    expect(mcp).toMatchObject({ href: DEVELOPERS_HREF, icon: 'mcp' });
    expect(mcp?.external).toBeUndefined();
    expect(mcp?.children?.map((p) => [p.key, p.href])).toEqual([
      ['keys', DEVELOPERS_KEYS_HREF],
      ['webhooks', DEVELOPERS_WEBHOOKS_HREF],
      ['docs', DEVELOPERS_DOCS_HREF],
    ]);
  });

  it('marks the group active on every one of its pages, and on nothing outside it', () => {
    for (const page of DEVELOPER_PAGES) {
      expect(page.href.startsWith(`${DEVELOPERS_HREF}/`)).toBe(true);
      expect(isNavItemActive(page.href, DEVELOPERS_HREF)).toBe(true);
    }
    expect(isNavItemActive('/admin/settings/general', DEVELOPERS_HREF)).toBe(false);
  });

  it('has a label for every item and page in both languages', () => {
    for (const locale of ['en', 'es'] as const) {
      const admin = getMessages(locale).admin;
      for (const item of adminNav({ isAdmin: true, docsHref: DOCS })) expect(admin.nav[item.key]).toBeTruthy();
      for (const page of DEVELOPER_PAGES) expect(admin.developerNav[page.key]).toBeTruthy();
    }
  });
});

describe('the redirects into the MCP group', () => {
  it('answers the old Settings address and the bare group address with the keys page, before any render', async () => {
    const config = (await import('../next.config.mjs')).default;
    const redirects = await config.redirects?.();
    expect(redirects).toEqual(
      expect.arrayContaining([
        { source: '/admin/settings/developer', destination: DEVELOPERS_KEYS_HREF, permanent: false },
        { source: DEVELOPERS_HREF, destination: DEVELOPERS_KEYS_HREF, permanent: false },
      ]),
    );
  });
});
