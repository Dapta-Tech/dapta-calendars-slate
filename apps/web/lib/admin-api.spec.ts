import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The admin API client's own 401 wiring. `refreshOrSignOut` is covered through
 * `hostFetch` in auth-session-refresh.spec.ts; what is asserted here is that
 * this client — the busier of the two, serving every admin page render and nine
 * action files — retries correctly around it.
 */
const getSession = vi.fn();
const refreshOrSignOut = vi.fn();
const signOutAndRedirect = vi.fn((_session: unknown): never => {
  throw new Error('NEXT_REDIRECT:/login?signedout=1');
});
// Hoisted, because the mock factory runs while `./admin-api` is being imported
// — before this file's own body executes — and the client tells the retryable
// failure apart from a redirect with `instanceof`, so it has to be given the
// very class it will compare against.
const { SessionUnavailableError } = vi.hoisted(() => ({
  SessionUnavailableError: class SessionUnavailableError extends Error {
    readonly retryable = true;
    readonly code = 'SESSION_REFRESH_UNAVAILABLE';
    constructor(message: string) {
      super(message);
      this.name = 'SessionUnavailableError';
    }
  },
}));
vi.mock('./auth-session', () => ({
  getSession: () => getSession(),
  refreshOrSignOut: () => refreshOrSignOut(),
  signOutAndRedirect: (session: unknown) => signOutAndRedirect(session),
  SessionUnavailableError,
}));

import { adminApi, ApiError } from './admin-api';

const stale = { provider: 'workos', accessToken: 'stale-token' };
const fresh = { provider: 'workos', accessToken: 'fresh-token' };

const bearerOf = (call: unknown[] | undefined) =>
  ((call?.[1] as RequestInit | undefined)?.headers as Record<string, string> | undefined)?.[
    'authorization'
  ];

describe('adminApi 401 handling', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    getSession.mockResolvedValue(stale);
    // The real one stores the refreshed session; the jar is what the retry reads.
    refreshOrSignOut.mockImplementation(async () => {
      getSession.mockResolvedValue(fresh);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('re-reads identity per attempt, so the retry carries the new bearer', async () => {
    fetchMock
      .mockResolvedValueOnce({ status: 401 })
      .mockResolvedValueOnce({ status: 200, ok: true, json: async () => ({ accountId: 'a' }) });

    await expect(adminApi.me()).resolves.toMatchObject({ accountId: 'a' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bearerOf(fetchMock.mock.calls[0])).toBe('Bearer stale-token');
    expect(bearerOf(fetchMock.mock.calls[1])).toBe('Bearer fresh-token');
  });

  it('signs out when the retried request 401s again, rather than throwing an ApiError', async () => {
    fetchMock.mockResolvedValue({ status: 401 });

    await expect(adminApi.me()).rejects.toThrow('NEXT_REDIRECT:/login?signedout=1');

    expect(refreshOrSignOut).toHaveBeenCalledTimes(1); // one refresh, never a loop
    expect(signOutAndRedirect).toHaveBeenCalledWith(fresh);
  });

  // #114. A 401 that meets an unreachable identity service is NOT a sign-out.
  it('surfaces a retryable 503 ApiError when the identity service cannot be reached', async () => {
    fetchMock.mockResolvedValue({ status: 401 });
    refreshOrSignOut.mockRejectedValue(
      new SessionUnavailableError('You’re still signed in. Wait a moment and try again.'),
    );

    await expect(adminApi.me()).rejects.toMatchObject({
      name: 'ApiError',
      status: 503,
      code: 'SESSION_REFRESH_UNAVAILABLE',
      message: 'You’re still signed in. Wait a moment and try again.',
    });

    // Never a sign-out, and never a second attempt on a service that just failed.
    expect(signOutAndRedirect).not.toHaveBeenCalled();
    expect(refreshOrSignOut).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('is a 503 the /admin gate reads as "not a sign-out"', async () => {
    // The gate redirects to /login on `ApiError && status === 401` and rethrows
    // everything else to the error boundary. This has to land on the second path.
    fetchMock.mockResolvedValue({ status: 401 });
    refreshOrSignOut.mockRejectedValue(new SessionUnavailableError('try again'));

    const err = await adminApi.me().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).not.toBe(401);
  });

  it('re-throws a redirect from the refresh untouched', async () => {
    // Only the retryable failure is re-wrapped; a `redirect()` must reach Next.
    fetchMock.mockResolvedValue({ status: 401 });
    refreshOrSignOut.mockRejectedValue(new Error('NEXT_REDIRECT:/api/auth/refresh'));

    await expect(adminApi.me()).rejects.toThrow('NEXT_REDIRECT:/api/auth/refresh');
  });

  it('passes a 204 through after a retry instead of parsing a body', async () => {
    fetchMock
      .mockResolvedValueOnce({ status: 401 })
      .mockResolvedValueOnce({ status: 204, ok: true });

    await expect(adminApi.deleteEventType('et_1')).resolves.toBeUndefined();
  });

  it('still surfaces a non-401 failure as an ApiError carrying status and code', async () => {
    fetchMock
      .mockResolvedValueOnce({ status: 401 })
      .mockResolvedValueOnce({
        status: 409,
        ok: false,
        json: async () => ({ error: 'SLOT_TAKEN', message: 'that slot is gone' }),
      });

    await expect(adminApi.me()).rejects.toMatchObject({
      name: 'ApiError',
      status: 409,
      code: 'SLOT_TAKEN',
      message: 'that slot is gone',
    });
  });

  it('leaves a healthy request alone — no refresh, no retry', async () => {
    fetchMock.mockResolvedValue({ status: 200, ok: true, json: async () => ({ accountId: 'a' }) });

    await adminApi.me();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(refreshOrSignOut).not.toHaveBeenCalled();
  });

  it('sends the local identity header instead of a bearer', async () => {
    getSession.mockResolvedValue({ provider: 'local', email: 'a@b.c' });
    fetchMock.mockResolvedValue({ status: 200, ok: true, json: async () => ({ accountId: 'a' }) });

    await adminApi.me();

    const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-slate-email']).toBe('a@b.c');
    expect(headers['authorization']).toBeUndefined();
  });

  it('is an ApiError for callers that catch it', () => {
    expect(new ApiError(410, 'gone', 'GONE')).toBeInstanceOf(Error);
  });

  // A reply that answers with DATA rather than prose has to survive this client
  // (H1b / #93). A refused CRM credential names the scopes the private app was
  // missing; before this, everything but `message` and `error` was dropped here
  // and the connect dialog could not render them — a silent failure, since the
  // catalog's generic copy would still have rendered something plausible.
  it('keeps the rest of an error body, so a structured refusal survives', async () => {
    fetchMock.mockResolvedValue({
      status: 422,
      ok: false,
      json: async () => ({
        error: 'INTEGRATION_REJECTED',
        message: 'That token was rejected.',
        category: 'MISSING_SCOPES',
        requiredGranularScopes: ['crm.objects.contacts.write'],
      }),
    });

    await expect(
      adminApi.connectIntegration({ provider: 'hubspot', token: 'pat-fake-0000' }),
    ).rejects.toMatchObject({
      status: 422,
      code: 'INTEGRATION_REJECTED',
      details: { requiredGranularScopes: ['crm.objects.contacts.write'] },
    });
  });

  it('sends the pasted token in the body and never in the URL', async () => {
    // A token in a path or a query string lands in every access log and proxy
    // trace between here and the API. It travels in a POST body only.
    fetchMock.mockResolvedValue({ status: 201, ok: true, json: async () => ({}) });

    await adminApi.connectIntegration({ provider: 'hubspot', token: 'pat-fake-0000' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain('pat-fake-0000');
    expect(url).toMatch(/\/v1\/integrations$/);
    expect(init.method).toBe('POST');
    expect(init.body).toContain('pat-fake-0000');
  });
});
