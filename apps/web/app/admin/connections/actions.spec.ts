/**
 * Starting a calendar connect from the dialog. When the API cannot start it
 * (503 while the provider is busy), the action answers instead of throwing:
 * a thrown server action lands on the error page, an answer lets the dialog
 * close its popup and show its own "try again" text.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const admin = vi.hoisted(() => ({ connectionToken: vi.fn() }));
vi.mock('@/lib/admin-api', () => ({ adminApi: admin }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
const nav = vi.hoisted(() => ({ unstable_rethrow: vi.fn() }));
vi.mock('next/navigation', () => nav);

import { connectCalendarAction } from './actions';

describe('connectCalendarAction', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes a started connect through', async () => {
    admin.connectionToken.mockResolvedValue({ enabled: true, token: 't', connectUrl: 'https://connect.example.com/x', message: 'Connect started.' });
    await expect(connectCalendarAction('google', 'host@example.com')).resolves.toEqual({
      enabled: true,
      connectUrl: 'https://connect.example.com/x',
      message: 'Connect started.',
    });
  });

  it('answers a connect that could not start, with no URL and no server text', async () => {
    const refused = Object.assign(new Error('The calendar connection could not start right now.'), { status: 503 });
    admin.connectionToken.mockRejectedValue(refused);
    await expect(connectCalendarAction('google', 'host@example.com')).resolves.toEqual({
      enabled: true,
      connectUrl: null,
      message: '',
    });
    // Next's own control flow (a sign-in redirect) is handed back first.
    expect(nav.unstable_rethrow).toHaveBeenCalledWith(refused);
  });

  it('throws any other failure, so it is not mistaken for a busy provider', async () => {
    const broken = Object.assign(new Error('Internal server error'), { status: 500 });
    admin.connectionToken.mockRejectedValue(broken);
    await expect(connectCalendarAction('google', 'host@example.com')).rejects.toBe(broken);
    const unreachable = new TypeError('fetch failed');
    admin.connectionToken.mockRejectedValue(unreachable);
    await expect(connectCalendarAction('google', 'host@example.com')).rejects.toBe(unreachable);
  });
});
