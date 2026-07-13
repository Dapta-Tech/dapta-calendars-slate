import { describe, it, expect } from 'vitest';
import { badgeHidden, buildSignupUrl, DEFAULT_SIGNUP_URL } from './growth';

describe('buildSignupUrl', () => {
  it('tags the default destination with the full UTM scheme', () => {
    const url = new URL(buildSignupUrl({ medium: 'badge', accountCode: 'acme' }));
    expect(`${url.origin}${url.pathname}`).toBe(DEFAULT_SIGNUP_URL + '/');
    expect(url.searchParams.get('utm_source')).toBe('dapta-calendars');
    expect(url.searchParams.get('utm_medium')).toBe('badge');
    expect(url.searchParams.get('utm_campaign')).toBe('made-with-dapta');
    expect(url.searchParams.get('utm_content')).toBe('acme');
  });

  it('varies only the medium between badge and confirmation', () => {
    const badge = new URL(buildSignupUrl({ medium: 'badge' }));
    const conf = new URL(buildSignupUrl({ medium: 'confirmation' }));
    expect(badge.searchParams.get('utm_medium')).toBe('badge');
    expect(conf.searchParams.get('utm_medium')).toBe('confirmation');
    expect(badge.searchParams.get('utm_source')).toBe(conf.searchParams.get('utm_source'));
    expect(badge.searchParams.get('utm_campaign')).toBe(conf.searchParams.get('utm_campaign'));
  });

  it('omits utm_content when there is no account code', () => {
    const url = new URL(buildSignupUrl({ medium: 'badge' }));
    expect(url.searchParams.has('utm_content')).toBe(false);
  });

  it('honors a configured base URL and preserves its path', () => {
    const url = new URL(
      buildSignupUrl({ baseUrl: 'https://example.com/signup', medium: 'confirmation' }),
    );
    expect(url.origin).toBe('https://example.com');
    expect(url.pathname).toBe('/signup');
    expect(url.searchParams.get('utm_medium')).toBe('confirmation');
  });

  it('falls back to the default destination on an unparseable base', () => {
    const url = new URL(buildSignupUrl({ baseUrl: 'not a url', medium: 'badge' }));
    expect(url.origin).toBe(DEFAULT_SIGNUP_URL);
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
