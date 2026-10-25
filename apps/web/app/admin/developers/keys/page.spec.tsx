/**
 * API and webhooks, API keys: the keys, the skill zip for an agent without
 * MCP, and the apps that signed in through this API's own OAuth server. No
 * connect guide any more: connecting an AI app with the person's account is
 * the connect page's, so nothing here prints the MCP address, a snippet or the
 * app tabs, whatever the API says about MCP.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AnchorHTMLAttributes, ReactElement, ReactNode } from 'react';
import { getMessages } from '@slate/shared';

const admin = vi.hoisted(() => ({
  me: vi.fn(),
  listApiKeys: vi.fn(),
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
vi.mock('next/link', () => ({
  default: ({ children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode }) => (
    <a {...rest}>{children}</a>
  ),
}));
// The interactive islands post through server actions; this checks the page's data path.
vi.mock('../developer-client', () => ({ ApiKeys: () => <div data-testid="api-keys" /> }));
vi.mock('../connected-apps', () => ({ ConnectedApps: () => <div data-testid="connected-apps" /> }));
vi.mock('../skill-download', () => ({ SkillDownload: () => <div data-testid="skill-download" /> }));

import DeveloperKeysPage from './page';

const MCP_URL = 'https://mcp.example.test/mcp';
const API_ORIGIN = 'https://api.example.test';
const m = getMessages('en').admin.developer;

const render = async () => renderToStaticMarkup((await DeveloperKeysPage()) as ReactElement);

function expectNoConnectGuide(html: string): void {
  expect(html).not.toContain(MCP_URL);
  expect(html).not.toContain('cursor://');
  expect(html).not.toContain('claude mcp add');
  expect(html).not.toContain('role="tablist"');
  expect(html).not.toContain('data-testid="setup-guide"');
}

describe('API and webhooks, API keys', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('MCP_PUBLIC_URL', MCP_URL);
    vi.stubEnv('API_PUBLIC_URL', API_ORIGIN);
    admin.me.mockResolvedValue({ role: 'owner', handle: 'riley-chen', accountCode: 'northwind' });
    admin.listApiKeys.mockResolvedValue([]);
    admin.listEventTypes.mockResolvedValue([]);
    admin.listTeams.mockResolvedValue([]);
    admin.teamEventTypes.mockResolvedValue([]);
    admin.connectedApps.mockResolvedValue({ enabled: false, mcpEnabled: true, accessTokenTtlSeconds: null, grants: [] });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('lists the keys under the page title and offers the skill, with no connect guide even with MCP on', async () => {
    const html = await render();
    expect(html).toContain(getMessages('en').admin.developerNav.keys);
    expect(html).toContain('data-testid="api-keys"');
    expect(html).toContain(m.guideSkillTitle);
    expect(html).toContain('data-testid="skill-download"');
    expectNoConnectGuide(html);
  });

  it("keeps this API's own OAuth server's Connected apps", async () => {
    admin.connectedApps.mockResolvedValue({ enabled: true, mcpEnabled: true, accessTokenTtlSeconds: 3600, grants: [] });
    expect(await render()).toContain('data-testid="connected-apps"');
  });

  it('has no Connected apps for an external sign-in, whose connections live there, or when the read fails', async () => {
    admin.connectedApps.mockResolvedValue({ enabled: false, external: true, mcpEnabled: true, accessTokenTtlSeconds: null, grants: [] });
    let html = await render();
    expect(html).not.toContain('data-testid="connected-apps"');
    expectNoConnectGuide(html);
    admin.connectedApps.mockRejectedValue(new Error('503 Service Unavailable'));
    html = await render();
    expect(html).not.toContain('data-testid="connected-apps"');
    expect(html).toContain('data-testid="api-keys"');
  });

  it('says the skill is not available on a production installation with no public API address', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('MCP_PUBLIC_URL', '');
    vi.stubEnv('API_PUBLIC_URL', '');
    const html = await render();
    expect(html).toContain('data-testid="setup-skill-unavailable"');
    expect(html).toContain(m.guideSkillUnavailable);
    expect(html).not.toContain('data-testid="skill-download"');
  });

  it('gives a member the no-access panel, and reads nothing else from the API', async () => {
    admin.me.mockResolvedValue({ role: 'member', handle: 'sam', accountCode: 'northwind' });
    const html = await render();
    expect(html).toContain(getMessages('en').admin.members.noAccessTitle);
    expect(admin.listApiKeys).not.toHaveBeenCalled();
    expect(admin.connectedApps).not.toHaveBeenCalled();
  });
});
