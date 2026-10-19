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
      '1234567890',
      'chatgpt.com',
      'google/cpc',
      'q&a webinar',
      'at&t calendar',
      'video #2',
      '50% off',
      'www.google.com',
      '15551234567',
      '2026 10 18',
    ]) {
      expect(analyticsCampaignValue(v)).toBe(v);
    }
    expect(analyticsCampaignValue('  padded  ')).toBe('padded');
  });

  it("passes the growth loop's own tags through the parser unchanged", () => {
    const url = buildSignupUrl({ baseUrl: 'https://signup.example.test', medium: 'badge', accountCode: 'k7m2qp' })!;
    const query = Object.fromEntries(new URLSearchParams(url.slice(url.indexOf('?') + 1)));
    const parsed = parseAttribution({ params: query })!;
    for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content'] as const) {
      expect(analyticsCampaignValue(parsed[key])).toBe(parsed[key]);
    }
  });

  it('withholds an address, a handle, a URL, a query, an entity, a phone, and their encoded forms', () => {
    for (const v of [
      'ana@example.com',
      '@dapta_ai',
      'ana%40example.com',
      'ana%2540example.com',
      'https://example.com/x?email=ana',
      'https:%2f%2fevil.test%2fana',
      '//evil.test/reset/ana',
      'linkedin.com/in/ana-smith',
      'see www.example.com/reset/abc',
      'HTTPS://EXAMPLE.COM/X',
      'HTTPS%3A%2F%2FEXAMPLE.COM',
      'ANA%40EXAMPLE.COM',
      'a=1&b=2',
      'a%3d1',
      'page?x',
      'page%3fx',
      'host%3a8080',
      'tom &amp; jerry',
      '&#64;handle',
      '+15551234567',
      '+57 300 123 4567',
      '57 300 123 4567',
      '(555) 123-4567',
      'tel:+15551234567',
      'mailto:ana',
      'example.com:8080/path',
      'example.com:8080',
      '%26%2364%3Bhandle',
      'ana%2Eexample',
      'ana\uFF20example.com',
      'ana\uFE6Bexample.com',
      'https\uFF1A\uFF0F\uFF0Fevil.test',
      'x'.repeat(101),
      '   ',
    ]) {
      expect([v, analyticsCampaignValue(v)]).toEqual([v, null]);
    }
    expect(analyticsCampaignValue(undefined)).toBeNull();
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
