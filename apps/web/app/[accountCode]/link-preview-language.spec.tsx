/**
 * A booking link pasted in a chat is previewed by a robot: Slack's states no
 * language (2026-11-24, `Slackbot-LinkExpanding`, no `Accept-Language`), so
 * every preview used to be English around a host's Spanish title ("Entrevista
 * oficina with Felipe", button "Book a time").
 *
 * For each public link (a person, one of their events, a team, a team event)
 * this drives the page's metadata and then the image route at the exact
 * address the metadata names, with the real language rule (`lib/locale.ts`):
 *   - a robot gets the host's language, in the words and in the picture;
 *   - `?lang=` still wins, for the words and the picture alike;
 *   - a person keeps their browser's language, as before;
 *   - with no host language on record, a robot gets English, as before.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Metadata } from 'next';
import type { NextRequest } from 'next/server';
import { getMessages } from '@slate/shared';

const request = vi.hoisted(() => ({ headers: {} as Record<string, string> }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => ({ get: (name: string) => request.headers[name.toLowerCase()] ?? null }),
}));

const api = vi.hoisted(() => ({ getProfile: vi.fn(), getTeamProfile: vi.fn() }));
vi.mock('@/lib/api', () => api);
vi.mock('@/lib/theme.server', () => ({ resolveDocumentTheme: async () => 'dark' }));
vi.mock('@/lib/og-image-source', () => ({ cardImageDataUri: async () => null }));

/** The route's input to the card, captured; nothing is drawn. */
const drawn = vi.hoisted(() => ({
  last: null as null | { cta: string; title: string },
  opts: undefined as undefined | { reusable?: boolean },
}));
vi.mock('@/lib/og-card', async (real) => {
  const mod = await real<typeof import('@/lib/og-card')>();
  return {
    ...mod,
    bookingCardResponse: (input: { cta: string; title: string }, opts?: { reusable?: boolean }) => {
      drawn.last = input;
      drawn.opts = opts;
      return new Response(null);
    },
  };
});

import { generateMetadata as profileMetadata } from './[handle]/page';
import { generateMetadata as eventMetadata } from './[handle]/[slug]/page';
import { generateMetadata as teamMetadata } from './team/[teamSlug]/page';
import { generateMetadata as teamEventMetadata } from './team/[teamSlug]/[slug]/page';
import { GET as profileImage } from './[handle]/card.png/route';
import { GET as eventImage } from './[handle]/[slug]/card.png/route';
import { GET as teamImage } from './team/[teamSlug]/card.png/route';
import { GET as teamEventImage } from './team/[teamSlug]/[slug]/card.png/route';

const SLACK = 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)';
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131 Safari/537.36';
const ES = getMessages('es').growth;
const EN = getMessages('en').growth;

function person(locale: 'en' | 'es' | null) {
  return {
    account: { code: 'northwind', name: 'Felipe' },
    member: {
      handle: 'felipe',
      displayName: 'Felipe',
      timeZone: 'America/Bogota',
      avatarUrl: null,
      connectedAvatarUrl: null,
      coverUrl: null,
      brandColor: '#c8e64a',
      layout: null,
      style: { theme: 'dark' },
      locale,
    },
    eventTypes: [
      { slug: 'entrevista-oficina', title: 'Entrevista oficina', description: null, lengthMinutes: 60, timeZone: 'America/Bogota' },
    ],
  };
}

function team(locale: 'en' | 'es' | null) {
  return {
    account: { code: 'northwind', name: 'Dapta' },
    team: { slug: 'ventas', name: 'Equipo comercial', logoUrl: null, timeZone: 'America/Bogota', locale },
    eventTypes: [
      { slug: 'demo', title: 'Demo de producto', description: null, lengthMinutes: 30, schedulingType: 'round_robin' },
    ],
    brand: null,
  };
}

const none = Promise.resolve({});
const surfaces = [
  {
    name: 'a person',
    words: { es: ES.seoProfile.replace('{name}', 'Felipe'), en: EN.seoProfile.replace('{name}', 'Felipe') },
    meta: () => profileMetadata({ params: Promise.resolve({ accountCode: 'northwind', handle: 'felipe' }), searchParams: none }),
    image: (url: string) =>
      profileImage(req(url), { params: Promise.resolve({ accountCode: 'northwind', handle: 'felipe' }) }),
    path: '/northwind/felipe',
  },
  {
    name: 'an event',
    words: { es: 'Entrevista oficina con Felipe', en: 'Entrevista oficina with Felipe' },
    meta: () =>
      eventMetadata({
        params: Promise.resolve({ accountCode: 'northwind', handle: 'felipe', slug: 'entrevista-oficina' }),
        searchParams: none,
      }),
    image: (url: string) =>
      eventImage(req(url), {
        params: Promise.resolve({ accountCode: 'northwind', handle: 'felipe', slug: 'entrevista-oficina' }),
      }),
    path: '/northwind/felipe/entrevista-oficina',
  },
  {
    name: 'a team',
    words: {
      es: ES.seoProfile.replace('{name}', 'Equipo comercial'),
      en: EN.seoProfile.replace('{name}', 'Equipo comercial'),
    },
    meta: () => teamMetadata({ params: Promise.resolve({ accountCode: 'northwind', teamSlug: 'ventas' }), searchParams: none }),
    image: (url: string) =>
      teamImage(req(url), { params: Promise.resolve({ accountCode: 'northwind', teamSlug: 'ventas' }) }),
    path: '/northwind/team/ventas',
  },
  {
    name: 'a team event',
    words: { es: 'Demo de producto con Equipo comercial', en: 'Demo de producto with Equipo comercial' },
    meta: () =>
      teamEventMetadata({
        params: Promise.resolve({ accountCode: 'northwind', teamSlug: 'ventas', slug: 'demo' }),
        searchParams: none,
      }),
    image: (url: string) =>
      teamEventImage(req(url), { params: Promise.resolve({ accountCode: 'northwind', teamSlug: 'ventas', slug: 'demo' }) }),
    path: '/northwind/team/ventas/demo',
  },
];

function req(url: string): NextRequest {
  return { nextUrl: new URL(url, 'https://book.example.test') } as NextRequest;
}

/** What a chat shows: the words, and the card drawn from the address the words name. */
async function preview(s: (typeof surfaces)[number]) {
  const md = (await s.meta()) as Metadata;
  const og = md.openGraph as { title: string; description: string; images: Array<{ url: string; alt: string }> };
  const tw = md.twitter as { card: string; images: Array<{ url: string }> };
  drawn.last = null;
  await s.image(og.images[0]!.url);
  return { og, tw, card: drawn.last! };
}

/** The text a surface's preview carries: an event's title, else its description. */
const textOf = (s: (typeof surfaces)[number], og: { title: string; description: string }) =>
  s.name.includes('event') ? og.title : og.description;

beforeEach(() => {
  request.headers = {};
  api.getProfile.mockReset();
  api.getTeamProfile.mockReset();
});

function hostSpeaks(locale: 'en' | 'es' | null) {
  api.getProfile.mockResolvedValue(person(locale));
  api.getTeamProfile.mockResolvedValue(team(locale));
}

describe('a link preview speaks the host language when the robot states none', () => {
  for (const s of surfaces) {
    it(`${s.name}: Slack gets Spanish words and a Spanish card for a Spanish host`, async () => {
      hostSpeaks('es');
      request.headers['user-agent'] = SLACK;
      const { og, tw, card } = await preview(s);
      expect(textOf(s, og)).toBe(s.words.es);
      expect(og.images[0]!.url).toBe(`${s.path}/card.png?lang=es`);
      expect(tw.card).toBe('summary_large_image');
      expect(tw.images[0]!.url).toBe(og.images[0]!.url);
      expect(card.cta).toBe(ES.shareCardCta);
      // The address names its language, so a shared cache may reuse it.
      expect(drawn.opts).toEqual({ reusable: true });
    });

    it(`${s.name}: ?lang=en still wins, in the words and the card alike`, async () => {
      hostSpeaks('es');
      request.headers['user-agent'] = SLACK;
      request.headers['x-slate-query'] = '?lang=en';
      const { og, card } = await preview(s);
      expect(textOf(s, og)).toBe(s.words.en);
      expect(og.images[0]!.url).toBe(`${s.path}/card.png?lang=en`);
      expect(card.cta).toBe(EN.shareCardCta);
    });

    it(`${s.name}: a person keeps their own browser language`, async () => {
      hostSpeaks('es');
      request.headers['user-agent'] = CHROME;
      request.headers['accept-language'] = 'en-US,en;q=0.9';
      const { og, card } = await preview(s);
      expect(textOf(s, og)).toBe(s.words.en);
      expect(og.images[0]!.url).toBe(`${s.path}/card.png?lang=en`);
      expect(card.cta).toBe(EN.shareCardCta);
    });

    it(`${s.name}: with no host language on record, a robot gets English as before`, async () => {
      hostSpeaks(null);
      request.headers['user-agent'] = SLACK;
      const { og, card } = await preview(s);
      expect(textOf(s, og)).toBe(s.words.en);
      expect(card.cta).toBe(EN.shareCardCta);
    });
  }

  it('an image address without lang (shared before the move) follows the same rule', async () => {
    hostSpeaks('es');
    request.headers['user-agent'] = 'Slackbot 1.0 (+https://api.slack.com/robots)';
    drawn.last = null;
    await eventImage(req('/northwind/felipe/entrevista-oficina/card.png?32d4739efa90c459'), {
      params: Promise.resolve({ accountCode: 'northwind', handle: 'felipe', slug: 'entrevista-oficina' }),
    });
    expect(drawn.last!.cta).toBe(ES.shareCardCta);
    // Its language came from this request's headers: no cache may hand it on.
    expect(drawn.opts).toEqual({ reusable: false });
  });

  it("the card's alt text is the preview's own headline, in its language", async () => {
    hostSpeaks('es');
    request.headers['user-agent'] = SLACK;
    const { og } = await preview(surfaces[1]!);
    expect(og.images[0]!.alt).toBe('Entrevista oficina con Felipe');
  });
});
