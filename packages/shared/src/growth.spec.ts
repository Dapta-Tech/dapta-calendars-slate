import { describe, it, expect } from 'vitest';
import {
  ATTRIBUTION_BLOB_MAX,
  ATTRIBUTION_VALUE_MAX,
  badgeHidden,
  buildSignupUrl,
  parseAttribution,
} from './growth';

const SELF = 'https://calendar.example.com';

describe('buildSignupUrl', () => {
  it('tags a configured destination with the full UTM scheme', () => {
    const url = new URL(buildSignupUrl({ baseUrl: 'https://signup.example.com', medium: 'badge', accountCode: 'acme' })!);
    expect(url.origin).toBe('https://signup.example.com');
    expect(url.searchParams.get('utm_source')).toBe('dapta-calendars');
    expect(url.searchParams.get('utm_medium')).toBe('badge');
    expect(url.searchParams.get('utm_campaign')).toBe('made-with-dapta');
    expect(url.searchParams.get('utm_content')).toBe('acme');
  });

  it('varies only the medium between badge and confirmation', () => {
    const base = 'https://signup.example.com';
    const badge = new URL(buildSignupUrl({ baseUrl: base, medium: 'badge' })!);
    const conf = new URL(buildSignupUrl({ baseUrl: base, medium: 'confirmation' })!);
    expect(badge.searchParams.get('utm_medium')).toBe('badge');
    expect(conf.searchParams.get('utm_medium')).toBe('confirmation');
    expect(badge.searchParams.get('utm_source')).toBe(conf.searchParams.get('utm_source'));
    expect(badge.searchParams.get('utm_campaign')).toBe(conf.searchParams.get('utm_campaign'));
  });

  it('omits utm_content when there is no account code', () => {
    const url = new URL(buildSignupUrl({ baseUrl: 'https://signup.example.com', medium: 'badge' })!);
    expect(url.searchParams.has('utm_content')).toBe(false);
  });

  it('preserves an existing path and query on the destination', () => {
    const url = new URL(buildSignupUrl({ baseUrl: 'https://example.com/signup?ref=x', medium: 'confirmation' })!);
    expect(url.pathname).toBe('/signup');
    expect(url.searchParams.get('ref')).toBe('x');
    expect(url.searchParams.get('utm_medium')).toBe('confirmation');
  });

  it('returns null when no destination is configured (surface hides)', () => {
    expect(buildSignupUrl({ medium: 'badge' })).toBeNull();
    expect(buildSignupUrl({ baseUrl: '', medium: 'badge' })).toBeNull();
    expect(buildSignupUrl({ baseUrl: 'not a url', medium: 'badge' })).toBeNull();
    expect(buildSignupUrl({ baseUrl: 'ftp://x.example', medium: 'badge' })).toBeNull();
  });
});

describe('badgeHidden', () => {
  it('is shown by default (unset / empty / junk values)', () => {
    expect(badgeHidden(undefined)).toBe(false);
    expect(badgeHidden(null)).toBe(false);
    expect(badgeHidden('')).toBe(false);
    expect(badgeHidden('0')).toBe(false);
    expect(badgeHidden('off')).toBe(false);
  });

  it('hides on the documented truthy spellings', () => {
    expect(badgeHidden('1')).toBe(true);
    expect(badgeHidden('true')).toBe(true);
    expect(badgeHidden('TRUE')).toBe(true);
    expect(badgeHidden(' yes ')).toBe(true);
  });
});

describe('parseAttribution — the 7-key allowlist', () => {
  it('carries exactly the seven allowlisted keys', () => {
    const got = parseAttribution({
      params: {
        utm_source: 'google',
        utm_medium: 'cpc',
        utm_campaign: 'q3-launch',
        utm_term: 'booking software',
        utm_content: 'acme',
        gclid: 'Cj0KCQiA',
        fbclid: 'IwAR2x',
      },
      selfOrigin: SELF,
    });
    expect(got).toEqual({
      utm_source: 'google',
      utm_medium: 'cpc',
      utm_campaign: 'q3-launch',
      utm_term: 'booking software',
      utm_content: 'acme',
      gclid: 'Cj0KCQiA',
      fbclid: 'IwAR2x',
    });
  });

  it('drops every parameter outside the allowlist', () => {
    // The glob this allowlist replaced would have carried all three. The claim
    // downstream is write-once, so each is a permanent poisoning of the row.
    const got = parseAttribution({
      params: {
        utm_source: 'google',
        utm_anything: 'junk',
        utm_id: '123',
        msclkid: 'abc',
        ref: 'somewhere',
      },
      selfOrigin: SELF,
    });
    expect(got).toEqual({ utm_source: 'google' });
  });

  it('lowercases utm values but preserves click-id case', () => {
    const got = parseAttribution({
      params: { utm_source: 'GOOGLE', utm_campaign: 'Q3-Launch', gclid: 'AbCdEf', fbclid: 'XyZ' },
      selfOrigin: SELF,
    });
    expect(got).toEqual({
      utm_source: 'google',
      utm_campaign: 'q3-launch',
      gclid: 'AbCdEf',
      fbclid: 'XyZ',
    });
  });

  it('trims, then drops values that were only whitespace', () => {
    const got = parseAttribution({
      params: { utm_source: '  google  ', utm_medium: '   ', utm_campaign: '' },
      selfOrigin: SELF,
    });
    expect(got).toEqual({ utm_source: 'google' });
  });

  it('caps each value at the documented length', () => {
    const got = parseAttribution({
      params: { utm_campaign: 'a'.repeat(500) },
      selfOrigin: SELF,
    });
    expect(got?.utm_campaign).toHaveLength(ATTRIBUTION_VALUE_MAX);
  });

  it('leaves seven maxed-out values alone — they fit under the blob cap', () => {
    const long = 'b'.repeat(ATTRIBUTION_VALUE_MAX);
    const got = parseAttribution({
      params: {
        utm_source: long,
        utm_medium: long,
        utm_campaign: long,
        utm_term: long,
        utm_content: long,
        gclid: long,
        fbclid: long,
      },
      selfOrigin: SELF,
    });
    expect(Object.keys(got!)).toHaveLength(7);
    expect(JSON.stringify(got).length).toBeLessThanOrEqual(ATTRIBUTION_BLOB_MAX);
  });

  it('bounds the blob, dropping the tail rather than the keys the payload reads', () => {
    // Seven maxed values plus a maxed referer is the only way past the cap.
    // `referer` is inserted last, so it is what gets lost — source/medium/
    // campaign, the three the dapta_sync payload reads, always survive.
    const long = 'b'.repeat(ATTRIBUTION_VALUE_MAX);
    const got = parseAttribution({
      params: {
        utm_source: long,
        utm_medium: long,
        utm_campaign: long,
        utm_term: long,
        utm_content: long,
        gclid: long,
        fbclid: long,
      },
      refererHeader: `https://news.example.org/${'c'.repeat(200)}`,
      selfOrigin: SELF,
    });
    expect(JSON.stringify(got).length).toBeLessThanOrEqual(ATTRIBUTION_BLOB_MAX);
    expect(got?.utm_source).toBe(long);
    expect(got?.utm_medium).toBe(long);
    expect(got?.utm_campaign).toBe(long);
    expect(got?.referer).toBeUndefined();
  });

  it('never reads referer from a query parameter', () => {
    // Attacker-controlled text; once claimed it is indistinguishable from a
    // real referrer, which is why the param is dropped like any other non-key.
    const got = parseAttribution({
      params: { utm_source: 'google', referer: 'https://evil.example.com' },
      selfOrigin: SELF,
    });
    expect(got).toEqual({ utm_source: 'google' });
  });

  it('reads a cross-origin referer from the header', () => {
    const got = parseAttribution({
      params: {},
      refererHeader: 'https://news.example.org/post/1',
      selfOrigin: SELF,
    });
    expect(got).toEqual({ referer: 'https://news.example.org/post/1' });
  });

  it('ignores a same-origin referer header (internal navigation)', () => {
    expect(
      parseAttribution({
        params: {},
        refererHeader: `${SELF}/acme/alex-rivera`,
        selfOrigin: SELF,
      }),
    ).toBeNull();
  });

  // The proxy shape. TLS terminates at the load balancer, so the deployment
  // sees `http://` while the browser sends an `https://` referrer, and the raw
  // request URL is the bind address rather than the public host. Comparing
  // full origins here would call internal navigation cross-origin and stamp
  // EVERY organic signup with a self-referral — permanently, since the claim
  // is write-once. Local dev never shows it, because there the two match.
  it('treats an https referer as same-origin when the deployment sees http', () => {
    expect(
      parseAttribution({
        params: {},
        refererHeader: 'https://calendar.example.com/',
        selfOrigin: 'http://calendar.example.com',
      }),
    ).toBeNull();
  });

  it('still records a genuinely different host behind a proxy', () => {
    expect(
      parseAttribution({
        params: {},
        refererHeader: 'https://news.example.org/post/1',
        selfOrigin: 'http://calendar.example.com',
      }),
    ).toEqual({ referer: 'https://news.example.org/post/1' });
  });

  it('ignores a referer header that is not an absolute http(s) URL', () => {
    expect(
      parseAttribution({ params: {}, refererHeader: 'android-app://com.example', selfOrigin: SELF }),
    ).toBeNull();
  });

  it('sends nothing for organic traffic — no synthetic direct/organic', () => {
    // Stamping `utm_source=direct` on someone who typed the domain writes a
    // permanent lie into a row that can never be corrected (#65).
    expect(parseAttribution({ params: {}, selfOrigin: SELF })).toBeNull();
    expect(parseAttribution({ params: { foo: 'bar' }, selfOrigin: SELF })).toBeNull();
  });

  it('accepts a URLSearchParams-shaped source as well as a plain object', () => {
    const params = new URLSearchParams('utm_source=Google&utm_anything=junk');
    expect(parseAttribution({ params, selfOrigin: SELF })).toEqual({ utm_source: 'google' });
  });

  it('takes the first value when a key is repeated', () => {
    expect(
      parseAttribution({ params: { utm_source: ['google', 'bing'] }, selfOrigin: SELF }),
    ).toEqual({ utm_source: 'google' });
  });
});
