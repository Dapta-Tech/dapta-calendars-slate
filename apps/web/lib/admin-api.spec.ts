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
vi.mock('./auth-session', () => ({
  getSession: () => getSession(),
  refreshOrSignOut: () => refreshOrSignOut(),
  signOutAndRedirect: (session: unknown) => signOutAndRedirect(session),
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
});
