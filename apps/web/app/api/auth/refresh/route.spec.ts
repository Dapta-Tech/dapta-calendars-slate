import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// The retryable branch renders the i18n copy, which reads the locale cookie.
const localeCookie = vi.fn(() => undefined as { value: string } | undefined);
vi.mock('next/headers', () => ({ cookies: async () => ({ get: localeCookie }) }));

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

/** The three outcomes `refreshUpstreamSession` can report (#114). */
const refreshed = (session: unknown) => ({ outcome: 'refreshed', session });
const EXPIRED = { outcome: 'expired' } as const;
const UNAVAILABLE = { outcome: 'unavailable' } as const;

describe('GET /api/auth/refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSession.mockResolvedValue(staleSession);
    localeCookie.mockReturnValue(undefined);
  });

  it('stores the refreshed session and returns to /admin', async () => {
    refreshUpstreamSession.mockResolvedValue(refreshed(freshSession));

    const res = await GET(req());

    expect(refreshUpstreamSession).toHaveBeenCalledWith(staleSession);
    expect(setSession).toHaveBeenCalledWith(freshSession);
    expect(res.headers.get('location')).toBe('https://calendars.example.com/admin');
  });

  it('hands off to the logout route when the refresh token is dead, without touching the cookie', async () => {
    refreshUpstreamSession.mockResolvedValue(EXPIRED);

    const res = await GET(req());

    expect(setSession).not.toHaveBeenCalled();
    expect(res.headers.get('location')).toBe(LOGOUT);
  });

  it('hands off to the logout route when there is no session at all', async () => {
    getSession.mockResolvedValue(null);
    refreshUpstreamSession.mockResolvedValue(EXPIRED);

    const res = await GET(req());

    expect(res.headers.get('location')).toBe(LOGOUT);
  });

  // #114. The render-side path is the one with no retry affordance of its own,
  // so it gets a terminal page rather than a redirect: /admin would 401 and come
  // straight back here, and /login auto-redirects into the very service that has
  // just failed to answer.
  it('answers 503 and signs nobody out when the identity service is unreachable', async () => {
    refreshUpstreamSession.mockResolvedValue(UNAVAILABLE);

    const res = await GET(req());

    expect(res.status).toBe(503);
    expect(res.headers.get('location')).toBeNull();
    expect(setSession).not.toHaveBeenCalled();
  });

  it('renders the retryable copy with a way back, in the reader’s language', async () => {
    refreshUpstreamSession.mockResolvedValue(UNAVAILABLE);

    const en = await (await GET(req())).text();

    expect(en).toContain('still signed in');
    expect(en).toContain('href="/admin"');
    expect(en).toContain('lang="en"');

    localeCookie.mockReturnValue({ value: 'es' });
    const es = await (await GET(req())).text();

    expect(es).toContain('Tu sesión sigue activa');
    expect(es).toContain('lang="es"');
  });

  it('marks the 503 uncacheable and retryable', async () => {
    refreshUpstreamSession.mockResolvedValue(UNAVAILABLE);

    const res = await GET(req());

    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('retry-after')).toBe('5');
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  // `unavailable` is not always transient — a non-401/403 4xx is a contract
  // drift no amount of waiting fixes — so the page has to offer a way off it
  // that is not "know that /api/auth/logout can be typed by hand".
  it('offers a deliberate sign-out beside the retry', async () => {
    refreshUpstreamSession.mockResolvedValue(UNAVAILABLE);

    const en = await (await GET(req())).text();
    expect(en).toContain('href="/api/auth/logout"');
    expect(en).toContain('Sign out instead');

    localeCookie.mockReturnValue({ value: 'es' });
    expect(await (await GET(req())).text()).toContain('Cerrar sesión');
  });

  it('never auto-retries: no meta refresh and no script on the page', async () => {
    refreshUpstreamSession.mockResolvedValue(UNAVAILABLE);

    const html = await (await GET(req())).text();

    expect(html).not.toContain('http-equiv');
    expect(html).not.toContain('<script');
  });

  it('escapes the copy it interpolates into the markup', async () => {
    // The strings are the catalog's, not a person's, but this route hand-builds
    // HTML — the escaping is the whole defence and nothing else asserts it.
    refreshUpstreamSession.mockResolvedValue(UNAVAILABLE);
    const messages = (await import('@slate/shared')).getMessages('en').admin.session;
    const original = messages.unavailableBody;
    messages.unavailableBody = `<script>alert("x")</script> & 'quoted'`;

    try {
      const html = await (await GET(req())).text();

      expect(html).not.toContain('<script>alert');
      expect(html).toContain('&#60;script&#62;');
      expect(html).toContain('&#38;');
      expect(html).toContain('&#39;quoted&#39;');
    } finally {
      messages.unavailableBody = original;
    }
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
    refreshUpstreamSession.mockResolvedValue(refreshed({ ...freshSession, accessToken: token(-1) }));

    const res = await GET(req());

    expect(setSession).not.toHaveBeenCalled();
    expect(res.headers.get('location')).toBe(LOGOUT);
  });

  // The two guards have to ask the SAME question, or a token with less life left
  // than the arrival guard demands gets stored, 401s, comes back, and is
  // refreshed again — one rotation per lap, forever.
  it('signs out on a refreshed token with too little life left to survive the next arrival', async () => {
    refreshUpstreamSession.mockResolvedValue(refreshed({ ...freshSession, accessToken: token(30) }));

    const res = await GET(req());

    expect(setSession).not.toHaveBeenCalled();
    expect(res.headers.get('location')).toBe(LOGOUT);
  });

  it('still refreshes a local session that reaches here by direct navigation', async () => {
    // The freshness guard only reads a workos token; a local session has none,
    // so it falls through to the refresh, which declines it, and lands on logout.
    getSession.mockResolvedValue({ provider: 'local', email: 'a@b.c' });
    refreshUpstreamSession.mockResolvedValue(EXPIRED);

    const res = await GET(req());

    expect(res.headers.get('location')).toBe(LOGOUT);
  });

  it('takes no redirect target from the query — an open redirect on the auth path', async () => {
    refreshUpstreamSession.mockResolvedValue(refreshed(freshSession));

    const res = await GET(req('/api/auth/refresh?next=https://evil.example'));

    expect(res.headers.get('location')).toBe('https://calendars.example.com/admin');
  });
});
