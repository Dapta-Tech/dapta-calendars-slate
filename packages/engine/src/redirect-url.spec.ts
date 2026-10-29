import { describe, expect, it } from 'vitest';
import { MAX_SUCCESS_REDIRECT_URL, bookingRedirectUrl, isSuccessRedirectUrl } from './redirect-url';

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

describe('bookingRedirectUrl', () => {
  const details = {
    eventTypeSlug: 'intro-call',
    eventTypeName: 'Intro call',
    startUtc: '2026-11-03T15:00:00.000Z',
    endUtc: '2026-11-03T15:30:00.000Z',
    status: 'accepted',
    hostName: 'Alex Rivera',
    utm: { utm_source: 'google', utm_campaign: 'q4 launch', other: 'nope' } as Record<string, string>,
    invitee: { name: 'Sam Visitor', email: 'sam@example.com' },
  };
  const params = (url: string) => Object.fromEntries(new URL(url).searchParams);

  it('leaves the address as typed when the event passes nothing', () => {
    expect(bookingRedirectUrl('https://example.com/thanks?x=1', null, details)).toBe('https://example.com/thanks?x=1');
    expect(bookingRedirectUrl('https://example.com/thanks', undefined, details)).toBe('https://example.com/thanks');
  });

  it('event: the event, the time, the status, the host and the UTMs, never the invitee', () => {
    const out = bookingRedirectUrl('https://example.com/thanks?from=calendar', 'event', details);
    expect(params(out)).toEqual({
      from: 'calendar',
      event_type: 'intro-call',
      event_type_name: 'Intro call',
      event_start_time: '2026-11-03T15:00:00.000Z',
      event_end_time: '2026-11-03T15:30:00.000Z',
      booking_status: 'accepted',
      assigned_to: 'Alex Rivera',
      utm_source: 'google',
      utm_campaign: 'q4 launch',
    });
    expect(out).not.toContain('sam');
    expect(out).toContain('utm_campaign=q4+launch');
  });

  it('event_and_invitee: adds the invitee’s name and email', () => {
    const p = params(bookingRedirectUrl('https://example.com/thanks', 'event_and_invitee', details));
    expect(p.invitee_full_name).toBe('Sam Visitor');
    expect(p.invitee_email).toBe('sam@example.com');
  });

  it('a parameter the host already put on the address wins, and a campaign there keeps the booking’s out whole', () => {
    const p = params(bookingRedirectUrl('https://example.com/thanks?utm_source=newsletter', 'event', details));
    expect(p.utm_source).toBe('newsletter');
    // All or nothing: never two campaigns on one visit.
    expect(p).not.toHaveProperty('utm_campaign');
    expect(p.event_type).toBe('intro-call');
  });

  it('keeps the host’s own query byte for byte, the details after it', () => {
    const out = bookingRedirectUrl('https://example.com/thanks?a=b%20c&flag&sig=ab~c#done', 'event', details);
    expect(out.startsWith('https://example.com/thanks?a=b%20c&flag&sig=ab~c&event_type=intro-call')).toBe(true);
    expect(out.endsWith('#done')).toBe(true);
  });

  it('goes as typed rather than not at all when the details would make it too long', () => {
    const long = { ...details, eventTypeName: 'x'.repeat(2100) };
    expect(bookingRedirectUrl('https://example.com/thanks', 'event', long)).toBe('https://example.com/thanks');
  });
});
