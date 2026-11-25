/**
 * The link-preview image's address. The page names it with the language it
 * chose (`?lang=`), so the words and the picture of one preview agree; the old
 * `opengraph-image` address, already in previews people shared, still draws
 * the card; and no event can take a link name one of those routes answers on.
 */
import { describe, expect, it } from 'vitest';
import { RESERVED_EVENT_SLUGS, eventTypeInputSchema } from '@slate/types';
import { CARD_FILE, cardUrl, previewMetadata } from './share-card';

describe('the card address', () => {
  it("names the page's language", () => {
    expect(cardUrl('/northwind/riley-chen/design-review', 'es')).toBe('/northwind/riley-chen/design-review/card.png?lang=es');
  });

  it('puts the same large image on Open Graph and X, with its headline as alt text', () => {
    const md = previewMetadata({
      pagePath: '/northwind/riley-chen',
      locale: 'en',
      title: 'Riley Chen',
      description: 'Book time with Riley Chen online.',
      type: 'profile',
      alt: 'Riley Chen',
    });
    const og = md.openGraph as { images: Array<{ url: string; width: number; height: number; alt: string }> };
    const tw = md.twitter as { card: string; images: Array<{ url: string }> };
    expect(og.images).toEqual([
      { url: '/northwind/riley-chen/card.png?lang=en', width: 1200, height: 630, type: 'image/png', alt: 'Riley Chen' },
    ]);
    expect(tw.card).toBe('summary_large_image');
    expect(tw.images[0]!.url).toBe(og.images[0]!.url);
  });
});

describe('the old address', () => {
  it('is rewritten to the card for a profile and an event, after the static routes and before [slug]', async () => {
    const config = (await import('../next.config.mjs')).default;
    const rewrites = (await config.rewrites?.()) as { afterFiles: Array<{ source: string; destination: string }> };
    expect(rewrites.afterFiles).toEqual(
      expect.arrayContaining([
        { source: '/:accountCode/:handle/opengraph-image', destination: `/:accountCode/:handle/${CARD_FILE}` },
        { source: '/:accountCode/:handle/:slug/opengraph-image', destination: `/:accountCode/:handle/:slug/${CARD_FILE}` },
      ]),
    );
  });
});

describe('reserved link names', () => {
  const event = { title: 'Intro', lengthMinutes: 30 };

  it('refuses an event named after a route the page answers on', () => {
    for (const slug of [...RESERVED_EVENT_SLUGS, 'Card.PNG', ' opengraph-image ']) {
      expect(eventTypeInputSchema.safeParse({ ...event, slug }).success, slug).toBe(false);
    }
    expect(RESERVED_EVENT_SLUGS).toContain(CARD_FILE);
  });

  it('accepts every ordinary link name', () => {
    for (const slug of ['intro', 'card', 'opengraph', 'card-png']) {
      expect(eventTypeInputSchema.safeParse({ ...event, slug }).success, slug).toBe(true);
    }
  });
});
