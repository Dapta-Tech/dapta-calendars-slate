/**
 * MCP, API docs lists the MCP tools only when the API says it serves MCP
 * (`mcpEnabled` on the Connected apps read): the list describes an endpoint, and
 * a deployment can set MCP_PUBLIC_URL while the API answers `/mcp` with 404. MCP
 * off, an older API without the field, and a failed read all land on one
 * sentence instead. The API reference does not depend on MCP and shows in
 * every state.
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
const m = getMessages('en').admin.developer;

const render = async () => renderToStaticMarkup((await DeveloperDocsPage()) as ReactElement);

function expectReference(html: string): void {
  expect(html).toContain(m.apiRefTitle);
  expect(html).toContain(`${API_ORIGIN}/docs`);
  expect(html).toContain(`${API_ORIGIN}/openapi.json`);
}

function expectNoTools(html: string): void {
  expect(html).toContain(m.mcpUnavailable);
  expect(html).not.toContain(m.toolsTitle);
  expect(html).not.toContain('find_available_slots');
}

describe('MCP, API docs: the tool list follows the API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('API_PUBLIC_URL', API_ORIGIN);
    admin.me.mockResolvedValue({ role: 'owner' });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('MCP on: the tools, then the reference', async () => {
    admin.connectedApps.mockResolvedValue({ enabled: false, mcpEnabled: true, accessTokenTtlSeconds: null, grants: [] });
    const html = await render();
    expect(html).toContain(m.toolsTitle);
    expect(html).toContain('find_available_slots');
    expect(html).not.toContain(m.mcpUnavailable);
    expectReference(html);
  });

  it('MCP off: one sentence instead of the tools, and the reference', async () => {
    admin.connectedApps.mockResolvedValue({ enabled: false, mcpEnabled: false, accessTokenTtlSeconds: null, grants: [] });
    const html = await render();
    expectNoTools(html);
    expectReference(html);
  });

  it('an older API that does not report MCP reads as off', async () => {
    admin.connectedApps.mockResolvedValue({ enabled: false, accessTokenTtlSeconds: null, grants: [] });
    const html = await render();
    expectNoTools(html);
    expectReference(html);
  });

  it('a failed read fails closed, and the reference still renders', async () => {
    admin.connectedApps.mockRejectedValue(new Error('503 Service Unavailable'));
    const html = await render();
    expectNoTools(html);
    expectReference(html);
  });

  it('a member gets the no-access panel and no read of the API', async () => {
    admin.me.mockResolvedValue({ role: 'member' });
    const html = await render();
    expect(html).toContain(getMessages('en').admin.members.noAccessTitle);
    expect(html).not.toContain(m.apiRefTitle);
    expect(admin.connectedApps).not.toHaveBeenCalled();
  });
});
