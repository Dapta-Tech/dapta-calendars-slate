import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getSession = vi.fn();
const setSession = vi.fn();
const refreshUpstreamSession = vi.fn();
vi.mock('@/lib/auth-session', async () => {
  // accessTokenExpired is pure; the real one runs so these tests exercise the
  // actual loop ceiling rather than a mirror of it.
  const actual = await vi.importActual<typeof import('@/lib/auth-session')>('@/lib/auth-session');
  return {
    accessTokenExpired: actual.accessTokenExpired,
    getSession: (...a: unknown[]) => getSession(...a),
    setSession: (...a: unknown[]) => setSession(...a),
    refreshUpstreamSession: (...a: unknown[]) => refreshUpstreamSession(...a),
  };
});

import { GET } from './route';

const req = (path = '/api/auth/refresh') => new NextRequest(`https://calendars.example.com${path}`);
const LOGOUT = 'https://calendars.example.com/api/auth/logout?reason=expired';

const b64u = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
const token = (expOffsetSec: number) =>
  `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ exp: Math.floor(Date.now() / 1000) + expOffsetSec })}.sig`;

const staleSession = { provider: 'workos', accessToken: token(-30), refreshToken: 'refresh-1' };
const freshSession = { provider: 'workos', accessToken: token(3600), refreshToken: 'refresh-2' };

describe('GET /api/auth/refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSession.mockResolvedValue(staleSession);
  });

  it('stores the refreshed session and returns to /admin', async () => {
    refreshUpstreamSession.mockResolvedValue(freshSession);

    const res = await GET(req());

    expect(refreshUpstreamSession).toHaveBeenCalledWith(staleSession);
    expect(setSession).toHaveBeenCalledWith(freshSession);
    expect(res.headers.get('location')).toBe('https://calendars.example.com/admin');
  });

  it('hands off to the logout route when the refresh fails, without touching the cookie', async () => {
    refreshUpstreamSession.mockResolvedValue(null);

    const res = await GET(req());

    expect(setSession).not.toHaveBeenCalled();
    expect(res.headers.get('location')).toBe(LOGOUT);
  });

  it('hands off to the logout route when there is no session at all', async () => {
    getSession.mockResolvedValue(null);
    refreshUpstreamSession.mockResolvedValue(null);

    const res = await GET(req());

    expect(res.headers.get('location')).toBe(LOGOUT);
  });

  // The ceiling. This route is reached by a browser redirect and remembers
  // nothing between arrivals, so a 401 the refresh cannot fix — a claim the API
  // will not resolve, a mismatched secret — would otherwise run
  // /admin -> here -> /admin forever, spending a rotation per lap.
  it('signs out instead of refreshing when the token has NOT expired', async () => {
    getSession.mockResolvedValue({ ...staleSession, accessToken: token(3600) });

    const res = await GET(req());

    expect(refreshUpstreamSession).not.toHaveBeenCalled();
    expect(setSession).not.toHaveBeenCalled();
    expect(res.headers.get('location')).toBe(LOGOUT);
  });

  it('signs out when the IAM hands back a token that is already dead', async () => {
    refreshUpstreamSession.mockResolvedValue({ ...freshSession, accessToken: token(-1) });

    const res = await GET(req());

    expect(setSession).not.toHaveBeenCalled();
    expect(res.headers.get('location')).toBe(LOGOUT);
  });

  // The two guards have to ask the SAME question, or a token with less life left
  // than the arrival guard demands gets stored, 401s, comes back, and is
  // refreshed again — one rotation per lap, forever.
  it('signs out on a refreshed token with too little life left to survive the next arrival', async () => {
    refreshUpstreamSession.mockResolvedValue({ ...freshSession, accessToken: token(30) });

    const res = await GET(req());

    expect(setSession).not.toHaveBeenCalled();
    expect(res.headers.get('location')).toBe(LOGOUT);
  });

  it('still refreshes a local session that reaches here by direct navigation', async () => {
    // The freshness guard only reads a workos token; a local session has none,
    // so it falls through to the refresh, which declines it, and lands on logout.
    getSession.mockResolvedValue({ provider: 'local', email: 'a@b.c' });
    refreshUpstreamSession.mockResolvedValue(null);

    const res = await GET(req());

    expect(res.headers.get('location')).toBe(LOGOUT);
  });

  it('takes no redirect target from the query — an open redirect on the auth path', async () => {
    refreshUpstreamSession.mockResolvedValue(freshSession);

    const res = await GET(req('/api/auth/refresh?next=https://evil.example'));

    expect(res.headers.get('location')).toBe('https://calendars.example.com/admin');
  });
});
