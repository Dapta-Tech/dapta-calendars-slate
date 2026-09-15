import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `resolveDocumentTheme` is where ADR 0004's central rule is enforced: the
 * host's product-theme cookie decides the PRODUCT's palette and must never
 * decide a booking page's. B2 grew it from a two-line branch into a path
 * matcher, a name-based exclusion and a network read, so the rule is pinned
 * here rather than left to inspection.
 *
 * The cookie assertions are the load-bearing ones. A failure in any of them is
 * the specific leak the ADR forbids and the one nobody would spot on screen —
 * the page simply looks like the host's own dashboard.
 */

const headerStore = { path: null as string | null, query: null as string | null };
const cookieStore = { theme: undefined as string | undefined };
const getProfile = vi.fn();

vi.mock('next/headers', () => ({
  headers: async () => ({
    get: (name: string) =>
      name === 'x-slate-path' ? headerStore.path : name === 'x-slate-query' ? headerStore.query : null,
  }),
  cookies: async () => ({
    get: (name: string) =>
      name === 'slate.theme' && cookieStore.theme !== undefined
        ? { value: cookieStore.theme }
        : undefined,
  }),
}));

vi.mock('@/lib/api', () => ({ getProfile: (...args: unknown[]) => getProfile(...args) }));

const { resolveDocumentTheme } = await import('./theme.server');

/** Resolve for one request. `theme` is what the page has STORED. */
function request(path: string | null, opts: { query?: string; cookie?: string; stored?: unknown } = {}) {
  headerStore.path = path;
  headerStore.query = opts.query ?? null;
  cookieStore.theme = opts.cookie;
  getProfile.mockResolvedValue(
    opts.stored === undefined ? null : { member: { style: opts.stored } },
  );
  return resolveDocumentTheme();
}

beforeEach(() => {
  getProfile.mockReset();
});

describe('resolveDocumentTheme — the product/public boundary (ADR 0004)', () => {
  it('answers a product route with the host cookie, and the product default without one', async () => {
    await expect(request('/admin/settings/booking-page', { cookie: 'light' })).resolves.toBe('light');
    await expect(request('/admin', { cookie: 'dark' })).resolves.toBe('dark');
    await expect(request('/admin')).resolves.toBe('dark');
    // A value that is not a theme is not a preference.
    await expect(request('/admin', { cookie: 'sepia' })).resolves.toBe('dark');
  });

  it('NEVER lets the cookie decide a public route, in either direction', async () => {
    // The leak the ADR forbids: a host on dark reaching a stored-light page.
    await expect(
      request('/acme/alex-rivera', { cookie: 'dark', stored: { theme: 'light' } }),
    ).resolves.toBe('light');
    // And the mirror: a host on light must not lighten a stored-dark page.
    await expect(
      request('/acme/alex-rivera/intro-call', { cookie: 'light', stored: { theme: 'dark' } }),
    ).resolves.toBe('dark');
    // A page with no stored axis answers the ADR default, never the cookie. The
    // default is `dark` since the 2026-09-11 amendment, so the cookie here is
    // `light` — with both on the same value this assertion would pass for the
    // wrong reason.
    await expect(request('/acme/alex-rivera', { cookie: 'light', stored: {} })).resolves.toBe('dark');
  });

  it('reads no cookie at all on the public branch', async () => {
    // Stated as its own law: the branches above could pass by coincidence if the
    // stored value happened to equal the cookie on every fixture.
    for (const cookie of ['dark', 'light', undefined]) {
      await expect(request('/acme/alex-rivera', { cookie, stored: { theme: 'dark' } })).resolves.toBe(
        'dark',
      );
    }
  });

  it('fails to the PUBLIC branch when the path header is missing', async () => {
    // The middleware covers every page request, so this should not happen. If it
    // does, the admin quietly ignoring the toggle is visible immediately; the
    // cookie reaching a booking page is not.
    await expect(request(null, { cookie: 'light' })).resolves.toBe('dark');
    expect(getProfile).not.toHaveBeenCalled();
  });
});

describe('resolveDocumentTheme — the embed override', () => {
  it('outranks the stored axis, both ways', async () => {
    await expect(
      request('/acme/alex-rivera', { query: '?embed=1&theme=dark', stored: { theme: 'light' } }),
    ).resolves.toBe('dark');
    await expect(
      request('/acme/alex-rivera', { query: '?embed=1&theme=light', stored: { theme: 'dark' } }),
    ).resolves.toBe('light');
  });

  it('is ignored without embed mode — a shared link cannot be restyled (#67)', async () => {
    await expect(
      request('/acme/alex-rivera', { query: '?theme=dark', stored: { theme: 'light' } }),
    ).resolves.toBe('light');
  });

  it('drops a value it does not recognise rather than raising', async () => {
    await expect(
      request('/acme/alex-rivera', { query: '?embed=1&theme=nonsense', stored: { theme: 'dark' } }),
    ).resolves.toBe('dark');
  });
});

describe('resolveDocumentTheme — which paths carry a stored theme', () => {
  it('reads the profile for the two personal routes, and only those', async () => {
    await expect(request('/acme/alex-rivera', { stored: { theme: 'dark' } })).resolves.toBe('dark');
    expect(getProfile).toHaveBeenCalledWith('acme', 'alex-rivera');

    getProfile.mockClear();
    await expect(request('/acme/alex-rivera/intro-call', { stored: { theme: 'dark' } })).resolves.toBe(
      'dark',
    );
    expect(getProfile).toHaveBeenCalledWith('acme', 'alex-rivera');
  });

  it('answers the default for the surfaces that store no branding, with no read at all', async () => {
    // `/manage/{uid}` is two segments and a team event is three, so both collide
    // with the personal shapes and are excluded by NAME. That is safe only
    // because `manage` and `team` are reserved slugs — pinned in
    // `packages/engine/src/short-links.spec.ts`, which names this file.
    for (const path of [
      '/manage/42c2a53c-6b57-4383-8a58-013216f4e137',
      '/acme/team/sales',
      '/acme/team/sales/team-demo',
    ]) {
      getProfile.mockClear();
      await expect(request(path, { cookie: 'light' })).resolves.toBe('dark');
      expect(getProfile, path).not.toHaveBeenCalled();
    }
  });

  it('does not turn a path segment into an API path it should not reach', async () => {
    // `getProfile` encodes with `encodeURIComponent`, which does not escape `.`,
    // so a segment decoding to `..` would walk out of `/v1/profiles/`.
    for (const path of ['/%2E%2E/alex-rivera', '/acme/%2E%2E', '/a%2Fb/alex-rivera']) {
      getProfile.mockClear();
      await expect(request(path)).resolves.toBe('dark');
      expect(getProfile, path).not.toHaveBeenCalled();
    }
  });

  it('survives an API that is down by answering the default, not by throwing', async () => {
    headerStore.path = '/acme/alex-rivera';
    headerStore.query = null;
    cookieStore.theme = 'light';
    getProfile.mockRejectedValue(new Error('API /v1/profiles/acme/alex-rivera failed: 500'));
    await expect(resolveDocumentTheme()).resolves.toBe('dark');
  });
});
