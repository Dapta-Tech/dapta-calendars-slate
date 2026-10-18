/**
 * F4 (QA battery, 2026-10-12): on an event type the host confirms by hand, the
 * booking comes back `pending`, the page says "Booking requested ... We'll email
 * you once it's confirmed" and hands over a "Manage your booking" link. That
 * link must let the visitor withdraw the request. It used to answer "This
 * booking can no longer be changed", although the API accepts the cancel.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
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
import { ManageActions } from './manage-actions';
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

/** The first element of `type` in a rendered tree (props only, nothing runs). */
function findElement(node: ReactNode, type: unknown): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findElement(child, type);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement<Record<string, unknown>>(node)) return null;
  if (node.type === type) return node;
  return findElement(node.props.children as ReactNode, type);
}

describe('the booking summary handed to the manage island (F9)', () => {
  it('carries a key, so React does not warn that a child in a list has none', async () => {
    // Made on the server and placed by the client island beside its own
    // children: React's dev build warned about it on every manage page.
    for (const status of ['accepted', 'pending'] as const) {
      api.getProfile.mockResolvedValue(profile({ theme: 'light' }));
      api.getManageView.mockResolvedValue({ ok: true, booking: booking({ status }) });
      api.getAvailability.mockResolvedValue({ slots: [] });
      const tree = await ManagePage({
        params: Promise.resolve({ uid: 'bk_keyed_0001' }),
        searchParams: Promise.resolve({ token: 'tok_keyed' }),
      });
      const island = findElement(tree, ManageActions);
      expect(island, status).not.toBeNull();
      const summary = island!.props.summary as ReactElement;
      expect(isValidElement(summary), status).toBe(true);
      expect(summary.key, status).toBe('summary');
    }
  });
});
