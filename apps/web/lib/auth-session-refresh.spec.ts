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
      provider: 'workos',
      accessToken: jwtWith({ workos_session_id: 'session_NEW' }),
      refreshToken: 'refresh-2',
      sessionId: 'session_NEW',
    });
  });

  it('keeps the old session id when the new token carries no claim', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: jwtWith({ sub: 'u' }), refresh_token: 'refresh-2' }),
    });

    await expect(refreshUpstreamSession(workosSession)).resolves.toMatchObject({ sessionId: 'session_OLD' });
  });

  it('keeps the old refresh token when the IAM omits a rotated one', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ access_token: jwtWith({}) }) });

    await expect(refreshUpstreamSession(workosSession)).resolves.toMatchObject({ refreshToken: 'refresh-1' });
  });

  it('resolves null on a 401 from the IAM: the refresh token is dead, sign in again', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401 });

    await expect(refreshUpstreamSession(workosSession)).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('resolves null on a rejected fetch instead of throwing', async () => {
    fetchMock.mockRejectedValue(new Error('iam down'));

    await expect(refreshUpstreamSession(workosSession)).resolves.toBeNull();
  });

  it('resolves null on a body with no access token', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ success: true }) });

    await expect(refreshUpstreamSession(workosSession)).resolves.toBeNull();
  });

  it('skips the IAM entirely for a local session, a missing refresh token, or no IAM', async () => {
    await expect(refreshUpstreamSession({ provider: 'local', email: 'a@b.c' })).resolves.toBeNull();
    await expect(refreshUpstreamSession({ provider: 'workos', accessToken: 'tok' })).resolves.toBeNull();
    await expect(refreshUpstreamSession(null)).resolves.toBeNull();
    vi.stubEnv('IAM_BASE_URL', '');
    await expect(refreshUpstreamSession(workosSession)).resolves.toBeNull();
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
