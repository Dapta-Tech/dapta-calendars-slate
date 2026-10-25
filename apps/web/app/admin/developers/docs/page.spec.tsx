/**
 * API and webhooks, API docs: the API's own reference, for code that calls it
 * with a key. What a connected agent can do moved to the Tools page, so no
 * tool is listed here, and the page asks the API nothing.
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

import DeveloperDocsPage from './page';

const API_ORIGIN = 'https://api.example.test';
const admin_ = getMessages('en').admin;
const m = admin_.developer;

const render = async () => renderToStaticMarkup((await DeveloperDocsPage()) as ReactElement);

describe('API and webhooks, API docs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('API_PUBLIC_URL', API_ORIGIN);
    admin.me.mockResolvedValue({ role: 'owner' });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('links the reference and the OpenAPI document, under the page title', async () => {
    const html = await render();
    expect(html).toContain(admin_.developerNav.docs);
    expect(html).toContain(m.apiRefTitle);
    expect(html).toContain(`${API_ORIGIN}/docs`);
    expect(html).toContain(`${API_ORIGIN}/openapi.json`);
  });

  it('lists no MCP tool and asks the API nothing: that is the Tools page now', async () => {
    const html = await render();
    expect(html).not.toContain('find_available_slots');
    expect(html).not.toContain(admin_.tools.title);
    expect(admin.connectedApps).not.toHaveBeenCalled();
  });

  it('says so when the installation has no public API address', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('API_PUBLIC_URL', '');
    vi.stubEnv('MCP_PUBLIC_URL', '');
    expect(await render()).toContain(m.apiRefMissing);
  });

  it('a member gets the no-access panel', async () => {
    admin.me.mockResolvedValue({ role: 'member' });
    const html = await render();
    expect(html).toContain(admin_.members.noAccessTitle);
    expect(html).not.toContain(m.apiRefTitle);
  });
});
