/**
 * The bookings list: every row leads to the booking's own page (its details,
 * the campaign it came from), and keeps offering its action beside the link.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AnchorHTMLAttributes, ReactElement, ReactNode } from 'react';

const admin = vi.hoisted(() => ({ listBookings: vi.fn(), me: vi.fn() }));
vi.mock('@/lib/admin-api', () => ({ adminApi: admin }));
vi.mock('@/lib/locale', () => ({ getLocale: async () => 'en' }));
vi.mock('next/link', () => ({
  default: ({ children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock('./legacy-booking-link', () => ({ LegacyBookingLink: () => null }));
vi.mock('./booking-actions', () => ({
  PendingActions: ({ uid }: { uid: string }) => <div data-testid="pending-actions" data-uid={uid} />,
  CancelAction: ({ uid }: { uid: string }) => <div data-testid="cancel-action" data-uid={uid} />,
}));

import BookingsPage from './page';

const DAY = 86_400_000;
const row = (uid: string, status: string, offsetDays: number, title: string) => ({
  uid,
  status,
  title,
  startUtc: new Date(Date.now() + offsetDays * DAY).toISOString(),
  endUtc: new Date(Date.now() + offsetDays * DAY + 1_800_000).toISOString(),
  hostMemberId: 'm1',
});

const render = async () => renderToStaticMarkup((await BookingsPage()) as ReactElement);

describe('the bookings list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    admin.me.mockResolvedValue({ timeZone: 'UTC' });
  });

  it("links every row, in each part of the list, to the booking's own page", async () => {
    admin.listBookings.mockResolvedValue({
      items: [
        row('req-1', 'pending', 2, 'A request'),
        row('up-1', 'accepted', 3, 'Coming up'),
        row('past-1', 'cancelled', -3, 'Called off'),
      ],
    });

    const html = await render();

    for (const [uid, title] of [
      ['req-1', 'A request'],
      ['up-1', 'Coming up'],
      ['past-1', 'Called off'],
    ])
      expect(html).toMatch(new RegExp(`<a href="/admin/bookings/${uid}"[^>]*><span[^>]*>${title}</span>`));
    // The row's action stays beside the link, never inside it.
    expect(html).toMatch(/<\/a><div[^>]*><div data-testid="pending-actions" data-uid="req-1">/);
    expect(html).toMatch(/<\/a><div[^>]*><div data-testid="cancel-action" data-uid="up-1">/);
  });

  it('escapes the uid in the link', async () => {
    admin.listBookings.mockResolvedValue({ items: [row('a b#c', 'accepted', 2, 'Odd uid')] });
    expect(await render()).toContain('href="/admin/bookings/a%20b%23c"');
  });
});
