import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * The end of the hosted login. It lands on the dashboard page the login was
 * started for (the return-target cookie /api/auth/login parked), read through
 * `safeReturnTo` again, and spends the cookie whatever happens.
 */
const jarValues = new Map<string, string>();
const cookieJar = {
  get: vi.fn((name: string) => (jarValues.has(name) ? { value: jarValues.get(name)! } : undefined)),
  set: vi.fn(),
  delete: vi.fn((name: string) => jarValues.delete(name)),
};
vi.mock('next/headers', () => ({ cookies: vi.fn(async () => cookieJar) }));
const setSession = vi.fn();
vi.mock('@/lib/auth-session', () => ({
  setSession: (...a: unknown[]) => setSession(...a),
  workosSessionIdFromJwt: () => 'session_1',
}));

import { GET } from './route';

const ORIGIN = 'https://calendars.example.com';
const PAGE = '/admin/bookings/6f1c2a9e-1b7d-4c55-9a0e-3d2f8b7c4e10';
const blob = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64');
const callback = (session: string | null = blob({ access_token: 'jwt', refresh_token: 'r' })) =>
  new NextRequest(`${ORIGIN}/api/auth/callback${session ? `?session=${encodeURIComponent(session)}` : ''}`);

describe('GET /api/auth/callback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    jarValues.clear();
    jarValues.set('slate_oauth_state', 'state-1');
  });

  it('lands on the page the login was started for, and spends the cookie', async () => {
    jarValues.set('slate_return_to', PAGE);

    const res = await GET(callback());

    expect(setSession).toHaveBeenCalled();
    expect(res.headers.get('location')).toBe(`${ORIGIN}${PAGE}`);
    expect(cookieJar.delete).toHaveBeenCalledWith('slate_return_to');
  });

  it('lands on /admin when the login was started without one', async () => {
    const res = await GET(callback());

    expect(res.headers.get('location')).toBe(`${ORIGIN}/admin`);
  });

  it.each(['//evil.example', 'https://evil.example/admin', '/\\evil.example', '/%2F%2Fevil.example', '/login'])(
    'never follows a cookie that is not a dashboard page (%s)',
    async (target) => {
      jarValues.set('slate_return_to', target);

      const res = await GET(callback());

      expect(res.headers.get('location')).toBe(`${ORIGIN}/admin`);
      expect(cookieJar.delete).toHaveBeenCalledWith('slate_return_to');
    },
  );

  it('a failed callback hands the page to the error card, so its retry keeps it', async () => {
    jarValues.set('slate_return_to', PAGE);

    const res = await GET(callback(null));

    expect(setSession).not.toHaveBeenCalled();
    expect(res.headers.get('location')).toBe(`${ORIGIN}/login?error=callback&next=${encodeURIComponent(PAGE)}`);
    expect(cookieJar.delete).toHaveBeenCalledWith('slate_return_to');
  });

  it('a login that did not start here keeps the target for the retry, and signs nobody in', async () => {
    jarValues.delete('slate_oauth_state');
    jarValues.set('slate_return_to', PAGE);

    const res = await GET(callback());

    expect(setSession).not.toHaveBeenCalled();
    expect(res.headers.get('location')).toBe(`${ORIGIN}/login?error=state&next=${encodeURIComponent(PAGE)}`);
  });
});
