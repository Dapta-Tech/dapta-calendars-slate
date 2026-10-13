/**
 * Settings > General reads the branding status next to the member's profile.
 * When that one read fails (an older API without the endpoint, or the endpoint
 * erroring), the page still renders, and the branding row rests on the
 * default: branding on, switch locked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

const admin = vi.hoisted(() => ({
  me: vi.fn(),
  profile: vi.fn(),
  brandingStatus: vi.fn(),
}));
vi.mock('@/lib/admin-api', () => ({
  adminApi: admin,
  isAdminRole: (role: string) => role === 'owner' || role === 'admin',
}));
vi.mock('@/lib/locale', () => ({ getLocale: async () => 'en' }));
vi.mock('@/components/language-switcher', () => ({ LanguageSwitcher: () => <div data-testid="language" /> }));
vi.mock('./general-form', () => ({ GeneralForm: () => <div data-testid="general-form" /> }));
vi.mock('./branding-setting', () => ({
  BrandingSetting: ({ initial }: { initial: unknown }) => (
    <div data-testid="branding-setting" data-initial={JSON.stringify(initial)} />
  ),
}));

import GeneralSettings from './page';

async function render(): Promise<{ html: string; branding: unknown }> {
  const html = renderToStaticMarkup((await GeneralSettings()) as ReactElement);
  const raw = html.match(/data-initial="([^"]*)"/)![1]!.replace(/&quot;/g, '"');
  return { html, branding: JSON.parse(raw) };
}

describe('Settings > General', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    admin.me.mockResolvedValue({ handle: 'riley-chen', accountCode: 'northwind', displayName: 'Riley', role: 'owner' });
    admin.profile.mockResolvedValue({ member: { timeZone: 'UTC' } });
  });

  it('passes the branding status through when the API answers', async () => {
    const status = { hideBranding: true, canHide: true, showing: false };
    admin.brandingStatus.mockResolvedValue(status);
    expect((await render()).branding).toEqual(status);
  });

  it('a failed branding read keeps the page up, on the default (branding on, switch locked)', async () => {
    admin.brandingStatus.mockRejectedValue(new Error('404 Not Found'));
    const { html, branding } = await render();
    expect(html).toContain('data-testid="general-form"');
    expect(html).toContain('data-testid="language"');
    expect(branding).toEqual({ hideBranding: false, canHide: false, showing: true });
  });
});
