/**
 * F4 (QA battery, 2026-10-12): on an event type the host confirms by hand, the
 * booking comes back `pending`, the page says "Booking requested ... We'll email
 * you once it's confirmed" and hands over a "Manage your booking" link. That
 * link must let the visitor withdraw the request. It used to answer "This
 * booking can no longer be changed", although the API accepts the cancel.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BookingView } from '@slate/types';

const api = vi.hoisted(() => ({
  getProfile: vi.fn(),
  getAvailability: vi.fn(),
  getManageView: vi.fn(),
  getRescheduleAvailability: vi.fn(),
}));
vi.mock('@/lib/api', () => api);
vi.mock('@/lib/locale', () => ({ publicLocale: async () => 'en' }));
vi.mock('@/lib/theme.server', () => ({ resolveDocumentTheme: async () => 'dark' }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('notFound');
  },
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/',
}));
vi.mock('./actions', () => ({ cancelAction: vi.fn(), rescheduleAction: vi.fn() }));

import ManagePage from './page';
import { manageMode } from '@/lib/manage-mode';
import { NOW, booking, profile } from '../../[accountCode]/__fixtures__/public-surface';

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});
afterAll(() => vi.useRealTimers());

async function manage(status: NonNullable<BookingView['status']>): Promise<string> {
  api.getProfile.mockResolvedValue(profile({ theme: 'light' }));
  api.getManageView.mockResolvedValue({ ok: true, booking: booking({ status }) });
  api.getAvailability.mockResolvedValue({ slots: [] });
  return renderToStaticMarkup(
    await ManagePage({
      params: Promise.resolve({ uid: 'bk_pending_0001' }),
      searchParams: Promise.resolve({ token: 'tok_pending' }),
    }),
  );
}

describe('the manage link of a request waiting on the host', () => {
  it('offers to cancel the request, with the token it was opened with', async () => {
    const html = await manage('pending');
    expect(html).toContain('This booking is pending.');
    expect(html).toContain('Cancel this request');
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Cancel request<\/button>/);
    expect(html).toContain('name="token" value="tok_pending"');
    expect(html).not.toContain('This booking can no longer be changed.');
  });

  it('does not offer to move it: a new time is a new request', async () => {
    const html = await manage('pending');
    expect(html).not.toContain('role="grid"');
    expect(api.getAvailability).not.toHaveBeenCalled();
    expect(api.getRescheduleAvailability).not.toHaveBeenCalled();
  });

  it('a cancelled booking still offers nothing', async () => {
    const html = await manage('cancelled');
    expect(html).toContain('This booking can no longer be changed.');
    expect(html).not.toContain('Cancel request');
  });
});

describe('manageMode', () => {
  const ahead = new Date(Date.parse(NOW) + 86_400_000).toISOString();
  const behind = new Date(Date.parse(NOW) - 86_400_000).toISOString();
  const now = Date.parse(NOW);
  it('accepted and ahead: move or cancel', () => expect(manageMode('accepted', ahead, now)).toBe('full'));
  it('pending and ahead: withdraw only', () => expect(manageMode('pending', ahead, now)).toBe('cancel'));
  it('past, unreadable, cancelled or declined: nothing', () => {
    expect(manageMode('accepted', behind, now)).toBe('none');
    expect(manageMode('pending', behind, now)).toBe('none');
    expect(manageMode('pending', null, now)).toBe('none');
    expect(manageMode('cancelled', ahead, now)).toBe('none');
    expect(manageMode('rejected', ahead, now)).toBe('none');
  });
});
