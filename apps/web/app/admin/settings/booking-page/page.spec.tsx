/**
 * The "Learn more" beside "Custom links are included with your Dapta AI
 * subscription" goes to the Dapta AI app (NEXT_PUBLIC_PLATFORM_URL), the same
 * destination as the branding setting's subscription line. It never follows
 * NEXT_PUBLIC_SIGNUP_URL: that one is where the "Made with" links send
 * visitors, and a deployment may point it at its product site.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

const admin = vi.hoisted(() => ({
  me: vi.fn(),
  profile: vi.fn(),
  listEventTypes: vi.fn(),
  vanityStatus: vi.fn(),
  bookingPageState: vi.fn(),
  getBrandKit: vi.fn(),
  listConnections: vi.fn(),
}));
vi.mock('@/lib/admin-api', () => ({ adminApi: admin }));
vi.mock('@/lib/locale', () => ({ getLocale: async () => 'en' }));
vi.mock('./studio-tabs', () => ({ StudioTabs: () => <div data-testid="studio-tabs" /> }));
vi.mock('./studio', () => ({
  Studio: ({ subscriptionUrl }: { subscriptionUrl: string | null }) => (
    <div data-testid="studio" data-subscription-url={subscriptionUrl ?? 'null'} />
  ),
}));

import BookingPageSettings from './page';

const ENV_KEYS = ['NEXT_PUBLIC_PLATFORM_URL', 'NEXT_PUBLIC_SIGNUP_URL'] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

async function subscriptionUrl(): Promise<string> {
  const html = renderToStaticMarkup((await BookingPageSettings()) as ReactElement);
  return html.match(/data-subscription-url="([^"]*)"/)![1]!;
}

describe('Settings > Booking page: the subscription link', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    admin.me.mockResolvedValue({ handle: 'riley-chen', accountCode: 'northwind', accountShortCode: 'nw' });
    admin.profile.mockResolvedValue(null);
    admin.listEventTypes.mockResolvedValue([]);
    admin.vanityStatus.mockResolvedValue({ vanitySlug: null, shortCode: 'nw', canClaim: false });
    admin.bookingPageState.mockResolvedValue({ backup: null });
    admin.getBrandKit.mockResolvedValue({ config: null, updatedAt: null });
    admin.listConnections.mockResolvedValue([]);
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('links to the platform URL, not to the signup URL', async () => {
    process.env.NEXT_PUBLIC_PLATFORM_URL = 'https://platform.example.com';
    process.env.NEXT_PUBLIC_SIGNUP_URL = 'https://site.example.com';
    expect(await subscriptionUrl()).toBe('https://platform.example.com');
  });

  it('stays plain text without a platform URL, even with a signup URL', async () => {
    delete process.env.NEXT_PUBLIC_PLATFORM_URL;
    process.env.NEXT_PUBLIC_SIGNUP_URL = 'https://site.example.com';
    expect(await subscriptionUrl()).toBe('null');
  });

  it('an empty platform URL (the image default) is plain text too', async () => {
    process.env.NEXT_PUBLIC_PLATFORM_URL = '';
    expect(await subscriptionUrl()).toBe('null');
  });
});
