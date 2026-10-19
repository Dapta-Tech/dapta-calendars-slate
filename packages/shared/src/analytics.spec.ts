import { describe, it, expect } from 'vitest';
import { buildSignupUrl, parseAttribution } from './growth';
import {
  ANALYTICS_EVENT_PREFIX,
  BROWSER_ANALYTICS_EVENTS,
  POSTHOG_DEFAULT_HOST,
  SERVER_ANALYTICS_EVENTS,
  analyticsCampaignValue,
  analyticsEventName,
  isInternalEmail,
  parseInternalEmailPatterns,
  referrerDomain,
  resolveAnalyticsConfig,
  sanitizeLandingDistinctId,
} from './analytics';

describe('resolveAnalyticsConfig', () => {
  it('is off when nothing is set (the fork default)', () => {
    expect(resolveAnalyticsConfig({})).toBeNull();
  });

  it('is off with a provider but no key, and with a key but no provider', () => {
    expect(resolveAnalyticsConfig({ provider: 'posthog' })).toBeNull();
    expect(resolveAnalyticsConfig({ provider: 'posthog', key: '   ' })).toBeNull();
    expect(resolveAnalyticsConfig({ key: 'phc_test' })).toBeNull();
    expect(resolveAnalyticsConfig({ provider: 'none', key: 'phc_test' })).toBeNull();
  });

  it('refuses a read credential in the place of the write-only key, since the key is published', () => {
    expect(resolveAnalyticsConfig({ provider: 'posthog', key: 'phx_personal_read_key' })).toBeNull();
    expect(resolveAnalyticsConfig({ provider: 'posthog', key: 'PHX_upper' })).toBeNull();
  });

  it('is off for a provider this repo does not ship', () => {
    expect(resolveAnalyticsConfig({ provider: 'acme', key: 'k' })).toBeNull();
  });

  it('falls back to the vendor host and trims a trailing slash', () => {
    expect(resolveAnalyticsConfig({ provider: 'posthog', key: 'phc_test' })).toEqual({
      provider: 'posthog',
      key: 'phc_test',
      host: POSTHOG_DEFAULT_HOST,
    });
    expect(
      resolveAnalyticsConfig({ provider: ' PostHog ', key: 'phc_test', host: 'https://e.example.com/' })?.host,
    ).toBe('https://e.example.com');
  });

  it('refuses a host that is not http(s), rather than load a script from it', () => {
    expect(resolveAnalyticsConfig({ provider: 'posthog', key: 'k', host: 'javascript:alert(1)' })).toBeNull();
    expect(resolveAnalyticsConfig({ provider: 'posthog', key: 'k', host: 'e.example.com' })).toBeNull();
    expect(resolveAnalyticsConfig({ provider: 'posthog', key: 'k', host: 'https://e.example.com?x=1' })).toBeNull();
  });
});

describe('event names', () => {
  it('prefixes every event, and the two lists never share a name', () => {
    expect(analyticsEventName('booking_created')).toBe('calendars_booking_created');
    const all = [...SERVER_ANALYTICS_EVENTS, ...BROWSER_ANALYTICS_EVENTS];
    expect(new Set(all).size).toBe(all.length);
    for (const e of all) expect(analyticsEventName(e).startsWith(ANALYTICS_EVENT_PREFIX)).toBe(true);
  });
});

describe('isInternalEmail', () => {
  const patterns = parseInternalEmailPatterns(' Example , @staff.test,, +');

  it('parses a comma list, lower-cased, empties dropped', () => {
    expect(patterns).toEqual(['example', '@staff.test', '+']);
    expect(parseInternalEmailPatterns(undefined)).toEqual([]);
  });

  it('matches a case-insensitive substring, like ILIKE', () => {
    expect(isInternalEmail('Ana@EXAMPLE.com', patterns)).toBe(true);
    expect(isInternalEmail('bo@staff.test', patterns)).toBe(true);
    expect(isInternalEmail('cy+demo@gmail.com', patterns)).toBe(true);
    expect(isInternalEmail('dee@customer.io', patterns)).toBe(false);
  });

  it('marks nobody internal without patterns or without an email', () => {
    expect(isInternalEmail('ana@example.com', [])).toBe(false);
    expect(isInternalEmail(null, patterns)).toBe(false);
  });
});

describe('sanitizeLandingDistinctId', () => {
  it('keeps vendor-shaped ids', () => {
    expect(sanitizeLandingDistinctId('0198a1b2-c3d4-7e89-a1b2-c3d4e5f60718')).toBe(
      '0198a1b2-c3d4-7e89-a1b2-c3d4e5f60718',
    );
    expect(sanitizeLandingDistinctId('$device:0198a1b2')).toBe('$device:0198a1b2');
    expect(sanitizeLandingDistinctId(['first', 'second'])).toBe('first');
  });

  it('drops anything else, and anything too long', () => {
    expect(sanitizeLandingDistinctId('"><script>x')).toBeNull();
    expect(sanitizeLandingDistinctId('a b')).toBeNull();
    expect(sanitizeLandingDistinctId('')).toBeNull();
    expect(sanitizeLandingDistinctId(undefined)).toBeNull();
    expect(sanitizeLandingDistinctId('a'.repeat(201))).toBeNull();
  });
});

describe('analyticsCampaignValue', () => {
  it('keeps campaign labels, Dapta-made and ad-tool-made alike', () => {
    for (const v of [
      'made-with-dapta',
      'q3 launch',
      'q3: launch',
      '1234567890',
      '15551234567',
      'chatgpt.com',
      'www.google.com',
      'google/cpc',
      'q&a webinar',
      'at&t calendar',
      'video #2',
      '50% off',
      '20%descuento',
      '100%ad',
      "mother's day",
      'campaign | audience',
      'lanzamiento año',
      '2026 10 18',
      'q3 \u2013 launch',
      'dapta\u2019s webinar',
      '\u00A1oferta!',
      '\u20AC50 descuento',
      '$100 off',
      'dapta\u00AE',
      '\uD83D\uDE80 launch',
      'black friday \uD83D\uDD25',
      '\u30AD\u30E3\u30F3\u30DA\u30FC\u30F3',
      '\u4EBA\u3005',
      'q3 \u00B7 launch',
      'google / cpc / brand',
      '24/7 support',
      '"launch"',
      '[search] brand es',
      '{campaignid}',
      'launch_20261018_01',
      'email_campaign_2019_04_18_05_14',
      '2026-10-18-01',
      '12345678901_98765432101',
      '1234567890_2024',
      '\u2764\uFE0F promo',
      '\uD83D\uDC4D\uD83C\uDFFD deal',
      '\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67 familia',
      '\uD83C\uDDE8\uD83C\uDDF4 lanzamiento',
      '#\uFE0F\u20E3 hashtag',
      'webinar 18/10/2026',
      '10/18/2026',
      'v1.2/beta',
      '\u00BD price',
    ]) {
      expect([v, analyticsCampaignValue(v)]).toEqual([v, v]);
    }
    expect(analyticsCampaignValue('  padded  ')).toBe('padded');
  });

  it('decodes an encoding left over once, and refuses one left twice', () => {
    expect(analyticsCampaignValue('summer%20sale')).toBe('summer sale');
    expect(analyticsCampaignValue('ana%40example.com')).toBeNull();
    expect(analyticsCampaignValue('ana%2540example.com')).toBeNull();
    expect(analyticsCampaignValue('20%descuento%40x')).toBeNull();
    // Three levels: decoded once, still encoded, refused.
    expect(analyticsCampaignValue('summer%2520sale')).toBeNull();
  });

  it("passes the growth loop's own tags through the parser unchanged", () => {
    const url = buildSignupUrl({ baseUrl: 'https://signup.example.test', medium: 'badge', accountCode: 'k7m2qp' })!;
    const query = Object.fromEntries(new URLSearchParams(url.slice(url.indexOf('?') + 1)));
    const parsed = parseAttribution({ params: query })!;
    for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content'] as const) {
      expect(analyticsCampaignValue(parsed[key])).toBe(parsed[key]);
    }
  });

  /** Inputs, each refused by one rule in particular. */
  const withheld: Record<string, string[]> = {
    'characters outside the allowlist': [
      'ana@example.com',
      '@dapta_ai',
      'page?x',
      'a=1',
      'tom &amp; jerry',
      '\\\\evil.test\\reset',
      'ana\uFF20example.com',
      'https\u2236\u2215\u2215evil.test',
      'tel\uA789+15551234567',
      'evil\u3002test/reset',
      'tom ; jerry',
    ],
    'an invisible character': [
      '+1555\u200B1234567',
      'ana\u200F',
      '+1555\u034F1234567',
      '+1555\uFE0F1234567',
      '+1555\u180B1234567',
      '+1555\u31641234567',
      '+1555\uFFA01234567',
      'evil.test\u034F/reset',
    ],
    'a colon not followed by a space': ['tel:+15551234567', 'mailto:ana', 'example.com:8080', 'brand:search:exact'],
    'a path': [
      '//evil.test',
      'localhost/reset/abc',
      '/reset/8f3a9c1d2e',
      'fb/ig/stories',
      'reset/18/10/2026/8f3a9c1d2e',
      'blog/2026/10/18/post',
    ],
    'a host before a slash, or an IP address': [
      'linkedin.com/ana-smith',
      'LINKEDIN.COM/ANA',
      'evil.xn--p1ai/ana',
      'evil.\u0440\u0444/ana',
      '10.0.0.1/abc',
      'ip 192.168.0.10',
      'evil.test./ana',
      'see www.example.com/abc',
    ],
    'an HTML numeric entity': ['ana&#64example.com', '&#64dapta_ai', '&#x40;'],
    'a phone number': [
      '+15551234567',
      'tel+15551234567',
      'tel +15551234567',
      '57 300 123 4567',
      '57_300_123_4567',
      '(555) 123-4567',
      'cel 300 123 4567',
      '300 123 4567 ana',
      '\u0663\u0660\u0660 \u0661\u0662\u0663 \u0664\u0665\u0666\u0667',
      '555\u2013123\u20134567',
      '555,123,4567',
      '555|123|4567',
      '+57*300*123*4567',
      '555~123~4567',
      "555'123'4567",
      '555&123&4567',
      '555#123#4567',
      '300: 123: 4567',
      '+57/300/123/4567',
      '+57 300 123 4567 300 765 4321',
      '300 123 4567 / 310 765 4321',
      '300-123-4567, 310-765-4321',
      '+1 555 123 4567 / +1 555 765 4321',
      '+57 300 123 4567 2026',
      '+57 300 2012 0115',
      '+52 55 2020 1225',
      '+1 2019 12 1555',
      '+12019121555',
      '\u2764\uFE0F +57 300 123 4567',
    ],
    'an escape': [
      'ana%u0040example.com',
      '%26%2364%3Bhandle',
      'ana%40%ADexample.com',
      '%40%ADdapta_ai',
      'tel%3A%AD%2B15551234567',
      'jos%e9%40example.com',
    ],
    'length or emptiness': ['x'.repeat(101), '   '],
  };
  for (const [rule, inputs] of Object.entries(withheld)) {
    it(`withholds ${rule}`, () => {
      for (const v of inputs) expect([v, analyticsCampaignValue(v)]).toEqual([v, null]);
    });
  }

  it('is null for anything that is not a string', () => {
    expect(analyticsCampaignValue(undefined)).toBeNull();
    expect(analyticsCampaignValue(42)).toBeNull();
  });
});

describe('referrerDomain', () => {
  it('keeps only the host, never the path or query', () => {
    expect(referrerDomain('https://ChatGPT.com/c/abc?q=my+email@x.com')).toBe('chatgpt.com');
    expect(referrerDomain('http://localhost:3000/x')).toBe('localhost');
  });

  it('is null for a host no browser would send', () => {
    expect(referrerDomain('https://ana%40example.com/')).toBeNull();
    expect(referrerDomain('http://[::1]/x')).toBeNull();
  });

  it('never mistakes the user part of an authority for the domain', () => {
    expect(referrerDomain('https://alice@example.com/x')).toBe('example.com');
    expect(referrerDomain('https://a.b@corp.com@evil.test/')).toBe('evil.test');
    expect(referrerDomain('https://site.test:8443/p')).toBe('site.test');
  });

  it('is null for anything that is not an http(s) URL', () => {
    expect(referrerDomain('android-app://com.linkedin')).toBeNull();
    expect(referrerDomain('')).toBeNull();
    expect(referrerDomain(undefined)).toBeNull();
  });
});
