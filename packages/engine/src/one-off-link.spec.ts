import { describe, expect, it } from 'vitest';
import { isReservedPublicSlug, validateVanitySlug } from './short-links';
import {
  generateOneOffToken,
  isOneOffTokenShape,
  oneOffLinkPath,
  oneOffLinkState,
} from './one-off-link';

describe('generateOneOffToken', () => {
  it('mints 256 bits as 43 base64url characters', () => {
    const token = generateOneOffToken();
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 raw bytes — the same width as the manage token, kept despite the lower
    // privilege because enumeration resistance is what makes 410/404 safe.
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
  });

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateOneOffToken()));
    expect(seen.size).toBe(200);
  });
});

describe('isOneOffTokenShape', () => {
  it('accepts what generateOneOffToken mints', () => {
    for (let i = 0; i < 50; i++) expect(isOneOffTokenShape(generateOneOffToken())).toBe(true);
  });

  it('rejects the shapes a mangled copy-paste produces', () => {
    expect(isOneOffTokenShape('')).toBe(false);
    expect(isOneOffTokenShape(null)).toBe(false);
    expect(isOneOffTokenShape(undefined)).toBe(false);
    expect(isOneOffTokenShape('short')).toBe(false);
    // Standard base64 rather than base64url: `+`, `/` and `=` are all out.
    expect(isOneOffTokenShape('a'.repeat(42) + '=')).toBe(false);
    expect(isOneOffTokenShape('a'.repeat(42) + '+')).toBe(false);
    expect(isOneOffTokenShape('a'.repeat(42) + '/')).toBe(false);
    // One character either side of the exact width.
    expect(isOneOffTokenShape('a'.repeat(42))).toBe(false);
    expect(isOneOffTokenShape('a'.repeat(44))).toBe(false);
  });
});

describe('oneOffLinkState', () => {
  it('is live when nothing has happened to it', () => {
    expect(oneOffLinkState({})).toBe('live');
    expect(oneOffLinkState({ consumedAt: null, revokedAt: null })).toBe('live');
  });

  it('is consumed once a booking was made against it', () => {
    expect(oneOffLinkState({ consumedAt: 1_700_000_000_000 })).toBe('consumed');
  });

  it('is revoked when the host killed it by hand', () => {
    expect(oneOffLinkState({ revokedAt: 1_700_000_000_000 })).toBe('revoked');
  });

  it('reports consumed, not revoked, when both are set', () => {
    // Revoking a link that already produced a booking does not undo the
    // booking, and "revoked" would hide the fact that matters about it.
    expect(
      oneOffLinkState({ consumedAt: 1_700_000_000_000, revokedAt: 1_700_000_001_000 }),
    ).toBe('consumed');
  });
});

describe('oneOffLinkPath', () => {
  it('is the token alone under /booking', () => {
    expect(oneOffLinkPath('abc')).toBe('/booking/abc');
  });

  /**
   * The property the whole URL shape rests on (#110).
   *
   * `/booking/{token}` is a top-level route, so it sits in the same namespace
   * as `/{accountCode}/{handle}`. Next resolves the static segment first, but
   * that only matters if no account could legitimately live there — and this is
   * what guarantees none can: `booking` is on the blocklist that
   * `generateUniqueShortCode` skips and `validateVanitySlug` rejects, so it can
   * never be claimed as a code, a vanity slug or a retired alias.
   *
   * Pinned HERE, beside the blocklist, rather than in `apps/web`: that package
   * does not depend on this one and a test is not a reason to change it — the
   * same split `apps/web/lib/framing.spec.ts` already makes for the framing
   * prefixes. The web half of the argument is in `lib/one-off-route.spec.ts`.
   */
  it('uses a prefix no account can ever claim', () => {
    expect(isReservedPublicSlug('booking')).toBe(true);
    expect(validateVanitySlug('booking')).toBe('reserved');
    // Case-folded, because a vanity slug is lowercased before it is checked.
    expect(isReservedPublicSlug('BOOKING')).toBe(true);
  });
});
