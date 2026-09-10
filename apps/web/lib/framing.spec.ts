import { describe, expect, it } from 'vitest';
import { frameAncestorsFor, framingHeaders } from './framing';

describe('frameAncestorsFor', () => {
  it('opens the four public booking routes — the promise the embed rests on', () => {
    expect(frameAncestorsFor('/acme/alex-rivera')).toBe('*');
    expect(frameAncestorsFor('/acme/alex-rivera/intro-call')).toBe('*');
    expect(frameAncestorsFor('/acme/team/sales')).toBe('*');
    expect(frameAncestorsFor('/acme/team/sales/demo')).toBe('*');
  });

  it("closes everything the host or the invitee acts on", () => {
    expect(frameAncestorsFor('/admin')).toBe("'self'");
    expect(frameAncestorsFor('/admin/event-types')).toBe("'self'");
    expect(frameAncestorsFor('/admin/settings/booking-page')).toBe("'self'");
    expect(frameAncestorsFor('/manage/abc123')).toBe("'self'");
    expect(frameAncestorsFor('/manage')).toBe("'self'");
    expect(frameAncestorsFor('/login')).toBe("'self'");
    expect(frameAncestorsFor('/onboarding')).toBe("'self'");
    expect(frameAncestorsFor('/')).toBe("'self'");
  });

  it('does not close a public route that merely starts with a protected name', () => {
    // `/administration` is an account code, not the dashboard.
    expect(frameAncestorsFor('/administration/alex/intro')).toBe('*');
    expect(frameAncestorsFor('/managed/alex/intro')).toBe('*');
  });
});

describe('framingHeaders', () => {
  it('carries the legacy header only where the answer is same-origin', () => {
    expect(framingHeaders('/admin/bookings')).toEqual({
      'Content-Security-Policy': "frame-ancestors 'self'",
      'X-Frame-Options': 'SAMEORIGIN',
    });
  });

  it('never sends X-Frame-Options on a public route — SAMEORIGIN would break the embed', () => {
    expect(framingHeaders('/acme/alex/intro')).toEqual({
      'Content-Security-Policy': 'frame-ancestors *',
    });
  });
});
