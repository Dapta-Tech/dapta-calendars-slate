/**
 * The connect page as the server renders it: the connector guide for this
 * environment's MCP address when the API serves MCP and takes a sign-in (or
 * the note that the connector is not available here), and what the MCP can
 * do, leading to Tools. Nothing about API keys. Owners and admins only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AnchorHTMLAttributes, ReactElement, ReactNode } from 'react';
import { getMessages, t, type Locale } from '@slate/shared';
import { CONNECTOR_NAME } from '@/lib/product-name';

const locale = vi.hoisted(() => ({ value: 'en' as Locale }));
const admin = vi.hoisted(() => ({ me: vi.fn(), connectedApps: vi.fn() }));
vi.mock('@/lib/admin-api', () => ({
  adminApi: admin,
  isAdminRole: (role: string) => role === 'owner' || role === 'admin',
}));
vi.mock('@/lib/locale', () => ({ getLocale: async () => locale.value }));
vi.mock('next/link', () => ({
  default: ({ children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode }) => (
    <a {...rest}>{children}</a>
  ),
}));

import ConnectPage from './page';

const MCP = 'https://mcp.calendar.example.com/mcp';
const LISTING = 'https://claude.ai/directory/acme-calendars';
const render = async () => renderToStaticMarkup((await ConnectPage()) as ReactElement);
const has = (html: string, id: string) => html.includes(`data-testid="${id}"`);
const SIGN_IN = { enabled: false, external: true, mcpEnabled: true, accessTokenTtlSeconds: null, grants: [] };

describe('the connect page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    locale.value = 'en';
    vi.stubEnv('MCP_PUBLIC_URL', MCP);
    admin.me.mockResolvedValue({ role: 'owner' });
    admin.connectedApps.mockResolvedValue(SIGN_IN);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('opens with the heading, the MCP eyebrow and the way to Tools', async () => {
    const html = await render();
    const m = getMessages('en').admin;
    expect(html).toMatch(new RegExp(`<h1[^>]*>${t(m.connect.heading, { product: CONNECTOR_NAME })}</h1>`));
    expect(html).toContain('data-testid="mcp-logos"');
    const link = html.match(/<a [^>]*data-testid="tools-link"[^>]*>.*?<\/a>/)?.[0] ?? '';
    expect(link).toContain('href="/admin/developers/tools"');
    expect(link).toContain(m.nav.tools);
    expect(html).not.toContain('/admin/developers/docs');
    expect(html).not.toContain('/admin/developers/keys');
  });

  it('shows the recommended card, its benefits and one tab per app, Claude first, with its animated walkthrough', async () => {
    const html = await render();
    const c = getMessages('en').admin.connect;
    expect(html).toContain(c.signinTitle);
    for (const b of Object.values(c.benefits)) expect(html).toContain(b.title);
    const tabs = [...html.matchAll(/data-testid="mcp-app-([a-z-]+)"/g)].map((x) => x[1]);
    expect(tabs).toEqual(['tabs', 'claude', 'chatgpt', 'claude-code', 'codex', 'cursor', 'openclaw', 'hermes', 'panel']);
    expect(html).toMatch(/data-testid="mcp-walkthrough" data-kind="app" data-app="claude"/);
    expect(html).not.toMatch(/<video|<img/);
    expect(html).toContain(MCP);
  });

  it('fills the names in on the server: no placeholder reaches the page', async () => {
    for (const l of ['en', 'es'] as const) {
      locale.value = l;
      const html = await render();
      expect(html).not.toMatch(/\{(product|server|count)\}/);
      expect(html).toContain(CONNECTOR_NAME);
    }
  });

  it('works with this API\'s own sign-in too, not only an external one', async () => {
    admin.connectedApps.mockResolvedValue({ enabled: true, mcpEnabled: true, accessTokenTtlSeconds: 3600, grants: [] });
    expect(has(await render(), 'mcp-connect')).toBe(true);
  });

  it('never asks for a key and never names the identity provider', async () => {
    for (const l of ['en', 'es'] as const) {
      locale.value = l;
      const html = await render();
      expect(html).not.toContain('DAPTA_CALENDARS_API_KEY');
      expect(html).not.toMatch(/Authorization|Bearer|dcl_/);
      expect(html).not.toMatch(/Dapta|WorkOS|AuthKit/);
      // "No API key." is a benefit; what must not show is the keys themselves.
      expect(html).not.toMatch(/API keys|Claves API|api-key/);
    }
  });

  describe('the Claude directory button', () => {
    it('is not there with no listing: the custom connector is Claude\'s path', async () => {
      const html = await render();
      expect(has(html, 'mcp-claude-directory')).toBe(false);
      expect(has(html, 'mcp-claude-fallback')).toBe(false);
      expect(has(html, 'mcp-open-claude')).toBe(true);
    });

    it('leads Claude\'s tab with a listing set for this deployment, the custom connector folded under it', async () => {
      vi.stubEnv('MCP_CLAUDE_DIRECTORY_URL', LISTING);
      const html = await render();
      expect(html).toMatch(/<a [^>]*href="https:\/\/claude\.ai\/directory\/acme-calendars"[^>]*data-testid="mcp-claude-directory"/);
      expect(has(html, 'mcp-claude-fallback')).toBe(true);
      expect(has(html, 'mcp-open-claude')).toBe(false);
    });

    it('ignores a listing that is not https', async () => {
      vi.stubEnv('MCP_CLAUDE_DIRECTORY_URL', 'http://claude.ai/directory/acme-calendars');
      expect(has(await render(), 'mcp-claude-directory')).toBe(false);
    });
  });

  describe('when the connector cannot work here', () => {
    const expectUnavailable = (html: string) => {
      expect(has(html, 'mcp-connect')).toBe(false);
      expect(has(html, 'mcp-connect-unavailable')).toBe(true);
      expect(html).not.toContain(MCP);
      // What the MCP can do still shows, and still leads to Tools.
      expect(has(html, 'mcp-tools')).toBe(true);
    };

    it('says so when the API does not serve MCP', async () => {
      admin.connectedApps.mockResolvedValue({ ...SIGN_IN, mcpEnabled: false });
      expectUnavailable(await render());
    });

    it('says so when the API takes no sign-in, or is older than the field', async () => {
      admin.connectedApps.mockResolvedValue({ enabled: false, mcpEnabled: true, accessTokenTtlSeconds: null, grants: [] });
      expectUnavailable(await render());
      admin.connectedApps.mockResolvedValue({ enabled: false, accessTokenTtlSeconds: null, grants: [] });
      expectUnavailable(await render());
    });

    it('fails closed when the API cannot be asked', async () => {
      admin.connectedApps.mockRejectedValue(new Error('503 Service Unavailable'));
      expectUnavailable(await render());
    });

    it('says so when a production installation has no MCP address', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('MCP_PUBLIC_URL', '');
      vi.stubEnv('API_PUBLIC_URL', '');
      const html = await render();
      expect(has(html, 'mcp-connect-unavailable')).toBe(true);
      expect(html).toContain('<code');
    });
  });

  it('shows what the MCP can do in groups, linked to Tools', async () => {
    const html = await render();
    const x = getMessages('en').admin;
    expect(html).toContain(x.connect.toolsTitle);
    for (const g of Object.values(x.tools.groups)) expect(html).toContain(g.title);
    expect(html).toContain('href="/admin/developers/tools#availability"');
    expect(html).toContain('href="/admin/developers/tools"');
  });

  it('speaks Spanish to a Spanish reader', async () => {
    locale.value = 'es';
    const html = await render();
    const es = getMessages('es').admin.connect;
    expect(html).toContain(t(es.heading, { product: CONNECTOR_NAME }));
    expect(html).toContain(es.signinTitle);
    expect(html).toContain(t(es.apps.claude.steps[0]!.title, { product: CONNECTOR_NAME }));
  });

  it('gives a member the no-access panel, and asks the API nothing', async () => {
    admin.me.mockResolvedValue({ role: 'member' });
    const html = await render();
    expect(html).toContain(getMessages('en').admin.members.noAccessTitle);
    expect(has(html, 'mcp-connect')).toBe(false);
    expect(admin.connectedApps).not.toHaveBeenCalled();
  });
});
