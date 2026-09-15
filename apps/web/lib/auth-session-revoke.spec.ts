import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({ cookies: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));

import { revokeUpstreamSession, workosSessionIdFromJwt, type Session } from './auth-session';

const workosSession: Session = { provider: 'workos', accessToken: 'tok', sessionId: 'session_123' };

describe('revokeUpstreamSession', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('IAM_BASE_URL', 'https://iam.example.com/iam');
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('POSTs redirect=false with both id keys and no Authorization header', async () => {
    await revokeUpstreamSession(workosSession);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://iam.example.com/iam/auth/logout?redirect=false',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ workos_session_id: 'session_123', session_id: 'session_123' }),
      }),
    );
    // An expired Bearer on this call is what creates logout -> 401 -> logout
    // loops: /auth/logout is a public route and must be called unauthenticated.
    const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('authorization');
  });

  it('bounds the call at five seconds — a hung IAM must not hang a sign-out', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');

    await revokeUpstreamSession(workosSession);

    expect(timeout).toHaveBeenCalledWith(5000);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it('returns nothing even when the IAM hands back an IdP logout URL', async () => {
    // The URL is deliberately unusable: no caller may send a browser to the
    // identity provider, which is what used to end the whole platform session.
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ logoutUrl: 'https://idp.example.com/sessions/logout?session_id=session_123' }),
    });

    await expect(revokeUpstreamSession(workosSession)).resolves.toBeUndefined();
  });

  it('still POSTs an empty body when the workos session has no session id', async () => {
    await revokeUpstreamSession({ provider: 'workos', accessToken: 'tok' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://iam.example.com/iam/auth/logout?redirect=false',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({}) }),
    );
  });

  it('resolves on a rejected fetch — local cleanup is never hostage to the IAM', async () => {
    fetchMock.mockRejectedValue(new Error('iam down'));

    await expect(revokeUpstreamSession(workosSession)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('resolves on a non-ok IAM answer without retrying', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401 });

    await expect(revokeUpstreamSession(workosSession)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('skips the IAM for a local session and for no session at all', async () => {
    await revokeUpstreamSession({ provider: 'local', email: 'a@b.c' });
    await revokeUpstreamSession(null);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips the IAM when IAM_BASE_URL is not configured', async () => {
    vi.stubEnv('IAM_BASE_URL', '');

    await revokeUpstreamSession(workosSession);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('workosSessionIdFromJwt', () => {
  const jwtWith = (claims: Record<string, unknown>) =>
    `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')}.${Buffer.from(
      JSON.stringify(claims),
    ).toString('base64url')}.signature`;

  it('reads the upstream session id from the claim, not the IAM row id', () => {
    const token = jwtWith({
      sub: 'a4d2b7a0-0000-0000-0000-000000000000',
      session_id: '00000000-0000-0000-0000-000000000000',
      workos_session_id: 'session_01JQEXAMPLE',
    });

    expect(workosSessionIdFromJwt(token)).toBe('session_01JQEXAMPLE');
  });

  it('returns null when the claim is absent, empty, or not a string', () => {
    expect(workosSessionIdFromJwt(jwtWith({ sub: 'u' }))).toBeNull();
    expect(workosSessionIdFromJwt(jwtWith({ workos_session_id: '' }))).toBeNull();
    expect(workosSessionIdFromJwt(jwtWith({ workos_session_id: 42 }))).toBeNull();
  });

  it('returns null for a malformed token instead of throwing', () => {
    expect(workosSessionIdFromJwt('not-a-jwt')).toBeNull();
    expect(workosSessionIdFromJwt('a.%%%not-base64%%%.c')).toBeNull();
    expect(workosSessionIdFromJwt(`a.${Buffer.from('[1,2]').toString('base64url')}.c`)).toBeNull();
    expect(workosSessionIdFromJwt('')).toBeNull();
  });
});
