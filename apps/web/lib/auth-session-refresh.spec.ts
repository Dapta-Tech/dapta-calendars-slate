import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cookieJar = { get: vi.fn(), set: vi.fn(), delete: vi.fn() };
vi.mock('next/headers', () => ({ cookies: vi.fn(async () => cookieJar) }));
const redirect = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});
vi.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url) }));

import {
  accessTokenExpired,
  encodeSession,
  hostFetch,
  refreshUpstreamSession,
  SessionUnavailableError,
  type Session,
} from './auth-session';

const b64u = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
const jwtWith = (claims: Record<string, unknown>) =>
  `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u(claims)}.sig`;
const nowSec = () => Math.floor(Date.now() / 1000);

const workosSession: Session = {
  provider: 'workos',
  accessToken: 'tok',
  refreshToken: 'refresh-1',
  sessionId: 'session_OLD',
};

describe('refreshUpstreamSession', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('IAM_BASE_URL', 'https://iam.example.com/iam');
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: jwtWith({ workos_session_id: 'session_NEW' }),
        refresh_token: 'refresh-2',
      }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('POSTs the refresh token with no Authorization header', async () => {
    await refreshUpstreamSession(workosSession);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://iam.example.com/iam/auth/refresh',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ refresh_token: 'refresh-1' }) }),
    );
    const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('authorization');
  });

  it('bounds the call at five seconds', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');

    await refreshUpstreamSession(workosSession);

    expect(timeout).toHaveBeenCalledWith(5000);
  });

  it('returns the rotated pair with the session id re-read from the new token', async () => {
    // The IAM rotates the refresh token on every call, so the whole returned
    // session has to be stored — keeping the old one guarantees the next 401.
    await expect(refreshUpstreamSession(workosSession)).resolves.toEqual({
      outcome: 'refreshed',
      session: {
        provider: 'workos',
        accessToken: jwtWith({ workos_session_id: 'session_NEW' }),
        refreshToken: 'refresh-2',
        sessionId: 'session_NEW',
      },
    });
  });

  it('keeps the old session id when the new token carries no claim', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: jwtWith({ sub: 'u' }), refresh_token: 'refresh-2' }),
    });

    await expect(refreshUpstreamSession(workosSession)).resolves.toMatchObject({
      session: { sessionId: 'session_OLD' },
    });
  });

  it('keeps the old refresh token when the IAM omits a rotated one', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ access_token: jwtWith({}) }) });

    await expect(refreshUpstreamSession(workosSession)).resolves.toMatchObject({
      session: { refreshToken: 'refresh-1' },
    });
  });

  // #114: the three outcomes are the whole point. `expired` is the ONLY one
  // that may cost anybody their session.
  it('reports expired on a 401 or a 403: the refresh token is dead, sign in again', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401 });
    await expect(refreshUpstreamSession(workosSession)).resolves.toEqual({ outcome: 'expired' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValue({ ok: false, status: 403 });
    await expect(refreshUpstreamSession(workosSession)).resolves.toEqual({ outcome: 'expired' });
  });

  it('reports unavailable on a 5xx — the service failed, the credential did not', async () => {
    for (const status of [500, 502, 503, 504]) {
      fetchMock.mockResolvedValue({ ok: false, status });
      await expect(refreshUpstreamSession(workosSession)).resolves.toEqual({ outcome: 'unavailable' });
    }
  });

  it('reports unavailable on a rejected fetch instead of throwing', async () => {
    fetchMock.mockRejectedValue(new Error('iam down'));

    await expect(refreshUpstreamSession(workosSession)).resolves.toEqual({ outcome: 'unavailable' });
  });

  it('reports unavailable when the five-second budget aborts the call', async () => {
    // What a hung identity service actually produces: the AbortSignal fires and
    // fetch rejects. Signing out on it would end a session over a slow deploy.
    fetchMock.mockRejectedValue(
      Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }),
    );

    await expect(refreshUpstreamSession(workosSession)).resolves.toEqual({ outcome: 'unavailable' });
  });

  it('reports unavailable on a non-401/403 4xx: our call was refused, not the credential', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400 });

    await expect(refreshUpstreamSession(workosSession)).resolves.toEqual({ outcome: 'unavailable' });
  });

  it('reports unavailable on a 200 whose body carries no access token', async () => {
    // The IAM ACCEPTED the refresh token and then failed to answer with one, so
    // nothing here says the credential is dead.
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ success: true }) });

    await expect(refreshUpstreamSession(workosSession)).resolves.toEqual({ outcome: 'unavailable' });
  });

  it('never retries internally — one call, one five-second budget', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 });

    await refreshUpstreamSession(workosSession);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports expired without calling the IAM when there is nothing to spend', async () => {
    // A local session, a session with no refresh token, no session, no IAM: the
    // credential is absent rather than unreachable, so signing out is honest.
    await expect(refreshUpstreamSession({ provider: 'local', email: 'a@b.c' })).resolves.toEqual({
      outcome: 'expired',
    });
    await expect(refreshUpstreamSession({ provider: 'workos', accessToken: 'tok' })).resolves.toEqual({
      outcome: 'expired',
    });
    await expect(refreshUpstreamSession(null)).resolves.toEqual({ outcome: 'expired' });
    vi.stubEnv('IAM_BASE_URL', '');
    await expect(refreshUpstreamSession(workosSession)).resolves.toEqual({ outcome: 'expired' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('accessTokenExpired — the render-side refresh ceiling', () => {
  it('is true for a token past its exp, false for one comfortably inside it', () => {
    expect(accessTokenExpired(jwtWith({ exp: nowSec() - 1 }))).toBe(true);
    expect(accessTokenExpired(jwtWith({ exp: nowSec() + 3600 }))).toBe(false);
  });

  it('counts a token about to expire as expired — the next request would 401 anyway', () => {
    expect(accessTokenExpired(jwtWith({ exp: nowSec() + 10 }))).toBe(true);
    // …and the strict question, for asking whether a token is dead right now.
    expect(accessTokenExpired(jwtWith({ exp: nowSec() + 10 }), 0)).toBe(false);
  });

  it('counts an unreadable or missing exp as expired — the API requires the claim', () => {
    expect(accessTokenExpired(jwtWith({ sub: 'u' }))).toBe(true);
    expect(accessTokenExpired(jwtWith({ exp: 'soon' }))).toBe(true);
    expect(accessTokenExpired('not-a-jwt')).toBe(true);
    expect(accessTokenExpired('')).toBe(true);
  });
});

describe('hostFetch 401 refresh path', () => {
  const fetchMock = vi.fn();
  const freshJwt = jwtWith({ workos_session_id: 'session_NEW' });

  /** After `setSession` the jar must serve the refreshed session, or the retry
   *  re-sends the dead token. */
  const storeOnSet = () => {
    cookieJar.set.mockImplementation((name: string, value: string) => {
      cookieJar.get.mockImplementation((n: string) => (n === 'slate_session' ? { value } : undefined));
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('IAM_BASE_URL', 'https://iam.example.com/iam');
    vi.stubEnv('AUTH_PROVIDER', 'workos');
    vi.stubEnv('WEB_SESSION_SECRET', 'spec-secret');
    cookieJar.get.mockImplementation((name: string) =>
      name === 'slate_session' ? { value: encodeSession(workosSession) } : undefined,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('refreshes once and retries the request with the new bearer', async () => {
    fetchMock
      .mockResolvedValueOnce({ status: 401 }) // original API call
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: freshJwt, refresh_token: 'refresh-2' }),
      }) // IAM refresh
      .mockResolvedValueOnce({ status: 200, ok: true }); // retried API call
    storeOnSet();

    const res = await hostFetch('/v1/me');

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://iam.example.com/iam/auth/refresh');
    const retryHeaders = (fetchMock.mock.calls[2]?.[1] as RequestInit).headers as Record<string, string>;
    expect(retryHeaders['authorization']).toBe(`Bearer ${freshJwt}`);
    expect(redirect).not.toHaveBeenCalled();
  });

  it('falls back to the logout shape when the refresh itself fails', async () => {
    fetchMock
      .mockResolvedValueOnce({ status: 401 }) // original API call
      .mockResolvedValueOnce({ ok: false, status: 401 }) // IAM refresh: dead
      .mockResolvedValue({ ok: true, json: async () => ({}) }); // IAM revoke

    await expect(hostFetch('/v1/me')).rejects.toThrow('NEXT_REDIRECT:/login?signedout=1');

    expect(cookieJar.delete).toHaveBeenCalled();
    // Read-then-clear: the revoke has to be sent the id the cookie carried.
    const revoke = fetchMock.mock.calls.find((c) => String(c[0]).includes('/auth/logout'));
    expect(revoke?.[1]).toMatchObject({
      body: JSON.stringify({ workos_session_id: 'session_OLD', session_id: 'session_OLD' }),
    });
  });

  // #114. The single failure this unit exists to remove: an identity service
  // that cannot answer must not cost a healthy session.
  it('throws a retryable failure when the IAM is down, leaving the session intact', async () => {
    fetchMock
      .mockResolvedValueOnce({ status: 401 }) // original API call
      .mockResolvedValueOnce({ ok: false, status: 503 }); // IAM refresh: unreachable

    await expect(hostFetch('/v1/me')).rejects.toBeInstanceOf(SessionUnavailableError);

    // The three things a sign-out would have done, none of which happened.
    expect(cookieJar.delete).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/auth/logout'))).toBe(false);
    expect(redirect).not.toHaveBeenCalled();
  });

  it('carries the retryable copy and never a "sign in again"', async () => {
    fetchMock.mockResolvedValueOnce({ status: 401 }).mockRejectedValueOnce(new Error('iam down'));

    await expect(hostFetch('/v1/me')).rejects.toMatchObject({
      code: 'SESSION_REFRESH_UNAVAILABLE',
      retryable: true,
      message: expect.stringContaining('still signed in'),
    });
  });

  it('spends one refresh attempt on an unavailable IAM, never a loop', async () => {
    fetchMock.mockResolvedValueOnce({ status: 401 }).mockResolvedValue({ ok: false, status: 500 });

    await expect(hostFetch('/v1/me')).rejects.toBeInstanceOf(SessionUnavailableError);

    const refreshCalls = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/auth/refresh'));
    expect(refreshCalls).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2); // the API call and the one refresh
  });

  it('never refreshes twice: a 401 on the retried request goes straight to logout', async () => {
    storeOnSet();
    fetchMock
      .mockResolvedValueOnce({ status: 401 }) // original API call
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: freshJwt, refresh_token: 'refresh-2' }),
      }) // IAM refresh succeeds
      .mockResolvedValueOnce({ status: 401 }) // retried API call STILL 401
      .mockResolvedValue({ ok: true, json: async () => ({}) }); // IAM revoke

    await expect(hostFetch('/v1/me')).rejects.toThrow('NEXT_REDIRECT:/login?signedout=1');

    const refreshCalls = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/auth/refresh'));
    expect(refreshCalls).toHaveLength(1);
  });

  it('hands the exchange to the refresh route WITHOUT spending a rotation first', async () => {
    // A Server Component render: `cookies().set()` throws. The identity service
    // rotates the refresh token on every call, so asking it before discovering
    // we cannot store the answer would retire the token still in the cookie and
    // leave the route handler holding a dead credential. Writability is settled
    // first, so the IAM is never called at all.
    cookieJar.set.mockImplementation(() => {
      throw new Error('Cookies can only be modified in a Server Action or Route Handler');
    });
    fetchMock.mockResolvedValue({ status: 401 });

    await expect(hostFetch('/v1/me')).rejects.toThrow('NEXT_REDIRECT:/api/auth/refresh');

    expect(fetchMock).toHaveBeenCalledTimes(1); // the original API call, and nothing else
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/auth/refresh'))).toBe(false);
  });

  it('lands on a bare /login under the local provider, with no IAM call', async () => {
    vi.stubEnv('AUTH_PROVIDER', 'local');
    cookieJar.get.mockImplementation((name: string) =>
      name === 'slate_session' ? { value: encodeSession({ provider: 'local', email: 'a@b.c' }) } : undefined,
    );
    fetchMock.mockResolvedValue({ status: 401 });

    await expect(hostFetch('/v1/me')).rejects.toThrow('NEXT_REDIRECT:/login');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
