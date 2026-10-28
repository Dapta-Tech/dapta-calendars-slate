// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { AnalyticsConfig } from '@slate/shared';
import { connectPosthog, resetPosthogForTests } from '@/lib/analytics/posthog';
import {
  DEFAULT_POSTHOG_HOST,
  EVENT_OWNER_POSTHOG,
  META_PIXEL_SRC,
  hasAnyTracking,
  resetTrackingForTests,
  resolveTracking,
  startTracking,
  type TrackingWindow,
} from '@/lib/event-tracking';

type Queue = unknown[][] & Record<string, unknown>;
const w = () => window as unknown as TrackingWindow & { posthog?: Record<string, unknown> };
const scripts = () => [...document.head.querySelectorAll('script')].map((s) => ({ src: s.src, id: s.id }));

afterEach(() => {
  const win = w();
  delete win.dataLayer;
  delete win.fbq;
  delete win._fbq;
  delete win.posthog;
  document.head.innerHTML = '';
  resetTrackingForTests();
  resetPosthogForTests();
});

describe('resolveTracking', () => {
  it('trims, turns blank into off and defaults the PostHog host', () => {
    expect(resolveTracking({ gtmId: ' GTM-X1 ', metaPixelId: '  ', posthogKey: 'phc_k' })).toEqual({
      gtmId: 'GTM-X1',
      metaPixelId: null,
      posthogKey: 'phc_k',
      posthogHost: DEFAULT_POSTHOG_HOST,
      hubspotTrackingId: null,
    });
    expect(hasAnyTracking(resolveTracking(null))).toBe(false);
    expect(hasAnyTracking(resolveTracking({ posthogHost: 'https://eu.i.posthog.com' }))).toBe(false);
  });
});

describe('startTracking', () => {
  it('starts nothing and creates nothing for an event without ids', () => {
    startTracking(w(), resolveTracking(null));
    expect(scripts()).toEqual([]);
    expect(w().dataLayer).toBeUndefined();
    expect(w().fbq).toBeUndefined();
    expect(w().posthog).toBeUndefined();
  });

  it('Google Tag Manager: the gtm.js event first, then the container, its id as data', () => {
    startTracking(w(), resolveTracking({ gtmId: 'GTM-AB12' }));
    expect(w().dataLayer).toEqual([expect.objectContaining({ event: 'gtm.js' })]);
    expect(scripts()).toEqual([{ src: 'https://www.googletagmanager.com/gtm.js?id=GTM-AB12', id: '' }]);
  });

  it('Meta Pixel: its library, init with the id and exactly one PageView, however often it starts', () => {
    const t = resolveTracking({ metaPixelId: '123456789' });
    startTracking(w(), t);
    startTracking(w(), t);
    expect(scripts()).toEqual([{ src: META_PIXEL_SRC, id: '' }]);
    const queue = (w().fbq as unknown as { queue: unknown[][] }).queue.map((args) => [...args]);
    expect(queue).toEqual([
      ['init', '123456789'],
      ['track', 'PageView'],
    ]);
    // No PageView per history change: a step of the page is not a page.
    expect((w().fbq as unknown as { disablePushState?: boolean }).disablePushState).toBe(true);
  });

  it('Meta Pixel: an fbq already on the page is joined, never replaced', () => {
    const calls: unknown[][] = [];
    const existing = (...args: unknown[]) => void calls.push(args);
    w().fbq = existing;
    startTracking(w(), resolveTracking({ metaPixelId: '42' }));
    expect(w().fbq).toBe(existing);
    expect(calls).toEqual([
      ['init', '42'],
      ['track', 'PageView'],
    ]);
    expect(scripts()).toEqual([]);
  });

  it('HubSpot: the loader tag with the id HubSpot expects', () => {
    startTracking(w(), resolveTracking({ hubspotTrackingId: '24681357' }));
    expect(scripts()).toEqual([{ src: 'https://js.hs-scripts.com/24681357.js', id: 'hs-script-loader' }]);
  });

  it('an id reaches a URL encoded, never as markup', () => {
    startTracking(w(), resolveTracking({ gtmId: 'a&b=c', hubspotTrackingId: '1/../2' }));
    expect(scripts().map((s) => s.src)).toEqual([
      'https://www.googletagmanager.com/gtm.js?id=a%26b%3Dc',
      'https://js.hs-scripts.com/1%2F..%2F2.js',
    ]);
  });

  it('PostHog alone: the host’s project as its own named instance, pageview only, one pageview by hand', () => {
    startTracking(w(), resolveTracking({ posthogKey: 'phc_owner', posthogHost: 'https://eu.i.posthog.com' }));
    const global = w().posthog!;
    const [key, settings, name] = (global['_i'] as [string, Record<string, unknown>, string][])[0]!;
    expect([key, name]).toEqual(['phc_owner', EVENT_OWNER_POSTHOG]);
    // Events go to the host's address; nothing records what an invitee types.
    expect(settings).toEqual({
      api_host: 'https://eu.i.posthog.com',
      capture_pageview: false,
      capture_pageleave: false,
      autocapture: false,
      disable_session_recording: true,
      capture_heatmaps: false,
      capture_dead_clicks: false,
      rageclick: false,
      disable_surveys: true,
      capture_exceptions: false,
    });
    expect([...(global[EVENT_OWNER_POSTHOG] as Queue)]).toEqual([['capture', '$pageview']]);
    // The library from the vendor's CDN, never from the host's own server.
    expect(scripts()).toEqual([{ src: 'https://us-assets.i.posthog.com/static/array.js', id: '' }]);
  });

  it('PostHog first, dCal’s analytics second: one loader, one vendor library, both instances queued', () => {
    startTracking(w(), resolveTracking({ posthogKey: 'phc_owner', posthogHost: 'https://ph.selfhosted.example' }));
    const platform: AnalyticsConfig = { provider: 'posthog', key: 'phc_platform', host: 'https://us.i.posthog.com', errors: false };
    connectPosthog(platform, 'visitor', w() as never);
    const inits = ((w().posthog!['_i']) as unknown[][]).map(([k, , name]) => [k, name]);
    expect(inits).toEqual([
      ['phc_owner', EVENT_OWNER_POSTHOG],
      ['phc_platform', 'calendars_visitor'],
    ]);
    expect(scripts()).toEqual([{ src: 'https://us-assets.i.posthog.com/static/array.js', id: '' }]);
  });

  it('PostHog beside dCal’s own analytics: two named instances on one loader, neither touching the other', () => {
    const platform: AnalyticsConfig = { provider: 'posthog', key: 'phc_platform', host: 'https://us.i.posthog.com', errors: false };
    connectPosthog(platform, 'visitor', w() as never);
    startTracking(w(), resolveTracking({ posthogKey: 'phc_owner' }));
    const global = w().posthog!;
    const inits = (global['_i'] as unknown[][]).map(([key, , name]) => [key, name]);
    expect(inits).toEqual([
      ['phc_platform', 'calendars_visitor'],
      ['phc_owner', EVENT_OWNER_POSTHOG],
    ]);
    expect([...(global[EVENT_OWNER_POSTHOG] as Queue)]).toEqual([['capture', '$pageview']]);
    expect([...(global['calendars_visitor'] as Queue)]).toEqual([]);
    // One library request for both.
    expect(scripts()).toHaveLength(1);
  });

  it('a vendor that throws does not stop the others', () => {
    Object.defineProperty(window, 'fbq', {
      configurable: true,
      get: () => () => {
        throw new Error('blocked');
      },
      set: () => {},
    });
    try {
      expect(() =>
        startTracking(w(), resolveTracking({ metaPixelId: '42', gtmId: 'GTM-OK', hubspotTrackingId: '7' })),
      ).not.toThrow();
      expect(scripts().map((s) => s.src)).toEqual([
        'https://www.googletagmanager.com/gtm.js?id=GTM-OK',
        'https://js.hs-scripts.com/7.js',
      ]);
    } finally {
      Object.defineProperty(window, 'fbq', { configurable: true, writable: true, value: undefined });
    }
  });
});
