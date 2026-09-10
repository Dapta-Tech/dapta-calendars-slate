import { describe, expect, it } from 'vitest';
import { frameAncestorsFor, framingHeaders } from './framing';

/**
 * Kept in step with `PRODUCT_PREFIXES` in `lib/theme.ts` by the two tests
 * below rather than imported, because the point is to notice when that list
 * changes — an import would silently follow it.
 */
const PRODUCT_PREFIXES = ['/admin', '/login', '/onboarding', '/api'];

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

  /**
   * `theme.ts`'s prefix list became a security boundary when this module
   * started reading it. Deleting an entry there opens that path to framing by
   * any site, which nothing on screen would show — so it breaks here instead.
   */
  it('closes every product prefix, so removing one from theme.ts fails a test', () => {
    for (const prefix of PRODUCT_PREFIXES) {
      expect(frameAncestorsFor(prefix)).toBe("'self'");
      expect(frameAncestorsFor(`${prefix}/anything`)).toBe("'self'");
    }
  });
});

// The other half of this — that no account can CLAIM one of these prefixes as
// its vanity slug, and so serve a booking page from a path this rule calls the
// product — is pinned in `packages/engine/src/short-links.spec.ts`, next to the
// blocklist it asserts on. `apps/web` does not depend on `@slate/engine`, and a
// test is not a reason to make it.

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
