import { describe, expect, it } from 'vitest';
import { ENTITLEMENT_TTL_MS, entitlementIsStale, showDaptaBranding } from './dapta-branding';

describe('showDaptaBranding: the one rule every public surface obeys', () => {
  it('shows the branding by default, whatever the verdict or the mode', () => {
    for (const entitlement of ['paid', 'free', null] as const) {
      for (const premiumMode of ['open', 'locked'] as const) {
        expect(showDaptaBranding({ hideBranding: false, entitlement, premiumMode })).toBe(true);
      }
    }
    expect(showDaptaBranding(null)).toBe(true);
    expect(showDaptaBranding(undefined)).toBe(true);
  });

  it('hides it only for an account that asked, while it is a paying Dapta AI customer', () => {
    expect(showDaptaBranding({ hideBranding: true, entitlement: 'paid', premiumMode: 'locked' })).toBe(false);
  });

  it('brings it back when the verdict is not paid, or was never fetched', () => {
    expect(showDaptaBranding({ hideBranding: true, entitlement: 'free', premiumMode: 'locked' })).toBe(true);
    expect(showDaptaBranding({ hideBranding: true, entitlement: null, premiumMode: 'locked' })).toBe(true);
  });

  it('gives the switch to everyone on an open deployment (the OSS default)', () => {
    expect(showDaptaBranding({ hideBranding: true, entitlement: null, premiumMode: 'open' })).toBe(false);
    expect(showDaptaBranding({ hideBranding: true, entitlement: 'free', premiumMode: 'open' })).toBe(false);
  });
});

describe('entitlementIsStale', () => {
  const now = 1_000_000_000_000;
  it('is six hours', () => {
    expect(ENTITLEMENT_TTL_MS).toBe(6 * 60 * 60 * 1000);
  });
  it('a verdict never fetched is stale', () => {
    expect(entitlementIsStale(null, now)).toBe(true);
    expect(entitlementIsStale(undefined, now)).toBe(true);
    expect(entitlementIsStale(0, now)).toBe(true);
  });
  it('is fresh until one TTL has passed, and stale from then on', () => {
    expect(entitlementIsStale(now - ENTITLEMENT_TTL_MS + 1, now)).toBe(false);
    expect(entitlementIsStale(now - ENTITLEMENT_TTL_MS, now)).toBe(true);
  });
});
