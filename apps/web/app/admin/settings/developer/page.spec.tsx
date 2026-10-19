/**
 * MCP & API shows how to connect an agent only when the API says it serves MCP
 * (`mcpEnabled` on the Connected apps read). The web's MCP_PUBLIC_URL alone is
 * not enough: a deployment can set it while the API answers `/mcp` with 404.
 * MCP off, an older API without the field, and a failed read all land on the
 * same honest state: one sentence, no tabs, no address, no tool list. API keys,
 * webhooks and the API reference render the same either way.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { getMessages } from '@slate/shared';

const admin = vi.hoisted(() => ({
  me: vi.fn(),
  listApiKeys: vi.fn(),
  listWebhooks: vi.fn(),
  listEventTypes: vi.fn(),
  listTeams: vi.fn(),
  teamEventTypes: vi.fn(),
  connectedApps: vi.fn(),
}));
vi.mock('@/lib/admin-api', () => ({
  adminApi: admin,
  isAdminRole: (role: string) => role === 'owner' || role === 'admin',
}));
vi.mock('@/lib/locale', () => ({ getLocale: async () => 'en' }));
// The interactive islands post through server actions; this checks the page's data path.
vi.mock('./developer-client', () => ({
  ApiKeys: () => <div data-testid="api-keys" />,
  Webhooks: () => <div data-testid="webhooks" />,
}));
vi.mock('./connected-apps', () => ({ ConnectedApps: () => <div data-testid="connected-apps" /> }));

import DeveloperSettings from './page';

const MCP_URL = 'https://mcp.example.test/mcp';
const API_ORIGIN = 'https://api.example.test';
const m = getMessages('en').admin.developer;

const render = async () => renderToStaticMarkup((await DeveloperSettings()) as ReactElement);

function expectUnavailable(html: string): void {
  expect(html).toContain(m.connectTitle);
  expect(html).toContain(m.mcpUnavailable);
  // No address anywhere: not the configured one, not a snippet built from it.
  expect(html).not.toContain(MCP_URL);
  expect(html).not.toContain('mcp.example.test');
  expect(html).not.toContain('cursor://');
  expect(html).not.toContain('claude mcp add');
  expect(html).not.toContain(m.addToCursor);
  expect(html).not.toContain('role="tablist"');
  expect(html).not.toContain(m.mcpUrlMissing);
  // The tool list describes the endpoint that is off.
  expect(html).not.toContain(m.toolsTitle);
  expect(html).not.toContain('find_available_slots');
}

function expectOtherSectionsUnchanged(html: string): void {
  expect(html).toContain('data-testid="api-keys"');
  expect(html).toContain('data-testid="webhooks"');
  expect(html).toContain(`${API_ORIGIN}/docs`);
  expect(html).toContain(`${API_ORIGIN}/openapi.json`);
}

describe('Settings > MCP & API: the connect-agent guide follows the API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('MCP_PUBLIC_URL', MCP_URL);
    vi.stubEnv('API_PUBLIC_URL', API_ORIGIN);
    admin.me.mockResolvedValue({ role: 'owner', handle: 'riley-chen', accountCode: 'northwind' });
    admin.listApiKeys.mockResolvedValue([]);
    admin.listWebhooks.mockResolvedValue([]);
    admin.listEventTypes.mockResolvedValue([]);
    admin.listTeams.mockResolvedValue([]);
    admin.teamEventTypes.mockResolvedValue([]);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('MCP on: shows the steps with the configured address', async () => {
    admin.connectedApps.mockResolvedValue({ enabled: false, mcpEnabled: true, accessTokenTtlSeconds: null, grants: [] });
    const html = await render();
    expect(html).toContain(m.connectLead);
    expect(html).toContain('role="tablist"');
    expect(html).toContain(MCP_URL);
    expect(html).toContain('cursor://anysphere.cursor-deeplink/mcp/install');
    expect(html).toContain(m.addToCursor);
    expect(html).toContain(m.toolsTitle);
    expect(html).not.toContain(m.mcpUnavailable);
    expectOtherSectionsUnchanged(html);
  });

  it('MCP off: the honest state, and no address', async () => {
    admin.connectedApps.mockResolvedValue({ enabled: false, mcpEnabled: false, accessTokenTtlSeconds: null, grants: [] });
    const html = await render();
    expectUnavailable(html);
    expectOtherSectionsUnchanged(html);
  });

  it('an older API that does not report MCP reads as off', async () => {
    admin.connectedApps.mockResolvedValue({ enabled: false, accessTokenTtlSeconds: null, grants: [] });
    const html = await render();
    expectUnavailable(html);
    expectOtherSectionsUnchanged(html);
  });

  it('a failed read fails closed: MCP off, and the rest of the page still renders', async () => {
    admin.connectedApps.mockRejectedValue(new Error('503 Service Unavailable'));
    const html = await render();
    expectUnavailable(html);
    expectOtherSectionsUnchanged(html);
    expect(html).not.toContain('data-testid="connected-apps"');
  });

  it('MCP on without a public address keeps the existing "set MCP_PUBLIC_URL" note', async () => {
    vi.stubEnv('MCP_PUBLIC_URL', '');
    vi.stubEnv('API_PUBLIC_URL', '');
    vi.stubEnv('NODE_ENV', 'production');
    admin.connectedApps.mockResolvedValue({ enabled: false, mcpEnabled: true, accessTokenTtlSeconds: null, grants: [] });
    const html = await render();
    expect(html).toContain(m.mcpUrlMissing);
    expect(html).not.toContain(m.mcpUnavailable);
  });
});
