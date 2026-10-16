import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A session found dead in the middle of a dashboard page keeps that page as the
 * login's return target, so a host who opened a booking from an email gets
 * back to it. The page comes from the headers the middleware stamps on every
 * request; only a dashboard page is ever carried.
 */
const cookieJar = { get: vi.fn(), set: vi.fn(), delete: vi.fn() };
const headerBag = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => cookieJar),
  headers: vi.fn(async () => ({ get: (name: string) => headerBag.get(name) ?? null })),
}));
const redirect = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});
vi.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url) }));

import { currentReturnTo, encodeSession, hostFetch, signOutAndRedirect, type Session } from './auth-session';
import { PATH_HEADER, QUERY_HEADER } from './theme';

const PAGE = '/admin/bookings/6f1c2a9e-1b7d-4c55-9a0e-3d2f8b7c4e10';
const NEXT = `next=${encodeURIComponent(PAGE)}`;

const workosSession: Session = {
  provider: 'workos',
  accessToken: 'tok',
  refreshToken: 'refresh-1',
  sessionId: 'session_OLD',
};

const onPage = (path: string, query = '') => {
  headerBag.set(PATH_HEADER, path);
  headerBag.set(QUERY_HEADER, query);
};
const withSession = (s: Session) =>
  cookieJar.get.mockImplementation((name: string) =>
    name === 'slate_session' ? { value: encodeSession(s) } : undefined,
  );

describe('the page a dead session was found on travels with the sign-in', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    // A render's throwing `set` must not leak into the next test.
    cookieJar.set.mockReset();
    headerBag.clear();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('IAM_BASE_URL', 'https://iam.example.com/iam');
    vi.stubEnv('AUTH_PROVIDER', 'workos');
    vi.stubEnv('WEB_SESSION_SECRET', 'spec-secret');
    withSession(workosSession);
    onPage(PAGE);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('reads the page and its query off the middleware headers, minus the flight param', async () => {
    onPage('/admin/bookings', '?status=pending&_rsc=abc');
    expect(await currentReturnTo()).toBe('/admin/bookings?status=pending');
  });

  it('a render hands the refresh route the page, so a refreshed session lands back on it', async () => {
    cookieJar.set.mockImplementation(() => {
      throw new Error('Cookies can only be modified in a Server Action or Route Handler');
    });
    fetchMock.mockResolvedValue({ status: 401 });

    await expect(hostFetch('/v1/me')).rejects.toThrow(`NEXT_REDIRECT:/api/auth/refresh?${NEXT}`);
  });

  it('a dead refresh token signs out to the login with the page as its target', async () => {
    fetchMock
      .mockResolvedValueOnce({ status: 401 }) // the API call
      .mockResolvedValueOnce({ ok: false, status: 401 }) // the refresh: dead
      .mockResolvedValue({ ok: true, json: async () => ({}) }); // the revoke

    await expect(hostFetch('/v1/me')).rejects.toThrow(`NEXT_REDIRECT:/login?signedout=1&${NEXT}`);
  });

  it('the local provider lands on the login form with the page as its target', async () => {
    vi.stubEnv('AUTH_PROVIDER', 'local');
    withSession({ provider: 'local', email: 'a@b.c' });
    fetchMock.mockResolvedValue({ status: 401 });

    await expect(hostFetch('/v1/me')).rejects.toThrow(`NEXT_REDIRECT:/login?${NEXT}`);
  });

  it.each(['//evil.example', '/api/auth/logout', '/acme/alex-rivera/intro-call', '/\\evil.example'])(
    'carries nothing when the page is not a dashboard page (%s)',
    async (path) => {
      vi.stubEnv('AUTH_PROVIDER', 'local');
      withSession({ provider: 'local', email: 'a@b.c' });
      onPage(path);
      fetchMock.mockResolvedValue({ status: 401 });

      await expect(hostFetch('/v1/me')).rejects.toThrow(/^NEXT_REDIRECT:\/login$/);
    },
  );

  it('the sign-out button carries no target: leaving is not a place to return to', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    await expect(signOutAndRedirect(workosSession)).rejects.toThrow(/^NEXT_REDIRECT:\/login\?signedout=1$/);
  });
});
