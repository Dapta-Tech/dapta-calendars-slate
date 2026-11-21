import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const cookieJar = { get: vi.fn(), set: vi.fn(), delete: vi.fn() };
vi.mock('next/headers', () => ({ cookies: vi.fn(async () => cookieJar) }));
const provider = vi.fn(() => 'workos');
vi.mock('@/lib/auth-session', () => ({ authProvider: () => provider() }));

import { GET } from './route';

const AUTHORIZE = 'https://idp.example.com/user_management/authorize?client_id=client_1&state=abc';

const req = (path: string) => new NextRequest(`https://calendars.example.com${path}`);

describe('GET /api/auth/login prompt handling', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('IAM_BASE_URL', 'https://iam.example.com/iam');
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ loginUrl: AUTHORIZE }) });
    cookieJar.get.mockReturnValue(undefined);
    provider.mockReturnValue('workos');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('patches prompt=login onto the authorize URL — the IAM drops the param', async () => {
    const res = await GET(req('/api/auth/login?prompt=login'));

    const target = new URL(res.headers.get('location')!);
    expect(target.origin + target.pathname).toBe('https://idp.example.com/user_management/authorize');
    expect(target.searchParams.get('prompt')).toBe('login');
    // Forwarded to the IAM too, so nothing changes here the day it propagates it.
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('prompt=login');
  });

  it('sends no prompt on the bare auto-redirect — the silent SSO stays', async () => {
    const res = await GET(req('/api/auth/login'));

    expect(new URL(res.headers.get('location')!).searchParams.get('prompt')).toBeNull();
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('prompt');
  });

  it('ignores any prompt value that is not exactly login', async () => {
    const res = await GET(req('/api/auth/login?prompt=evil%20login'));

    expect(new URL(res.headers.get('location')!).searchParams.get('prompt')).toBeNull();
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('prompt');
  });

  // `NextResponse.redirect` throws on a malformed URL, so an unparseable answer
  // from the identity service would otherwise be an unhandled 500 on the login
  // path. Both branches land on the error card, not just the patched one.
  it.each(['/api/auth/login?prompt=login', '/api/auth/login'])(
    'lands on the error card rather than throwing when the login URL is unparseable (%s)',
    async (path) => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ loginUrl: 'not a url' }) });

      const res = await GET(req(path));

      expect(res.headers.get('location')).toBe('https://calendars.example.com/login?error=login');
    },
  );
});

describe('GET /api/auth/login keeps the page the sign-in returns to', () => {
  const fetchMock = vi.fn();
  const PAGE = '/admin/bookings/6f1c2a9e-1b7d-4c55-9a0e-3d2f8b7c4e10';
  const withNext = (v: string, extra = '') => `/api/auth/login?${extra}next=${encodeURIComponent(v)}`;
  // A parked target, not the expired write that removes a stale one.
  const returnCookie = () => cookieJar.set.mock.calls.find((c) => c[0] === 'slate_return_to' && c[1] !== '');

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('IAM_BASE_URL', 'https://iam.example.com/iam');
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ loginUrl: AUTHORIZE }) });
    provider.mockReturnValue('workos');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('parks it in a short-lived httpOnly cookie, and never on the identity service URL', async () => {
    await GET(req(withNext(PAGE, 'prompt=login&')));

    expect(returnCookie()?.[1]).toBe(PAGE);
    expect(returnCookie()?.[2]).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/', maxAge: 600 });
    // The identity service still returns to the one callback it always did.
    const iamCall = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(iamCall.searchParams.get('returnTo')).toBe('https://calendars.example.com/api/auth/callback');
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('bookings');
  });

  it.each(['//evil.example', 'https://evil.example', '/\\evil.example', '/%2F%2Fevil.example', '/api/auth/logout'])(
    'parks nothing for a target that is not a dashboard page (%s), and clears a stale one',
    async (target) => {
      await GET(req(withNext(target)));

      expect(returnCookie()).toBeUndefined();
      expect(cookieJar.set).toHaveBeenCalledWith('slate_return_to', '', expect.objectContaining({ maxAge: 0 }));
    },
  );

  it('a login started without one clears what an abandoned login left behind', async () => {
    await GET(req('/api/auth/login'));

    expect(returnCookie()).toBeUndefined();
    expect(cookieJar.set).toHaveBeenCalledWith('slate_return_to', '', expect.objectContaining({ maxAge: 0 }));
  });

  it('the error card keeps it, so its retry returns to the page too', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({}) });

    const res = await GET(req(withNext(PAGE)));

    expect(res.headers.get('location')).toBe(
      `https://calendars.example.com/login?error=login&next=${encodeURIComponent(PAGE)}`,
    );
  });

  it('the local provider hands it to the login form', async () => {
    provider.mockReturnValue('local');

    const res = await GET(req(withNext(PAGE)));

    expect(res.headers.get('location')).toBe(
      `https://calendars.example.com/login?next=${encodeURIComponent(PAGE)}`,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * `?screen=sign-up` (lib/login-screen.ts): a landing's "create an account"
 * call to action, passed on by the root page, asks the identity service for
 * its sign-up screen. The identity service call is asserted as a whole string,
 * so "without the flag" means byte for byte the request this route has always
 * sent, and "with it" means that same request plus one trailing parameter.
 */
describe('GET /api/auth/login sign-up screen', () => {
  const fetchMock = vi.fn();
  const PAGE = '/admin/bookings/6f1c2a9e-1b7d-4c55-9a0e-3d2f8b7c4e10';
  const iamCall = () => String(fetchMock.mock.calls[0]?.[0]);
  const stateCookie = () => cookieJar.set.mock.calls.find((c) => c[0] === 'slate_oauth_state');
  /** The identity service request this route sent before the flag existed, plus `extra`. */
  const iamUrl = (origin: string, extra = '') =>
    'https://iam.example.com/iam/auth/login-url' +
    `?returnTo=${encodeURIComponent(`${origin}/api/auth/callback`)}` +
    `&state=${encodeURIComponent(String(stateCookie()?.[1]))}` +
    extra;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('IAM_BASE_URL', 'https://iam.example.com/iam');
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ loginUrl: AUTHORIZE }) });
    cookieJar.get.mockReturnValue(undefined);
    provider.mockReturnValue('workos');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('asks the identity service for the sign-up screen', async () => {
    const res = await GET(req('/api/auth/login?screen=sign-up'));

    expect(iamCall()).toBe(iamUrl('https://calendars.example.com', '&screenHint=sign-up'));
    // The identity service puts the hint on the authorize URL itself, so its
    // answer is followed untouched.
    expect(res.headers.get('location')).toBe(AUTHORIZE);
  });

  it('sends exactly the request it always sent without it', async () => {
    const res = await GET(req('/api/auth/login'));

    expect(iamCall()).toBe(iamUrl('https://calendars.example.com'));
    expect(res.headers.get('location')).toBe(AUTHORIZE);
  });

  it.each([
    'screen=signup',
    'screen=Sign-Up',
    'screen=sign-in',
    'screen=',
    'screen',
    'screen=sign-up%20',
    'screen=%20sign-up',
    // The decoded value is `sign-up&prompt=none`: never spliced onto the request.
    'screen=sign-up%26prompt%3Dnone',
    // A repeated parameter is not a choice, in either order, as on the root page.
    'screen=evil&screen=sign-up',
    'screen=sign-up&screen=evil',
    'screen=sign-up&screen=sign-up',
    // The identity service's own names are not this route's parameter.
    'screenHint=sign-up',
    'screen_hint=sign-up',
  ])('ignores anything but exactly screen=sign-up (%s)', async (query) => {
    const res = await GET(req(`/api/auth/login?${query}`));

    expect(iamCall()).toBe(iamUrl('https://calendars.example.com'));
    expect(res.headers.get('location')).toBe(AUTHORIZE);
  });

  it('keeps prompt=login and the return target beside it', async () => {
    const res = await GET(req(`/api/auth/login?screen=sign-up&prompt=login&next=${encodeURIComponent(PAGE)}`));

    expect(iamCall()).toBe(iamUrl('https://calendars.example.com', '&prompt=login&screenHint=sign-up'));
    expect(new URL(res.headers.get('location')!).searchParams.get('prompt')).toBe('login');
    expect(cookieJar.set).toHaveBeenCalledWith('slate_return_to', PAGE, expect.objectContaining({ maxAge: 600 }));
  });

  it.each([
    ['with it', '?screen=sign-up', '&screenHint=sign-up'],
    ['without it', '', ''],
  ])('returns to the public origin behind the proxy, %s', async (_label, query, extra) => {
    // Behind the load balancer `req.url` is the bind address; the callback is
    // built from the forwarded headers, as it always was.
    const proxied = new NextRequest(`https://0.0.0.0:3000/api/auth/login${query}`, {
      headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'app.example.org, internal.example' },
    });

    await GET(proxied);

    expect(iamCall()).toBe(iamUrl('https://app.example.org', extra));
  });

  it('parks the same state cookie, the login-CSRF guard the callback checks', async () => {
    await GET(req('/api/auth/login?screen=sign-up'));

    expect(stateCookie()?.[1]).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(stateCookie()?.[2]).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/', maxAge: 600 });
  });

  it('lands on the same error card when the identity service fails', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({}) });

    const res = await GET(req('/api/auth/login?screen=sign-up'));

    expect(res.headers.get('location')).toBe('https://calendars.example.com/login?error=login');
  });

  it('the local provider has no hosted screen to pick: the login form, as before', async () => {
    provider.mockReturnValue('local');

    const res = await GET(req('/api/auth/login?screen=sign-up'));

    expect(res.headers.get('location')).toBe('https://calendars.example.com/login');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
