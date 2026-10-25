/**
 * The Tools page: every tool of the MCP server, grouped, each with a plain
 * one-liner and an example request, in the reader's language. No routes, no
 * parameters, no JSON, no tool names. Owners and admins only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AnchorHTMLAttributes, ReactElement, ReactNode } from 'react';
import { getMessages, t, type Locale } from '@slate/shared';
import { CONNECTOR_NAME } from '@/lib/product-name';
import { TOOL_COUNT, TOOL_GROUPS } from '../tool-groups';

const locale = vi.hoisted(() => ({ value: 'en' as Locale }));
const admin = vi.hoisted(() => ({ me: vi.fn() }));
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

import ToolsPage from './page';

const render = async () => renderToStaticMarkup((await ToolsPage()) as ReactElement);
const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/'/g, '&#x27;').replace(/"/g, '&quot;');
const ALL = Object.values(TOOL_GROUPS).flat() as string[];

describe('the Tools page', () => {
  beforeEach(() => {
    locale.value = 'en';
    admin.me.mockResolvedValue({ role: 'admin' });
  });

  it('lists every tool once, with what it does and what to ask, in both languages', async () => {
    for (const l of ['en', 'es'] as const) {
      locale.value = l;
      const html = await render();
      const x = getMessages(l).admin.tools;
      const listed = [...html.matchAll(/data-tool="([a-z_]+)"/g)].map((r) => r[1]);
      expect([...listed].sort()).toEqual([...ALL].sort());
      for (const name of ALL) {
        expect(html, `${l} ${name}`).toContain(escape(x.items[name]!.what));
        expect(html, `${l} ${name}`).toContain(escape(x.items[name]!.ask));
      }
      for (const g of Object.values(x.groups)) expect(html).toContain(escape(g.title));
      expect(html).toContain(escape(t(x.intro, { product: CONNECTOR_NAME, count: TOOL_COUNT })));
    }
  });

  it('says nothing technical: no HTTP, no JSON, no parameters, no tool names on screen', async () => {
    for (const l of ['en', 'es'] as const) {
      locale.value = l;
      const text = (await render()).replace(/<[^>]+>/g, ' ');
      expect(text).not.toMatch(/\b(GET|POST|PUT|PATCH|DELETE)\b|\/v[12]\/|curl|\{\s*"|_id\b|scope/);
      for (const name of ALL) expect(text).not.toContain(name);
    }
  });

  it('counts each group in words, one tool or several', async () => {
    const html = (await render()).replace(/<[^>]+>/g, ' ');
    expect(html).toContain('1 tool ');
    expect(html).not.toContain('1 tools');
    expect(html).toContain('4 tools');
    locale.value = 'es';
    const es = (await render()).replace(/<[^>]+>/g, ' ');
    expect(es).toContain('1 herramienta ');
    expect(es).not.toContain('1 herramientas');
  });

  it('jumps to each group from the chips at the top', async () => {
    const html = await render();
    for (const group of Object.keys(TOOL_GROUPS)) {
      expect(html).toContain(`href="#${group}"`);
      expect(html).toContain(`id="${group}"`);
    }
  });

  it('leads to the connect page', async () => {
    const html = await render();
    const link = html.match(/<a [^>]*data-testid="tools-connect-link"[^>]*>/)?.[0] ?? '';
    expect(link).toContain('href="/admin/developers/connect"');
  });

  it('gives a member the no-access panel', async () => {
    admin.me.mockResolvedValue({ role: 'member' });
    const html = await render();
    expect(html).toContain(getMessages('en').admin.members.noAccessTitle);
    expect(html).not.toContain('data-tool=');
  });
});
