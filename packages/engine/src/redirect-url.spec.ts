import { describe, expect, it } from 'vitest';
import { MAX_SUCCESS_REDIRECT_URL, isSuccessRedirectUrl } from './redirect-url';

describe('isSuccessRedirectUrl: where an invitee may be sent after booking', () => {
  it('accepts absolute https addresses, with a path, a query, a fragment or a port', () => {
    expect(isSuccessRedirectUrl('https://example.com')).toBe(true);
    expect(isSuccessRedirectUrl('https://www.example.com/thanks?from=dcal#top')).toBe(true);
    expect(isSuccessRedirectUrl('HTTPS://EXAMPLE.COM/Thanks')).toBe(true);
    expect(isSuccessRedirectUrl('https://example.com:8443/x')).toBe(true);
    expect(isSuccessRedirectUrl('https://xn--fsq.example/')).toBe(true);
  });

  it('refuses every scheme that is not https, plain http included', () => {
    for (const bad of [
      'http://example.com/thanks',
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'ftp://example.com/',
      'mailto:host@example.com',
      '//example.com/thanks',
      '/thanks',
      'example.com/thanks',
    ]) {
      expect(isSuccessRedirectUrl(bad), bad).toBe(false);
    }
  });

  it('refuses spellings the URL parser would quietly repair into something else', () => {
    expect(isSuccessRedirectUrl('https:example.com')).toBe(false);
    expect(isSuccessRedirectUrl('https:/example.com')).toBe(false);
    expect(isSuccessRedirectUrl(' https://example.com')).toBe(false);
    expect(isSuccessRedirectUrl('https://example.com/a b')).toBe(false);
    expect(isSuccessRedirectUrl('https://example.com/\nset-cookie')).toBe(false);
    expect(isSuccessRedirectUrl('https://exa\tmple.com')).toBe(false);
    expect(isSuccessRedirectUrl('https://')).toBe(false);
    expect(isSuccessRedirectUrl('https://[::1')).toBe(false);
  });

  it('refuses credentials in the address, which would show a phishing-shaped prompt', () => {
    expect(isSuccessRedirectUrl('https://user:pass@example.com/')).toBe(false);
    expect(isSuccessRedirectUrl('https://user@example.com/')).toBe(false);
  });

  it('caps the length', () => {
    const base = 'https://example.com/';
    expect(isSuccessRedirectUrl(base + 'a'.repeat(MAX_SUCCESS_REDIRECT_URL - base.length))).toBe(true);
    expect(isSuccessRedirectUrl(base + 'a'.repeat(MAX_SUCCESS_REDIRECT_URL - base.length + 1))).toBe(false);
  });
});
