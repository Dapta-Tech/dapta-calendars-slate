import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getSession = vi.fn();
const clearSession = vi.fn();
const revokeUpstreamSession = vi.fn();
vi.mock('@/lib/auth-session', () => ({
  getSession: (...a: unknown[]) => getSession(...a),
  clearSession: (...a: unknown[]) => clearSession(...a),
  revokeUpstreamSession: (...a: unknown[]) => revokeUpstreamSession(...a),
}));

import { GET } from './route';

const req = (path = '/api/auth/logout') => new NextRequest(`https://calendars.example.com${path}`);
const workosSession = { provider: 'workos', accessToken: 'tok', sessionId: 'session_123' };

describe('GET /api/auth/logout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    revokeUpstreamSession.mockResolvedValue(undefined);
  });

  it('lands locally and never sends the browser to the identity provider', async () => {
    getSession.mockResolvedValue(workosSession);

    const res = await GET(req());

    expect(res.headers.get('location')).toBe('https://calendars.example.com/login?signedout=1');
    // Read-then-clear: the revoke needs the session id the cookie carried.
    expect(getSession.mock.invocationCallOrder[0]).toBeLessThan(clearSession.mock.invocationCallOrder[0]!);
    expect(revokeUpstreamSession).toHaveBeenCalledWith(workosSession);
    expect(clearSession).toHaveBeenCalled();
  });

  it('reason=expired behaves identically: revoke, clear, local landing', async () => {
    getSession.mockResolvedValue(workosSession);

    const res = await GET(req('/api/auth/logout?reason=expired'));

    expect(revokeUpstreamSession).toHaveBeenCalledWith(workosSession);
    expect(clearSession).toHaveBeenCalled();
    expect(res.headers.get('location')).toBe('https://calendars.example.com/login?signedout=1');
  });

  it('cleans up and lands locally when there is no session at all', async () => {
    getSession.mockResolvedValue(null);

    const res = await GET(req());

    expect(clearSession).toHaveBeenCalled();
    expect(revokeUpstreamSession).toHaveBeenCalledWith(null);
    expect(res.headers.get('location')).toBe('https://calendars.example.com/login?signedout=1');
  });

  it('clears the cookie even when the IAM revoke is a no-op', async () => {
    // Local cleanup is never hostage to the identity service.
    getSession.mockResolvedValue(workosSession);
    revokeUpstreamSession.mockResolvedValue(undefined);

    const res = await GET(req());

    expect(clearSession).toHaveBeenCalled();
    expect(res.headers.get('location')).toBe('https://calendars.example.com/login?signedout=1');
  });
});
