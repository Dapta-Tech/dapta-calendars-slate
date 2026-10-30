/**
 * The old address of API docs. The rail opens the API's own reference in a new
 * tab now, so this page only sends a link made before straight to it, on the
 * API's origin: no page in the dashboard between, and the reference is never
 * drawn inside the dashboard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { getMessages } from '@slate/shared';

const admin = vi.hoisted(() => ({ me: vi.fn(), connectedApps: vi.fn() }));
vi.mock('@/lib/admin-api', () => ({
  adminApi: admin,
  isAdminRole: (role: string) => role === 'owner' || role === 'admin',
}));
vi.mock('@/lib/locale', () => ({ getLocale: async () => 'en' }));
const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
);
vi.mock('next/navigation', () => ({ redirect }));

import DeveloperDocsPage from './page';

const API_ORIGIN = 'https://api.example.test';
const admin_ = getMessages('en').admin;
const m = admin_.developer;

const render = async () => renderToStaticMarkup((await DeveloperDocsPage()) as ReactElement);

describe('API and webhooks, the old API docs address', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('API_PUBLIC_URL', API_ORIGIN);
    admin.me.mockResolvedValue({ role: 'owner' });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sends an owner or admin to the API's own reference", async () => {
    await expect(render()).rejects.toThrow(`NEXT_REDIRECT ${API_ORIGIN}/docs`);
    expect(redirect).toHaveBeenCalledWith(`${API_ORIGIN}/docs`);
    expect(admin.connectedApps).not.toHaveBeenCalled();
  });

  it('keeps a path prefix the API is served under', async () => {
    vi.stubEnv('API_PUBLIC_URL', 'https://host.example.test/calendar-api/');
    await expect(render()).rejects.toThrow('NEXT_REDIRECT https://host.example.test/calendar-api/docs');
  });

  it('says so, without redirecting, when the installation has no public API address', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('API_PUBLIC_URL', '');
    vi.stubEnv('MCP_PUBLIC_URL', '');
    const html = await render();
    expect(html).toContain(admin_.developerNav.docs);
    expect(html).toContain(m.apiRefMissing);
    expect(redirect).not.toHaveBeenCalled();
  });

  it('a member gets the no-access panel, as on the rest of API and webhooks', async () => {
    admin.me.mockResolvedValue({ role: 'member' });
    const html = await render();
    expect(html).toContain(admin_.members.noAccessTitle);
    expect(redirect).not.toHaveBeenCalled();
  });
});
