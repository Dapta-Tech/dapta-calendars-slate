import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const cookieJar = { get: vi.fn(), set: vi.fn(), delete: vi.fn() };
vi.mock('next/headers', () => ({ cookies: vi.fn(async () => cookieJar) }));
vi.mock('@/lib/auth-session', () => ({ authProvider: () => 'workos' }));

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
