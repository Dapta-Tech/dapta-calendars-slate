/**
 * Does a public page carry the Dapta branding? The ONE rule every surface obeys
 * (the "Made with" badge, the free-calendar block, the team landing, the
 * confirmation, the manage page, the embed). The API applies it and hands the
 * answer to the pages as `showBranding`; nothing else decides.
 *
 * Calendars never charges. Hiding the branding is included with a PAYING Dapta
 * AI subscription, which the upstream entitlement service decides and the
 * account row caches. So the branding is hidden only when BOTH hold:
 *  - the account asked for it (`hideBranding`), and
 *  - the cached verdict reads `paid`, or the deployment runs with
 *    `PREMIUM_FEATURES=open` (the OSS default: a fork gets the switch free).
 * Anything else shows it: a lapsed verdict, a verdict never fetched, no row.
 *
 * Pure, and it never looks at the verdict's age: a public page decides from the
 * cache as it stands and asks for a refresh on the side (see
 * `entitlementIsStale`), so no visitor ever waits on the upstream service.
 */

/** How long a cached entitlement verdict stays fresh before it is asked again. */
export const ENTITLEMENT_TTL_MS = 6 * 3_600_000;

export type PremiumMode = 'open' | 'locked';

export interface DaptaBrandingInput {
  /** The account's stored choice. */
  hideBranding: boolean;
  /** The cached upstream verdict, or null when it was never asked. */
  entitlement: 'paid' | 'free' | null;
  /** `PREMIUM_FEATURES`: `open` unlocks every premium switch (the OSS default). */
  premiumMode: PremiumMode;
}

export function showDaptaBranding(input: DaptaBrandingInput | null | undefined): boolean {
  if (!input || !input.hideBranding) return true;
  return !(input.premiumMode === 'open' || input.entitlement === 'paid');
}

/** True when a verdict checked at `checkedAt` (epoch ms) is due a refresh at `now`. */
export function entitlementIsStale(checkedAt: number | null | undefined, now: number): boolean {
  return !checkedAt || now - checkedAt >= ENTITLEMENT_TTL_MS;
}
