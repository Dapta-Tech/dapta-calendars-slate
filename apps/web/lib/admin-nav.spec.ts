import { describe, expect, it } from 'vitest';
import { getMessages, isNavItemActive } from '@slate/shared';
import {
  adminNav,
  DEVELOPER_PAGES,
  DEVELOPERS_CONNECT_HREF,
  DEVELOPERS_DOCS_HREF,
  DEVELOPERS_HREF,
  DEVELOPERS_KEYS_HREF,
  DEVELOPERS_TOOLS_HREF,
  DEVELOPERS_WEBHOOKS_HREF,
  platformNavHref,
} from './admin-nav';

/**
 * Who gets which rail item, in what order, and where each one goes. The shell
 * only draws this list, so the rules live (and are proven) here.
 */
const DOCS = 'https://docs.example.test/?utm_source=calendars&utm_medium=sidebar';
const keys = (items: ReturnType<typeof adminNav>) => items.map((i) => i.key);

describe('adminNav', () => {
  it('gives an owner or admin the product pages, then Connect your agent, Tools and API and webhooks, then Docs, last', () => {
    expect(keys(adminNav({ isAdmin: true, docsHref: DOCS }))).toEqual([
      'home',
      'bookings',
      'availability',
      'eventTypes',
      'teams',
      'calendars',
      'settings',
      'connect',
      'tools',
      'api',
      'docs',
    ]);
  });

  it('never gives a plain member the agent items, which would only lead to "no access" or a sign-in that fails', () => {
    const items = adminNav({ isAdmin: false, docsHref: DOCS });
    for (const key of ['connect', 'tools', 'api'] as const) expect(keys(items)).not.toContain(key);
    // Docs is for everyone: reading the manual needs no role.
    expect(keys(items).at(-1)).toBe('docs');
  });

  it('ends with the Dapta Agents door, external, only when the deployment has a platform', () => {
    const PLATFORM = 'https://platform.example.test/?utm_source=calendars&utm_medium=sidebar';
    const items = adminNav({ isAdmin: false, docsHref: DOCS, platformHref: PLATFORM });
    expect(keys(items).slice(-2)).toEqual(['docs', 'agents']);
    expect(items.at(-1)).toMatchObject({ href: PLATFORM, external: true, icon: 'agents' });
    expect(keys(adminNav({ isAdmin: true, docsHref: DOCS }))).not.toContain('agents');
    expect(keys(adminNav({ isAdmin: true, docsHref: DOCS, platformHref: null }))).not.toContain('agents');
  });

  it('has no Docs item when the deployment configures no docs (a fork, by default)', () => {
    expect(keys(adminNav({ isAdmin: true, docsHref: null }))).not.toContain('docs');
    expect(keys(adminNav({ isAdmin: false, docsHref: null }))).not.toContain('docs');
  });

  it('makes Docs an external item pointing at exactly the URL it was given', () => {
    const docs = adminNav({ isAdmin: false, docsHref: DOCS }).find((i) => i.key === 'docs');
    expect(docs).toMatchObject({ href: DOCS, external: true, icon: 'book' });
  });

  it('makes Connect your agent the prominent item, with the rotating logos, and Tools a plain one', () => {
    const items = adminNav({ isAdmin: true, docsHref: null });
    expect(items.find((i) => i.key === 'connect')).toEqual({
      key: 'connect',
      href: DEVELOPERS_CONNECT_HREF,
      icon: 'mcp',
      prominent: true,
    });
    expect(items.find((i) => i.key === 'tools')).toEqual({ key: 'tools', href: DEVELOPERS_TOOLS_HREF, icon: 'tools' });
    expect(items.filter((i) => i.prominent).map((i) => i.key)).toEqual(['connect']);
  });

  it('makes API and webhooks a quiet group of the keys, webhooks and API docs pages', () => {
    const api = adminNav({ isAdmin: true, docsHref: null }).find((i) => i.key === 'api');
    expect(api).toMatchObject({ href: DEVELOPERS_HREF, icon: 'api' });
    expect(api?.prominent).toBeUndefined();
    expect(api?.external).toBeUndefined();
    expect(api?.children?.map((p) => [p.key, p.href])).toEqual([
      ['keys', DEVELOPERS_KEYS_HREF],
      ['webhooks', DEVELOPERS_WEBHOOKS_HREF],
      ['docs', DEVELOPERS_DOCS_HREF],
    ]);
  });

  it('marks the group active on its own pages only, never on the connect guide or Tools beside them', () => {
    const api = adminNav({ isAdmin: true, docsHref: null }).find((i) => i.key === 'api')!;
    for (const page of DEVELOPER_PAGES) {
      expect(isNavItemActive(page.href, api.href, api.match)).toBe(true);
      expect(isNavItemActive(`${page.href}/anything`, api.href, api.match)).toBe(true);
    }
    for (const path of [DEVELOPERS_CONNECT_HREF, DEVELOPERS_TOOLS_HREF, '/admin/settings/general']) {
      expect(isNavItemActive(path, api.href, api.match)).toBe(false);
    }
    expect(isNavItemActive(DEVELOPERS_CONNECT_HREF, DEVELOPERS_CONNECT_HREF)).toBe(true);
    expect(isNavItemActive(DEVELOPERS_KEYS_HREF, DEVELOPERS_CONNECT_HREF)).toBe(false);
  });

  it('has a label for every item and page in both languages', () => {
    for (const locale of ['en', 'es'] as const) {
      const admin = getMessages(locale).admin;
      for (const item of adminNav({ isAdmin: true, docsHref: DOCS })) expect(admin.nav[item.key]).toBeTruthy();
      for (const page of DEVELOPER_PAGES) expect(admin.developerNav[page.key]).toBeTruthy();
    }
  });
});

describe('platformNavHref', () => {
  it('tags the platform address as a click from the sidebar', () => {
    const url = new URL(platformNavHref('https://platform.example.test/app')!);
    expect(url.origin + url.pathname).toBe('https://platform.example.test/app');
    expect(url.searchParams.get('utm_source')).toBe('calendars');
    expect(url.searchParams.get('utm_medium')).toBe('sidebar');
  });

  it('is null with no platform, or one that is not an http(s) URL', () => {
    for (const v of [undefined, '', '   ', 'platform.example.test', 'javascript:alert(1)']) {
      expect(platformNavHref(v)).toBeNull();
    }
  });
});

describe('the redirects to the connect guide', () => {
  it('answers the old Settings address and the bare /admin/developers with the connect guide, before any render', async () => {
    const config = (await import('../next.config.mjs')).default;
    const redirects = await config.redirects?.();
    expect(redirects).toEqual(
      expect.arrayContaining([
        { source: '/admin/settings/developer', destination: DEVELOPERS_CONNECT_HREF, permanent: false },
        { source: DEVELOPERS_HREF, destination: DEVELOPERS_CONNECT_HREF, permanent: false },
      ]),
    );
  });

  it('leaves the keys, webhooks, API docs and Tools addresses alone: they are pages', async () => {
    const config = (await import('../next.config.mjs')).default;
    const sources = ((await config.redirects?.()) ?? []).map((r: { source: string }) => r.source);
    for (const page of [...DEVELOPER_PAGES.map((p) => p.href), DEVELOPERS_TOOLS_HREF, DEVELOPERS_CONNECT_HREF]) {
      expect(sources).not.toContain(page);
    }
  });
});
