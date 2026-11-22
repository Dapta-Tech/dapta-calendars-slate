/**
 * `/login` is where a signed-out visit to a dashboard page is sent
 * (`requireSession`), with the page as `?next=`. On a WorkOS build it goes
 * straight on to the hosted login, always on the SIGN-IN screen: only the app
 * root passes a landing's `?screen=sign-up` on (lib/login-screen.ts), and this
 * page never does, whatever its URL carries.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const provider = vi.fn(() => 'workos');
vi.mock('@/lib/auth-session', () => ({ authProvider: () => provider() }));
vi.mock('@/lib/locale', () => ({ getLocale: async () => 'en' }));
vi.mock('./login-form', () => ({ LoginForm: () => null }));
const redirect = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT ${url}`);
});
vi.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url) }));

import LoginPage from './page';

const PAGE = '/admin/bookings/6f1c2a9e-1b7d-4c55-9a0e-3d2f8b7c4e10';
const visit = (params: Record<string, string>) => LoginPage({ searchParams: Promise.resolve(params) });

describe('/login on a WorkOS build', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    provider.mockReturnValue('workos');
  });

  it('hands a signed-out dashboard visit to the hosted login with its page, on the sign-in screen', async () => {
    await expect(visit({ next: PAGE })).rejects.toThrow('NEXT_REDIRECT');
    expect(redirect).toHaveBeenCalledWith(`/api/auth/login?next=${encodeURIComponent(PAGE)}`);
  });

  it('never passes a sign-up screen on, even when the URL carries one', async () => {
    await expect(visit({ next: PAGE, screen: 'sign-up' } as Record<string, string>)).rejects.toThrow('NEXT_REDIRECT');
    expect(redirect).toHaveBeenCalledWith(`/api/auth/login?next=${encodeURIComponent(PAGE)}`);
    expect(String(redirect.mock.calls[0]?.[0])).not.toContain('screen');
  });
});
