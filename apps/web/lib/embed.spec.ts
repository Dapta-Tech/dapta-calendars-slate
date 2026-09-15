import { describe, expect, it } from 'vitest';
import { bookingPageStyleSchema } from '@slate/types';
import {
  EMBED_STYLE_PARAMS,
  embedSnippet,
  embedSrcPath,
  isEmbedRequest,
  mergeEmbedStyle,
  parseAccentParam,
  parseEmbedParams,
  searchParamsFromQuery,
  withSearchParams,
} from './embed';

describe('isEmbedRequest', () => {
  it('accepts the canonical value and the one a host hand-writes', () => {
    expect(isEmbedRequest({ embed: '1' })).toBe(true);
    expect(isEmbedRequest({ embed: 'true' })).toBe(true);
    expect(isEmbedRequest({ embed: 'TRUE' })).toBe(true);
  });

  it('refuses everything else, so a page never renders AS an embed by accident', () => {
    expect(isEmbedRequest(undefined)).toBe(false);
    expect(isEmbedRequest({})).toBe(false);
    expect(isEmbedRequest({ embed: '0' })).toBe(false);
    expect(isEmbedRequest({ embed: 'false' })).toBe(false);
    expect(isEmbedRequest({ embed: '' })).toBe(false);
    expect(isEmbedRequest({ embed: 'yes' })).toBe(false);
  });

  it('reads the first value when the key repeats', () => {
    expect(isEmbedRequest({ embed: ['1', '0'] })).toBe(true);
    expect(isEmbedRequest({ embed: ['0', '1'] })).toBe(false);
  });
});

describe('parseAccentParam', () => {
  it('takes six hex digits with or without the hash', () => {
    expect(parseAccentParam('#1A73E8')).toBe('#1a73e8');
    expect(parseAccentParam('1a73e8')).toBe('#1a73e8');
    expect(parseAccentParam('  #1a73e8  ')).toBe('#1a73e8');
  });

  it('drops anything that is not a six-digit hex', () => {
    expect(parseAccentParam(undefined)).toBeNull();
    expect(parseAccentParam('')).toBeNull();
    expect(parseAccentParam('#abc')).toBeNull();
    expect(parseAccentParam('rebeccapurple')).toBeNull();
    expect(parseAccentParam('#1a73e88')).toBeNull();
    expect(parseAccentParam('#zzzzzz')).toBeNull();
  });
});

describe('parseEmbedParams', () => {
  it('ignores overrides entirely outside embed mode', () => {
    const r = parseEmbedParams({ corners: 'round', brand_color: '#1a73e8' });
    expect(r).toEqual({ embed: false, brandColor: null, style: {} });
  });

  it('reads the accent and all ten axes under embed=1', () => {
    const r = parseEmbedParams({
      embed: '1',
      brand_color: '%231a73e8'.replace('%23', '#'),
      template: 'split',
      card_style: 'elevated',
      corners: 'round',
      buttons: 'pill',
      density: 'compact',
      font: 'serif',
      slot_layout: 'list',
      day_group: 'boxed',
      slot_select: 'solid',
      theme: 'dark',
    });
    expect(r.embed).toBe(true);
    expect(r.brandColor).toBe('#1a73e8');
    expect(r.style).toEqual({
      template: 'split',
      cardStyle: 'elevated',
      corners: 'round',
      buttons: 'pill',
      density: 'compact',
      font: 'serif',
      slotLayout: 'list',
      dayGroup: 'boxed',
      slotSelect: 'solid',
      theme: 'dark',
    });
  });

  it('drops ONE bad axis and keeps the rest — a typo never takes the page down', () => {
    const r = parseEmbedParams({
      embed: '1',
      corners: 'rounded-ish',
      font: 'serif',
      brand_color: 'not-a-color',
    });
    expect(r.style).toEqual({ font: 'serif' });
    expect(r.brandColor).toBeNull();
  });

  it('never exposes the behaviour keys of the same schema', () => {
    const r = parseEmbedParams({
      embed: '1',
      landing_enabled: 'false',
      default_event_slug: 'somewhere-else',
      bio: 'rewritten',
      landingEnabled: 'false',
      defaultEventSlug: 'somewhere-else',
    });
    expect(r.style).toEqual({});
  });

  // The tenth axis (B2, #109). It is the one that changes the page's GROUND, so
  // it gets its own cases rather than only riding the all-axes sweep above: a
  // host pasting a booking page into a dark site is the reason it is overridable
  // at all, and a typo there must cost the canvas and nothing else.
  it('takes the canvas override, on both grounds', () => {
    expect(parseEmbedParams({ embed: '1', theme: 'dark' }).style).toEqual({ theme: 'dark' });
    expect(parseEmbedParams({ embed: '1', theme: 'light' }).style).toEqual({ theme: 'light' });
  });

  it('drops a canvas it does not recognise and keeps every other axis', () => {
    const r = parseEmbedParams({ embed: '1', theme: 'nonsense', corners: 'round', font: 'serif' });
    expect(r.style).toEqual({ corners: 'round', font: 'serif' });
  });

  it('ignores the canvas override entirely outside embed mode', () => {
    expect(parseEmbedParams({ theme: 'dark' }).style).toEqual({});
  });
});

/**
 * The two callers that are NOT a route — the root layout, which gets the query
 * as a middleware header, and `ThemeStamp`, which reads `location.search` —
 * rebuild `searchParams` through this and then use the SAME `parseEmbedParams`.
 * A drift here is a document stamped on one canvas around a shell painted on
 * the other, which is the bug the single parser exists to prevent.
 */
describe('searchParamsFromQuery', () => {
  it('round-trips a query into the shape a route is handed', () => {
    expect(searchParamsFromQuery('?embed=1&theme=dark')).toEqual({ embed: '1', theme: 'dark' });
    expect(searchParamsFromQuery('embed=1&theme=dark')).toEqual({ embed: '1', theme: 'dark' });
  });

  it('is empty for a request that carries no query at all', () => {
    for (const q of ['', '?', null, undefined]) expect(searchParamsFromQuery(q)).toEqual({});
  });

  it('keeps a repeated key in order, leaving first-value-wins to the parser', () => {
    expect(searchParamsFromQuery('?theme=dark&theme=light')).toEqual({ theme: ['dark', 'light'] });
    expect(parseEmbedParams(searchParamsFromQuery('?embed=1&theme=dark&theme=light')).style).toEqual({
      theme: 'dark',
    });
  });

  it('decodes, so a token beside the override survives it', () => {
    const params = searchParamsFromQuery('?token=a%2Bb%2Fc&embed=1&theme=dark');
    expect(params.token).toBe('a+b/c');
    expect(parseEmbedParams(params).style).toEqual({ theme: 'dark' });
  });
});

describe('mergeEmbedStyle', () => {
  it('leaves the server style untouched when nothing was overridden', () => {
    const server = { corners: 'soft' };
    expect(mergeEmbedStyle(server, {})).toBe(server);
    expect(mergeEmbedStyle(null, {})).toBeNull();
  });

  it('lays overrides over the server value, key by key', () => {
    expect(mergeEmbedStyle({ corners: 'soft', font: 'sans' }, { corners: 'round' })).toEqual({
      corners: 'round',
      font: 'sans',
    });
  });

  it('is the whole style when the route holds none — the team pages', () => {
    expect(mergeEmbedStyle(null, { corners: 'round' })).toEqual({ corners: 'round' });
  });
});

describe('withSearchParams', () => {
  it('carries the embed and its overrides through a redirect', () => {
    expect(withSearchParams('/acme/alex/intro', { embed: '1', corners: 'round' })).toBe(
      '/acme/alex/intro?embed=1&corners=round',
    );
  });

  it('returns a bare path when there is no query', () => {
    expect(withSearchParams('/acme/alex', {})).toBe('/acme/alex');
    expect(withSearchParams('/acme/alex', undefined)).toBe('/acme/alex');
    expect(withSearchParams('/acme/alex', { lang: undefined })).toBe('/acme/alex');
  });

  it('encodes, and keeps every value of a repeated key', () => {
    expect(withSearchParams('/p', { brand_color: '#1a73e8' })).toBe('/p?brand_color=%231a73e8');
    expect(withSearchParams('/p', { lang: ['es', 'en'] })).toBe('/p?lang=es&lang=en');
  });
});

describe('embedSrcPath / embedSnippet', () => {
  it('points the iframe at the public path in embed mode', () => {
    expect(embedSrcPath('/acme/alex/intro')).toBe('/acme/alex/intro?embed=1');
  });

  it('adds the accent only when the host picked a real one', () => {
    expect(embedSrcPath('/acme/alex/intro', '#1a73e8')).toBe(
      '/acme/alex/intro?embed=1&brand_color=%231a73e8',
    );
    expect(embedSrcPath('/acme/alex/intro', 'nope')).toBe('/acme/alex/intro?embed=1');
    expect(embedSrcPath('/acme/alex/intro', null)).toBe('/acme/alex/intro?embed=1');
  });

  it('writes the iframe FIRST, so the snippet renders with the script blocked', () => {
    const s = embedSnippet({
      origin: 'https://cal.example.com',
      publicPath: '/acme/alex/intro',
      title: 'Book a meeting',
    });
    expect(s.indexOf('<iframe')).toBeLessThan(s.indexOf('<script'));
    expect(s).toContain('data-dapta-calendars');
    expect(s).toContain('src="https://cal.example.com/acme/alex/intro?embed=1"');
    expect(s).toContain('min-height:700px');
    expect(s).toContain('<script src="https://cal.example.com/embed.js" async></script>');
  });

  it('escapes a quote in the title rather than breaking out of the attribute', () => {
    const s = embedSnippet({
      origin: 'https://cal.example.com',
      publicPath: '/acme/alex/intro',
      title: 'The "quick" chat',
    });
    expect(s).toContain('title="The &quot;quick&quot; chat"');
  });

  it('escapes the ampersand a two-param src always has', () => {
    const s = embedSnippet({
      origin: 'https://cal.example.com',
      publicPath: '/acme/alex/intro',
      brandColor: '#1a73e8',
      title: 'Sales & Marketing',
    });
    expect(s).toContain('?embed=1&amp;brand_color=%231a73e8"');
    expect(s).toContain('title="Sales &amp; Marketing"');
  });

  /**
   * The studio builds this path from the handle field as it is TYPED, so it is
   * raw input until the save round-trip — a space or a quote used to produce a
   * snippet with a broken `src`.
   */
  it('encodes a path segment a host is still typing', () => {
    expect(embedSrcPath('/acme/alex rivera')).toBe('/acme/alex%20rivera?embed=1');
    const s = embedSnippet({
      origin: 'https://cal.example.com',
      publicPath: '/acme/al"ex',
      title: 'x',
    });
    expect(s).toContain('/acme/al%22ex?embed=1"');
    expect(s).not.toContain('al"ex');
  });
});

/**
 * The override map has to stay exactly the APPEARANCE half of the style
 * contract. A tenth axis added upstream would otherwise be silently
 * un-overridable, and a behaviour key added to the map would let a URL change
 * what the page does rather than how it looks.
 */
describe('EMBED_STYLE_PARAMS covers the appearance half of the contract', () => {
  const BEHAVIOUR_KEYS = ['landingEnabled', 'defaultEventSlug', 'bio'];

  it('maps every appearance axis and no behaviour key', () => {
    const inContract = Object.keys(bookingPageStyleSchema.shape);
    const expected = inContract.filter((k) => !BEHAVIOUR_KEYS.includes(k)).sort();
    expect(Object.values(EMBED_STYLE_PARAMS).slice().sort()).toEqual(expected);
    for (const key of BEHAVIOUR_KEYS) {
      expect(Object.values(EMBED_STYLE_PARAMS)).not.toContain(key);
    }
  });
});
