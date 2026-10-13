/**
 * The link preview cards obey the API's `showBranding` too. The small product
 * mark in the card's top rail is Dapta branding: an account that turned the
 * branding off while it is a paying Dapta AI customer gets a card with the
 * host alone; every other account gets the card exactly as before.
 *
 * Each card (profile and event) renders both states, through the route and
 * the real card tree. "Exactly as before" is byte for byte: `showBranding:
 * true` renders the same card as a payload without the field.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const env = vi.hoisted(() => {
  const saved = process.env.NEXT_PUBLIC_PRODUCT_NAME;
  process.env.NEXT_PUBLIC_PRODUCT_NAME = 'Dapta Calendars';
  return saved;
});

const api = vi.hoisted(() => ({ getProfile: vi.fn() }));
vi.mock('@/lib/api', () => api);
vi.mock('@/lib/locale', () => ({ publicLocale: async () => 'en' }));
vi.mock('@/lib/og-image-source', () => ({ cardImageDataUri: async () => null }));

/** The route's input to the card, captured; the card itself stays real. */
const drawn = vi.hoisted(() => ({ last: null as unknown }));
vi.mock('@/lib/og-card', async (real) => {
  const mod = await real<typeof import('@/lib/og-card')>();
  return {
    ...mod,
    bookingCardResponse: (input: unknown) => {
      drawn.last = input;
      return new Response(null);
    },
  };
});

import { BookingCard, type BookingCardInput } from '@/lib/og-card';
import ProfileCard from './[handle]/opengraph-image';
import EventCard from './[handle]/[slug]/opengraph-image';

afterAll(() => {
  if (env === undefined) delete process.env.NEXT_PUBLIC_PRODUCT_NAME;
  else process.env.NEXT_PUBLIC_PRODUCT_NAME = env;
});

const profile = {
  account: { code: 'northwind', name: 'Northwind' },
  member: {
    handle: 'riley-chen',
    displayName: 'Riley Chen',
    avatarUrl: null,
    connectedAvatarUrl: null,
    brandColor: '#2f6fed',
    style: { bio: 'Product design at Northwind.' },
  },
  eventTypes: [{ slug: 'design-review', title: 'Design review', description: null, lengthMinutes: 30 }],
};
const withShow = (show?: boolean) => (show === undefined ? profile : { ...profile, showBranding: show });

const surfaces = [
  {
    name: 'the profile card',
    draw: () => ProfileCard({ params: Promise.resolve({ accountCode: 'northwind', handle: 'riley-chen' }) }),
  },
  {
    name: 'the event card',
    draw: () =>
      EventCard({
        params: Promise.resolve({ accountCode: 'northwind', handle: 'riley-chen', slug: 'design-review' }),
      }),
  },
];

async function card(draw: () => Promise<unknown>, show?: boolean): Promise<{ input: BookingCardInput; html: string }> {
  api.getProfile.mockResolvedValue(withShow(show));
  drawn.last = null;
  await draw();
  const input = drawn.last as BookingCardInput;
  return { input, html: renderToStaticMarkup(BookingCard(input)) };
}

describe('the link preview cards follow the account branding switch', () => {
  beforeEach(() => api.getProfile.mockReset());

  for (const s of surfaces) {
    it(`${s.name}: switched off while paying, the product mark and name are gone`, async () => {
      const { input, html } = await card(s.draw, false);
      expect(input.productName).toBeNull();
      expect(html).not.toContain('Dapta Calendars');
      // The host is still there.
      expect(html).toContain('Riley Chen');
    });

    it(`${s.name}: on (or lapsed) renders byte for byte what a payload without the field renders`, async () => {
      const shown = await card(s.draw, true);
      const absent = await card(s.draw);
      expect(shown.input.productName).toBe('Dapta Calendars');
      expect(shown.html).toContain('Dapta Calendars');
      expect(shown.html).toBe(absent.html);
    });
  }
});
