/**
 * The Calendars (connections) page. Loading it asks the API whether calendar
 * sync is on and never starts a connect: a real handshake per page view
 * created provider-side state and spent the provider's rate limit. Its
 * "Checked <time>" caption is written in the account's zone, so the server
 * render and the browser's hydration agree (React #418 before).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

const admin = vi.hoisted(() => ({
  listConnections: vi.fn(),
  connectionStatus: vi.fn(),
  connectionToken: vi.fn(),
  me: vi.fn(),
}));
vi.mock('@/lib/admin-api', () => ({ adminApi: admin }));
vi.mock('@/lib/locale', () => ({ getLocale: async () => 'en' }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('./actions', () => ({
  connectCalendarAction: vi.fn(),
  deleteConnectionAction: vi.fn(),
  discoverConnectionsAction: vi.fn(),
  pingConnectionAction: vi.fn(),
  testConnectionAction: vi.fn(),
  toggleConnectionAction: vi.fn(),
}));

import ConnectionsPage from './page';

const CHECKED_AT = Date.UTC(2026, 10, 2, 17, 46);

const connection = {
  id: 'c1',
  provider: 'google',
  externalId: 'ref-1',
  primaryEmail: 'host@example.com',
  isDestination: true,
  checkConflicts: true,
  lastCheckAt: CHECKED_AT,
  lastCheckOk: true,
  lastCheckDetail: null,
};

const render = async () => renderToStaticMarkup((await ConnectionsPage()) as ReactElement);

describe('the connections page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    admin.listConnections.mockResolvedValue([connection]);
    admin.connectionStatus.mockResolvedValue({ enabled: true, message: 'Calendar sync is available.' });
    admin.me.mockResolvedValue({ email: 'host@example.com', timeZone: 'America/Bogota' });
  });

  it('asks whether sync is on without starting a connect', async () => {
    await render();
    expect(admin.connectionStatus).toHaveBeenCalledTimes(1);
    expect(admin.connectionToken).not.toHaveBeenCalled();
  });

  it('falls back to UTC for a corrupt stored zone instead of crashing the page', async () => {
    admin.me.mockResolvedValue({ email: 'host@example.com', timeZone: 'Not/AZone' });
    const html = await render();
    expect(html).toContain('5:46');
  });

  it("writes the last check in the account's zone, not the server's", async () => {
    const html = await render();
    // 17:46 UTC is 12:46 in Bogota (UTC-5, no DST).
    expect(html).toContain('12:46');
    expect(html).not.toContain('5:46');
  });
});
