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
  const returnCookie = () => cookieJar.set.mock.calls.find((c) => c[0] === 'slate_return_to');

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
      expect(cookieJar.delete).toHaveBeenCalledWith('slate_return_to');
    },
  );

  it('a login started without one clears what an abandoned login left behind', async () => {
    await GET(req('/api/auth/login'));

    expect(returnCookie()).toBeUndefined();
    expect(cookieJar.delete).toHaveBeenCalledWith('slate_return_to');
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
