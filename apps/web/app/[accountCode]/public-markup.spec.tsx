/**
 * The public surface, pinned as markup before the booking page is redesigned.
 *
 * A booking page is the one screen a host's invitees see, and every host has
 * already chosen how theirs looks: three templates, two canvases, two slot
 * layouts and six more axes. A reskin that moves markup nobody meant to touch
 * changes a live page without the host doing anything. So the markup the
 * CURRENT renderer writes is pinned here, and any change to it shows up as a
 * file diff a reviewer reads, instead of a screenshot someone eyeballed.
 *
 * Pinned: the profile page on both canvases; the event page for every template
 * x canvas x slot layout; one event page in Spanish; the inline embed; and the
 * manage page. The details step and the confirmation need clicks, so they live
 * in `public-steps.spec.tsx`.
 *
 * Every snapshot under `__snapshots__/public-markup/` was written by the
 * renderer at the base of the redesign. A redesign PR that changes one updates
 * it deliberately and explains the diff in its body.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

// The attribution badge reads the deployment's env at render time and the
// brand gate at import time: both are pinned so the proof holds on any machine.
const env = vi.hoisted(() => {
  const saved = {
    NEXT_PUBLIC_SIGNUP_URL: process.env.NEXT_PUBLIC_SIGNUP_URL,
    NEXT_PUBLIC_HIDE_BADGE: process.env.NEXT_PUBLIC_HIDE_BADGE,
    NEXT_PUBLIC_PRODUCT_NAME: process.env.NEXT_PUBLIC_PRODUCT_NAME,
    TZ: process.env.TZ,
  };
  // The hold countdown formats in the PROCESS time zone, so a snapshot written
  // in one city would fail in another (or on CI) without this.
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
}));
vi.mock('@/lib/api', () => api);
// The real `publicLocale()` reads `?lang=` from the query the middleware
// forwards when a page passes none; `eventPage` sets what that query carries.
const forwarded = vi.hoisted(() => ({ lang: undefined as string | undefined }));
vi.mock('@/lib/locale', () => ({
  publicLocale: async (lang?: string) => ((lang ?? forwarded.lang) === 'es' ? 'es' : 'en'),
}));
vi.mock('@/lib/theme.server', () => ({ resolveDocumentTheme: async () => 'dark' }));
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
vi.mock('@/app/manage/[uid]/actions', () => ({
  cancelAction: vi.fn(),
  rescheduleAction: vi.fn(),
}));

import ProfilePage from './[handle]/page';
import BookingPage from './[handle]/[slug]/page';
import ManagePage from '../manage/[uid]/page';
import {
  BASE_STYLE,
  CANVASES,
  NOW,
  SLOT_LAYOUTS,
  TEMPLATES,
  availability,
  booking,
  pretty,
  profile,
} from './__fixtures__/public-surface';

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

const SNAP = './__snapshots__/public-markup';

async function render(page: Promise<ReactElement>): Promise<string> {
  return pretty(renderToStaticMarkup(await page));
}

// Each render starts from a request with no `?lang=`.
afterEach(() => {
  forwarded.lang = undefined;
});

function eventPage(query: Record<string, string> = {}) {
  forwarded.lang = query.lang;
  return BookingPage({
    params: Promise.resolve({ accountCode: 'northwind', handle: 'riley-chen', slug: 'design-review' }),
    searchParams: Promise.resolve(query),
  });
}

describe('the profile page renders byte for byte', () => {
  for (const theme of CANVASES) {
    it(theme, async () => {
      api.getProfile.mockResolvedValue(profile({ ...BASE_STYLE, theme }));
      const html = await render(
        ProfilePage({
          params: Promise.resolve({ accountCode: 'northwind', handle: 'riley-chen' }),
          searchParams: Promise.resolve({}),
        }),
      );
      await expect(html).toMatchFileSnapshot(`${SNAP}/profile-${theme}.html`);
    });
  }
});

describe('the event page renders byte for byte', () => {
  for (const template of TEMPLATES) {
    for (const theme of CANVASES) {
      for (const slotLayout of SLOT_LAYOUTS) {
        const name = `event-${template}-${theme}-${slotLayout}`;
        it(name, async () => {
          api.getProfile.mockResolvedValue(profile({ ...BASE_STYLE, template, theme, slotLayout }));
          api.getAvailability.mockResolvedValue(availability());
          await expect(await render(eventPage())).toMatchFileSnapshot(`${SNAP}/${name}.html`);
        });
      }
    }
  }

  it('in Spanish', async () => {
    api.getProfile.mockResolvedValue(profile({ ...BASE_STYLE, theme: 'light' }));
    api.getAvailability.mockResolvedValue(availability());
    await expect(await render(eventPage({ lang: 'es' }))).toMatchFileSnapshot(`${SNAP}/event-classic-light-grid.es.html`);
  });

  it('with no stored style at all (what a host who never opened the studio gets)', async () => {
    api.getProfile.mockResolvedValue(profile({}, null));
    api.getAvailability.mockResolvedValue(availability());
    await expect(await render(eventPage())).toMatchFileSnapshot(`${SNAP}/event-unstyled.html`);
  });

  it('inside the inline embed, with the snippet overriding the accent and the canvas', async () => {
    api.getProfile.mockResolvedValue(profile({ ...BASE_STYLE, theme: 'dark' }));
    api.getAvailability.mockResolvedValue(availability());
    const html = await render(eventPage({ embed: '1', brand_color: 'e5484d', theme: 'light' }));
    await expect(html).toMatchFileSnapshot(`${SNAP}/embed.html`);
  });
});

describe('the manage page renders byte for byte', () => {
  it('an upcoming booking, with times to move it to', async () => {
    // The page wears the host's branding, read through the booking's context.
    api.getProfile.mockResolvedValue(profile({ ...BASE_STYLE, theme: 'light' }));
    api.getManageView.mockResolvedValue({ ok: true, booking: booking() });
    api.getAvailability.mockResolvedValue(availability());
    const html = await render(
      ManagePage({
        params: Promise.resolve({ uid: 'bk_pinned_0001' }),
        searchParams: Promise.resolve({ token: 'tok_pinned' }),
      }),
    );
    await expect(html).toMatchFileSnapshot(`${SNAP}/manage.html`);
  });

  it('a cancelled booking', async () => {
    api.getProfile.mockResolvedValue(profile({ ...BASE_STYLE, theme: 'dark' }));
    api.getManageView.mockResolvedValue({ ok: true, booking: booking({ status: 'cancelled' }) });
    const html = await render(
      ManagePage({
        params: Promise.resolve({ uid: 'bk_pinned_0001' }),
        searchParams: Promise.resolve({ token: 'tok_pinned' }),
      }),
    );
    await expect(html).toMatchFileSnapshot(`${SNAP}/manage-cancelled.html`);
  });
});

/** A host's verdict: a link with one event type opens the event, not a list of one. */
describe('the handle route', () => {
  const profilePage = (query: Record<string, string> = {}) =>
    ProfilePage({
      params: Promise.resolve({ accountCode: 'northwind', handle: 'riley-chen' }),
      searchParams: Promise.resolve(query),
    });
  const oneEvent = (style: Record<string, unknown>) => {
    const p = profile({ ...BASE_STYLE, ...style });
    return { ...p, eventTypes: p.eventTypes.slice(0, 1) };
  };

  it('goes straight to the only event, carrying the query', async () => {
    api.getProfile.mockResolvedValue(oneEvent({ landingEnabled: true }));
    await expect(profilePage()).rejects.toThrow('redirect /northwind/riley-chen/design-review');
    await expect(profilePage({ embed: '1' })).rejects.toThrow('redirect /northwind/riley-chen/design-review?embed=1');
  });

  it('keeps the profile with ?landing=1 or "Always show my profile"', async () => {
    api.getProfile.mockResolvedValue(oneEvent({}));
    expect(await render(profilePage({ landing: '1' }))).toContain('bp-profile');
    api.getProfile.mockResolvedValue(oneEvent({ showProfile: true }));
    expect(await render(profilePage())).toContain('bp-profile');
  });

  it('keeps the profile with two event types (the pins above)', async () => {
    api.getProfile.mockResolvedValue(profile(BASE_STYLE));
    expect(await render(profilePage())).toContain('bp-event-list');
  });
});

/** With no signup destination the pages carry no call to action at all. */
describe('without a signup destination', () => {
  it('renders no free-calendar block on the profile, and no cover band either', async () => {
    const saved = process.env.NEXT_PUBLIC_SIGNUP_URL;
    delete process.env.NEXT_PUBLIC_SIGNUP_URL;
    try {
      api.getProfile.mockResolvedValue(profile(BASE_STYLE));
      const html = await render(
        ProfilePage({
          params: Promise.resolve({ accountCode: 'northwind', handle: 'riley-chen' }),
          searchParams: Promise.resolve({}),
        }),
      );
      expect(html).not.toContain('bp-growth');
      expect(html).not.toContain('bp-embed-footer');
      expect(html).not.toContain('bp-cover');
    } finally {
      process.env.NEXT_PUBLIC_SIGNUP_URL = saved;
    }
  });
});


describe('the host’s own tags on the event page', () => {
  it('an event with tracking ids gets their fallbacks; the page without stays as it was', async () => {
    api.getAvailability.mockResolvedValue(availability());
    const plain = profile({ ...BASE_STYLE, theme: 'light' });
    api.getProfile.mockResolvedValue(plain);
    const without = await render(eventPage());
    expect(without).not.toContain('tracking-');

    const tracked = profile({ ...BASE_STYLE, theme: 'light' });
    tracked.eventTypes[0] = { ...tracked.eventTypes[0]!, tracking: { gtmId: 'GTM-AB12', metaPixelId: '424242424242' } };
    api.getProfile.mockResolvedValue(tracked);
    const html = await render(eventPage());
    expect(html).toContain('data-testid="tracking-gtm-noscript"');
    expect(html).toContain('data-testid="tracking-meta-pixel-noscript"');
    expect(html).toContain('https://www.googletagmanager.com/ns.html?id=GTM-AB12');
  });
});
