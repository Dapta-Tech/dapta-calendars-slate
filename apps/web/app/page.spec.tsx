/**
 * The root is where a landing's calls to action point (the middleware parks
 * their campaign tags on a page, never on an `/api/` route). On a WorkOS build
 * it is an app entry: a signed-in person goes to the dashboard, anyone else to
 * the hosted login, which a "create an account" call to action opens on its
 * sign-up screen with `?screen=sign-up` (lib/login-screen.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const provider = vi.fn(() => 'workos');
const getSession = vi.fn<() => Promise<unknown>>(async () => null);
vi.mock('@/lib/auth-session', () => ({ authProvider: () => provider(), getSession: () => getSession() }));
vi.mock('@/lib/locale', () => ({ getLocale: async () => 'en' }));
const redirect = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT ${url}`);
});
vi.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url) }));

import HomePage from './page';

const visit = (params: Record<string, string | string[]> = {}) => HomePage({ searchParams: Promise.resolve(params) });

describe('/ (the app root)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    provider.mockReturnValue('workos');
    getSession.mockResolvedValue(null);
  });

  it('sends an anonymous visitor to the hosted login, as before', async () => {
    await expect(visit()).rejects.toThrow('NEXT_REDIRECT /api/auth/login');
    expect(redirect).toHaveBeenCalledWith('/api/auth/login');
  });

  it('passes a sign-up call to action on to the login route', async () => {
    await expect(visit({ screen: 'sign-up' })).rejects.toThrow('NEXT_REDIRECT');
    expect(redirect).toHaveBeenCalledWith('/api/auth/login?screen=sign-up');
  });

  it.each<[string, Record<string, string | string[]>]>([
    ['another value', { screen: 'signup' }],
    ['a different case', { screen: 'Sign-Up' }],
    ['an empty value', { screen: '' }],
    ['a repeated parameter', { screen: ['sign-up', 'sign-up'] }],
  ])('treats %s as a plain login', async (_label, params) => {
    await expect(visit(params)).rejects.toThrow('NEXT_REDIRECT');
    expect(redirect).toHaveBeenCalledWith('/api/auth/login');
  });

  it('sends a signed-in person to the dashboard, call to action or not', async () => {
    getSession.mockResolvedValue({ accountId: 'acc_1' });

    await expect(visit({ screen: 'sign-up' })).rejects.toThrow('NEXT_REDIRECT /admin');
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith('/admin');
  });

  it('keeps the clone-and-run landing on a local build', async () => {
    provider.mockReturnValue('local');

    await expect(visit({ screen: 'sign-up' })).resolves.toBeTruthy();
    expect(redirect).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
  });
});
