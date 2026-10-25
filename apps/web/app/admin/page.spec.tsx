/**
 * The admin home's agent promo: the banner on top and the card after the
 * figures, as on the dForms home, for owners and admins, who are the only ones
 * a sign-in can connect. A member sees neither, and no door to the agent pages.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AnchorHTMLAttributes, ReactElement, ReactNode } from 'react';
import { getMessages } from '@slate/shared';

const admin = vi.hoisted(() => ({
  me: vi.fn(),
  listEventTypes: vi.fn(),
  listBookings: vi.fn(),
  listTeams: vi.fn(),
  setupStatus: vi.fn(),
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
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));

import AdminHome from './page';

const render = async () => renderToStaticMarkup((await AdminHome()) as ReactElement);
const at = (html: string, id: string) => html.indexOf(`data-testid="${id}"`);
const h = getMessages('en').admin.home;

describe('the admin home', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    admin.me.mockResolvedValue({ role: 'owner', displayName: 'Laura Mendez', handle: 'laura', accountCode: 'pulse' });
    admin.listEventTypes.mockResolvedValue([]);
    admin.listBookings.mockResolvedValue({ items: [] });
    admin.listTeams.mockResolvedValue([]);
    admin.setupStatus.mockResolvedValue({ hasConnectedCalendar: true, hasWorkingHours: true, hasPublishedEventType: true });
  });

  it('puts the agent banner above the greeting and the card after the figures, for an owner', async () => {
    const html = await render();
    expect(at(html, 'home-agent-banner')).toBeGreaterThan(-1);
    expect(at(html, 'home-agent-banner')).toBeLessThan(html.indexOf('<h1'));
    expect(at(html, 'home-agent-card')).toBeGreaterThan(html.indexOf(h.statTeams));
    expect(html).toContain('href="/admin/developers/connect"');
    // The names are filled in: the card's copy reaches the page complete.
    expect(html).not.toMatch(/\{(product|server|count)\}/);
  });

  it('shows the same to an admin', async () => {
    admin.me.mockResolvedValue({ role: 'admin', displayName: 'Sam Lee', handle: 'sam', accountCode: 'pulse' });
    const html = await render();
    expect(at(html, 'home-agent-banner')).toBeGreaterThan(-1);
    expect(at(html, 'home-agent-card')).toBeGreaterThan(-1);
  });

  it('shows a member neither, and no way into the agent or API pages', async () => {
    admin.me.mockResolvedValue({ role: 'member', displayName: 'Ana Ruiz', handle: 'ana', accountCode: 'pulse' });
    const html = await render();
    expect(at(html, 'home-agent-banner')).toBe(-1);
    expect(at(html, 'home-agent-card')).toBe(-1);
    expect(html).not.toContain('/admin/developers');
  });

  it('no longer has the old "Connect an agent" shortcut to the keys page', async () => {
    const html = await render();
    expect(html).not.toContain('href="/admin/developers/keys"');
  });
});
