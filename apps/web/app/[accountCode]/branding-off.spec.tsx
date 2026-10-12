/**
 * Every public surface obeys the API's `showBranding`, the answer of
 * `showDaptaBranding` (@slate/shared): an account that turned the Dapta
 * branding off while it is a paying Dapta AI customer gets pages with no
 * "Made with" badge and no free-calendar block; every other account gets the
 * page exactly as before.
 *
 * Each surface renders both states. "Exactly as before" is proved byte for
 * byte: `showBranding: true` (what the API sends for a lapsed subscription)
 * renders the same markup as a payload without the field, which is the markup
 * the pins in `public-markup.spec.tsx` hold.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

const env = vi.hoisted(() => {
  const saved = {
    NEXT_PUBLIC_SIGNUP_URL: process.env.NEXT_PUBLIC_SIGNUP_URL,
    NEXT_PUBLIC_HIDE_BADGE: process.env.NEXT_PUBLIC_HIDE_BADGE,
    NEXT_PUBLIC_PRODUCT_NAME: process.env.NEXT_PUBLIC_PRODUCT_NAME,
    TZ: process.env.TZ,
  };
  process.env.TZ = 'America/New_York';
  process.env.NEXT_PUBLIC_SIGNUP_URL = 'https://example.com/signup';
  delete process.env.NEXT_PUBLIC_HIDE_BADGE;
  process.env.NEXT_PUBLIC_PRODUCT_NAME = 'Dapta Calendars';
  return saved;
});

const api = vi.hoisted(() => ({
  getProfile: vi.fn(),
  getAvailability: vi.fn(),
  getManageView: vi.fn(),
  getRescheduleAvailability: vi.fn(),
  getTeamProfile: vi.fn(),
  getTeamAvailability: vi.fn(),
  getOneOffLink: vi.fn(),
  getAvailabilityWithOneOff: vi.fn(),
  getTeamAvailabilityWithOneOff: vi.fn(),
}));
vi.mock('@/lib/api', () => api);
vi.mock('@/lib/locale', () => ({
  publicLocale: async (lang?: string) => (lang === 'es' ? 'es' : 'en'),
}));
vi.mock('@/lib/theme.server', () => ({ resolveDocumentTheme: async () => 'light' }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('notFound');
  },
  permanentRedirect: (to: string) => {
    throw new Error(`permanentRedirect ${to}`);
  },
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/',
}));
vi.mock('@/app/[accountCode]/[handle]/[slug]/actions', () => ({
  bookAction: vi.fn(),
  reserveAction: vi.fn(),
  releaseAction: vi.fn(),
}));
vi.mock('@/app/[accountCode]/team/[teamSlug]/[slug]/actions', () => ({
  bookAction: vi.fn(),
  reserveAction: vi.fn(),
  releaseAction: vi.fn(),
}));
vi.mock('@/app/manage/[uid]/actions', () => ({
  cancelAction: vi.fn(),
  rescheduleAction: vi.fn(),
}));

import ProfilePage from './[handle]/page';
import EventPage from './[handle]/[slug]/page';
import TeamPage from './team/[teamSlug]/page';
import TeamEventPage from './team/[teamSlug]/[slug]/page';
import ManagePage from '../manage/[uid]/page';
import OneOffPage from '../booking/[token]/page';
import { ProfilePreview } from '@/components/booking-preview';
import { ACCOUNT, BASE_STYLE, NOW, TIME_ZONE, availability, booking, profile } from './__fixtures__/public-surface';

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});

afterAll(() => {
  vi.useRealTimers();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  vi.clearAllMocks();
});

const team = () => ({
  account: ACCOUNT,
  team: { slug: 'studio', name: 'Studio Team', logoUrl: null, timeZone: TIME_ZONE },
  eventTypes: [
    { slug: 'design-review', title: 'Design review', description: null, lengthMinutes: 45 },
    { slug: 'intro', title: 'Intro call', description: null, lengthMinutes: 15 },
  ],
});

/** `undefined` = the field absent (an older API), as every pinned fixture is. */
type Branding = boolean | undefined;
const withBranding = <T extends object>(payload: T, show: Branding): T =>
  show === undefined ? payload : { ...payload, showBranding: show };

interface Surface {
  name: string;
  /** Whether the surface carries the free-calendar block as well as the badge. */
  cta: boolean;
  render: (show: Branding) => Promise<ReactElement>;
}

const SURFACES: Surface[] = [
  {
    name: 'the profile',
    cta: true,
    render: (show) => {
      api.getProfile.mockResolvedValue(withBranding(profile({ ...BASE_STYLE, theme: 'light' }), show));
      return ProfilePage({
        params: Promise.resolve({ accountCode: 'northwind', handle: 'riley-chen' }),
        searchParams: Promise.resolve({}),
      });
    },
  },
  {
    name: 'the event page',
    cta: false,
    render: (show) => {
      api.getProfile.mockResolvedValue(withBranding(profile({ ...BASE_STYLE, theme: 'dark' }), show));
      api.getAvailability.mockResolvedValue(availability());
      return EventPage({
        params: Promise.resolve({ accountCode: 'northwind', handle: 'riley-chen', slug: 'design-review' }),
        searchParams: Promise.resolve({}),
      });
    },
  },
  {
    name: 'the inline embed',
    cta: false,
    render: (show) => {
      api.getProfile.mockResolvedValue(withBranding(profile({ ...BASE_STYLE, theme: 'light' }), show));
      api.getAvailability.mockResolvedValue(availability());
      return EventPage({
        params: Promise.resolve({ accountCode: 'northwind', handle: 'riley-chen', slug: 'design-review' }),
        searchParams: Promise.resolve({ embed: '1' }),
      });
    },
  },
  {
    name: 'the team landing',
    cta: true,
    render: (show) => {
      api.getTeamProfile.mockResolvedValue(withBranding(team(), show));
      return TeamPage({
        params: Promise.resolve({ accountCode: 'northwind', teamSlug: 'studio' }),
        searchParams: Promise.resolve({}),
      });
    },
  },
  {
    name: 'the team event page',
    cta: false,
    render: (show) => {
      api.getTeamProfile.mockResolvedValue(withBranding(team(), show));
      api.getTeamAvailability.mockResolvedValue(availability());
      return TeamEventPage({
        params: Promise.resolve({ accountCode: 'northwind', teamSlug: 'studio', slug: 'design-review' }),
        searchParams: Promise.resolve({}),
      });
    },
  },
  {
    name: 'the manage page',
    cta: false,
    render: (show) => {
      api.getProfile.mockResolvedValue(profile({ ...BASE_STYLE, theme: 'light' }));
      api.getManageView.mockResolvedValue({ ok: true, booking: withBranding(booking(), show) });
      api.getAvailability.mockResolvedValue(availability());
      return ManagePage({
        params: Promise.resolve({ uid: 'bk_pinned_0001' }),
        searchParams: Promise.resolve({ token: 'tok_pinned' }),
      });
    },
  },
  {
    name: 'a one-off link',
    cta: false,
    render: (show) => {
      api.getOneOffLink.mockResolvedValue({
        ok: true,
        target: { kind: 'personal', accountCode: 'northwind', handle: 'riley-chen', slug: 'design-review' },
      });
      api.getProfile.mockResolvedValue(withBranding(profile({ ...BASE_STYLE, theme: 'light' }), show));
      api.getAvailabilityWithOneOff.mockResolvedValue(availability());
      return OneOffPage({
        params: Promise.resolve({ token: 'a'.repeat(43) }),
        searchParams: Promise.resolve({}),
      });
    },
  },
];

const html = async (s: Surface, show: Branding) => renderToStaticMarkup(await s.render(show));

describe('every public surface obeys showBranding', () => {
  for (const s of SURFACES) {
    describe(s.name, () => {
      it('with the branding: the badge (and the free-calendar block where it lives)', async () => {
        const on = await html(s, true);
        expect(on).toContain('bp-embed-footer');
        expect(on).toContain('Made with Dapta Calendars');
        expect(on).toContain('example.com/signup');
        expect(on.includes('class="bp-growth"')).toBe(s.cta);
      });

      it('an account that hid it while paying: no badge, no block, no signup link', async () => {
        const off = await html(s, false);
        expect(off).not.toContain('bp-embed-footer');
        expect(off).not.toContain('Made with Dapta Calendars');
        expect(off).not.toContain('class="bp-growth"');
        expect(off).not.toContain('example.com/signup');
      });

      it('a lapsed subscription (showBranding true) renders exactly as a page always has', async () => {
        expect(await html(s, true)).toBe(await html(s, undefined));
      });
    });
  }
});

describe('the studio profile preview follows the same flag', () => {
  const preview = (showBranding?: boolean) =>
    renderToStaticMarkup(
      <ProfilePreview
        accountCode="northwind"
        showBranding={showBranding}
        locale="en"
        displayName="Riley Chen"
        accountName="Northwind Studio"
        bio=""
        avatarUrl=""
        coverUrl=""
        events={[{ slug: 'design-review', title: 'Design review', lengthMinutes: 45 }]}
      />,
    );
  it('ends with the free-calendar block while the pages carry the branding, and without it when they do not', () => {
    expect(preview(true)).toContain('class="bp-growth"');
    expect(preview(false)).not.toContain('class="bp-growth"');
    expect(preview(undefined)).toBe(preview(true));
  });
});
