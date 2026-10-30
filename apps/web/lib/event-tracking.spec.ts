// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { AnalyticsConfig } from '@slate/shared';
import { connectPosthog, resetPosthogForTests } from '@/lib/analytics/posthog';
import { POSTHOG_JS_VERSION } from '@/lib/analytics/posthog';
import {
  DEFAULT_POSTHOG_HOST,
  EVENT_OWNER_POSTHOG,
  GA4_GTAG,
  GA4_LAYER,
  META_PIXEL_SRC,
  OWNER_POSTHOG_SETTINGS,
  ga4CookieSettings,
  hasAnyTracking,
  resetTrackingForTests,
  resolveTracking,
  startTracking,
  type TrackingWindow,
} from '@/lib/event-tracking';

type Queue = unknown[][] & Record<string, unknown>;
const w = () => window as unknown as TrackingWindow & { posthog?: Record<string, unknown> };
const scripts = () => [...document.head.querySelectorAll('script')].map((s) => ({ src: s.src, id: s.id }));

/** Valid ids, one per vendor, in each vendor's own format. */
const PIXEL = '123456789012345';
const PH_KEY = 'phc_abcdefghijklmnopqrstuvwxyz0123456789';

afterEach(() => {
  const win = w();
  delete win.dataLayer;
  delete win[GA4_GTAG];
  delete win[GA4_LAYER];
  delete win.fbq;
  delete win._fbq;
  delete win.posthog;
  document.head.innerHTML = '';
  resetTrackingForTests();
  resetPosthogForTests();
});

describe('resolveTracking', () => {
  it('checks each id against its vendor format, turns blank into off and defaults the PostHog host', () => {
    expect(resolveTracking({ gtmId: ' gtm-x1y2z3 ', ga4Id: 'g-abc123xyz9', metaPixelId: '  ', posthogKey: PH_KEY })).toEqual({
      gtmId: 'GTM-X1Y2Z3',
      ga4Id: 'G-ABC123XYZ9',
      metaPixelId: null,
      posthogKey: PH_KEY,
      posthogHost: DEFAULT_POSTHOG_HOST,
      hubspotTrackingId: null,
    });
    expect(hasAnyTracking(resolveTracking(null))).toBe(false);
    expect(hasAnyTracking(resolveTracking({ posthogHost: 'https://eu.i.posthog.com' }))).toBe(false);
    expect(hasAnyTracking(resolveTracking({ ga4Id: 'G-ABC123XYZ9' }))).toBe(true);
  });

  it('never takes an id the save would refuse, whatever the API handed over', () => {
    expect(resolveTracking({ metaPixelId: '"><script>', gtmId: 'a&b=c', hubspotTrackingId: '1/../2' })).toEqual(resolveTracking(null));
    // A PostHog host that is not PostHog's own cloud: no PostHog at all, never
    // that host and never a cloud the host did not choose.
    expect(resolveTracking({ posthogKey: PH_KEY, posthogHost: 'https://ph.selfhosted.example' }).posthogKey).toBeNull();
  });
});

describe('startTracking', () => {
  it('starts nothing and creates nothing for an event without ids', () => {
    startTracking(w(), resolveTracking(null));
    expect(scripts()).toEqual([]);
    expect(w().dataLayer).toBeUndefined();
    expect(w()[GA4_GTAG]).toBeUndefined();
    expect(w().fbq).toBeUndefined();
    expect(w().posthog).toBeUndefined();
  });

  it('Google Tag Manager: the gtm.js event first, then the container, its id as data', () => {
    startTracking(w(), resolveTracking({ gtmId: 'GTM-AB12CD' }));
    expect(w().dataLayer).toEqual([expect.objectContaining({ event: 'gtm.js' })]);
    expect(scripts()).toEqual([{ src: 'https://www.googletagmanager.com/gtm.js?id=GTM-AB12CD', id: '' }]);
  });

  it('Google Analytics 4: gtag on GA4’s own layer, its library once, and the config that sends the page view', () => {
    const t = resolveTracking({ ga4Id: 'G-ABC123XYZ9' });
    startTracking(w(), t);
    startTracking(w(), t);
    expect(scripts()).toEqual([{ src: `https://www.googletagmanager.com/gtag/js?id=G-ABC123XYZ9&l=${GA4_LAYER}`, id: '' }]);
    const commands = (w()[GA4_LAYER] as IArguments[]).map((args) => [...args]);
    expect(commands).toEqual([['js', expect.any(Date)], ['config', 'G-ABC123XYZ9', ga4CookieSettings(window.location.protocol)]]);
    // Never the page-wide names a container (or another snippet) uses.
    expect(w().dataLayer).toBeUndefined();
    expect((w() as unknown as { gtag?: unknown }).gtag).toBeUndefined();
  });

  it('GA4 cookies: host-only everywhere, SameSite=None; Secure; Partitioned only over https', () => {
    expect(ga4CookieSettings('https:')).toEqual({ cookie_domain: 'none', cookie_flags: 'SameSite=None;Secure;Partitioned' });
    // A plain-http self-host would refuse Secure cookies, and gtag would then send nothing.
    expect(ga4CookieSettings('http:')).toEqual({ cookie_domain: 'none' });
  });

  it('GA4 beside a GTM container: two layers, so the container never hears GA4’s commands', () => {
    startTracking(w(), resolveTracking({ gtmId: 'GTM-AB12CD', ga4Id: 'G-ABC123XYZ9' }));
    expect(w().dataLayer).toEqual([expect.objectContaining({ event: 'gtm.js' })]);
    expect(w()[GA4_LAYER]).toHaveLength(2);
    expect(scripts().map((s) => s.src)).toEqual([
      'https://www.googletagmanager.com/gtm.js?id=GTM-AB12CD',
      `https://www.googletagmanager.com/gtag/js?id=G-ABC123XYZ9&l=${GA4_LAYER}`,
    ]);
  });

  it('Meta Pixel: its library, automatic events off, init with the id and exactly one PageView, however often it starts', () => {
    const t = resolveTracking({ metaPixelId: PIXEL });
    startTracking(w(), t);
    startTracking(w(), t);
    expect(scripts()).toEqual([{ src: META_PIXEL_SRC, id: '' }]);
    const queue = (w().fbq as unknown as { queue: unknown[][] }).queue.map((args) => [...args]);
    expect(queue).toEqual([
      // Meta's automatic events read the page's fields: here, the invitee's.
      ['set', 'autoConfig', false, PIXEL],
      ['init', PIXEL],
      ['track', 'PageView'],
    ]);
    // No PageView per history change: a step of the page is not a page.
    expect((w().fbq as unknown as { disablePushState?: boolean }).disablePushState).toBe(true);
  });

  it('Meta Pixel: an fbq already on the page is joined, never replaced', () => {
    const calls: unknown[][] = [];
    const existing = (...args: unknown[]) => void calls.push(args);
    w().fbq = existing;
    startTracking(w(), resolveTracking({ metaPixelId: PIXEL }));
    expect(w().fbq).toBe(existing);
    expect(calls).toEqual([
      ['set', 'autoConfig', false, PIXEL],
      ['init', PIXEL],
      ['track', 'PageView'],
    ]);
    expect(scripts()).toEqual([]);
  });

  it('HubSpot: the loader tag with the id HubSpot expects', () => {
    startTracking(w(), resolveTracking({ hubspotTrackingId: '24681357' }));
    expect(scripts()).toEqual([{ src: 'https://js.hs-scripts.com/24681357.js', id: 'hs-script-loader' }]);
  });

  it('PostHog alone: the host’s project as its own named instance, nothing loaded from it, one pageview by hand', () => {
    startTracking(w(), resolveTracking({ posthogKey: PH_KEY, posthogHost: 'https://eu.i.posthog.com' }));
    const global = w().posthog!;
    const [key, settings, name] = (global['_i'] as [string, Record<string, unknown>, string][])[0]!;
    expect([key, name]).toEqual([PH_KEY, EVENT_OWNER_POSTHOG]);
    // Events go to the host's PostHog cloud; nothing records what an invitee
    // types, and nothing the project configures (remote config, flags, any
    // extension script) is ever loaded.
    expect(settings).toEqual({ api_host: 'https://eu.i.posthog.com', ...OWNER_POSTHOG_SETTINGS });
    expect(settings).toMatchObject({
      disable_external_dependency_loading: true,
      advanced_disable_flags: true,
      disable_web_experiments: true,
      disable_product_tours: true,
      disable_conversations: true,
      disable_surveys: true,
      opt_in_site_apps: false,
      autocapture: false,
      disable_session_recording: true,
      persistence: 'memory',
    });
    expect([...(global[EVENT_OWNER_POSTHOG] as Queue)]).toEqual([['capture', '$pageview']]);
    // The library from the vendor's CDN, never from the host's own server.
    expect(scripts()).toEqual([{ src: `https://us-assets.i.posthog.com/static/${POSTHOG_JS_VERSION}/array.js`, id: '' }]);
  });

  it('PostHog with a host that is not PostHog’s own cloud: no PostHog at all', () => {
    startTracking(w(), resolveTracking({ posthogKey: PH_KEY, posthogHost: 'https://ph.selfhosted.example' }));
    expect(w().posthog).toBeUndefined();
    expect(scripts()).toEqual([]);
  });

  it('PostHog first, dCal’s analytics second: one loader, one vendor library, both instances queued', () => {
    startTracking(w(), resolveTracking({ posthogKey: PH_KEY, posthogHost: 'https://eu.i.posthog.com' }));
    const platform: AnalyticsConfig = { provider: 'posthog', key: 'phc_platform', host: 'https://us.i.posthog.com', errors: false };
    connectPosthog(platform, 'visitor', w() as never);
    const inits = ((w().posthog!['_i']) as unknown[][]).map(([k, , name]) => [k, name]);
    expect(inits).toEqual([
      [PH_KEY, EVENT_OWNER_POSTHOG],
      ['phc_platform', 'calendars_visitor'],
    ]);
    expect(scripts()).toEqual([{ src: `https://us-assets.i.posthog.com/static/${POSTHOG_JS_VERSION}/array.js`, id: '' }]);
  });

  it('PostHog beside dCal’s own analytics: two named instances on one loader, neither touching the other', () => {
    const platform: AnalyticsConfig = { provider: 'posthog', key: 'phc_platform', host: 'https://us.i.posthog.com', errors: false };
    connectPosthog(platform, 'visitor', w() as never);
    startTracking(w(), resolveTracking({ posthogKey: PH_KEY }));
    const global = w().posthog!;
    const inits = (global['_i'] as unknown[][]).map(([key, , name]) => [key, name]);
    expect(inits).toEqual([
      ['phc_platform', 'calendars_visitor'],
      [PH_KEY, EVENT_OWNER_POSTHOG],
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
        startTracking(w(), resolveTracking({ metaPixelId: PIXEL, gtmId: 'GTM-OKOK', hubspotTrackingId: '7' })),
      ).not.toThrow();
      expect(scripts().map((s) => s.src)).toEqual([
        'https://www.googletagmanager.com/gtm.js?id=GTM-OKOK',
        'https://js.hs-scripts.com/7.js',
      ]);
    } finally {
      Object.defineProperty(window, 'fbq', { configurable: true, writable: true, value: undefined });
    }
  });
});
